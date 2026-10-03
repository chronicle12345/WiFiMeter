#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

#[cfg(any(windows, target_os = "linux"))]
fn main() {
    wifimeter_desktop::shell::run();
}

#[cfg(not(any(windows, target_os = "linux")))]
fn main() {
    eprintln!("The Tauri desktop port currently supports Windows and Linux.");
    std::process::exit(1);
}
