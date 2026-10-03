pub mod autostart;
pub mod app_control;
pub mod app_icons;
pub mod backend;
pub mod close_check;
pub mod collector;
pub mod dialog_requests;
pub mod files;
pub mod identity;
pub mod ipc_policy;
pub mod legacy;
#[cfg(target_os = "linux")]
pub mod linux_login;
#[cfg(all(windows, feature = "desktop-shell"))]
mod mini;
pub mod mini_geometry;
pub mod notifications;
#[cfg(all(windows, feature = "desktop-shell"))]
mod native_dialog;
pub mod preferences;
pub mod updates;
pub mod update_download;
pub mod update_service;
#[cfg(all(windows, feature = "desktop-shell"))]
pub mod shell;
#[cfg(all(windows, feature = "desktop-shell"))]
mod tray;

#[cfg(windows)]
pub mod windows_login;
#[cfg(windows)]
pub mod windows_icons;
#[cfg(windows)]
pub mod windows_control;
#[cfg(windows)]
pub mod windows_update;
