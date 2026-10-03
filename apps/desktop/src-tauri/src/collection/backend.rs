use serde::Serialize;
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    ffi::OsString,
    io::{BufRead, BufReader, Write},
    path::PathBuf,
    process::{Child, ChildStdin, Command, Stdio},
    sync::{
        atomic::{AtomicU64, Ordering},
        mpsc, Arc, Mutex,
    },
    thread,
    time::{Duration, Instant},
};

#[derive(Debug, Clone, Serialize)]
pub struct BackendError {
    pub code: String,
    pub message: String,
}

impl BackendError {
    pub fn new(code: &str, message: impl ToString) -> Self {
        Self {
            code: code.into(),
            message: message.to_string(),
        }
    }
}

impl From<std::io::Error> for BackendError {
    fn from(error: std::io::Error) -> Self {
        Self::new("unavailable", error)
    }
}

impl std::fmt::Display for BackendError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.message)
    }
}
impl std::error::Error for BackendError {}

type Reply = Result<Value, BackendError>;
type EventHandler = Arc<dyn Fn(Value) + Send + Sync>;

#[derive(Default)]
struct Pending {
    closed: bool,
    requests: HashMap<u64, mpsc::Sender<Reply>>,
}

struct Running {
    child: Child,
    stdin: ChildStdin,
    pending: Arc<Mutex<Pending>>,
    stopping: bool,
}

