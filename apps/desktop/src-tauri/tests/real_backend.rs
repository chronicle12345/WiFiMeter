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
