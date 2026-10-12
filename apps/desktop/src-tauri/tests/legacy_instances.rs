#![cfg(windows)]

#[path = "../src/legacy_instance.rs"]
mod legacy_instance;

use legacy_instance::LegacyInstanceGuard;
use std::{
    fs,
    io::ErrorKind,
    os::windows::process::CommandExt,
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::atomic::{AtomicU64, Ordering},
    thread,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

static NEXT_PROFILE_ID: AtomicU64 = AtomicU64::new(1);

struct Profile(PathBuf);

impl Profile {
    fn new() -> Self {
        let path = std::env::temp_dir().join(format!(
            "wifimeter-instance-test-{}-{}-{} 用户目录",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos(),
            NEXT_PROFILE_ID.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir(&path).unwrap();
        Self(path)
    }
}

impl Drop for Profile {
    fn drop(&mut self) {
        assert_eq!(self.0.parent(), Some(std::env::temp_dir().as_path()));
        assert!(self
            .0
            .file_name()
            .unwrap()
            .to_string_lossy()
            .starts_with("wifimeter-instance-test-"));
        let archive = std::env::temp_dir().join("wifimeter-instance-archive");
        fs::create_dir_all(&archive).unwrap();
        fs::rename(&self.0, archive.join(self.0.file_name().unwrap())).unwrap();
    }
}

struct LockHolder {
    child: Child,
    control: Profile,
    next_probe: u64,
}

impl LockHolder {
    fn launch(profile: &Path) -> (Self, String) {
        let manifest = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
        let executable =
            PathBuf::from(std::env::var_os("SystemRoot").expect("Windows system directory"))
                .join("System32/WindowsPowerShell/v1.0/powershell.exe");
        let fixture = manifest.join("tests/fixtures/profile-lock.ps1");
        assert!(
            fixture.is_file(),
            "缺少独立锁文件测试夹具 {}",
            fixture.display()
        );
        // 每次启动使用独立控制目录，带序号的请求不会复用旧响应。
        let control = Profile::new();
        let stdout = fs::File::create(control.0.join("stdout.log"))
            .expect("create the isolated lock-holder stdout log");
        let stderr = fs::File::create(control.0.join("stderr.log"))
            .expect("create the isolated lock-holder stderr log");
        let child = Command::new(executable)
            .args([
                "-NoLogo",
                "-NoProfile",
                "-NonInteractive",
                "-ExecutionPolicy",
                "Bypass",
                "-File",
            ])
            .arg(fixture)
            .arg(profile)
            .arg(&control.0)
            .stdin(Stdio::null())
            .stdout(Stdio::from(stdout))
            .stderr(Stdio::from(stderr))
            .creation_flags(0x08000000)
            .spawn()
            .expect("launch the isolated lock-holder fixture");
        let mut instance = Self {
            child,
            control,
            next_probe: 1,
        };
        let state = instance.receive("等待单实例状态", "state");
        match state.as_str() {
            "READY" => instance.verify_running("收到 READY 后"),
            "DENIED" => {}
            _ => instance.infrastructure_error("等待单实例状态", format!("意外状态 {state:?}")),
        }
        (instance, state)
    }

    fn log_tail(&self, name: &str) -> String {
        match fs::read(self.control.0.join(name)) {
            Ok(bytes) => {
                String::from_utf8_lossy(&bytes[bytes.len().saturating_sub(8192)..]).into_owned()
            }
            Err(error) => format!("无法读取 {name}：{error:?}"),
        }
    }

    fn infrastructure_error(&mut self, phase: &str, details: String) -> ! {
        let status = self.child.try_wait();
        panic!(
            "锁文件测试基础设施错误：{phase}，{details}，PID {}，状态 {status:?}\n控制目录：{}\nstdout：\n{}\nstderr：\n{}",
            self.child.id(),
            self.control.0.display(),
            self.log_tail("stdout.log"),
            self.log_tail("stderr.log")
        );
    }

    fn receive(&mut self, phase: &str, name: &str) -> String {
        let path = self.control.0.join(name);
        let deadline = Instant::now() + Duration::from_secs(20);
        loop {
            match fs::read_to_string(&path) {
                Ok(message) => {
                    let mut fields = message.split_whitespace();
                    let state = fields.next().unwrap_or_default();
                    let pid = fields.next().and_then(|value| value.parse::<u32>().ok());
                    if pid != Some(self.child.id()) || fields.next().is_some() {
                        self.infrastructure_error(
                            phase,
                            format!("响应格式或 PID 错误：{message:?}"),
                        );
                    }
                    return state.to_string();
                }
                Err(error) if error.kind() == ErrorKind::NotFound => {}
                Err(error) => self.infrastructure_error(
                    phase,
                    format!("读取 {} 失败：{error:?}", path.display()),
                ),
            }
            self.assert_alive(phase);
            if Instant::now() >= deadline {
                self.infrastructure_error(phase, format!("等待 {} 超时", path.display()));
            }
            thread::sleep(Duration::from_millis(25));
        }
    }

    fn assert_alive(&mut self, phase: &str) {
        match self.child.try_wait() {
            Ok(None) => {}
            Ok(Some(status)) => {
                self.infrastructure_error(phase, format!("进程已退出，退出状态 {status}"))
            }
            Err(error) => self.infrastructure_error(phase, format!("无法检查进程状态：{error:?}")),
        }
    }

    fn verify_running(&mut self, phase: &str) {
        self.assert_alive(phase);
        let probe = self.next_probe;
        self.next_probe += 1;
        let request = self.control.0.join(format!("ping-{probe}"));
        if let Err(error) = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&request)
        {
            self.infrastructure_error(phase, format!("创建 {} 失败：{error:?}", request.display()));
        }
        let response = self.receive(phase, &format!("pong-{probe}"));
        self.assert_alive(phase);
        if response != "ALIVE" {
            self.infrastructure_error(phase, format!("意外的探测响应 {response:?}"));
        }
    }
}

impl Drop for LockHolder {
    fn drop(&mut self) {
        let _ = fs::write(self.control.0.join("exit"), b"");
        let deadline = Instant::now() + Duration::from_secs(10);
        while self.child.try_wait().ok().flatten().is_none() && Instant::now() < deadline {
            thread::sleep(Duration::from_millis(25));
        }
        if self.child.try_wait().ok().flatten().is_none() {
            let _ = self.child.kill();
        }
        let _ = self.child.wait();
    }
}

#[test]
fn refuses_a_profile_held_by_lock_holder_before_any_database_access() {
    let profile = Profile::new();
    let database = profile.0.join("wifimeter.db");
    fs::write(&database, b"existing data must stay untouched").unwrap();
    let (mut lock_holder, state) = LockHolder::launch(&profile.0);
    assert_eq!(state, "READY");
    let acquired = LegacyInstanceGuard::acquire(&profile.0);
    lock_holder.verify_running("同目录互斥检查后");
    assert!(
        acquired.is_err(),
        "Tauri must refuse an active profile lock"
    );
    assert_eq!(
        fs::read(&database).unwrap(),
        b"existing data must stay untouched"
    );
    drop(lock_holder);
    assert!(
        LegacyInstanceGuard::acquire(&profile.0).is_ok(),
        "a clean lock-holder exit releases the profile"
    );
}

#[test]
fn unrelated_lock_holder_profile_does_not_prevent_startup() {
    let first = Profile::new();
    let second = Profile::new();
    let (mut lock_holder, state) = LockHolder::launch(&first.0);
    assert_eq!(state, "READY");
    let acquired = LegacyInstanceGuard::acquire(&second.0);
    lock_holder.verify_running("不同目录互斥检查后");
    assert!(acquired.is_ok());
}

#[test]
fn a_lock_holder_launch_cannot_open_a_profile_held_by_tauri() {
    let profile = Profile::new();
    let guard = LegacyInstanceGuard::acquire(&profile.0).expect("unused profile is available");
    let (lock_holder, state) = LockHolder::launch(&profile.0);
    assert_eq!(
        state, "DENIED",
        "an independent process must respect an active Tauri profile"
    );
    drop(lock_holder);
    drop(guard);
    let (_lock_holder, state) = LockHolder::launch(&profile.0);
    assert_eq!(
        state, "READY",
        "Tauri cleanup releases the profile for a later launch"
    );
}