impl Drop for Running {
    fn drop(&mut self) {
        // 最终释放对象时才回收子进程；关闭超时不会进入这里，也不允许重启。
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

#[derive(Default)]
struct ResumeState {
    paused: Option<bool>,
    apps_enabled: Option<bool>,
}

struct Call {
    id: u64,
    pending: Arc<Mutex<Pending>>,
    receiver: mpsc::Receiver<Reply>,
}

impl Call {
    fn wait(self, method: &str, timeout: Duration) -> Reply {
        match self.receiver.recv_timeout(timeout) {
            Ok(result) => result,
            Err(error) => {
                self.pending.lock().unwrap().requests.remove(&self.id);
                let code = if error == mpsc::RecvTimeoutError::Timeout {
                    "timeout"
                } else {
                    "unavailable"
                };
                Err(BackendError::new(
                    code,
                    format!("后端没有响应 {method}：{error}"),
                ))
            }
        }
    }
}

pub struct Backend {
    executable: PathBuf,
    database: PathBuf,
    args: Vec<OsString>,
    on_event: EventHandler,
    next_id: AtomicU64,
    running: Mutex<Option<Running>>,
    resume: Mutex<ResumeState>,
}

impl Backend {
    pub fn new(
        executable: PathBuf,
        database: PathBuf,
        args: Vec<OsString>,
        on_event: EventHandler,
    ) -> Self {
        Self {
            executable,
            database,
            args,
            on_event,
            next_id: AtomicU64::new(1),
            running: Mutex::new(None),
            resume: Mutex::new(ResumeState::default()),
        }
    }

    fn spawn(&self) -> Result<Running, BackendError> {
        let mut command = Command::new(&self.executable);
        command
            .args(&self.args)
            .arg("--db")
            .arg(&self.database)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            command.creation_flags(0x08000000); // CREATE_NO_WINDOW
        }
        let mut child = command.spawn()?;
        let stdin = child.stdin.take().expect("piped stdin");
        let stdout = child.stdout.take().expect("piped stdout");
        let stderr = child.stderr.take().expect("piped stderr");
        let pending = Arc::new(Mutex::new(Pending::default()));
        let reader_pending = pending.clone();
        let on_event = self.on_event.clone();
        thread::spawn(move || {
            // BufRead 处理分段 UTF-8、CRLF 与连续消息；一条响应只分配一份缓冲。
            for line in BufReader::new(stdout).lines() {
                let Ok(line) = line else { break };
                let Ok(message) = serde_json::from_str::<Value>(&line) else {
                    continue;
                };
                if message.get("event").and_then(Value::as_str).is_some() {
                    on_event(message);
                    continue;
                }
                let Some(id) = message.get("id").and_then(Value::as_u64) else {
                    continue;
                };
                let sender = reader_pending.lock().unwrap().requests.remove(&id);
                if let Some(sender) = sender {
                    let reply = if message["ok"] == true {
                        Ok(message.get("result").cloned().unwrap_or_else(|| json!({})))
                    } else {
                        Err(BackendError::new(
                            message["error"]["code"].as_str().unwrap_or("unknown"),
                            message["error"]["message"]
                                .as_str()
                                .unwrap_or("后端返回失败。"),
                        ))
                    };
                    let _ = sender.send(reply);
                }
            }
            let mut pending = reader_pending.lock().unwrap();
            pending.closed = true;
            for (_, sender) in pending.requests.drain() {
                let _ = sender.send(Err(BackendError::new("unavailable", "后端进程已断开。")));
            }
        });
        thread::spawn(move || {
            for line in BufReader::new(stderr).lines().map_while(Result::ok) {
                eprintln!("[backend] {line}");
            }
        });
        Ok(Running {
            child,
            stdin,
            pending,
            stopping: false,
        })
    }

    fn enqueue(
        &self,
        running: &mut Running,
        method: &str,
        params: Value,
    ) -> Result<Call, BackendError> {
        let (sender, receiver) = mpsc::channel();
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let pending = running.pending.clone();
        {
            let mut entries = pending.lock().unwrap();
            if entries.closed {
                return Err(BackendError::new("unavailable", "后端进程已断开。"));
            }
            entries.requests.insert(id, sender);
        }
        if method == "shutdown" {
            running.stopping = true;
        }
        let payload = json!({ "id": id, "protocol": 1, "method": method, "params": params });
        if let Err(error) = writeln!(running.stdin, "{payload}") {
            pending.lock().unwrap().requests.remove(&id);
            return Err(error.into());
        }
        Ok(Call {
            id,
            pending,
            receiver,
        })
    }

    pub fn request(&self, method: &str, params: Value, timeout: Duration) -> Reply {
        if method.is_empty() {
            return Err(BackendError::new("badRequest", "缺少方法名。"));
        }
        // Keep state-changing replies ordered with process creation. Other requests release
        // this gate immediately after enqueueing, retaining concurrent response handling.
        let mut resume = self.resume.lock().unwrap();
        let call = {
            let mut slot = self.running.lock().unwrap();
            if let Some(running) = slot.as_mut() {
                if running.stopping {
                    return Err(BackendError::new("unavailable", "等待原采集进程实际退出。"));
                }
                if running.child.try_wait()?.is_some() {
                    *slot = None;
                }
            }
            if slot.is_none() {
                let mut running = self.spawn()?;
                // A replacement starts paused. Restore application collection before resuming,
                // and do not expose a partially restored process to other requests.
                if let Some(enabled) = resume.apps_enabled {
                    self.enqueue(&mut running, "setAppCollection", json!({"enabled":enabled}))?
                        .wait("setAppCollection", timeout)?;
                }
                if let Some(paused) = resume.paused {
                    self.enqueue(&mut running, "setPaused", json!({"paused":paused}))?
                        .wait("setPaused", timeout)?;
                }
                *slot = Some(running);
            }
            self.enqueue(slot.as_mut().unwrap(), method, params)?
        };
        if matches!(method, "setPaused" | "setAppCollection") {
            let result = call.wait(method, timeout)?;
            if method == "setPaused" {
                if let Some(paused) = result["paused"].as_bool() {
                    resume.paused = Some(paused);
                }
            } else if let Some(enabled) = result["appCollection"]["enabled"].as_bool() {
                resume.apps_enabled = Some(enabled);
            }
            Ok(result)
        } else {
            drop(resume);
            call.wait(method, timeout)
        }
    }

    pub fn wait_for_shutdown(&self, timeout: Duration) -> Result<(), BackendError> {
        let deadline = Instant::now() + timeout;
        loop {
            {
                let mut slot = self.running.lock().unwrap();
                let Some(running) = slot.as_mut() else {
                    return Ok(());
                };
                if !running.stopping {
                    return Err(BackendError::new("badRequest", "采集器尚未请求关闭。"));
                }
                if let Some(status) = running.child.try_wait()? {
                    *slot = None;
                    return if status.success() {
                        Ok(())
                    } else {
                        Err(BackendError::new(
                            "unavailable",
                            format!("采集器异常退出：{status}"),
                        ))
                    };
                }
            }
            if Instant::now() >= deadline {
                return Err(BackendError::new(
                    "timeout",
                    "采集器尚未完成保存，不能重启或安装更新。",
                ));
            }
            thread::sleep(Duration::from_millis(10));
        }
    }

    pub fn stop_gracefully(&self, timeout: Duration) -> Result<(), BackendError> {
        let stopping = {
            let slot = self.running.lock().unwrap();
            let Some(running) = slot.as_ref() else {
                return Ok(());
            };
            running.stopping
        };
        let start = Instant::now();
        if !stopping {
            self.request("shutdown", json!({}), timeout)?;
        }
        self.wait_for_shutdown(timeout.saturating_sub(start.elapsed()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::collector::Collector;

    #[test]
    #[ignore = "requires WIFIMETER_BACKEND pointing to a built C++ collector"]
    fn real_crashed_collector_restores_session_state_and_keeps_database() {
        let executable =
            PathBuf::from(std::env::var_os("WIFIMETER_BACKEND").expect("set WIFIMETER_BACKEND"));
        for paused in [false, true] {
            let profile = tempfile::tempdir().unwrap();
            let apps = profile.path().join("apps.json");
            std::fs::write(
                &apps,
                r#"{"state":"running","generation":"one","samples":[]}"#,
            )
            .unwrap();
            let backend = Arc::new(Backend::new(
                executable.clone(),
                profile.path().join("wifimeter.db"),
                vec![
                    "--paused".into(),
                    "--fake-apps".into(),
                    apps.into_os_string(),
                ],
                Arc::new(|_| {}),
            ));
            let collector = Collector::new(backend.clone(), profile.path().into(), None);
            collector
                .request(
                    "updateSettings",
                    json!({"settings":{"unit":"GiB","retention":30}}),
                    || false,
                )
                .unwrap();
            collector
                .request("setAppCollection", json!({"enabled":true}), || false)
                .unwrap();
            collector
                .request("setPaused", json!({"paused":paused}), || false)
                .unwrap();
            let pid = {
                let mut slot = backend.running.lock().unwrap();
                let child = &mut slot.as_mut().unwrap().child;
                let pid = child.id();
                child.kill().unwrap();
                child.wait().unwrap();
                pid
            };
            let hello = collector.request("hello", json!({}), || false).unwrap();
            assert_eq!(hello["paused"], paused);
            assert_eq!(hello["settings"]["unit"], "GiB");
            assert_eq!(hello["settings"]["retention"], 30);
            assert_ne!(
                backend.running.lock().unwrap().as_ref().unwrap().child.id(),
                pid
            );
            let snapshot = collector.request("snapshot", json!({}), || false).unwrap();
            assert_eq!(snapshot["appCollection"]["enabled"], true);
            collector.stop_gracefully(Duration::from_secs(30)).unwrap();
        }
    }
}
