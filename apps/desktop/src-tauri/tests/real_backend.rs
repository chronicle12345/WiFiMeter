use serde_json::json;
use std::{path::PathBuf, sync::Arc, time::Duration};
use wifimeter_desktop::backend::Backend;

#[test]
#[ignore = "requires WIFIMETER_BACKEND pointing to a built C++ collector"]
fn real_collector_settings_survive_shutdown_and_reopen() {
    let executable =
        PathBuf::from(std::env::var_os("WIFIMETER_BACKEND").expect("set WIFIMETER_BACKEND"));
    assert!(executable.is_file(), "build the C++ collector first");
    let directory = tempfile::tempdir().unwrap();
    let database = directory.path().join("wifimeter.db");
    let timeout = Duration::from_secs(20);
    let create = || {
        Backend::new(
            executable.clone(),
            database.clone(),
            vec!["--paused".into()],
            Arc::new(|_| {}),
        )
    };
    let backend = create();
    let hello = backend.request("hello", json!({}), timeout).unwrap();
    assert_eq!(hello["protocol"], 1);
    assert_eq!(hello["application"], "wifimeter-backend");
    assert_eq!(hello["paused"], true);
    let snapshot = backend.request("snapshot", json!({}), timeout).unwrap();
    assert_eq!(snapshot["source"], "backend");
    assert!(snapshot["networks"].is_array());
    let settings = backend
        .request(
            "updateSettings",
            json!({"settings":{"unit":"GiB","retention":30}}),
            timeout,
        )
        .unwrap();
    assert_eq!(settings["settings"]["unit"], "GiB");
    assert_eq!(
        backend
            .request("noSuchMethod", json!({}), timeout)
            .unwrap_err()
            .code,
        "unknownMethod"
    );
    backend.stop_gracefully(timeout).unwrap();
    drop(backend);
    assert!(std::fs::metadata(&database).unwrap().len() > 0);
    let reopened = create();
    let hello = reopened.request("hello", json!({}), timeout).unwrap();
    assert_eq!(hello["settings"]["unit"], "GiB");
    assert_eq!(hello["settings"]["retention"], 30);
    reopened.stop_gracefully(timeout).unwrap();
}

#[test]
#[ignore = "requires WIFIMETER_BACKEND pointing to a built C++ collector"]
fn legacy_import_preserves_u64_and_is_idempotent_after_reopen() {
    use wifimeter_desktop::legacy::import_directory;
    let executable =
        PathBuf::from(std::env::var_os("WIFIMETER_BACKEND").expect("set WIFIMETER_BACKEND"));
    let profile = tempfile::tempdir().unwrap();
    let source = tempfile::tempdir().unwrap();
    let raw = r#"{"SchemaVersion":1,"StartedAt":"2026-01-01T00:00:00Z","UpdatedAt":"2026-01-02T00:00:00Z","Networks":[{"SSID":"Sample","RxBytes":9007199254740993,"TxBytes":7,"FirstSeen":"2026-01-01T00:00:00Z","LastSeen":"2026-01-02T00:00:00Z","Days":[{"Date":"2026-01-01","RxBytes":9007199254740993,"TxBytes":7}]}]}"#;
    std::fs::write(source.path().join("state.json"), raw).unwrap();
    std::fs::write(
        source.path().join("settings.json"),
        r#"{"Language":"zh-CN","RetentionDays":0}"#,
    )
    .unwrap();
    let timeout = Duration::from_secs(30);
    for reopened in [false, true] {
        let backend = Backend::new(
            executable.clone(),
            profile.path().join("wifimeter.db"),
            vec!["--paused".into()],
            Arc::new(|_| {}),
        );
        let result = import_directory(
            Some(source.path()),
            profile.path(),
            !reopened,
            "reject",
            &mut |method, params| backend.request(method, params, timeout),
        )
        .unwrap();
        assert_eq!(result["imported"], !reopened);
        if reopened {
            assert_eq!(result["alreadyImported"], true);
        }
        let backup = backend.request("backup", json!({}), timeout).unwrap();
        assert_eq!(
            backup["backup"]["records"][0]["rxBytes"],
            "9007199254740993"
        );
        assert_eq!(backup["backup"]["legacyImports"][0]["stateJson"], raw);
        assert_eq!(
            backend.request("hello", json!({}), timeout).unwrap()["settings"]["language"],
            "zh-CN"
        );
        backend.stop_gracefully(timeout).unwrap();
    }
    assert_eq!(
        std::fs::read_dir(profile.path().join("migration-backups"))
            .unwrap()
            .count(),
        1
    );
}

#[test]
#[ignore = "requires WIFIMETER_BACKEND pointing to a built C++ collector"]
fn desktop_lifecycle_resumes_collection_and_closes_the_real_process() {
    use wifimeter_desktop::collector::Collector;
    let executable =
        PathBuf::from(std::env::var_os("WIFIMETER_BACKEND").expect("set WIFIMETER_BACKEND"));
    let profile = tempfile::tempdir().unwrap();
    let backend = Arc::new(Backend::new(
        executable,
        profile.path().join("wifimeter.db"),
        vec!["--paused".into()],
        Arc::new(|_| {}),
    ));
    let collector = Collector::new(backend, profile.path().into(), None);
    assert_eq!(
        collector.request("hello", json!({}), || false).unwrap()["paused"],
        false
    );
    assert_eq!(collector.migration_status(), json!({"found":false}));
    collector.stop_gracefully(Duration::from_secs(30)).unwrap();
    assert!(collector.request("hello", json!({}), || false).is_err());
}
