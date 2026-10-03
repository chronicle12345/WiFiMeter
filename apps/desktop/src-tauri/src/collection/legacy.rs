use crate::{backend::BackendError, files::assert_backup_size};
use serde::Deserialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    fs::{self, File, OpenOptions},
    io::{Read, Write},
    path::Path,
};

const MAX_LEGACY_BYTES: u64 = 128 * 1024 * 1024;
type Result<T> = std::result::Result<T, BackendError>;

fn digest(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

pub fn source_id(directory: &Path) -> Result<String> {
    // absolute 使用 Windows GetFullPathName，与原 Node path.resolve 一样，不解析符号链接。
    let resolved = std::path::absolute(directory)?;
    let mut text = resolved.to_string_lossy().into_owned();
    if cfg!(windows) {
        text = text.to_lowercase();
    }
    Ok(digest(text.as_bytes()))
}

fn read_raw(path: &Path) -> Result<Option<String>> {
    let file = match File::open(path) {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error.into()),
    };
    let metadata = file.metadata()?;
    if !metadata.is_file() || metadata.len() > MAX_LEGACY_BYTES {
        return Err(BackendError::new(
            "LegacySize",
            "Legacy JSON file exceeds the supported size.",
        ));
    }
    let mut bytes = Vec::new();
    file.take(MAX_LEGACY_BYTES + 1).read_to_end(&mut bytes)?;
    if bytes.len() as u64 > MAX_LEGACY_BYTES {
        return Err(BackendError::new(
            "LegacySize",
            "Legacy JSON file exceeds the supported size.",
        ));
    }
    String::from_utf8(bytes)
        .map(Some)
        .map_err(|error| BackendError::new("LegacyJsonSyntax", error))
}

fn check_json(raw: &str, name: &str) -> Result<()> {
    // 只校验语法，不把原文中的字节计数解析成浮点数或再序列化。
    let mut parser = serde_json::Deserializer::from_str(raw.trim_start_matches('\u{feff}'));
    serde::de::IgnoredAny::deserialize(&mut parser)
        .and_then(|_| parser.end())
        .map_err(|_| BackendError::new("LegacyJsonSyntax", format!("Invalid legacy JSON: {name}")))
}

fn read_json(path: &Path) -> Result<Option<String>> {
    let raw = read_raw(path)?;
    if let Some(raw) = &raw {
        check_json(raw, &path.file_name().unwrap().to_string_lossy())?;
    }
    Ok(raw)
}

#[derive(PartialEq)]
struct Candidate {
    raw: String,
    source_file: &'static str,
    primary_raw: Option<String>,
}

fn read_state(directory: &Path) -> Result<Option<Candidate>> {
    let primary = read_raw(&directory.join("state.json"))?;
    if let Some(raw) = &primary {
        if check_json(raw, "state.json").is_ok() {
            return Ok(Some(Candidate {
                raw: raw.clone(),
                source_file: "state.json",
                primary_raw: primary,
            }));
        }
    }
    if let Some(raw) = read_json(&directory.join("state.json.bak"))? {
        return Ok(Some(Candidate {
            raw,
            source_file: "state.json.bak",
            primary_raw: primary,
        }));
    }
    if let Some(raw) = primary {
        check_json(&raw, "state.json")?;
    }
    Ok(None)
}

fn archive_file(directory: &Path, name: &str, bytes: &[u8]) -> Result<()> {
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(directory.join(name))?;
    file.write_all(bytes)?;
    file.sync_all()?;
    Ok(())
}

