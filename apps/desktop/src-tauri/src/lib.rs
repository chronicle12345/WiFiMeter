pub mod app_control;
pub mod app_icons;
pub mod autostart;
pub mod close_check;
pub mod collection;
pub mod dialog_requests;
pub mod files;
pub mod identity;
pub mod ipc_policy;
pub mod mini_geometry;
pub mod notifications;
pub mod platform;
pub mod preferences;
pub mod update;

// 保留宿主及集成测试使用的接口；实现按业务与平台组织。
pub use collection::{backend, collector, legacy};
pub use update::{download as update_download, policy as updates, service as update_service};

#[cfg(all(any(windows, target_os = "linux"), feature = "desktop-shell"))]
pub mod desktop;
#[cfg(all(any(windows, target_os = "linux"), feature = "desktop-shell"))]
pub use desktop::shell;
#[cfg(all(any(windows, target_os = "linux"), feature = "desktop-shell"))]
pub(crate) use desktop::{dialog as native_dialog, mini, tray};

#[cfg(target_os = "linux")]
pub use platform::linux::login as linux_login;
#[cfg(all(target_os = "linux", feature = "desktop-shell"))]
pub(crate) use platform::linux::desktop as linux_desktop;
#[cfg(windows)]
pub use platform::windows::{
    control as windows_control, icons as windows_icons, login as windows_login,
    update as windows_update,
};
