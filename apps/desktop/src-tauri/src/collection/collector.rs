use crate::{
    backend::{Backend, BackendError},
    legacy,
};
use serde_json::{json, Value};
use std::{
    path::{Path, PathBuf},
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
    /// 当前数据库文件位置。
    fn database(&self) -> PathBuf;
    /// 采集进程是否仍在运行。
    fn running(&self) -> bool;
    /// 在采集进程停止后切换数据库位置。
    fn set_database(&self, path: PathBuf) -> Result<()>;
}

impl CollectorBackend for Backend {
    fn request(&self, method: &str, params: Value, timeout: Duration) -> Result<Value> {
        self.request(method, params, timeout)
    }
    fn stop(&self, timeout: Duration) -> Result<()> {
        self.stop_gracefully(timeout)
    }
    fn database(&self) -> PathBuf {
        self.database()
    }
    fn running(&self) -> bool {
        self.running()
    }
    fn set_database(&self, path: PathBuf) -> Result<()> {
        self.set_database(path)
    }
}

pub struct Collector {
    backend: Arc<dyn CollectorBackend>,
    profile: PathBuf,
    legacy_directory: Option<PathBuf>,
    started: OnceLock<()>,
    migration: Mutex<Value>,
    migration_busy: AtomicBool,
    relocating: AtomicBool,
    stopping: AtomicBool,
    updating: AtomicBool,
    update_recovery: Mutex<Option<UpdateRecovery>>,
    // 等待已经发出的修改完成，再暂停、导入或关闭。只读请求无需等待目录选择框。
    mutation: Mutex<()>,
    in_flight: RwLock<()>,
}

