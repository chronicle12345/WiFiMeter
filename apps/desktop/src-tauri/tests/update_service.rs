use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    fs,
    io::Cursor,
    path::Path,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    time::Duration,
};
use wifimeter_desktop::{
    update_download::{Response, Transport},
    update_service::{InstallHost, Snapshot, UpdateService},
    updates::{UpdateError, API, REPOSITORY},
};

const BYTES: &[u8] = b"mock installer";

#[derive(Default)]
struct Network {
    calls: Mutex<Vec<String>>,
    fail: AtomicBool,
    bad_digest: AtomicBool,
}

impl Transport for Network {
    fn get(&self, url: &str, _: Duration) -> Result<Response, UpdateError> {
        self.calls.lock().unwrap().push(url.into());
        if self.fail.load(Ordering::SeqCst) {
            return Err(UpdateError::Network);
        }
        let body =
            if url == API {
                let name = "WiFiMeter-1.3.0-windows-x64-Setup.exe";
                let digest = if self.bad_digest.load(Ordering::SeqCst) {
                    "0".repeat(64)
                } else {
                    format!("{:x}", Sha256::digest(BYTES))
                };
                serde_json::to_vec(&json!({"tag_name":"v1.3.0", "body":"Release notes", "assets":[{
                "name":name, "digest":format!("sha256:{digest}"),
                "browser_download_url":format!("{REPOSITORY}/releases/download/v1.3.0/{name}")
            }]})).unwrap()
            } else {
                BYTES.to_vec()
            };
        Ok(Response {
            status: 200,
            length: Some(body.len().to_string()),
            location: None,
            body: Box::new(Cursor::new(body)),
        })
    }
}

fn service(
    profile: &Path,
    platform: &str,
    network: Arc<Network>,
    events: Arc<Mutex<Vec<Value>>>,
) -> UpdateService {
    UpdateService::new(
        "1.2.2",
        platform,
        "x64",
        profile.into(),
        network,
        Arc::new(move |snapshot| {
            events.lock().unwrap().push(snapshot.value(false));
            // 模拟窗口已关闭；发送进度失败不能中断业务流程。
            Err("closed renderer".into())
        }),
    )
    .unwrap()
}

#[derive(Default)]
struct Host<'a> {
    service: Option<&'a UpdateService>,
    approved: bool,
    fail_prepare: bool,
    fail_launch: bool,
    fail_recover: AtomicBool,
    calls: Mutex<Vec<String>>,
}

impl InstallHost for Host<'_> {
    fn confirm(&self, snapshot: &Snapshot) -> Result<bool, UpdateError> {
        self.calls.lock().unwrap().push("confirm".into());
        let value = snapshot.value(false);
        assert_eq!(value["latestVersion"], "1.3.0");
        assert_eq!(value["notes"], "Release notes");
        if let Some(service) = self.service {
            assert_eq!(service.check(false).value(false)["state"], "busy");
            assert_eq!(service.install(self).value(false)["state"], "busy");
            assert_eq!(service.set_enabled(false).value(false)["state"], "busy");
            let status = service.status().value(false);
            assert_eq!(status["state"], "available");
            assert_eq!(status["busy"], true);
        }
        Ok(self.approved)
    }
    fn open_link(&self, url: &str) -> Result<(), UpdateError> {
        self.calls.lock().unwrap().push(url.into());
        Ok(())
    }
    fn prepare(&self) -> Result<(), UpdateError> {
        self.calls.lock().unwrap().push("prepare".into());
        if let Some(service) = self.service {
            assert_eq!(service.status().value(false)["state"], "preparing");
            assert_eq!(
                service.snapshot().value(false)["progress"]["percent"],
                Value::Null
            );
        }
        if self.fail_prepare {
            Err(UpdateError::Install)
        } else {
            Ok(())
        }
    }
    fn launch(&self, path: &Path, digest: &str) -> Result<(), UpdateError> {
        self.calls.lock().unwrap().push("launch".into());
        assert_eq!(fs::read(path).unwrap(), BYTES);
        assert_eq!(digest, format!("{:x}", Sha256::digest(BYTES)));
        if let Some(service) = self.service {
            assert_eq!(service.status().value(false)["state"], "installing");
            assert_eq!(
                service.snapshot().value(false)["progress"]["percent"],
                Value::Null
            );
        }
        if self.fail_launch {
            Err(UpdateError::Install)
        } else {
            Ok(())
        }
    }
    fn recover(&self) -> Result<(), UpdateError> {
        self.calls.lock().unwrap().push("recover".into());
        if self.fail_recover.load(Ordering::SeqCst) {
            Err(UpdateError::Install)
        } else {
            Ok(())
        }
    }
}

