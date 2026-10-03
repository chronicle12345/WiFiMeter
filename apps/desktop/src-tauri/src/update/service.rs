use crate::{
    update_download::{download, fetch_release, Progress, Transport},
    updates::{select_release, Asset, Preferences, UpdateError, Version, REPOSITORY},
};
use serde_json::{json, Value};
use std::{
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    time::{SystemTime, UNIX_EPOCH},
};

#[derive(Clone, Copy)]
enum Failure {
    Preferences,
    Check,
    Install {
        phase: &'static str,
        error: UpdateError,
    },
    Recovery,
}

#[derive(Clone)]
pub struct Snapshot {
    state: &'static str,
    current_version: String,
    latest_version: Option<String>,
    notes: String,
    url: String,
    can_install: bool,
    check_on_startup: bool,
    manual: bool,
    progress: Option<Progress>,
    busy: bool,
    recovery_required: bool,
    error: Option<Failure>,
    skipped: Option<&'static str>,
}

impl Snapshot {
    pub fn value(&self, english: bool) -> Value {
        let mut value = json!({"state":self.state,"status":self.state,
            "currentVersion":self.current_version,"latestVersion":self.latest_version,
            "notes":self.notes,"url":self.url,"canInstall":self.can_install,
            "checkOnStartup":self.check_on_startup,"manual":self.manual,
            "progress":self.progress,"busy":self.busy,"recoveryRequired":self.recovery_required,"error":null});
        if let Some(error) = self.error {
            let message = match (error, english) {
                (Failure::Preferences, false) => "无法读写更新偏好设置，请修复更新偏好文件后重试。",
                (Failure::Preferences, true) => "Cannot read or save update preferences. Repair the update preferences file and try again.",
                (Failure::Check, false) => "检查更新失败，请检查网络连接后重试。",
                (Failure::Check, true) => "Could not check for updates. Check your connection and try again.",
                (Failure::Install { phase, error }, _) => {
                    let (reason, code) = installation_reason(error, phase, english);
                    let label = match (phase, english) {
                        ("downloading", false) => "下载更新失败",
                        ("downloading", true) => "Update download failed",
                        ("verifying", false) => "更新文件 SHA-256 校验失败",
                        ("verifying", true) => "Update SHA-256 verification failed",
                        ("preparing", false) => "准备安装更新失败",
                        ("preparing", true) => "Update preparation failed",
                        ("installing", false) => "启动更新辅助程序失败",
                        ("installing", true) => "Could not start the update helper",
                        (_, false) => "安装更新失败",
                        (_, true) => "Update installation failed",
                    };
                    value["errorPhase"] = json!(phase);
                    value["errorCode"] = json!(code);
                    value["error"] = json!(format!("{label}{}{reason}{}",
                        if english { ": " } else { "：" },
                        code.map_or(String::new(), |code| format!(" ({code})"))));
                    return value;
                }
                (Failure::Recovery, false) => "更新已取消，但未能恢复采集。数据操作保持暂停，请稍后点击“恢复采集”重试。",
                (Failure::Recovery, true) => "The update was cancelled, but collection could not be restored. Data operations remain paused. Select Resume collection to retry.",
            };
            value["error"] = json!(message);
        }
        if let Some(skipped) = self.skipped {
            value["skipped"] = json!(skipped);
        }
        value
    }
}

fn installation_reason(
    error: UpdateError,
    phase: &str,
    english: bool,
) -> (&'static str, Option<&'static str>) {
    let (zh, en, code) = match error {
        UpdateError::DigestMismatch => (
            "文件内容与官方 SHA-256 不一致，请重新下载。",
            "The file does not match the official SHA-256. Download it again.",
            Some("DIGEST_MISMATCH"),
        ),
        UpdateError::HandoffStart => (
            "无法启动 Windows PowerShell 更新辅助进程。",
            "Could not start the Windows PowerShell update helper.",
            Some("HANDOFF_START_FAILED"),
        ),
        UpdateError::HandoffClosed => (
            "辅助进程在确认就绪前关闭了通信。",
            "The update helper closed communication before it was ready.",
            Some("HANDOFF_CLOSED_BEFORE_READY"),
        ),
        UpdateError::HandoffInvalid => (
            "辅助进程返回了无效的就绪信息。",
            "The update helper returned an invalid ready response.",
            Some("HANDOFF_INVALID_RESPONSE"),
        ),
        UpdateError::HandoffTimeout => (
            "等待辅助进程确认就绪超时。",
            "Timed out waiting for the update helper to become ready.",
            Some("HANDOFF_READY_TIMEOUT"),
        ),
        UpdateError::HandoffWrite => (
            "无法向更新辅助进程发送安装确认。",
            "Could not send installation authorization to the update helper.",
            Some("HANDOFF_WRITE_FAILED"),
        ),
        _ if phase == "preparing" => (
            "无法完成采集停止或数据保存，请重试。",
            "Could not finish stopping collection or saving data. Try again.",
            None,
        ),
        _ if phase == "installing" => (
            "无法验证本地安装包或启动安装程序，请重试。",
            "Could not verify the local installer or start installation. Try again.",
            None,
        ),
        _ => (
            "网络请求、文件写入或下载流未完成，请重试。",
            "The network request, file write or download stream did not complete. Try again.",
            None,
        ),
    };
    (if english { en } else { zh }, code)
}

