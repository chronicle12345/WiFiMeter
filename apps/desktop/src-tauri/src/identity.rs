use std::path::{Path, PathBuf};

pub const PRODUCT_NAME: &str = "WiFiMeter";
pub const WINDOWS_APP_ID: &str = "io.wifimeter.demo";

pub fn profile_directory(app_data: &Path, override_directory: Option<&Path>) -> PathBuf {
    // Tauri 默认使用 identifier 目录；必须显式沿用 Electron 目录以保留数据库及窗口偏好。
    override_directory
        .map(Path::to_path_buf)
        .unwrap_or_else(|| app_data.join("WiFiMeter Demo"))
}

pub fn legacy_directory(
    local_app_data: Option<&Path>,
    isolated_profile: bool,
    override_directory: Option<&Path>,
) -> Option<PathBuf> {
    if let Some(path) = override_directory {
        return Some(path.to_path_buf());
    }
    if isolated_profile {
        return None;
    }
    local_app_data.map(|path| path.join("WiFiMeter").join("data"))
}