struct UpdateRecovery {
    paused: bool,
    apps_enabled: bool,
    shutdown_requested: bool,
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
        Self {
            backend,
            profile,
            legacy_directory,
            started: OnceLock::new(),
            migration: Mutex::new(json!({"found":false})),
            migration_busy: AtomicBool::new(false),
            relocating: AtomicBool::new(false),
            stopping: AtomicBool::new(false),
            updating: AtomicBool::new(false),
            update_recovery: Mutex::new(None),
            mutation: Mutex::new(()),
            in_flight: RwLock::new(()),
        }
    }

    /// 当前数据库文件位置；自定义位置切换后立即反映。
    pub fn database(&self) -> PathBuf {
        self.backend.database()
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
            // 数据位置可能已被切换，按实际数据库判断是否已有历史可保留。
            let first_database_use = !self.backend.database().exists();
            let result = legacy::import_directory(
                self.legacy_directory.as_deref(),
                &self.profile,
                first_database_use,
                "reject",
                &mut |method, params| self.raw_request(method, params),
            )
            .and_then(|result| {
                self.raw_request("setPaused", json!({"paused":false}))?;
                Ok(result)
            });
            let status = match result {
                Ok(result) => result,
                Err(error) if !first_database_use && error.code == "LegacyOverlap" => {
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
        if !read_only && self.relocating.load(Ordering::SeqCst) {
            return Err(BackendError::new("unavailable", "The data location is changing; changes are temporarily unavailable. / 正在切换数据位置，暂时不能修改数据或恢复采集。"));
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
        // 等待期间可能已经进入退出/更新；此时未开始导入，不应记录导入失败或修改采集状态。
        if let Err(error) = self.available(true) {
            return json!({"error":error.message});
        }
        let result = (|| -> Result<Value> {
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

    /// 切换数据库位置：暂停采集、停止后端，在写锁内准备文件，再按原状态恢复采集。
    /// `prepare` 在后端已停止且没有任何请求能拉起进程时执行，用于复制数据库并写入指针。
    /// 文件操作回滚后原数据库始终可用，因此失败时连采集状态一起退回切换前，不留下半成品状态。
    pub fn relocate_database(
        &self,
        target: PathBuf,
        prepare: impl FnOnce(&Path) -> std::result::Result<(), BackendError>,
        timeout: Duration,
    ) -> Result<()> {
        self.available(false)?;
        if self.update_pending() {
            return Err(BackendError::new(
                "unavailable",
                "更新尚未完成，请先完成更新或恢复采集。",
            ));
        }
        // 包括已开始的只读请求：切换期间不能让任何请求把进程按旧路径重新拉起。
        let _requests = self.in_flight.write().unwrap();
        if self.relocating.swap(true, Ordering::SeqCst) {
            return Err(BackendError::new("unavailable", "正在切换数据位置。"));
        }
        let _busy = BusyGuard(&self.relocating);
        let _mutation = self.mutation.lock().unwrap();
        self.available(true)?;
        let source = self.backend.database();
        let original = if self.backend.running() {
            let hello = self.raw_request("hello", json!({}))?;
            let paused = hello["paused"].as_bool().ok_or_else(|| {
                BackendError::new("unavailable", "无法确认原采集状态，切换取消。")
            })?;
            let apps = hello["appCollection"]["enabled"] == true;
            self.raw_request("setPaused", json!({"paused":true}))?;
            self.backend.stop(timeout)?;
            Some((paused, apps))
        } else {
            None
        };
        // 先换路径：此时进程已退出，写锁排除了重新拉起，prepare 失败可以原样退回。
        if let Err(error) = self.backend.set_database(target) {
            self.restore_relocation(&source, original);
            return Err(error);
        }
        if let Err(error) = prepare(&source) {
            self.restore_relocation(&source, original);
            return Err(error);
        }
        if let Some((paused, apps)) = original {
            if apps {
                if let Err(error) = self.raw_request("setAppCollection", json!({"enabled":true})) {
                    eprintln!("[data-location] 恢复应用采集失败：{error}");
                }
            }
            self.raw_request("setPaused", json!({"paused":paused}))?;
        }
        Ok(())
    }

    /// 准备失败时退回原数据库位置，并恢复切换前的采集状态。
    fn restore_relocation(&self, source: &Path, original: Option<(bool, bool)>) {
        if let Err(error) = self.backend.set_database(source.to_path_buf()) {
            eprintln!("[data-location] 恢复原数据库路径失败：{error}");
        }
        if let Some((paused, _)) = original {
            if let Err(error) = self.raw_request("setPaused", json!({"paused":paused})) {
                eprintln!("[data-location] 恢复采集失败：{error}");
            }
        }
    }

    /// 本次运行临时改用默认位置（自定义位置不可用时的回落），不改指针文件。
    pub fn use_temporary_database(&self, target: PathBuf) -> Result<()> {
        self.available(false)?;
        if self.update_pending() {
            return Err(BackendError::new(
                "unavailable",
                "更新尚未完成，请先完成更新或恢复采集。",
            ));
        }
        let _requests = self.in_flight.write().unwrap();
        let _mutation = self.mutation.lock().unwrap();
        if self.backend.running() {
            return Err(BackendError::new(
                "badRequest",
                "采集器已启动，不能只切换本次运行的数据位置。",
            ));
        }
        self.backend.set_database(target)
    }

    pub fn stop_gracefully(&self, timeout: Duration) -> Result<()> {
        self.start();
        let _update = self.update_recovery.lock().unwrap();
        if self.update_pending() {
            return Err(BackendError::new(
                "unavailable",
                "更新尚未完成，请先完成更新或恢复采集。",
            ));
        }
        self.stopping.store(true, Ordering::SeqCst);
        drop(_update);
        // 包括已开始的只读请求，防止关闭后被延迟的请求重新拉起子进程。
        let _requests = self.in_flight.write().unwrap();
        self.backend.stop(timeout)
    }

    pub fn update_pending(&self) -> bool {
        self.updating.load(Ordering::SeqCst)
    }

    pub fn prepare_update(&self, timeout: Duration) -> Result<()> {
        self.start();
        let mut recovery = self.update_recovery.lock().unwrap();
        self.available(false)?;
        if self.migration.lock().unwrap()["error"]
            .as_str()
            .is_some_and(|error| !error.is_empty())
        {
            return Err(BackendError::new(
                "unavailable",
                "请先处理旧数据导入问题，再安装更新。",
            ));
        }
        self.updating.store(true, Ordering::SeqCst);
        self.stopping.store(true, Ordering::SeqCst);
        // 排空此前已发出的读写，后续 UI 请求不能在关闭后重新拉起采集进程。
        let _requests = self.in_flight.write().unwrap();
        if self.migration.lock().unwrap()["error"]
            .as_str()
            .is_some_and(|error| !error.is_empty())
        {
            self.updating.store(false, Ordering::SeqCst);
            self.stopping.store(false, Ordering::SeqCst);
            return Err(BackendError::new(
                "unavailable",
                "请先处理旧数据导入问题，再安装更新。",
            ));
        }
        let original = self.raw_request("hello", json!({})).and_then(|value| {
            let paused = value["paused"].as_bool().ok_or_else(|| {
                BackendError::new("unavailable", "无法确认原采集状态，更新取消。")
            })?;
            Ok(UpdateRecovery {
                paused,
                apps_enabled: value["appCollection"]["enabled"] == true,
                shutdown_requested: false,
            })
        });
        let original = match original {
            Ok(original) => original,
            Err(error) => {
                self.updating.store(false, Ordering::SeqCst);
                self.stopping.store(false, Ordering::SeqCst);
                return Err(error);
            }
        };
        // 暂停响应也可能超时但已在后端生效，因此先保存恢复信息，再发请求。
        *recovery = Some(original);
        self.raw_request("setPaused", json!({"paused":true}))?;
        recovery.as_mut().unwrap().shutdown_requested = true;
        self.backend.stop(timeout)
    }

    pub fn recover_update(&self, timeout: Duration) -> Result<()> {
        let mut recovery = self.update_recovery.lock().unwrap();
        let Some(original) = recovery.as_ref() else {
            return Ok(());
        };
        let _requests = self.in_flight.write().unwrap();
        if original.shutdown_requested {
            // stop 对已请求关闭的进程只等待实际退出，不强杀、不启动第二个进程。
            self.backend.stop(timeout)?;
        }
        if original.apps_enabled {
            self.raw_request("setAppCollection", json!({"enabled":true}))?;
        }
        self.raw_request("setPaused", json!({"paused":original.paused}))?;
        *recovery = None;
        self.updating.store(false, Ordering::SeqCst);
        self.stopping.store(false, Ordering::SeqCst);
        Ok(())
    }
}