pub fn import_directory(
    directory: Option<&Path>,
    profile: &Path,
    allow_initial_settings: bool,
    overlap_policy: &str,
    request: &mut impl FnMut(&str, Value) -> Result<Value>,
) -> Result<Value> {
    if !["reject", "keep-existing"].contains(&overlap_policy) {
        return Err(BackendError::new(
            "badRequest",
            "overlapPolicy must be reject or keep-existing.",
        ));
    }
    let Some(directory) = directory else {
        return Ok(json!({"found":false}));
    };
    let _lock = match File::open(directory.join("collector.lock")) {
        Ok(lock) => Some(lock),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
        Err(_) => {
            return Err(BackendError::new(
                "LegacyLocked",
                "Stop the previous WiFiMeter collector before importing its data.",
            ))
        }
    };
    let Some(candidate) = read_state(directory)? else {
        return Ok(json!({"found":false}));
    };
    let settings = read_json(&directory.join("settings.json"))?.unwrap_or_default();
    let apps = read_json(&directory.join("app-usage.json"))?.unwrap_or_default();
    let source_id = source_id(directory)?;
    let identity = digest(format!("{}\0{settings}\0{apps}", candidate.raw).as_bytes());
    let status = request("migrationStatus", json!({"sourceId":source_id}))?;
    let initialize = status["canInitializeSettings"]
        .as_bool()
        .unwrap_or(allow_initial_settings);
    let mut payload =
        json!({"stateJson":candidate.raw,"sourceId":source_id,"overlapPolicy":overlap_policy});
    if !settings.is_empty() {
        payload["settingsJson"] = json!(settings);
    }
    if !apps.is_empty() {
        payload["appUsageJson"] = json!(apps);
    }
    if initialize {
        payload["allowInitialSettings"] = json!(true);
    }
    if status["status"] == "completed" {
        let mut result = request("importLegacy", payload)?;
        result["found"] = json!(true);
        result["imported"] = json!(false);
        result["alreadyImported"] = json!(true);
        result["sourceFile"] = json!(candidate.source_file);
        return Ok(result);
    }
    let backup = request("backup", json!({}))?;
    if !backup["backup"].is_object() {
        return Err(BackendError::new(
            "unavailable",
            "No recovery backup was returned by the backend.",
        ));
    }
    let backup = serde_json::to_vec(&backup["backup"])
        .map_err(|error| BackendError::new("unavailable", error))?;
    assert_backup_size(backup.len() as u64)?;
    let parent = profile.join("migration-backups");
    fs::create_dir_all(&parent)?;
    // 即使之后导入失败也保留已生成的恢复档案。
    let archive = tempfile::Builder::new()
        .prefix(&format!("{}-", &identity[..16]))
        .tempdir_in(parent)?
        .keep();
    archive_file(&archive, "sqlite-before.json", &backup)?;
    if let Some(raw) = &candidate.primary_raw {
        archive_file(&archive, "state.json", raw.as_bytes())?;
    }
    if candidate.source_file == "state.json.bak" {
        archive_file(&archive, "state.json.bak", candidate.raw.as_bytes())?;
    }
    if !settings.is_empty() {
        archive_file(&archive, "settings.json", settings.as_bytes())?;
    }
    if !apps.is_empty() {
        archive_file(&archive, "app-usage.json", apps.as_bytes())?;
    }
    for name in [
        "state.json.bak",
        "proxy-clients.json",
        "app-usage-profiles.json",
    ] {
        if name == candidate.source_file {
            continue;
        }
        match fs::read(directory.join(name)) {
            Ok(bytes) => archive_file(&archive, name, &bytes)?,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => (),
            Err(error) => return Err(error.into()),
        }
    }
    if read_state(directory)?.as_ref() != Some(&candidate)
        || read_json(&directory.join("settings.json"))?.unwrap_or_default() != settings
        || read_json(&directory.join("app-usage.json"))?.unwrap_or_default() != apps
    {
        return Err(BackendError::new(
            "LegacyChanged",
            "Legacy data changed during import preparation. Stop the previous collector and retry.",
        ));
    }
    let mut result = request("importLegacy", payload)?;
    let imported = (result["status"] == "completed" && result["alreadyImported"] != true)
        || result["imported"] == true;
    result["found"] = json!(true);
    result["imported"] = json!(imported);
    result["sourceFile"] = json!(candidate.source_file);
    result["backupDirectory"] = json!(archive);
    Ok(result)
}