#[test]
fn install_preserves_full_progress_and_stays_busy_after_successful_handoff() {
    let directory = tempfile::tempdir().unwrap();
    let events = Arc::new(Mutex::new(vec![]));
    let network = Arc::new(Network::default());
    let service = service(directory.path(), "win32", network.clone(), events.clone());
    let host = Host {
        service: Some(&service),
        approved: true,
        ..Default::default()
    };
    let result = service.install(&host).value(false);
    assert_eq!(result["state"], "installing");
    assert_eq!(result["busy"], true);
    assert_eq!(
        *host.calls.lock().unwrap(),
        ["confirm", "prepare", "launch"]
    );
    assert_eq!(
        fs::read_dir(directory.path().join("updates"))
            .unwrap()
            .count(),
        1
    );
    let events = events.lock().unwrap();
    let mut phases: Vec<_> = events
        .iter()
        .map(|event| event["state"].as_str().unwrap())
        .collect();
    phases.dedup();
    assert_eq!(
        phases,
        [
            "checking",
            "downloading",
            "verifying",
            "preparing",
            "installing"
        ]
    );
    for event in events.iter() {
        assert_eq!(event["state"], event["status"]);
        assert_eq!(event["currentVersion"], "1.2.2");
        assert_eq!(event["busy"], true);
        if event["state"] != "downloading" {
            assert!(event["progress"]["percent"].is_null());
        }
    }
    assert_eq!(service.install(&host).value(false)["state"], "busy");
    assert_eq!(service.check(false).value(false)["state"], "busy");
    assert_eq!(service.status().value(false)["state"], "installing");
    assert_eq!(network.calls.lock().unwrap().len(), 2);
}

#[test]
fn cancellation_downloads_nothing_and_linux_opens_only_the_release_page() {
    for (platform, approved, expected) in [
        ("win32", false, "cancelled"),
        ("linux", false, "cancelled"),
        ("linux", true, "manual"),
    ] {
        let directory = tempfile::tempdir().unwrap();
        let network = Arc::new(Network::default());
        let service = service(directory.path(), platform, network.clone(), Arc::default());
        let host = Host {
            approved,
            ..Default::default()
        };
        let result = service.install(&host).value(false);
        assert_eq!(result["state"], expected);
        assert_eq!(result["progress"], Value::Null);
        assert_eq!(result["busy"], false);
        assert_eq!(network.calls.lock().unwrap().len(), 1);
        assert!(!directory.path().join("updates").exists());
        let calls = host.calls.lock().unwrap();
        if approved {
            assert_eq!(
                *calls,
                ["confirm", &format!("{REPOSITORY}/releases/tag/v1.3.0")]
            );
        } else {
            assert_eq!(*calls, ["confirm"]);
        }
    }
}

#[test]
fn failures_clear_progress_clean_files_and_recover_before_allowing_a_retry() {
    for failure in ["digest", "prepare", "launch"] {
        let directory = tempfile::tempdir().unwrap();
        let network = Arc::new(Network::default());
        network
            .bad_digest
            .store(failure == "digest", Ordering::SeqCst);
        let events = Arc::new(Mutex::new(vec![]));
        let service = service(directory.path(), "win32", network.clone(), events.clone());
        let host = Host {
            service: Some(&service),
            approved: true,
            fail_prepare: failure == "prepare",
            fail_launch: failure == "launch",
            ..Default::default()
        };
        let snapshot = service.install(&host);
        let result = snapshot.value(false);
        assert_eq!(result["state"], "error");
        assert_eq!(result["progress"], Value::Null);
        assert_eq!(result["busy"], false);
        assert_eq!(result["recoveryRequired"], false);
        assert_eq!(
            fs::read_dir(directory.path().join("updates"))
                .unwrap()
                .count(),
            0
        );
        let calls = host.calls.lock().unwrap().clone();
        assert_eq!(calls.last().unwrap(), "recover");
        if failure == "digest" {
            assert!(!calls
                .iter()
                .any(|call| call == "prepare" || call == "launch"));
        }
        if failure == "prepare" {
            assert!(!calls.iter().any(|call| call == "launch"));
        }
        let chinese = result["error"].as_str().unwrap();
        assert!(!chinese.chars().any(|c| c.is_ascii_alphabetic()));
        assert!(snapshot.value(true)["error"].as_str().unwrap().is_ascii());
        assert_eq!(service.check(false).value(false)["state"], "available");
        assert!(service.snapshot().value(false)["error"].is_null());
    }
}

