use serde_json::{json, Value};
use std::{
    collections::{HashMap, HashSet},
    io::{BufRead, BufReader, Write},
    path::PathBuf,
    process::{ChildStdin, Command, Stdio},
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc, Mutex,
    },
    time::Duration,
};
use tauri::{AppHandle, Emitter, Manager};
use tokio::sync::oneshot;

#[cfg(windows)]
#[path = "legacy_instance.rs"]
mod legacy_instance;

pub type Reply = Result<Value, String>;

pub struct Host {
    input: Mutex<Option<ChildStdin>>,
    pending: Mutex<HashMap<u64, oneshot::Sender<Reply>>>,
    pub options: Mutex<HashMap<String, Value>>,
    pub user_data: Mutex<Option<PathBuf>>,
    pub loaded: Mutex<HashSet<String>>,
    pub close_action: Mutex<Option<(u64, Value)>>,
    #[cfg(windows)]
    legacy_instance: Mutex<Option<legacy_instance::LegacyInstanceGuard>>,
    next_id: AtomicU64,
    pub quitting: AtomicBool,
    failed: AtomicBool,
}

impl Host {
    pub fn new() -> Arc<Self> {
        Arc::new(Self {
            input: Mutex::new(None),
            pending: Mutex::new(HashMap::new()),
            options: Mutex::new(HashMap::new()),
            user_data: Mutex::new(None),
            loaded: Mutex::new(HashSet::new()),
            close_action: Mutex::new(None),
            #[cfg(windows)]
            legacy_instance: Mutex::new(None),
            next_id: AtomicU64::new(1),
            quitting: AtomicBool::new(false),
            failed: AtomicBool::new(false),
        })
    }

    pub fn send(&self, message: Value) -> Result<(), String> {
        let mut input = self.input.lock().map_err(|_| "worker input lock failed")?;
        let input = input.as_mut().ok_or("桌面服务尚未启动或已经退出。")?;
        serde_json::to_writer(&mut *input, &message).map_err(|error| error.to_string())?;
        input.write_all(b"\n").map_err(|error| error.to_string())?;
        input.flush().map_err(|error| error.to_string())
    }

    pub async fn request(&self, window: &str, channel: String, args: Vec<Value>) -> Reply {
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let (sender, receiver) = oneshot::channel();
        self.pending.lock().unwrap().insert(id, sender);
        if let Err(error) = self.send(json!({ "type": "request", "id": id,
            "window": window, "channel": channel, "args": args }))
        {
            self.pending.lock().unwrap().remove(&id);
            return Err(error);
        }
        // Backup, migration, and installers may take several minutes.
        let result = tokio::time::timeout(Duration::from_secs(360), receiver).await;
        self.pending.lock().unwrap().remove(&id);
        match result {
            Ok(Ok(reply)) => reply,
            Ok(Err(_)) => Err("桌面服务已退出。".into()),
            Err(_) => Err("桌面服务请求超时。".into()),
        }
    }

    fn response(&self, message: &Value) {
        if let Some(id) = message["id"].as_u64() {
            if let Some(sender) = self.pending.lock().unwrap().remove(&id) {
                let reply = if message["ok"].as_bool() == Some(true) {
                    Ok(message["result"].clone())
                } else {
                    Err(message["error"]["message"]
                        .as_str()
                        .or_else(|| message["error"].as_str())
                        .unwrap_or("桌面服务请求失败。")
                        .to_string())
                };
                let _ = sender.send(reply);
            }
        }
    }

    pub fn native_response(&self, id: Value, result: Reply) {
        let message = match result {
            Ok(value) => json!({ "type": "native-result", "id": id, "ok": true, "result": value }),
            Err(error) => json!({ "type": "native-result", "id": id, "ok": false,
                "error": { "message": error } }),
        };
        let _ = self.send(message);
    }

    pub fn request_close(&self, app: &AppHandle, action: Value) {
        if !self.loaded.lock().unwrap().contains("main") {
            let _ = self.send(action);
            return;
        }
        let mut pending = self.close_action.lock().unwrap();
        if pending.is_some() {
            return;
        }
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        *pending = Some((id, action));
        let _ = app.emit_to(
            "main",
            "desktop:event",
            json!({
            "channel": "window:close-request", "payload": { "id": id } }),
        );
    }

