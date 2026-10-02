use serde_json::{json, Value};
use std::{
    fs,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    time::Duration,
};
use wifimeter_desktop::{
    backend::BackendError,
    collector::{Collector, CollectorBackend},
};

#[derive(Default)]
struct FakeBackend {
    calls: Mutex<Vec<(String, Value)>>,
    paused: AtomicBool,
    import_error: Mutex<Option<String>>,
    fail_resume: AtomicBool,
}

impl CollectorBackend for FakeBackend {
    fn request(
        &self,
        method: &str,
        params: Value,
        timeout: Duration,
    ) -> Result<Value, BackendError> {
        self.calls
            .lock()
            .unwrap()
            .push((method.to_string(), params.clone()));
        match method {
            "hello" => Ok(json!({"paused":self.paused.load(Ordering::SeqCst)})),
            "setPaused" => {
                let paused = params["paused"].as_bool().unwrap();
                if !paused && self.fail_resume.load(Ordering::SeqCst) {
                    return Err(BackendError::new("unavailable", "resume failed"));
                }
                self.paused.store(paused, Ordering::SeqCst);
                Ok(json!({"paused":paused}))
            }
            "migrationStatus" => Ok(json!({})),
            "backup" => {
                assert_eq!(timeout, Duration::from_secs(300));
                Ok(json!({"backup":{}}))
            }
            "importLegacy" => {
                assert_eq!(timeout, Duration::from_secs(300));
                if let Some(code) = self.import_error.lock().unwrap().as_deref() {
                    if code != "LegacyOverlap" || params["overlapPolicy"] != "keep-existing" {
                        return Err(BackendError::new(code, "import failed"));
                    }
                }
                Ok(json!({"status":"completed"}))
            }
            _ => Ok(json!({})),
        }
    }
    fn stop(&self, _: Duration) -> Result<(), BackendError> {
        self.calls
            .lock()
            .unwrap()
            .push(("shutdown".into(), json!({})));
        Ok(())
    }
}

fn backend() -> Arc<FakeBackend> {
    Arc::new(FakeBackend {
        paused: AtomicBool::new(true),
        ..Default::default()
    })
}
fn source() -> tempfile::TempDir {
    let directory = tempfile::tempdir().unwrap();
    fs::write(directory.path().join("state.json"), "{}").unwrap();
    directory
}

#[test]
fn concurrent_startup_waits_for_import_and_resumes_exactly_once() {
    let profile = tempfile::tempdir().unwrap();
    let source = source();
    let backend = backend();
    let collector = Arc::new(Collector::new(
        backend.clone(),
        profile.path().into(),
        Some(source.path().into()),
    ));
    let threads: Vec<_> = (0..8)
        .map(|_| {
            let collector = collector.clone();
            std::thread::spawn(move || collector.request("hello", json!({}), || false).unwrap())
        })
        .collect();
    for thread in threads {
        assert_eq!(thread.join().unwrap()["paused"], false);
    }
    let calls = backend.calls.lock().unwrap();
    assert_eq!(
        calls
            .iter()
            .filter(|(method, _)| method == "importLegacy")
            .count(),
        1
    );
    assert_eq!(
        calls
            .iter()
            .filter(|(method, _)| method == "setPaused")
            .count(),
        1
    );
    assert_eq!(
        calls[..4]
            .iter()
            .map(|(method, _)| method.as_str())
            .collect::<Vec<_>>(),
        ["migrationStatus", "backup", "importLegacy", "setPaused"]
    );
}

#[test]
fn only_existing_database_overlap_resumes_automatically() {
    for existing in [false, true] {
        for code in ["LegacyOverlap", "LegacyVersion"] {
            let profile = tempfile::tempdir().unwrap();
            if existing {
                fs::write(profile.path().join("wifimeter.db"), "database").unwrap();
            }
            let source = source();
            let backend = backend();
            *backend.import_error.lock().unwrap() = Some(code.into());
            let collector = Collector::new(
                backend.clone(),
                profile.path().into(),
                Some(source.path().into()),
            );
            let status = collector.migration_status();
            let resume = existing && code == "LegacyOverlap";
            assert_eq!(backend.paused.load(Ordering::SeqCst), !resume);
            assert_eq!(status["error"].is_string(), !resume);
            assert_eq!(status["importWarning"].is_string(), resume);
        }
    }
}

