pub mod backend;
pub mod collector;
pub mod files;
pub mod identity;
pub mod ipc_policy;
pub mod legacy;
#[cfg(all(windows, feature = "desktop-shell"))]
mod native_dialog;
pub mod preferences;
#[cfg(all(windows, feature = "desktop-shell"))]
pub mod shell;
