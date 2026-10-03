use serde_json::json;
use std::{fs, path::Path, sync::Arc, thread};
use wifimeter_desktop::{
    files::*,
    identity::*,
    preferences::{defaults, Preferences},
};

#[test]
fn windows_identity_keeps_existing_profile_and_test_isolation() {
    let app_data = Path::new("C:\\Users\\someone\\AppData\\Roaming");
    assert_eq!(PRODUCT_NAME, "WiFiMeter");
    assert_eq!(WINDOWS_APP_ID, "io.wifimeter.demo");
    assert_eq!(
        profile_directory(app_data, None, true),
        app_data.join("WiFiMeter Demo")
    );
    assert_eq!(
        profile_directory(app_data, Some(Path::new("isolated")), true),
        Path::new("isolated")
    );
    assert_eq!(
        legacy_directory(Some(app_data), false, None),
        Some(app_data.join("WiFiMeter/data"))
    );
    assert_eq!(legacy_directory(Some(app_data), true, None), None);
    assert_eq!(legacy_directory(None, false, None), None);
    assert_eq!(
        legacy_directory(Some(app_data), true, Some(Path::new("legacy-test"))),
        Some("legacy-test".into())
    );
}

#[test]
fn linux_identity_keeps_electron_config_directory_and_test_isolation() {
    for config in ["/home/user/.config", "/home/user/custom config"] {
        let config = Path::new(config);
        assert_eq!(profile_directory(config, None, false), config.join("WiFiMeter"));
        assert_eq!(profile_directory(config, Some(Path::new("/tmp/isolated")), false), Path::new("/tmp/isolated"));
    }
}

#[test]
fn loads_electron_preferences_and_ignores_only_invalid_fields() {
    let dir = tempfile::tempdir().unwrap();
    let preferences = Preferences::load(dir.path().into());
    assert_eq!(preferences.read(), defaults());
    fs::write(dir.path().join("window-preferences.json"), r#"{"miniWindow":true,"closeAction":"ask","theme":"dark","miniShape":"circle","miniPalette":"light","miniSnap":false,"miniAutoHide":false,"future":42}"#).unwrap();
    let saved = Preferences::load(dir.path().into());
    assert_eq!(
        saved.read(),
        json!({"miniWindow":true,"closeAction":"ask","theme":"dark","miniShape":"circle","miniPalette":"light","miniSnap":false,"miniAutoHide":false})
    );
    fs::write(
        dir.path().join("window-preferences.json"),
        r#"{"theme":"unknown","miniWindow":true,"miniSnap":1}"#,
    )
    .unwrap();
    let loaded = Preferences::load(dir.path().into()).read();
    assert_eq!(loaded["theme"], "system");
    assert_eq!(loaded["miniWindow"], true);
    assert_eq!(loaded["miniSnap"], true);
    fs::write(dir.path().join("window-preferences.json"), "{").unwrap();
    assert_eq!(Preferences::load(dir.path().into()).read(), defaults());
}

#[test]
fn concurrent_preference_updates_merge_and_survive_restart() {
    let dir = tempfile::tempdir().unwrap();
    let preferences = Arc::new(Preferences::load(dir.path().into()));
    let tasks: Vec<_> = [
        json!({"miniWindow":true}),
        json!({"theme":"dark"}),
        json!({"miniSnap":false}),
    ]
    .into_iter()
    .map(|patch| {
        let preferences = preferences.clone();
        thread::spawn(move || preferences.update(patch).unwrap())
    })
    .collect();
    for task in tasks {
        task.join().unwrap();
    }
    let saved = Preferences::load(dir.path().into()).read();
    assert_eq!(saved, preferences.read());
    assert_eq!(saved["miniWindow"], true);
    assert_eq!(saved["theme"], "dark");
    assert_eq!(saved["miniSnap"], false);
}

#[test]
fn invalid_updates_and_failed_writes_preserve_state() {
    let dir = tempfile::tempdir().unwrap();
    let preferences = Preferences::load(dir.path().into());
    for patch in [
        json!(null),
        json!([]),
        json!({"theme":"blue"}),
        json!({"unknown":true}),
        json!({"miniWindow":1}),
        json!({"miniSnap":null}),
    ] {
        assert!(preferences.update(patch).is_err());
    }
    assert_eq!(preferences.read(), defaults());
    assert_eq!(fs::read_dir(dir.path()).unwrap().count(), 0);
    fs::create_dir(dir.path().join("window-preferences.json")).unwrap();
    assert!(preferences.update(json!({"theme":"dark"})).is_err());
    assert_eq!(preferences.read(), defaults());
    assert_eq!(
        fs::read_dir(dir.path()).unwrap().count(),
        1,
        "temporary files must be removed"
    );
    fs::remove_dir(dir.path().join("window-preferences.json")).unwrap();
    assert_eq!(
        preferences.update(json!({"theme":"dark"})).unwrap()["theme"],
        "dark"
    );
}

#[test]
fn backups_round_trip_utf8_and_replace_existing_destination() {
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("备份.json");
    atomic_write(&file, b"old").unwrap();
    let body = "{\"name\":\"无线网络\",\"bytes\":\"9007199254740993\"}";
    atomic_write(&file, body.as_bytes()).unwrap();
    assert_eq!(read_backup(&file).unwrap(), body);
    assert_eq!(fs::read_dir(dir.path()).unwrap().count(), 1);
    assert_eq!(
        export_filename("C:\\somewhere\\用量.csv", "csv").unwrap(),
        "用量.csv"
    );
    assert_eq!(
        export_filename("../backup.json", body).unwrap(),
        "backup.json"
    );
    for file in ["a.exe", "a", "a.JSON"] {
        assert!(export_filename(file, "").is_err());
    }
    assert!(assert_backup_size(MAX_BACKUP_BYTES).is_ok());
    assert!(assert_backup_size(MAX_BACKUP_BYTES + 1).is_err());
    let huge = fs::File::create(dir.path().join("huge.json")).unwrap();
    huge.set_len(MAX_BACKUP_BYTES + 1).unwrap();
    assert!(read_backup(&dir.path().join("huge.json")).is_err());
}

#[cfg(windows)]
#[test]
fn locked_windows_backup_remains_intact_after_failed_replace() {
    use std::os::windows::fs::OpenOptionsExt;
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("backup.json");
    fs::write(&path, "previous").unwrap();
    let lock = fs::OpenOptions::new()
        .read(true)
        .share_mode(0)
        .open(&path)
        .unwrap();
    assert!(atomic_write(&path, b"replacement").is_err());
    drop(lock);
    assert_eq!(fs::read_to_string(&path).unwrap(), "previous");
    assert_eq!(fs::read_dir(dir.path()).unwrap().count(), 1);
}