#[test]
fn failed_import_requires_confirmation_and_failed_resume_retains_error() {
    let profile = tempfile::tempdir().unwrap();
    let source = source();
    let backend = backend();
    *backend.import_error.lock().unwrap() = Some("LegacyVersion".into());
    let collector = Collector::new(
        backend.clone(),
        profile.path().into(),
        Some(source.path().into()),
    );
    assert!(collector
        .request("setPaused", json!({"paused":false}), || false)
        .is_err());
    assert!(backend.paused.load(Ordering::SeqCst));
    backend.fail_resume.store(true, Ordering::SeqCst);
    assert!(collector
        .request("setPaused", json!({"paused":false}), || true)
        .is_err());
    assert_eq!(collector.migration_status()["error"], "import failed");
    backend.fail_resume.store(false, Ordering::SeqCst);
    assert!(collector
        .request("setPaused", json!({"paused":false}), || true)
        .is_ok());
    assert_eq!(collector.migration_status()["error"], "");
    assert_eq!(
        collector.migration_status()["importWarning"],
        "import failed"
    );
}

#[test]
fn canceled_picker_changes_nothing_and_allows_reads_but_rejects_writes() {
    let profile = tempfile::tempdir().unwrap();
    let backend = backend();
    let collector = Collector::new(backend.clone(), profile.path().into(), None);
    collector.start();
    let status = collector.migration_status();
    backend.calls.lock().unwrap().clear();
    let result = collector.import_selected(
        || {
            assert!(collector.request("snapshot", json!({}), || false).is_ok());
            assert!(collector
                .request("setPaused", json!({"paused":false}), || true)
                .is_err());
            assert!(collector
                .request("updateSettings", json!({}), || false)
                .is_err());
            assert!(
                collector.import_selected(|| panic!("already importing"), || false)["error"]
                    .is_string()
            );
            Ok(None)
        },
        || panic!("no overlap decision needed"),
    );
    assert_eq!(result, json!({"canceled":true}));
    assert_eq!(collector.migration_status(), status);
    assert_eq!(backend.calls.lock().unwrap().len(), 1);
    assert!(collector
        .request("updateSettings", json!({}), || false)
        .is_ok());
}

#[test]
fn successful_manual_import_restores_previous_pause_state() {
    for paused in [false, true] {
        let profile = tempfile::tempdir().unwrap();
        let source = source();
        let backend = backend();
        let collector = Collector::new(backend.clone(), profile.path().into(), None);
        collector
            .request("setPaused", json!({"paused":paused}), || false)
            .unwrap();
        backend.calls.lock().unwrap().clear();
        let result = collector.import_selected(|| Ok(Some(source.path().into())), || false);
        assert_eq!(result["imported"], true);
        assert_eq!(backend.paused.load(Ordering::SeqCst), paused);
        let calls = backend.calls.lock().unwrap();
        let pauses: Vec<_> = calls
            .iter()
            .filter(|(method, _)| method == "setPaused")
            .map(|(_, params)| params["paused"].clone())
            .collect();
        assert_eq!(pauses, [json!(true), json!(paused)]);
    }
}

