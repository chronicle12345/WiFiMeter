pub fn allowed_channel(window: &str, channel: &str) -> bool {
    match window {
        "main" => matches!(
            channel,
            "backend:request"
                | "files:save"
                | "files:open-backup"
                | "app-icons:get"
                | "app-control:choose"
                | "app-control:request"
                | "app-control:list"
                | "legacy:status"
                | "legacy:import"
                | "window-preferences:read"
                | "window-preferences:update"
                | "updates:open-link"
                | "updates:status"
                | "updates:setting"
                | "updates:check"
                | "updates:download"
                | "updates:install"
                | "window:confirm-close"
        ),
        "mini" => matches!(channel, "mini:open-main" | "mini:close" | "mini:drag"
            | "mini:preferences-read" | "mini:preferences-update" | "mini:applications"),
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use super::allowed_channel;

    #[test]
    fn main_and_mini_have_separate_native_permissions() {
        assert!(allowed_channel("main", "backend:request"));
        assert!(allowed_channel("mini", "mini:open-main"));
        assert!(!allowed_channel("mini", "backend:request"));
        assert!(!allowed_channel("main", "mini:open-main"));
        assert!(!allowed_channel("other", "files:save"));
        assert!(!allowed_channel("main", "shell:open"));
        assert!(allowed_channel("main", "app-control:list"));
        assert!(allowed_channel("main", "updates:download"));
        assert!(!allowed_channel("mini", "updates:download"));
        assert!(!allowed_channel("mini", "app-control:list"));
    }
}
