// 数据库所在文件夹的自定义位置：指针文件放在默认配置目录，数据可以放在别处。
// 指针必须与数据位置无关，否则数据目录丢失后无法回退；因此不放进数据库设置里。

use crate::files::atomic_write;
use serde_json::{json, Value};
use std::{
    fs::{self, File},
    io::{self, Read},
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};

pub const DATABASE_FILE: &str = "wifimeter.db";
pub const POINTER_FILE: &str = "data-location.json";
const SQLITE_HEADER: &[u8] = b"SQLite format 3\0";

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Mode {
    /// 复制当前数据库到目标目录。
    Copy,
    /// 直接使用目标目录中已有的数据库。
    Adopt,
}

#[derive(Debug, Default)]
pub struct Outcome {
    /// 被复制的源数据库；空表示目标位置将从空数据库开始。
    pub source: Option<PathBuf>,
    /// 因重名而归档的目标数据库。
    pub archived: Option<PathBuf>,
    pub copied: bool,
}

pub fn database_file(directory: &Path) -> PathBuf {
    directory.join(DATABASE_FILE)
}

pub fn pointer_path(profile: &Path) -> PathBuf {
    profile.join(POINTER_FILE)
}

fn resolve(path: &Path) -> PathBuf {
    fs::canonicalize(path)
        .or_else(|_| std::path::absolute(path))
        .unwrap_or_else(|_| path.to_path_buf())
}

pub fn same_directory(left: &Path, right: &Path) -> bool {
    let (left, right) = (resolve(left), resolve(right));
    if cfg!(windows) {
        left.to_string_lossy().to_lowercase() == right.to_string_lossy().to_lowercase()
    } else {
        left == right
    }
}

pub fn is_default(profile: &Path, directory: &Path) -> bool {
    same_directory(profile, directory)
}

/// 读取自定义位置。缺失、非法、相对路径或等于默认目录都按默认位置处理。
pub fn load(profile: &Path) -> Option<PathBuf> {
    let file = pointer_path(profile);
    let bytes = match fs::read(&file) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return None,
        Err(error) => {
            eprintln!("[data-location] 读取数据位置失败：{error}");
            return None;
        }
    };
    let directory = serde_json::from_slice::<Value>(&bytes)
        .ok()
        .as_ref()
        .and_then(|value| value.get("directory"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(PathBuf::from);
    let Some(directory) = directory else {
        eprintln!("[data-location] 数据位置文件无效，使用默认目录。");
        return None;
    };
    if !directory.is_absolute() {
        eprintln!("[data-location] 数据位置不是绝对路径，使用默认目录。");
        return None;
    }
    if is_default(profile, &directory) {
        return None;
    }
    Some(directory)
}

/// 写入指针；指向默认目录时删除指针文件。
pub fn save(profile: &Path, directory: &Path, default_directory: &Path) -> io::Result<()> {
    let file = pointer_path(profile);
    if is_default(default_directory, directory) {
        return match fs::remove_file(&file) {
            Err(error) if error.kind() != io::ErrorKind::NotFound => Err(error),
            _ => Ok(()),
        };
    }
    let body = serde_json::to_string_pretty(&json!({
        "directory": directory.to_string_lossy(),
    }))? + "\n";
    atomic_write(&file, body.as_bytes())
}

/// 目录必须存在或可创建，并且可写；用临时文件探测，不留残留文件。
pub fn validate_directory(directory: &Path) -> Result<(), String> {
    if !directory.is_absolute() {
        return Err("请选择完整的文件夹路径。".into());
    }
    if directory.exists() && !directory.is_dir() {
        return Err(format!("{} 不是文件夹。", directory.display()));
    }
    fs::create_dir_all(directory).map_err(|error| format!("无法创建文件夹：{error}"))?;
    tempfile::NamedTempFile::new_in(directory)
        .map_err(|error| format!("该文件夹不可写：{error}"))?;
    Ok(())
}

/// 给同一目录下的路径追加后缀，用于 -wal / -shm 和归档文件。
fn sibling(path: &Path, suffix: &str) -> PathBuf {
    let mut name = path.as_os_str().to_os_string();
    name.push(suffix);
    PathBuf::from(name)
}

fn copy_file(source: &Path, target: &Path) -> Result<u64, String> {
    fs::copy(source, target)
        .map_err(|error| format!("复制数据库失败：{error}"))
}

fn verify_database(target: &Path, expected: u64) -> Result<(), String> {
    let metadata = fs::metadata(target).map_err(|error| format!("无法读取复制结果：{error}"))?;
    if metadata.len() != expected {
        return Err("复制后的数据库大小与源文件不一致。".into());
    }
    let mut header = [0u8; 16];
    let mut file = File::open(target).map_err(|error| format!("无法读取复制结果：{error}"))?;
    file.read_exact(&mut header)
        .map_err(|error| format!("复制后的数据库不完整：{error}"))?;
    if header != SQLITE_HEADER {
        return Err("复制后的文件不是 SQLite 数据库。".into());
    }
    Ok(())
}

/// 复制数据库文件（含未合并的 WAL），失败时清理半成品副本。
pub fn copy_database(source: &Path, target: &Path) -> Result<(), String> {
    let bytes = fs::metadata(source)
        .map_err(|error| format!("无法读取当前数据库：{error}"))?
        .len();
    let result = copy_file(source, target)
        .and_then(|_| verify_database(target, bytes))
        .and_then(|_| {
            let wal = sibling(source, "-wal");
            if fs::metadata(&wal).is_ok_and(|metadata| metadata.len() > 0) {
                copy_file(&wal, &sibling(target, "-wal"))?;
            }
            Ok(())
        });
    if let Err(error) = result {
        let _ = fs::remove_file(target);
        let _ = fs::remove_file(sibling(target, "-wal"));
        return Err(error);
    }
    Ok(())
}

fn unique(path: PathBuf) -> PathBuf {
    if !path.exists() {
        return path;
    }
    for index in 1..1000 {
        let candidate = sibling(&path, &format!("-{index}"));
        if !candidate.exists() {
            return candidate;
        }
    }
    path
}

/// 归档目标目录已有数据库，返回归档路径；同目录复制时先改名，避免覆盖用户数据。
pub fn archive_existing(directory: &Path) -> Result<Option<PathBuf>, String> {
    let database = database_file(directory);
    if !database.exists() {
        return Ok(None);
    }
    let stamp = timestamp_utc(
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|value| value.as_secs())
            .unwrap_or(0),
    );
    let archived = unique(sibling(&database, &format!(".replaced-{stamp}")));
    fs::rename(&database, &archived).map_err(|error| format!("无法归档目标数据库：{error}"))?;
    for suffix in ["-wal", "-shm"] {
        let sidecar = sibling(&database, suffix);
        if sidecar.exists() {
            let _ = fs::rename(&sidecar, sibling(&archived, suffix));
        }
    }
    Ok(Some(archived))
}

