use crate::{
    backend::{Backend, BackendError},
    legacy,
};
use serde_json::{json, Value};
use std::{
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex, OnceLock, RwLock,
    },
    time::Duration,
};

type Result<T> = std::result::Result<T, BackendError>;

pub trait CollectorBackend: Send + Sync {
    fn request(&self, method: &str, params: Value, timeout: Duration) -> Result<Value>;
    fn stop(&self, timeout: Duration) -> Result<()>;
}

impl CollectorBackend for Backend {
    fn request(&self, method: &str, params: Value, timeout: Duration) -> Result<Value> {
        self.request(method, params, timeout)
    }
    fn stop(&self, timeout: Duration) -> Result<()> {
        self.stop_gracefully(timeout)
    }
}

pub struct Collector {
    backend: Arc<dyn CollectorBackend>,
    profile: PathBuf,
    legacy_directory: Option<PathBuf>,
    first_database_use: bool,
    started: OnceLock<()>,
    migration: Mutex<Value>,
    migration_busy: AtomicBool,
    stopping: AtomicBool,
    // 等待已经发出的修改完成，再暂停、导入或关闭。只读请求无需等待目录选择框。
    mutation: Mutex<()>,
    in_flight: RwLock<()>,
}

struct BusyGuard<'a>(&'a AtomicBool);
impl Drop for BusyGuard<'_> {
    fn drop(&mut self) {
        self.0.store(false, Ordering::SeqCst);
    }
}

impl Collector {
    pub fn new(
        backend: Arc<dyn CollectorBackend>,
        profile: PathBuf,
        legacy_directory: Option<PathBuf>,
    ) -> Self {
        let first_database_use = !profile.join("wifimeter.db").exists();
        Self {
            backend,
            profile,
            legacy_directory,
            first_database_use,
            started: OnceLock::new(),
            migration: Mutex::new(json!({"found":false})),
            migration_busy: AtomicBool::new(false),
            stopping: AtomicBool::new(false),
            mutation: Mutex::new(()),
            in_flight: RwLock::new(()),
        }
    }

    fn raw_request(&self, method: &str, params: Value) -> Result<Value> {
        let timeout =
            Duration::from_secs(if matches!(method, "backup" | "restore" | "importLegacy") {
                300
            } else {
                15
            });
        self.backend.request(method, params, timeout)
    }

    pub fn start(&self) {
        self.started.get_or_init(|| {
            let result = legacy::import_directory(
                self.legacy_directory.as_deref(),
                &self.profile,
                self.first_database_use,
                "reject",
                &mut |method, params| self.raw_request(method, params),
            )
            .and_then(|result| {
                self.raw_request("setPaused", json!({"paused":false}))?;
                Ok(result)
            });
            let status = match result {
                Ok(result) => result,
                Err(error) if !self.first_database_use && error.code == "LegacyOverlap" => {
                    match self.raw_request("setPaused", json!({"paused":false})) {
                        Ok(_) => {
                            json!({"found":true,"imported":false,"importWarning":error.message})
                        }
                        Err(error) => json!({"found":true,"error":error.message}),
                    }
                }
                Err(error) => json!({"found":true,"error":error.message}),
            };
            *self.migration.lock().unwrap() = status;
        });
    }

    pub fn migration_status(&self) -> Value {
        self.start();
        self.migration.lock().unwrap().clone()
    }

    pub fn add_migration_warning(&self, warning: &str) {
        let mut status = self.migration.lock().unwrap();
        if !status["warnings"].is_array() {
            status["warnings"] = json!([]);
        }
        status["warnings"]
            .as_array_mut()
            .unwrap()
            .push(json!(warning));
    }