    pub fn fatal(self: &Arc<Self>, app: &AppHandle, error: String) {
        if self.quitting.load(Ordering::SeqCst) || self.failed.swap(true, Ordering::SeqCst) {
            return;
        }
        eprintln!("[desktop] {error}");
        self.input.lock().unwrap().take();
        for (_, sender) in self.pending.lock().unwrap().drain() {
            let _ = sender.send(Err(error.clone()));
        }
        let app = app.clone();
        std::thread::spawn(move || {
            rfd::MessageDialog::new()
                .set_title("WiFiMeter")
                .set_level(rfd::MessageLevel::Error)
                .set_description(format!("桌面服务启动失败或意外退出。\n{error}"))
                .show();
            app.exit(1);
        });
    }
}

#[cfg(any(target_os = "linux", test))]
fn sibling_resources_path(executable: &std::path::Path) -> Option<PathBuf> {
    let resources = executable.parent()?.join("resources");
    resources
        .join("runtime/host.cjs")
        .is_file()
        .then_some(resources)
}

fn node_compatible_path(path: &std::path::Path) -> PathBuf {
    #[cfg(windows)]
    {
        use std::{
            ffi::OsString,
            path::{Component, Prefix},
        };
        let mut components = path.components();
        let mut prefix = match components.next() {
            Some(Component::Prefix(prefix)) => match prefix.kind() {
                Prefix::VerbatimDisk(drive) => OsString::from(format!("{}:", drive as char)),
                Prefix::VerbatimUNC(server, share) => {
                    let mut prefix = OsString::from(r"\\");
                    prefix.push(server);
                    prefix.push(r"\");
                    prefix.push(share);
                    prefix
                }
                _ => return path.to_path_buf(),
            },
            _ => return path.to_path_buf(),
        };
        // 保留路径剩余部分和 UNC 共享名；Node 的模块加载不接受 verbatim 前缀。
        prefix.push(components.as_path().as_os_str());
        PathBuf::from(prefix)
    }
    #[cfg(not(windows))]
    {
        path.to_path_buf()
    }
}

fn resources_path(app: &AppHandle) -> Result<PathBuf, String> {
    if let Some(path) = std::env::var_os("WIFIMETER_RESOURCES_PATH") {
        return Ok(path.into());
    }
    if cfg!(debug_assertions) {
        Ok(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("resources"))
    } else {
        #[cfg(target_os = "linux")]
        if let Ok(executable) = std::env::current_exe() {
            if let Some(resources) = sibling_resources_path(&executable) {
                return Ok(resources);
            }
        }
        app.path()
            .resource_dir()
            .map(|path| path.join("resources"))
            .map_err(|error| error.to_string())
    }
}

fn node_path(resources: &std::path::Path) -> Result<PathBuf, String> {
    let name = if cfg!(windows) { "node.exe" } else { "node" };
    let bundled = resources.join("runtime").join(name);
    if bundled.is_file() {
        return Ok(bundled);
    }
    if cfg!(debug_assertions) {
        if let Some(path) = std::env::var_os("WIFIMETER_NODE") {
            return Ok(path.into());
        }
        #[cfg(windows)]
        {
            let system = PathBuf::from(r"C:\Program Files\nodejs\node.exe");
            if system.is_file() {
                return Ok(system);
            }
        }
        return Ok(PathBuf::from(name));
    }
    Err(format!(
        "缺少随应用提供的 Node 运行时：{}",
        bundled.display()
    ))
}

pub fn start(app: &AppHandle, host: Arc<Host>) -> Result<(), String> {
    let resources = std::path::absolute(node_compatible_path(&resources_path(app)?))
        .map_err(|error| error.to_string())?;
    let script = resources.join("runtime").join("host.cjs");
    if !script.is_file() {
        return Err(format!("缺少桌面服务文件：{}", script.display()));
    }
    let user_data_override = std::env::var_os("WIFIMETER_USER_DATA");
    let user_data = if let Some(path) = &user_data_override {
        PathBuf::from(path)
    } else if cfg!(windows) {
        app.path()
            .config_dir()
            .map_err(|error| error.to_string())?
            .join("WiFiMeter Demo")
    } else {
        app.path()
            .config_dir()
            .map_err(|error| error.to_string())?
            .join("WiFiMeter")
    };
    let user_data =
        std::path::absolute(node_compatible_path(&user_data)).map_err(|error| error.to_string())?;
    std::fs::create_dir_all(&user_data).map_err(|error| error.to_string())?;
    #[cfg(windows)]
    {
        let guard = legacy_instance::LegacyInstanceGuard::acquire(&user_data)?;
        *host.legacy_instance.lock().unwrap() = Some(guard);
    }
    *host.user_data.lock().unwrap() = Some(user_data.clone());
    let app_exe =
        node_compatible_path(&std::env::current_exe().map_err(|error| error.to_string())?);
    let packaged = (!cfg!(debug_assertions)).to_string();
    let screen = crate::native::screen_info(app);
    let mut command = Command::new(node_compatible_path(&node_path(&resources)?));
    command
        .arg(&script)
        .arg("--resources-path")
        .arg(&resources)
        .arg("--user-data")
        .arg(&user_data)
        .arg("--app-exe")
        .arg(&app_exe)
        .arg("--app-pid")
        .arg(std::process::id().to_string())
        .arg("--packaged")
        .arg(&packaged)
        .arg("--screen-json")
        .arg(screen.to_string())
        .env("WIFIMETER_RESOURCES_PATH", &resources)
        .env("WIFIMETER_HOST_USER_DATA", &user_data)
        .env("WIFIMETER_APP_EXE", &app_exe)
        .env("WIFIMETER_APP_PID", std::process::id().to_string())
        .env("WIFIMETER_IS_PACKAGED", &packaged)
        .env("WIFIMETER_SCREEN", screen["displays"].to_string())
        .current_dir(resources.join("runtime"))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    if user_data_override.is_some() {
        command.env("WIFIMETER_USER_DATA", &user_data);
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000); // CREATE_NO_WINDOW
    }
    let mut child = command
        .spawn()
        .map_err(|error| format!("无法启动桌面服务：{error}"))?;
    *host.input.lock().unwrap() = child.stdin.take();
    let output = child.stdout.take().ok_or("无法读取桌面服务输出。")?;
    let stderr = child.stderr.take().ok_or("无法读取桌面服务错误。")?;
    let diagnostics = Arc::new(Mutex::new(String::new()));
    let error_log = diagnostics.clone();
    std::thread::spawn(move || {
        for line in BufReader::new(stderr).lines().map_while(Result::ok) {
            eprintln!("[worker] {line}");
            let mut log = error_log.lock().unwrap();
            log.push_str(&line);
            log.push('\n');
            if log.len() > 8192 {
                let mut boundary = log.len() - 8192;
                while !log.is_char_boundary(boundary) {
                    boundary += 1;
                }
                log.drain(..boundary);
            }
        }
    });
    let reader_app = app.clone();
    let reader_host = host.clone();
    std::thread::spawn(move || {
        for line in BufReader::new(output).lines() {
            let message: Value = match line
                .and_then(|line| serde_json::from_str(&line).map_err(std::io::Error::other))
            {
                Ok(message) => message,
                Err(error) => {
                    reader_host.fatal(&reader_app, format!("桌面通信格式错误：{error}"));
                    return;
                }
            };
            match message["type"].as_str() {
                Some("response") => reader_host.response(&message),
                Some("native") => {
                    crate::native::dispatch(&reader_app, reader_host.clone(), message)
                }
                Some("event") => {
                    if let Some(label @ ("main" | "mini")) = message["window"].as_str() {
                        let _ = reader_app.emit_to(
                            label,
                            "desktop:event",
                            json!({
                            "channel": message["channel"], "payload": message["payload"] }),
                        );
                    }
                }
                Some("quit") => {
                    reader_host.quitting.store(true, Ordering::SeqCst);
                    reader_host.input.lock().unwrap().take();
                    reader_app.exit(0);
                }
                Some("fatal") => reader_host.fatal(
                    &reader_app,
                    message["message"]
                        .as_str()
                        .unwrap_or("桌面服务出现异常。")
                        .to_string(),
                ),
                _ => reader_host.fatal(&reader_app, "桌面服务发送了未知消息。".into()),
            }
        }
        let status = child
            .wait()
            .map(|value| value.to_string())
            .unwrap_or_else(|error| error.to_string());
        reader_host.fatal(
            &reader_app,
            format!("退出状态：{status}\n{}", diagnostics.lock().unwrap()),
        );
    });
    let timer_app = app.clone();
    let timer_host = host.clone();
    std::thread::spawn(move || {
        let mut visibility = HashMap::new();
        while !timer_host.quitting.load(Ordering::SeqCst)
            && !timer_host.failed.load(Ordering::SeqCst)
        {
            let _ = timer_host.send(crate::native::screen_info(&timer_app));
            for window in timer_app.webview_windows().values() {
                let current = (
                    window.is_visible().unwrap_or(false),
                    window.is_minimized().unwrap_or(false),
                );
                if visibility.insert(window.label().to_string(), current) != Some(current) {
                    crate::native::window_event(&timer_host, window, "visibility");
                }
            }
            std::thread::sleep(Duration::from_millis(100));
        }
    });
    let startup_app = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_secs(45));
        if startup_app.get_webview_window("main").is_none() {
            host.fatal(&startup_app, "桌面服务未能创建主窗口。".into());
        }
    });
    Ok(())
}

