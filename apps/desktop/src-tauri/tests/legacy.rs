use serde_json::{json, Value};
use std::{fs, path::Path};
use wifimeter_desktop::{backend::BackendError, legacy::import_directory};

const STATE: &str = r#"{"SchemaVersion":1,"Networks":[{"SSID":"Sample","RxBytes":9007199254740993,"TxBytes":0,"Days":[{"Date":"2026-01-01","RxBytes":9007199254740993,"TxBytes":0}]}]}"#;

fn prepare(directory: &Path) {
    fs::write(directory.join("state.json"), STATE).unwrap();
    fs::write(directory.join("settings.json"), r#"{"Language":"en"}"#).unwrap();
}

fn archive(profile: &Path) -> std::path::PathBuf {
    let entries: Vec<_> = fs::read_dir(profile.join("migration-backups"))
        .unwrap()
        .collect();
    assert_eq!(entries.len(), 1);
    entries[0].as_ref().unwrap().path()
}

#[test]
fn archives_exact_originals_and_database_before_import() {
    let source = tempfile::tempdir().unwrap();
    let profile = tempfile::tempdir().unwrap();
    prepare(source.path());
    fs::write(source.path().join("proxy-clients.json"), b"opaque bytes").unwrap();
    let mut methods = Vec::new();
    let result = import_directory(
        Some(source.path()),
        profile.path(),
        true,
        "reject",
        &mut |method, params| {
            methods.push(method.to_string());
            match method {
                "migrationStatus" => Ok(json!({"canInitializeSettings":false})),
                "backup" => Ok(json!({"backup":{"version":1}})),
                "importLegacy" => {
                    assert_eq!(params["stateJson"], STATE);
                    assert!(params.get("allowInitialSettings").is_none());
                    assert_eq!(params["overlapPolicy"], "reject");
                    assert_eq!(
                        fs::read_to_string(archive(profile.path()).join("state.json")).unwrap(),
                        STATE
                    );
                    assert_eq!(
                        fs::read(archive(profile.path()).join("proxy-clients.json")).unwrap(),
                        b"opaque bytes"
                    );
                    assert_eq!(
                        serde_json::from_slice::<Value>(
                            &fs::read(archive(profile.path()).join("sqlite-before.json")).unwrap()
                        )
                        .unwrap(),
                        json!({"version":1})
                    );
                    Ok(json!({"status":"completed"}))
                }
                _ => panic!("unexpected {method}"),
            }
        },
    )
    .unwrap();
    assert_eq!(methods, ["migrationStatus", "backup", "importLegacy"]);
    assert_eq!(result["imported"], true);
    assert_eq!(
        fs::read_to_string(source.path().join("state.json")).unwrap(),
        STATE
    );
}

#[test]
fn missing_source_is_a_noop() {
    let source = tempfile::tempdir().unwrap();
    for directory in [None, Some(source.path())] {
        let result = import_directory(directory, source.path(), true, "reject", &mut |_, _| {
            panic!("no requests expected")
        })
        .unwrap();
        assert_eq!(result, json!({"found":false}));
    }
}

#[test]
fn malformed_primary_falls_back_but_semantic_error_does_not() {
    let source = tempfile::tempdir().unwrap();
    let profile = tempfile::tempdir().unwrap();
    fs::write(source.path().join("state.json"), "{").unwrap();
    fs::write(source.path().join("state.json.bak"), STATE).unwrap();
    let result = import_directory(
        Some(source.path()),
        profile.path(),
        true,
        "reject",
        &mut |method, params| {
            Ok(match method {
                "migrationStatus" => json!({}),
                "backup" => json!({"backup":{}}),
                "importLegacy" => {
                    assert_eq!(params["stateJson"], STATE);
                    assert_eq!(params["allowInitialSettings"], true);
                    json!({"status":"completed"})
                }
                _ => unreachable!(),
            })
        },
    )
    .unwrap();
    assert_eq!(result["sourceFile"], "state.json.bak");
    assert_eq!(
        fs::read_to_string(archive(profile.path()).join("state.json")).unwrap(),
        "{"
    );
    assert_eq!(
        fs::read_to_string(archive(profile.path()).join("state.json.bak")).unwrap(),
        STATE
    );

    fs::write(source.path().join("state.json"), "{}").unwrap();
    let profile = tempfile::tempdir().unwrap();
    let mut imports = 0;
    let error = import_directory(
        Some(source.path()),
        profile.path(),
        false,
        "reject",
        &mut |method, params| match method {
            "migrationStatus" => Ok(json!({})),
            "backup" => Ok(json!({"backup":{}})),
            "importLegacy" => {
                imports += 1;
                assert_eq!(params["stateJson"], "{}");
                Err(BackendError::new("LegacyVersion", "unsupported schema"))
            }
            _ => unreachable!(),
        },
    )
    .unwrap_err();
    assert_eq!(error.code, "LegacyVersion");
    assert_eq!(imports, 1);
    assert!(archive(profile.path()).join("sqlite-before.json").is_file());
}

#[test]
fn completed_import_validates_without_another_archive() {
    let source = tempfile::tempdir().unwrap();
    let profile = tempfile::tempdir().unwrap();
    prepare(source.path());
    let mut methods = Vec::new();
    let result = import_directory(
        Some(source.path()),
        profile.path(),
        false,
        "reject",
        &mut |method, _| {
            methods.push(method.to_string());
            Ok(json!({"status":"completed"}))
        },
    )
    .unwrap();
    assert_eq!(methods, ["migrationStatus", "importLegacy"]);
    assert_eq!(result["alreadyImported"], true);
    assert_eq!(result["imported"], false);
    assert!(!profile.path().join("migration-backups").exists());
}

#[test]
fn failed_backup_never_imports() {
    let source = tempfile::tempdir().unwrap();
    let profile = tempfile::tempdir().unwrap();
    prepare(source.path());
    for backup in [json!({}), json!({"backup":null})] {
        let error = import_directory(
            Some(source.path()),
            profile.path(),
            false,
            "reject",
            &mut |method, _| match method {
                "migrationStatus" => Ok(json!({})),
                "backup" => Ok(backup.clone()),
                _ => panic!("must not import without recovery backup"),
            },
        )
        .unwrap_err();
        assert_eq!(error.code, "unavailable");
    }
    assert!(!profile.path().join("migration-backups").exists());
}

#[test]
fn changes_during_preparation_abort_import_and_retain_archive() {
    let source = tempfile::tempdir().unwrap();
    let profile = tempfile::tempdir().unwrap();
    prepare(source.path());
    let error = import_directory(
        Some(source.path()),
        profile.path(),
        false,
        "reject",
        &mut |method, _| match method {
            "migrationStatus" => Ok(json!({})),
            "backup" => {
                fs::write(source.path().join("settings.json"), "{}").unwrap();
                Ok(json!({"backup":{}}))
            }
            _ => panic!("must not import a moving source"),
        },
    )
    .unwrap_err();
    assert_eq!(error.code, "LegacyChanged");
    assert_eq!(
        fs::read_to_string(archive(profile.path()).join("settings.json")).unwrap(),
        r#"{"Language":"en"}"#
    );
}

#[test]
fn overlaps_are_only_skipped_with_explicit_policy() {
    let source = tempfile::tempdir().unwrap();
    let profile = tempfile::tempdir().unwrap();
    prepare(source.path());
    let mut policies = Vec::new();
    for policy in ["reject", "keep-existing"] {
        let result = import_directory(
            Some(source.path()),
            profile.path(),
            false,
            policy,
            &mut |method, params| match method {
                "migrationStatus" => Ok(json!({})),
                "backup" => Ok(json!({"backup":{}})),
                "importLegacy" => {
                    policies.push(params["overlapPolicy"].clone());
                    if params["overlapPolicy"] == "reject" {
                        Err(BackendError::new("LegacyOverlap", "overlap"))
                    } else {
                        Ok(json!({"status":"completed"}))
                    }
                }
                _ => unreachable!(),
            },
        );
        assert_eq!(result.is_ok(), policy == "keep-existing");
    }
    assert_eq!(policies, [json!("reject"), json!("keep-existing")]);
}

#[cfg(windows)]
#[test]
fn active_windows_collector_lock_prevents_any_backend_request() {
    use std::os::windows::fs::OpenOptionsExt;
    let source = tempfile::tempdir().unwrap();
    prepare(source.path());
    let _lock = fs::OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .share_mode(0)
        .open(source.path().join("collector.lock"))
        .unwrap();
    let error = import_directory(
        Some(source.path()),
        source.path(),
        true,
        "reject",
        &mut |_, _| panic!("collector still running"),
    )
    .unwrap_err();
    assert_eq!(error.code, "LegacyLocked");
}