#[test]
fn overlap_confirmation_controls_retry_and_failure_keeps_collection_paused() {
    for confirmed in [false, true] {
        let profile = tempfile::tempdir().unwrap();
        let source = source();
        let backend = backend();
        *backend.import_error.lock().unwrap() = Some("LegacyOverlap".into());
        let collector = Collector::new(backend.clone(), profile.path().into(), None);
        let result = collector.import_selected(|| Ok(Some(source.path().into())), || confirmed);
        assert_eq!(result["imported"] == true, confirmed);
        assert_eq!(backend.paused.load(Ordering::SeqCst), !confirmed);
        let calls = backend.calls.lock().unwrap();
        let policies: Vec<_> = calls
            .iter()
            .filter(|(method, _)| method == "importLegacy")
            .map(|(_, params)| params["overlapPolicy"].clone())
            .collect();
        assert_eq!(
            policies,
            if confirmed {
                vec![json!("reject"), json!("keep-existing")]
            } else {
                vec![json!("reject")]
            }
        );
    }
}

#[test]
fn empty_selected_directory_reports_failure_and_keeps_collection_paused() {
    let profile = tempfile::tempdir().unwrap();
    let source = tempfile::tempdir().unwrap();
    let backend = backend();
    let collector = Collector::new(backend.clone(), profile.path().into(), None);
    assert!(
        collector.import_selected(|| Ok(Some(source.path().into())), || false)["error"].is_string()
    );
    assert!(backend.paused.load(Ordering::SeqCst));
}

#[test]
fn shutdown_waits_for_startup_and_prevents_future_requests() {
    let profile = tempfile::tempdir().unwrap();
    let backend = backend();
    let collector = Collector::new(backend.clone(), profile.path().into(), None);
    collector.stop_gracefully(Duration::from_secs(5)).unwrap();
    assert!(collector.request("hello", json!({}), || false).is_err());
    assert!(collector.import_selected(|| panic!("stopping"), || false)["error"].is_string());
    let calls = backend.calls.lock().unwrap();
    assert_eq!(
        calls
            .iter()
            .map(|(method, _)| method.as_str())
            .collect::<Vec<_>>(),
        ["setPaused", "shutdown"]
    );
}

#[test]
fn shutdown_finishes_an_in_flight_read_before_stopping_the_process() {
    use std::sync::mpsc;
    struct WaitingBackend {
        entered: mpsc::Sender<()>,
        proceed: Mutex<mpsc::Receiver<()>>,
        inner: FakeBackend,
    }
    impl CollectorBackend for WaitingBackend {
        fn request(
            &self,
            method: &str,
            params: Value,
            timeout: Duration,
        ) -> Result<Value, BackendError> {
            if method == "hello" {
                self.entered.send(()).unwrap();
                self.proceed.lock().unwrap().recv().unwrap();
            }
            self.inner.request(method, params, timeout)
        }
        fn stop(&self, timeout: Duration) -> Result<(), BackendError> {
            self.inner.stop(timeout)
        }
    }
    let (entered, waiting) = mpsc::channel();
    let (proceed, blocked) = mpsc::channel();
    let backend = Arc::new(WaitingBackend {
        entered,
        proceed: Mutex::new(blocked),
        inner: FakeBackend::default(),
    });
    let profile = tempfile::tempdir().unwrap();
    let collector = Arc::new(Collector::new(backend.clone(), profile.path().into(), None));
    collector.start();
    let reader = {
        let collector = collector.clone();
        std::thread::spawn(move || collector.request("hello", json!({}), || false).unwrap())
    };
    waiting.recv_timeout(Duration::from_secs(5)).unwrap();
    let (stopped, finished) = mpsc::channel();
    let stopper = {
        let collector = collector.clone();
        std::thread::spawn(move || {
            collector.stop_gracefully(Duration::from_secs(5)).unwrap();
            stopped.send(()).unwrap();
        })
    };
    assert!(finished.recv_timeout(Duration::from_millis(30)).is_err());
    proceed.send(()).unwrap();
    reader.join().unwrap();
    stopper.join().unwrap();
    let calls = backend.inner.calls.lock().unwrap();
    assert_eq!(
        calls
            .iter()
            .map(|(method, _)| method.as_str())
            .collect::<Vec<_>>(),
        ["setPaused", "hello", "shutdown"]
    );
}