#[test]
fn failed_recovery_is_retried_before_any_new_check_or_download() {
    let directory = tempfile::tempdir().unwrap();
    let network = Arc::new(Network::default());
    let service = service(directory.path(), "win32", network.clone(), Arc::default());
    let host = Host {
        approved: true,
        fail_launch: true,
        fail_recover: AtomicBool::new(true),
        ..Default::default()
    };
    let result = service.install(&host).value(false);
    assert_eq!(result["recoveryRequired"], true);
    assert_eq!(result["busy"], false);
    assert_eq!(service.check(false).value(false)["recoveryRequired"], true);
    assert_eq!(network.calls.lock().unwrap().len(), 2);
    assert_eq!(
        service.install(&host).value(false)["recoveryRequired"],
        true
    );
    host.fail_recover.store(false, Ordering::SeqCst);
    let result = service.install(&host).value(false);
    assert_eq!(result["state"], "recovered");
    assert_eq!(result["recoveryRequired"], false);
    assert!(result["error"].is_null());
    assert_eq!(network.calls.lock().unwrap().len(), 2);
    assert_eq!(
        host.calls
            .lock()
            .unwrap()
            .iter()
            .filter(|call| *call == "confirm")
            .count(),
        1
    );
}

#[test]
fn automatic_failures_are_rate_limited_and_manual_checks_clear_the_error() {
    let directory = tempfile::tempdir().unwrap();
    let network = Arc::new(Network::default());
    network.fail.store(true, Ordering::SeqCst);
    let first = service(directory.path(), "win32", network.clone(), Arc::default());
    assert_eq!(first.check(true).value(false)["state"], "error");
    let restarted = service(directory.path(), "win32", network.clone(), Arc::default());
    assert_eq!(restarted.check(true).value(false)["skipped"], "cached");
    assert_eq!(network.calls.lock().unwrap().len(), 1);
    network.fail.store(false, Ordering::SeqCst);
    let result = restarted.check(false).value(true);
    assert_eq!(result["state"], "available");
    assert!(result["error"].is_null());
    assert!(result["skipped"].is_null());
    assert_eq!(
        restarted.set_enabled(false).value(false)["checkOnStartup"],
        false
    );
    assert_eq!(restarted.check(true).value(false)["skipped"], "disabled");
    assert_eq!(network.calls.lock().unwrap().len(), 2);
}

#[test]
fn broken_preferences_disable_updates_until_repaired_and_errors_follow_language() {
    let directory = tempfile::tempdir().unwrap();
    let network = Arc::new(Network::default());
    let service = service(directory.path(), "win32", network.clone(), Arc::default());
    let path = directory.path().join("update-preferences.json");
    fs::write(&path, "corrupt").unwrap();
    let snapshot = service.status();
    let status = snapshot.value(false);
    assert_eq!(status["checkOnStartup"], false);
    assert_eq!(status["state"], "error");
    assert!(!status["error"]
        .as_str()
        .unwrap()
        .chars()
        .any(|c| c.is_ascii_alphabetic()));
    assert!(snapshot.value(true)["error"].as_str().unwrap().is_ascii());
    assert_eq!(service.check(true).value(false)["state"], "error");
    assert!(network.calls.lock().unwrap().is_empty());
    assert_eq!(fs::read_to_string(&path).unwrap(), "corrupt");
    fs::write(&path, "{\"checkOnStartup\":true}").unwrap();
    assert_eq!(service.check(false).value(false)["state"], "available");
}