#[cfg(test)]
mod resource_tests {
    use super::sibling_resources_path;
    use std::{
        fs,
        path::PathBuf,
        time::{SystemTime, UNIX_EPOCH},
    };

    struct TestDirectory(PathBuf);

    impl TestDirectory {
        fn new() -> Self {
            let directory = std::env::temp_dir().join(format!(
                "wifimeter-tauri-resources-{}-{}",
                std::process::id(),
                SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .unwrap()
                    .as_nanos()
            ));
            fs::create_dir(&directory).unwrap();
            Self(directory)
        }
    }

    impl Drop for TestDirectory {
        fn drop(&mut self) {
            assert_eq!(self.0.parent(), Some(std::env::temp_dir().as_path()));
            assert!(self
                .0
                .file_name()
                .unwrap()
                .to_string_lossy()
                .starts_with("wifimeter-tauri-resources-"));
            fs::remove_dir_all(&self.0).unwrap();
        }
    }

    #[test]
    fn portable_executable_finds_its_sibling_worker_resources() {
        let directory = TestDirectory::new();
        let resources = directory.0.join("resources");
        fs::create_dir_all(resources.join("runtime")).unwrap();
        fs::write(resources.join("runtime/host.cjs"), "// worker").unwrap();
        assert_eq!(
            sibling_resources_path(&directory.0.join("wifimeter")),
            Some(resources)
        );
    }

