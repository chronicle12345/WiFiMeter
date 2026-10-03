fn main() {
    if matches!(
        std::env::var("CARGO_CFG_TARGET_OS").as_deref(),
        Ok("windows" | "linux")
    ) && std::env::var_os("CARGO_FEATURE_DESKTOP_SHELL").is_some()
    {
        tauri_build::build();
    }
}
