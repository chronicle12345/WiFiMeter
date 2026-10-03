pub mod autostart;
pub mod backend;
pub mod close_check;
pub mod collector;
pub mod dialog_requests;
pub mod files;
pub mod identity;
pub mod ipc_policy;
pub mod legacy;
#[cfg(all(windows, feature = "desktop-shell"))]
mod mini;
pub mod mini_geometry;
#[cfg(all(windows, feature = "desktop-shell"))]
mod native_dialog;
pub mod preferences;
#[cfg(all(windows, feature = "desktop-shell"))]
pub mod shell;
#[cfg(all(windows, feature = "desktop-shell"))]
mod tray;

#[cfg(windows)]
pub mod windows_login;
