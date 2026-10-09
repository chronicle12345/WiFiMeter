use std::{
    fs::{File, OpenOptions},
    os::windows::fs::OpenOptionsExt,
    path::Path,
};

// Electron 44.4.5 沿用 Chromium 的 profile/lockfile 协议；两份补丁未修改打开方式。
// https://github.com/chromium/chromium/blob/152.0.7977.130/chrome/browser/process_singleton_win.cc
// https://github.com/electron/electron/blob/v44.4.5/patches/chromium/process_singleton.patch
// https://github.com/electron/electron/blob/v44.4.5/patches/chromium/feat_add_data_parameter_to_processsingleton.patch
const FILE_SHARE_READ: u32 = 0x00000001;
const FILE_FLAG_DELETE_ON_CLOSE: u32 = 0x04000000;

pub struct LegacyInstanceGuard {
    _file: File,
}

impl LegacyInstanceGuard {
    pub fn acquire(user_data: &Path) -> Result<Self, String> {
        // 与 Chromium 的 GENERIC_WRITE / CREATE_ALWAYS / FILE_SHARE_READ 一致。
        // 原子打开同时保护两个启动顺序；关闭句柄后由 Windows 清理锁文件。
        let file = OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .share_mode(FILE_SHARE_READ)
            .custom_flags(FILE_FLAG_DELETE_ON_CLOSE)
            .open(user_data.join("lockfile"))
            .map_err(|error| {
                if matches!(error.raw_os_error(), Some(32 | 33)) {
                    format!(
                        "此数据目录正在被其他 WiFiMeter 实例使用。请正常退出该实例后重试。\n数据目录：{}",
                        user_data.display()
                    )
                } else {
                    format!("无法锁定 WiFiMeter 数据目录：{error}\n{}", user_data.display())
                }
            })?;
        Ok(Self { _file: file })
    }
}