/// 在后端已停止时执行切换：归档同名数据库、复制当前数据库、最后写入指针。
/// 任一步失败都回滚已完成的文件改动，并保持指针不变。
pub fn install(
    profile: &Path,
    directory: &Path,
    source: &Path,
    mode: Mode,
    default_directory: &Path,
) -> Result<Outcome, String> {
    validate_directory(directory)?;
    if let Some(parent) = source.parent() {
        if same_directory(parent, directory) {
            return Err("目标文件夹与当前数据位置相同。".into());
        }
    }
    let target = database_file(directory);
    if mode == Mode::Adopt && !target.exists() {
        return Err("目标文件夹中没有数据库文件。".into());
    }
    let mut outcome = Outcome::default();
    let mut rollback: Option<(PathBuf, PathBuf)> = None;
    if mode == Mode::Copy {
        if let Some(archived) = archive_existing(directory)? {
            rollback = Some((archived.clone(), target.clone()));
            outcome.archived = Some(archived);
        }
        match fs::metadata(source) {
            Ok(metadata) if metadata.is_file() => {
                copy_database(source, &target).inspect_err(|_| {
                    if let Some((archived, original)) = rollback.take() {
                        let _ = fs::rename(&archived, &original);
                    }
                })?;
                outcome.copied = true;
                outcome.source = Some(source.to_path_buf());
            }
            Ok(_) => return Err("当前数据位置不是数据库文件。".into()),
            Err(error) if error.kind() == io::ErrorKind::NotFound => (),
            Err(error) => return Err(format!("无法读取当前数据库：{error}")),
        }
    }
    if let Err(error) = save(profile, directory, default_directory) {
        if outcome.copied {
            let _ = fs::remove_file(&target);
            let _ = fs::remove_file(sibling(&target, "-wal"));
        }
        if let Some((archived, original)) = rollback {
            let _ = fs::rename(&archived, &original);
        }
        return Err(format!("无法保存数据位置：{error}"));
    }
    Ok(outcome)
}

/// 归档时间戳使用 UTC，避免依赖本地时区与系统语言。
fn timestamp_utc(seconds: u64) -> String {
    let days = (seconds / 86_400) as i64;
    let remaining = seconds % 86_400;
    let shifted = days + 719_468;
    let era = shifted.div_euclid(146_097);
    let day_of_era = shifted.rem_euclid(146_097);
    let year_of_era =
        (day_of_era - day_of_era / 1_460 + day_of_era / 36_524 - day_of_era / 146_096) / 365;
    let day_of_year = day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
    let month_index = (5 * day_of_year + 2) / 153;
    let day = day_of_year - (153 * month_index + 2) / 5 + 1;
    let month = if month_index < 10 {
        month_index + 3
    } else {
        month_index - 9
    };
    let year = year_of_era + era * 400 + i64::from(month <= 2);
    format!(
        "{year:04}{month:02}{day:02}T{:02}{:02}{:02}Z",
        remaining / 3_600,
        (remaining % 3_600) / 60,
        remaining % 60
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn utc_timestamp_covers_epoch_leap_day_and_end_of_year() {
        assert_eq!(timestamp_utc(0), "19700101T000000Z");
        assert_eq!(timestamp_utc(1_700_000_000), "20231114T221320Z");
        assert_eq!(timestamp_utc(951_782_399), "20000228T235959Z");
        assert_eq!(timestamp_utc(1_735_689_599), "20241231T235959Z");
    }

    #[test]
    fn sidecar_and_archive_suffixes_keep_the_original_name() {
        assert_eq!(
            sibling(Path::new("/data/wifimeter.db"), "-wal"),
            PathBuf::from("/data/wifimeter.db-wal")
        );
        let directory = tempfile::tempdir().unwrap();
        let first = unique(directory.path().join("wifimeter.db.replaced"));
        assert_eq!(first.file_name().unwrap(), "wifimeter.db.replaced");
        fs::write(&first, "one").unwrap();
        assert_eq!(
            unique(directory.path().join("wifimeter.db.replaced"))
                .file_name()
                .unwrap(),
            "wifimeter.db.replaced-1"
        );
    }
}
