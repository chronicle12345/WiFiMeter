use std::{fs, path::Path};
use wifimeter_desktop::data_location::{self, Mode};

// 只验证文件头与字节复制，不依赖真实 SQLite 引擎。
fn database_bytes(marker: &[u8]) -> Vec<u8> {
    let mut bytes = b"SQLite format 3\0".to_vec();
    bytes.extend_from_slice(marker);
    bytes.resize(4096, 0);
    bytes
}

fn write_database(path: &Path, marker: &[u8]) {
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(path, database_bytes(marker)).unwrap();
}

#[test]
fn pointer_round_trip_ignores_default_and_invalid_values() {
    let profile = tempfile::tempdir().unwrap();
    let custom = tempfile::tempdir().unwrap();
    assert_eq!(data_location::load(profile.path()), None);

    data_location::save(profile.path(), custom.path(), profile.path()).unwrap();
    assert_eq!(
        data_location::load(profile.path()),
        Some(custom.path().to_path_buf())
    );
    let pointer = data_location::pointer_path(profile.path());
    assert!(pointer.is_file());

    // 指回默认目录等于取消自定义，指针文件必须删除。
    data_location::save(profile.path(), profile.path(), profile.path()).unwrap();
    assert!(!pointer.exists());
    assert_eq!(data_location::load(profile.path()), None);

    fs::write(&pointer, b"{").unwrap();
    assert_eq!(data_location::load(profile.path()), None);
    fs::write(&pointer, br#"{"directory":"relative/path"}"#).unwrap();
    assert_eq!(data_location::load(profile.path()), None);
    fs::write(&pointer, br#"{"directory":"   "}"#).unwrap();
    assert_eq!(data_location::load(profile.path()), None);
    assert!(pointer.is_file(), "非法内容保留原文件，等待人工处理");
}

#[test]
fn validate_directory_creates_and_rejects_bad_targets() {
    let root = tempfile::tempdir().unwrap();
    let nested = root.path().join("新建 目录").join("数据");
    data_location::validate_directory(&nested).unwrap();
    assert!(nested.is_dir());
    assert_eq!(fs::read_dir(&nested).unwrap().count(), 0, "不留探测文件");

    let file = root.path().join("blocked");
    fs::write(&file, b"x").unwrap();
    assert!(data_location::validate_directory(&file).is_err());
    assert!(data_location::validate_directory(Path::new("relative")).is_err());
}

#[cfg(unix)]
#[test]
fn validate_directory_rejects_read_only_folder() {
    use std::os::unix::fs::PermissionsExt;
    let root = tempfile::tempdir().unwrap();
    let directory = root.path().join("readonly");
    fs::create_dir(&directory).unwrap();
    fs::set_permissions(&directory, fs::Permissions::from_mode(0o500)).unwrap();
    let result = data_location::validate_directory(&directory);
    fs::set_permissions(&directory, fs::Permissions::from_mode(0o700)).unwrap();
    assert!(result.is_err());
}

#[test]
fn copy_database_keeps_wal_and_cleans_failed_target() {
    let root = tempfile::tempdir().unwrap();
    let source = root.path().join("wifimeter.db");
    let target = root.path().join("copied").join("wifimeter.db");
    fs::create_dir_all(target.parent().unwrap()).unwrap();
    write_database(&source, b"one");
    fs::write(root.path().join("wifimeter.db-wal"), b"pending").unwrap();

    data_location::copy_database(&source, &target).unwrap();
    assert_eq!(fs::read(&target).unwrap(), fs::read(&source).unwrap());
    assert!(root.path().join("copied").join("wifimeter.db-wal").is_file());

    // 文件头不是 SQLite：报错并删除半成品副本，源文件不变。
    let broken = root.path().join("broken.db");
    fs::write(&broken, vec![0u8; 4096]).unwrap();
    let failed = root.path().join("copied").join("broken.db");
    assert!(data_location::copy_database(&broken, &failed).is_err());
    assert!(!failed.exists());
}

#[test]
fn install_copies_current_database_and_keeps_the_original() {
    let profile = tempfile::tempdir().unwrap();
    let target = tempfile::tempdir().unwrap();
    let source = data_location::database_file(profile.path());
    write_database(&source, b"current");

    let outcome = data_location::install(
        profile.path(),
        target.path(),
        &source,
        Mode::Copy,
        profile.path(),
    )
    .unwrap();
    assert!(outcome.copied);
    assert_eq!(outcome.source.as_deref(), Some(source.as_path()));
    assert!(outcome.archived.is_none());
    let copied = data_location::database_file(target.path());
    assert_eq!(fs::read(&copied).unwrap(), fs::read(&source).unwrap());
    assert!(source.is_file(), "原数据库必须保留");
    assert_eq!(
        data_location::load(profile.path()),
        Some(target.path().to_path_buf())
    );
}

#[test]
fn install_archives_existing_target_and_rolls_back_when_pointer_fails() {
    let profile = tempfile::tempdir().unwrap();
    let target = tempfile::tempdir().unwrap();
    let source = data_location::database_file(profile.path());
    write_database(&source, b"current");
    let existing = data_location::database_file(target.path());
    write_database(&existing, b"earlier");

    // profile 目录不存在时写指针失败：复制与归档都要回滚。
    let missing_profile = profile.path().join("missing").join("profile");
    let error = data_location::install(
        &missing_profile,
        target.path(),
        &source,
        Mode::Copy,
        &missing_profile,
    )
    .unwrap_err();
    assert!(error.contains("无法保存数据位置"), "{error}");
    assert_eq!(fs::read(&existing).unwrap(), database_bytes(b"earlier"));
    assert_eq!(fs::read_dir(target.path()).unwrap().count(), 1);

    let outcome = data_location::install(
        profile.path(),
        target.path(),
        &source,
        Mode::Copy,
        profile.path(),
    )
    .unwrap();
    let archived = outcome.archived.expect("目标数据库先归档");
    assert_eq!(fs::read(&archived).unwrap(), database_bytes(b"earlier"));
    assert_eq!(fs::read(&existing).unwrap(), database_bytes(b"current"));
    assert_eq!(fs::read(&source).unwrap(), database_bytes(b"current"));
}

#[test]
fn install_adopt_uses_target_data_without_copying() {
    let profile = tempfile::tempdir().unwrap();
    let target = tempfile::tempdir().unwrap();
    let source = data_location::database_file(profile.path());
    write_database(&source, b"current");

    assert!(data_location::install(
        profile.path(),
        target.path(),
        &source,
        Mode::Adopt,
        profile.path()
    )
    .is_err());
    let adopted = data_location::database_file(target.path());
    write_database(&adopted, b"other machine");
    let outcome = data_location::install(
        profile.path(),
        target.path(),
        &source,
        Mode::Adopt,
        profile.path(),
    )
    .unwrap();
    assert!(!outcome.copied);
    assert_eq!(fs::read(&adopted).unwrap(), database_bytes(b"other machine"));

    // 目标目录就是当前位置：必须拒绝，否则会把自己的数据库改名归档。
    assert!(data_location::install(
        profile.path(),
        profile.path(),
        &source,
        Mode::Copy,
        profile.path()
    )
    .is_err());
    assert_eq!(fs::read(&source).unwrap(), database_bytes(b"current"));
}

#[test]
fn install_without_existing_database_starts_empty_and_clears_pointer_on_default() {
    let profile = tempfile::tempdir().unwrap();
    let target = tempfile::tempdir().unwrap();
    let missing = data_location::database_file(profile.path());

    let outcome = data_location::install(
        profile.path(),
        target.path(),
        &missing,
        Mode::Copy,
        profile.path(),
    )
    .unwrap();
    assert!(!outcome.copied);
    assert!(outcome.source.is_none());
    assert!(!data_location::database_file(target.path()).exists());

    // 回到默认目录时删除指针。
    let outcome = data_location::install(
        profile.path(),
        profile.path(),
        &data_location::database_file(target.path()),
        Mode::Copy,
        profile.path(),
    )
    .unwrap();
    assert!(!outcome.copied);
    assert_eq!(data_location::load(profile.path()), None);
}

#[test]
fn same_directory_compares_resolved_paths() {
    let root = tempfile::tempdir().unwrap();
    assert!(data_location::same_directory(root.path(), root.path()));
    assert!(!data_location::same_directory(
        root.path(),
        &root.path().join("child")
    ));
    assert!(data_location::is_default(
        root.path(),
        &root.path().join(".")
    ));
}
