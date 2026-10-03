// 与原 preload 的主窗口/小窗隔离一致，小窗不能执行文件与采集器操作。
pub fn authorize(
    label: &str,
    scheme: &str,
    host: Option<&str>,
    path: &str,
    channel: Option<&str>,
) -> Result<(), String> {
    let expected = match label {
        "main" => "/renderer/index.html",
        "mini" => "/electron/mini/index.html",
        _ => return Err("不支持的页面请求。".into()),
    };
    if !local_page(scheme, host, path, expected) {
        return Err("不支持的页面请求。".into());
    }
    if label == "mini"
        && channel.is_some_and(|channel| !matches!(channel, "mini:open-main" | "mini:close"))
    {
        return Err("不支持的页面请求。".into());
    }
    Ok(())
}

pub fn local_page(scheme: &str, host: Option<&str>, path: &str, expected: &str) -> bool {
    (matches!(scheme, "http" | "https") && host == Some("tauri.localhost")
        || scheme == "tauri" && host == Some("localhost"))
        && path == expected
}

#[cfg(test)]
mod tests {
    use super::authorize;

    #[test]
    fn linux_protocol_has_the_same_window_and_channel_boundaries() {
        assert!(authorize(
            "main",
            "tauri",
            Some("localhost"),
            "/renderer/index.html",
            Some("backend:request")
        )
        .is_ok());
        assert!(authorize(
            "mini",
            "tauri",
            Some("localhost"),
            "/electron/mini/index.html",
            Some("mini:close")
        )
        .is_ok());
        assert!(authorize(
            "mini",
            "tauri",
            Some("localhost"),
            "/electron/mini/index.html",
            Some("files:save")
        )
        .is_err());
        for (scheme, host) in [
            ("http", "localhost"),
            ("tauri", "tauri.localhost"),
            ("tauri", "localhost.evil"),
            ("file", "localhost"),
        ] {
            assert!(authorize("main", scheme, Some(host), "/renderer/index.html", None).is_err());
        }
    }

    #[test]
    fn main_window_can_use_desktop_api_but_remote_pages_cannot() {
        assert!(authorize(
            "main",
            "http",
            Some("tauri.localhost"),
            "/renderer/index.html",
            Some("backend:request")
        )
        .is_ok());
        for (scheme, host, path) in [
            ("https", "example.com", "/renderer/index.html"),
            (
                "http",
                "tauri.localhost.example.com",
                "/renderer/index.html",
            ),
            ("file", "tauri.localhost", "/renderer/index.html"),
            ("http", "tauri.localhost", "/renderer/other.html"),
        ] {
            assert!(authorize("main", scheme, Some(host), path, Some("files:save")).is_err());
        }
    }

    #[test]
    fn mini_window_only_controls_its_own_lifecycle() {
        for channel in [None, Some("mini:open-main"), Some("mini:close")] {
            assert!(authorize(
                "mini",
                "http",
                Some("tauri.localhost"),
                "/electron/mini/index.html",
                channel
            )
            .is_ok());
        }
        for channel in [
            "backend:request",
            "files:open-backup",
            "app-control:request",
            "window-preferences:update",
        ] {
            assert!(authorize(
                "mini",
                "http",
                Some("tauri.localhost"),
                "/electron/mini/index.html",
                Some(channel)
            )
            .is_err());
        }
        assert!(authorize(
            "unknown",
            "http",
            Some("tauri.localhost"),
            "/renderer/index.html",
            None
        )
        .is_err());
    }
}