    #[test]
    fn missing_worker_leaves_platform_resource_fallback_available() {
        let directory = TestDirectory::new();
        let executable = directory.0.join("wifimeter");
        assert_eq!(sibling_resources_path(&executable), None);
        fs::create_dir_all(directory.0.join("resources/runtime/host.cjs")).unwrap();
        assert_eq!(sibling_resources_path(&executable), None);
    }
}

#[cfg(all(test, windows))]
mod windows_path_tests {
    use super::node_compatible_path;
    use std::path::Path;

    #[test]
    fn verbatim_drive_paths_remain_absolute_after_conversion() {
        for (input, expected) in [
            (
                r"\\?\C:\Program Files\WiFiMeter\resources",
                r"C:\Program Files\WiFiMeter\resources",
            ),
            (r"\\?\D:\用户\WiFiMeter Demo", r"D:\用户\WiFiMeter Demo"),
            (r"\\?\C:\", r"C:\"),
        ] {
            let converted = node_compatible_path(Path::new(input));
            assert_eq!(converted.as_os_str(), Path::new(expected).as_os_str());
            assert!(converted.is_absolute());
        }
    }

    #[test]
    fn verbatim_unc_paths_keep_the_server_and_share() {
        for (input, expected) in [
            (
                r"\\?\UNC\server\share\WiFiMeter\resources",
                r"\\server\share\WiFiMeter\resources",
            ),
            (r"\\?\UNC\服务器\共享\WiFiMeter", r"\\服务器\共享\WiFiMeter"),
            (r"\\?\UNC\server\share\", r"\\server\share\"),
        ] {
            let converted = node_compatible_path(Path::new(input));
            assert_eq!(converted.as_os_str(), Path::new(expected).as_os_str());
            assert!(converted.is_absolute());
        }
    }

    #[test]
    fn ordinary_paths_and_development_node_lookup_keep_their_meaning() {
        for input in [
            r"C:\WiFiMeter\resources",
            r"\\server\share\WiFiMeter",
            r"C:\",
            r"resources\runtime\host.cjs",
            r".\node.exe",
            "node.exe",
            "node",
        ] {
            assert_eq!(
                node_compatible_path(Path::new(input)).as_os_str(),
                Path::new(input).as_os_str()
            );
        }
    }
}