pub trait InstallHost {
    fn confirm(&self, snapshot: &Snapshot) -> Result<bool, UpdateError>;
    fn open_link(&self, url: &str) -> Result<(), UpdateError>;
    fn prepare(&self) -> Result<(), UpdateError>;
    // 只接受已经验证的本地文件；返回表示辅助进程接受交接，退出应用由调用方随后完成。
    fn launch(&self, path: &Path, digest: &str) -> Result<(), UpdateError>;
    // 尚未进入准备阶段时为空操作；失败必须保留恢复所需的原始采集状态。
    fn recover(&self) -> Result<(), UpdateError>;
}

struct State {
    snapshot: Snapshot,
    asset: Option<Asset>,
}
type Observer = dyn Fn(&Snapshot) -> Result<(), String> + Send + Sync;

pub struct UpdateService {
    current: Version,
    platform: String,
    arch: String,
    directory: PathBuf,
    preferences: Preferences,
    transport: Arc<dyn Transport>,
    observer: Arc<Observer>,
    state: Mutex<State>,
    operation: Mutex<()>,
}

impl UpdateService {
    pub fn new(
        current: &str,
        platform: &str,
        arch: &str,
        profile: PathBuf,
        transport: Arc<dyn Transport>,
        observer: Arc<Observer>,
    ) -> Result<Self, UpdateError> {
        Ok(Self {
            current: Version::parse(current)?,
            platform: platform.into(),
            arch: arch.into(),
            directory: profile.join("updates"),
            preferences: Preferences::new(profile),
            transport,
            observer,
            state: Mutex::new(State {
                asset: None,
                snapshot: Snapshot {
                    state: "unchecked",
                    current_version: current.into(),
                    latest_version: None,
                    notes: String::new(),
                    url: format!("{REPOSITORY}/releases/latest"),
                    can_install: false,
                    check_on_startup: true,
                    manual: false,
                    progress: None,
                    busy: false,
                    recovery_required: false,
                    error: None,
                    skipped: None,
                },
            }),
            operation: Mutex::new(()),
        })
    }

    pub fn snapshot(&self) -> Snapshot {
        let mut snapshot = self.state.lock().unwrap().snapshot.clone();
        snapshot.check_on_startup = self.preferences.enabled();
        snapshot.busy = self.operation.try_lock().is_err() || snapshot.state == "installing";
        snapshot
    }

    fn publish(&self) -> Snapshot {
        let snapshot = self.snapshot();
        // 已关闭的页面或事件发送错误不能中断下载、校验或安装交接。
        let _ = (self.observer)(&snapshot);
        snapshot
    }

    fn busy(&self) -> Snapshot {
        let mut snapshot = self.snapshot();
        snapshot.state = "busy";
        snapshot.busy = true;
        snapshot
    }

    fn terminal(&self, name: &'static str, error: Option<Failure>) {
        let mut state = self.state.lock().unwrap();
        state.snapshot.state = name;
        state.snapshot.error = error;
        state.snapshot.progress = None;
        state.snapshot.skipped = None;
    }

    fn progress(&self, progress: Progress) {
        {
            let mut state = self.state.lock().unwrap();
            state.snapshot.state = progress.phase;
            state.snapshot.progress = Some(progress);
            state.snapshot.error = None;
            state.snapshot.skipped = None;
        }
        self.publish();
    }

    fn phase(&self, phase: &'static str) {
        let previous = self.state.lock().unwrap().snapshot.progress.clone();
        self.progress(Progress {
            phase,
            received_bytes: previous.as_ref().map_or(0, |p| p.received_bytes),
            total_bytes: previous.and_then(|p| p.total_bytes),
            percent: None,
        });
    }

