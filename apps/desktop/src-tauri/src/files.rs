use std::{
    fs::File,
    io::{self, Read, Write},
    path::Path,
};

pub const MAX_BACKUP_BYTES: u64 = 512 * 1024 * 1024;

pub fn assert_backup_size(bytes: u64) -> io::Result<()> {
    if bytes > MAX_BACKUP_BYTES {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "备份超过 512 MiB，未写入或读取文件。",
        ));
    }
    Ok(())
}

// 目标文件与临时文件必须在同一目录；失败时保留旧内容并自动清理临时文件。
pub fn atomic_write(path: &Path, body: &[u8]) -> io::Result<()> {
    let parent = path
        .parent()
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "缺少文件目录。"))?;
    let mut temporary = tempfile::NamedTempFile::new_in(parent)?;
    temporary.write_all(body)?;
    temporary.as_file().sync_all()?;
    temporary.persist(path).map_err(|error| error.error)?;
    Ok(())
}

pub fn export_filename(value: &str, body: &str) -> io::Result<String> {
    // 即使在 Linux 上验证，也使用 Windows 分隔符规则，避免把输入目录带到保存对话框。
    let filename = value.rsplit(['/', '\\']).next().unwrap_or("");
    match filename.rsplit_once('.').map(|(_, extension)| extension) {
        Some("json") => assert_backup_size(body.len() as u64)?,
        Some("csv") => (),
        _ => {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "仅支持 CSV 和 JSON 文件。",
            ))
        }
    }
    Ok(filename.into())
}

pub fn read_backup(path: &Path) -> io::Result<String> {
    let file = File::open(path)?;
    assert_backup_size(file.metadata()?.len())?;
    let mut bytes = Vec::new();
    // 读取期间文件可能增长；读取量本身也受限制，而不只检查读取前的 metadata。
    file.take(MAX_BACKUP_BYTES + 1).read_to_end(&mut bytes)?;
    assert_backup_size(bytes.len() as u64)?;
    String::from_utf8(bytes).map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error))
}
