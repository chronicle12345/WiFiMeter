#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

#[cfg(windows)]
fn main() {
    wifimeter_desktop::shell::run();
}

#[cfg(not(windows))]
fn main() {
    eprintln!("The Tauri desktop port currently supports Windows only.");
    std::process::exit(1);
}