    pub fn status(&self) -> Snapshot {
        let Ok(guard) = self.operation.try_lock() else {
            return self.snapshot();
        };
        if self.snapshot().state == "installing" {
            drop(guard);
            return self.snapshot();
        }
        if self.preferences.read().is_err() {
            self.terminal("error", Some(Failure::Preferences));
        }
        drop(guard);
        self.snapshot()
    }

    pub fn set_enabled(&self, enabled: bool) -> Snapshot {
        let Ok(guard) = self.operation.try_lock() else {
            return self.busy();
        };
        if self.snapshot().state == "installing" {
            return self.busy();
        }
        if self.preferences.set_enabled(enabled).is_err() {
            self.terminal("error", Some(Failure::Preferences));
        }
        drop(guard);
        self.publish()
    }

    fn check_now(&self, automatic: bool) {
        let check = || -> Result<(), UpdateError> {
            let now = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default()
                .as_secs_f64()
                * 1000.0;
            if let Some(skipped) = self.preferences.begin_check(automatic, now)? {
                self.state.lock().unwrap().snapshot.skipped = Some(skipped);
                return Ok(());
            }
            self.state.lock().unwrap().asset = None;
            self.progress(Progress {
                phase: "checking",
                received_bytes: 0,
                total_bytes: None,
                percent: None,
            });
            let release = select_release(
                &self.current,
                &fetch_release(self.transport.as_ref())?,
                &self.platform,
                &self.arch,
            )?;
            let mut state = self.state.lock().unwrap();
            state.snapshot.state = if release.newer { "available" } else { "latest" };
            state.snapshot.latest_version = Some(release.version);
            state.snapshot.notes = release.notes;
            state.snapshot.url = release.url;
            state.snapshot.can_install = release.asset.is_some();
            state.snapshot.manual = release.newer && release.asset.is_none();
            state.snapshot.progress = None;
            state.snapshot.error = None;
            state.asset = release.asset;
            Ok(())
        };
        if let Err(error) = check() {
            self.terminal(
                "error",
                Some(if error == UpdateError::Preferences {
                    Failure::Preferences
                } else {
                    Failure::Check
                }),
            );
            let mut state = self.state.lock().unwrap();
            state.asset = None;
            state.snapshot.can_install = false;
            state.snapshot.manual = false;
        }
    }

    pub fn check(&self, automatic: bool) -> Snapshot {
        let Ok(guard) = self.operation.try_lock() else {
            return self.busy();
        };
        let snapshot = self.snapshot();
        if snapshot.state == "installing" {
            return self.busy();
        }
        if snapshot.recovery_required {
            drop(guard);
            return self.snapshot();
        }
        self.check_now(automatic);
        drop(guard);
        self.publish()
    }

    pub fn install(&self, host: &dyn InstallHost) -> Snapshot {
        let Ok(guard) = self.operation.try_lock() else {
            return self.busy();
        };
        if self.snapshot().state == "installing" {
            return self.busy();
        }
        if self.snapshot().recovery_required {
            self.recover(host, "recovered", None);
        } else {
            match self.install_now(host) {
                Err(UpdateError::Cancelled) => self.recover(host, "cancelled", None),
                Err(error) => {
                    let phase = self.state.lock().unwrap().snapshot.state;
                    self.recover(host, "error", Some(Failure::Install { phase, error }));
                }
                Ok(()) => (),
            }
        }
        drop(guard);
        self.publish()
    }

    fn recover(&self, host: &dyn InstallHost, state: &'static str, error: Option<Failure>) {
        let failed = host.recover().is_err();
        self.terminal(
            if failed { "error" } else { state },
            if failed {
                Some(Failure::Recovery)
            } else {
                error
            },
        );
        self.state.lock().unwrap().snapshot.recovery_required = failed;
    }

    fn install_now(&self, host: &dyn InstallHost) -> Result<(), UpdateError> {
        if self.snapshot().state != "available" {
            self.check_now(false);
        }
        let snapshot = self.snapshot();
        if snapshot.state != "available" {
            return Ok(());
        }
        let asset = self.state.lock().unwrap().asset.clone();
        if !host.confirm(&snapshot)? {
            self.terminal("cancelled", None);
            return Ok(());
        }
        let Some(asset) = asset else {
            host.open_link(&snapshot.url)?;
            self.terminal("manual", None);
            return Ok(());
        };
        let mut file = download(
            self.transport.as_ref(),
            &asset,
            &self.directory,
            |progress| self.progress(progress),
        )?;
        self.phase("preparing");
        host.prepare()?;
        self.phase("installing");
        host.launch(&file, &asset.digest)?;
        // persist_noclobber 已清除临时属性；交接成功后不再修改被辅助进程锁住的文件。
        file.disable_cleanup(true);
        Ok(())
    }
}