    fn available(&self, read_only: bool) -> Result<()> {
        if self.stopping.load(Ordering::SeqCst) {
            return Err(BackendError::new(
                "unavailable",
                "The application is stopping. / 应用正在退出。",
            ));
        }
        if !read_only && self.migration_busy.load(Ordering::SeqCst) {
            return Err(BackendError::new("unavailable", "Migration is running; changes are temporarily unavailable. / 正在迁移，暂时不能修改数据或恢复采集。"));
        }
        Ok(())
    }

    pub fn request(
        &self,
        method: &str,
        params: Value,
        confirm_resume: impl FnOnce() -> bool,
    ) -> Result<Value> {
        self.start();
        if method == "shutdown" {
            return Err(BackendError::new(
                "badRequest",
                "请通过桌面退出操作关闭采集器。",
            ));
        }
        let read_only = matches!(
            method,
            "hello" | "snapshot" | "exportUsage" | "backup" | "migrationStatus"
        );
        self.available(read_only)?;
        let _request = self.in_flight.read().unwrap();
        let _mutation = if read_only {
            None
        } else {
            Some(self.mutation.lock().unwrap())
        };
        self.available(read_only)?;
        let import_error = self.migration.lock().unwrap()["error"]
            .as_str()
            .unwrap_or("")
            .to_string();
        let resume_after_error =
            !import_error.is_empty() && method == "setPaused" && params["paused"] == false;
        if resume_after_error && !confirm_resume() {
            return Err(BackendError::new("unavailable", &import_error));
        }
        let result = self.raw_request(method, params)?;
        // 恢复请求失败时保留错误，下次不能绕过确认。
        if resume_after_error {
            let mut status = self.migration.lock().unwrap();
            status["error"] = json!("");
            status["importWarning"] = json!(import_error);
        }
        Ok(result)
    }

    pub fn import_selected(
        &self,
        choose: impl FnOnce() -> Result<Option<PathBuf>>,
        confirm_overlap: impl FnOnce() -> bool,
    ) -> Value {
        self.start();
        if let Err(error) = self.available(false) {
            return json!({"error":error.message});
        }
        let _request = self.in_flight.read().unwrap();
        if self.migration_busy.swap(true, Ordering::SeqCst) {
            return json!({"error":"An import is already running."});
        }
        let _busy = BusyGuard(&self.migration_busy);
        let _mutation = self.mutation.lock().unwrap();
        let result = (|| -> Result<Value> {
            self.available(true)?;
            let Some(directory) = choose()? else {
                return Ok(json!({"canceled":true}));
            };
            let previous_paused = self.raw_request("hello", json!({}))?["paused"] != false;
            self.raw_request("setPaused", json!({"paused":true}))?;
            let import = |policy| {
                legacy::import_directory(
                    Some(&directory),
                    &self.profile,
                    false,
                    policy,
                    &mut |method, params| self.raw_request(method, params),
                )
            };
            let result = match import("reject") {
                Err(error) if error.code == "LegacyOverlap" && confirm_overlap() => {
                    import("keep-existing")?
                }
                result => result?,
            };
            if result["found"] != true {
                return Err(BackendError::new(
                    "LegacyMissing",
                    "No state.json or state.json.bak was found in the selected directory.",
                ));
            }
            self.raw_request("setPaused", json!({"paused":previous_paused}))?;
            Ok(result)
        })();
        let result = match result {
            Ok(result) if result["canceled"] == true => return result,
            Ok(result) => result,
            Err(error) => {
                if let Err(pause_error) = self.raw_request("setPaused", json!({"paused":true})) {
                    eprintln!("[migration] Pause failed: {pause_error}");
                }
                json!({"found":true,"error":error.message})
            }
        };
        *self.migration.lock().unwrap() = result.clone();
        result
    }

    pub fn stop_gracefully(&self, timeout: Duration) -> Result<()> {
        self.start();
        self.stopping.store(true, Ordering::SeqCst);
        // 包括已开始的只读请求，防止关闭后被延迟的请求重新拉起子进程。
        let _requests = self.in_flight.write().unwrap();
        self.backend.stop(timeout)
    }
}
