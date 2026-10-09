use crate::host::{Host, Reply};
use serde_json::{json, Value};
use std::sync::Arc;
use tauri::{
    menu::{Menu, MenuItem, PredefinedMenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    webview::{NewWindowResponse, PageLoadEvent},
    AppHandle, LogicalPosition, LogicalSize, Manager, WebviewUrl, WebviewWindow,
    WebviewWindowBuilder,
};

pub fn trusted_url(url: &tauri::Url, page: &str) -> bool {
    let local = matches!(
        (url.scheme(), url.host_str()),
        ("http" | "https", Some("tauri.localhost")) | ("tauri", Some("localhost"))
    );
    local && url.path() == page
}

pub fn create_tray(app: &AppHandle, host: Arc<Host>) -> tauri::Result<()> {
    let open = MenuItem::with_id(app, "0", "打开 WiFiMeter", true, None::<&str>)?;
    let separator = PredefinedMenuItem::separator(app)?;
    let quit = MenuItem::with_id(app, "2", "退出", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&open, &separator, &quit])?;
    let menu_host = host.clone();
    TrayIconBuilder::with_id("desktop")
        .icon(
            app.default_window_icon()
                .expect("desktop icon is configured")
                .clone(),
        )
        .tooltip("WiFiMeter")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(move |app, event| {
            let action = json!({ "type": "tray-event", "event": "menu", "id": event.id.as_ref() });
            let _ = app;
            let _ = menu_host.send(action);
        })
        .on_tray_icon_event(move |_, event| {
            if matches!(
                event,
                TrayIconEvent::Click {
                    button: MouseButton::Left,
                    button_state: MouseButtonState::Up,
                    ..
                }
            ) {
                let _ = host.send(json!({ "type": "tray-event", "event": "click" }));
            }
        })
        .build(app)?;
    Ok(())
}

fn number(options: &Value, name: &str, fallback: f64) -> f64 {
    options[name]
        .as_f64()
        .filter(|value| value.is_finite())
        .unwrap_or(fallback)
}

fn boolean(options: &Value, name: &str, fallback: bool) -> bool {
    options[name].as_bool().unwrap_or(fallback)
}

fn create_window(app: &AppHandle, host: Arc<Host>, label: &str, page: &str) -> Reply {
    if label != page || !matches!(label, "main" | "mini") {
        return Err("窗口页面无效。".into());
    }
    if app.get_webview_window(label).is_some() {
        return Err("窗口已经存在。".into());
    }
    let options = host
        .options
        .lock()
        .unwrap()
        .get(label)
        .cloned()
        .ok_or("窗口尚未创建。")?;
    let path = format!("{page}/index.html");
    let trusted_path = format!("/{path}");
    let page_host = host.clone();
    let mut builder = WebviewWindowBuilder::new(app, label, WebviewUrl::App(path.into()))
        .title(options["title"].as_str().unwrap_or("WiFiMeter"))
        .inner_size(
            number(&options, "width", 1280.0),
            number(&options, "height", 900.0),
        )
        .resizable(boolean(&options, "resizable", true))
        .maximizable(boolean(&options, "maximizable", true))
        .minimizable(boolean(&options, "minimizable", true))
        .decorations(boolean(&options, "frame", true))
        .visible(boolean(&options, "show", true))
        .focusable(boolean(&options, "focusable", true))
        .skip_taskbar(boolean(&options, "skipTaskbar", false))
        .always_on_top(boolean(&options, "alwaysOnTop", false))
        .transparent(boolean(&options, "transparent", false))
        .shadow(boolean(&options, "hasShadow", true))
        .devtools(cfg!(debug_assertions))
        .disable_drag_drop_handler()
        .initialization_script(include_str!("../../tauri/bridge.js"))
        .on_navigation(move |url| trusted_url(url, &trusted_path))
        .on_new_window(|_, _| NewWindowResponse::Deny)
        .on_page_load(move |window, payload| {
            if payload.event() == PageLoadEvent::Finished {
                page_host
                    .loaded
                    .lock()
                    .unwrap()
                    .insert(window.label().to_string());
                window_event(&page_host, &window, "did-finish-load");
            }
        });
    if let Some(user_data) = host.user_data.lock().unwrap().as_ref() {
        builder = builder.data_directory(user_data.join("webview2"));
    }
    if let Some(icon) = app.default_window_icon() {
        builder = builder
            .icon(icon.clone())
            .map_err(|error| error.to_string())?;
    }
    if options["minWidth"].is_number() || options["minHeight"].is_number() {
        builder = builder.min_inner_size(
            number(&options, "minWidth", 1.0),
            number(&options, "minHeight", 1.0),
        );
    }
    if options["x"].is_number() && options["y"].is_number() {
        builder = builder.position(number(&options, "x", 0.0), number(&options, "y", 0.0));
    } else {
        builder = builder.center();
    }
    if label == "mini" {
        builder = builder.background_color(tauri::window::Color(0, 0, 0, 0));
    }
    if std::env::var("WIFIMETER_SOFTWARE_RENDERING").as_deref() == Ok("1") {
        builder = builder.additional_browser_args("--disable-gpu");
    }
    let window = builder.build().map_err(|error| error.to_string())?;
    Ok(json!({ "bounds": bounds(&window), "visible": window.is_visible().unwrap_or(false) }))
}

fn bounds(window: &WebviewWindow) -> Value {
    let scale = window.scale_factor().unwrap_or(1.0);
    let position = window
        .outer_position()
        .unwrap_or_default()
        .to_logical::<f64>(scale);
    let size = window
        .outer_size()
        .unwrap_or_default()
        .to_logical::<f64>(scale);
    json!({ "x": position.x.round(), "y": position.y.round(), "width": size.width.round(), "height": size.height.round() })
}

pub fn window_event(host: &Host, window: &WebviewWindow, event: &str) {
    let _ = host.send(
        json!({ "type": "window-event", "window": window.label(), "event": event,
        "bounds": bounds(window), "visible": window.is_visible().unwrap_or(false),
        "minimized": window.is_minimized().unwrap_or(false) }),
    );
}

pub fn screen_info(app: &AppHandle) -> Value {
    let primary = app.primary_monitor().ok().flatten();
    let mut monitors = app.available_monitors().unwrap_or_default();
    if let Some(primary) = primary {
        monitors.sort_by_key(|monitor| monitor.position() != primary.position());
    }
    let physical_cursor = app.cursor_position().unwrap_or_default();
    let cursor_scale = monitors
        .iter()
        .find(|monitor| {
            let position = monitor.position();
            let size = monitor.size();
            physical_cursor.x >= position.x as f64
                && physical_cursor.x < position.x as f64 + size.width as f64
                && physical_cursor.y >= position.y as f64
                && physical_cursor.y < position.y as f64 + size.height as f64
        })
        .map(|monitor| monitor.scale_factor())
        .unwrap_or(1.0);
    let displays: Vec<Value> = monitors.iter().enumerate().map(|(id, monitor)| {
        let scale = monitor.scale_factor();
        let area = monitor.work_area();
        json!({ "id": id, "scaleFactor": scale,
            "bounds": { "x": (monitor.position().x as f64 / scale).round(), "y": (monitor.position().y as f64 / scale).round(),
                "width": (monitor.size().width as f64 / scale).round(), "height": (monitor.size().height as f64 / scale).round() },
            "workArea": { "x": (area.position.x as f64 / scale).round(), "y": (area.position.y as f64 / scale).round(),
                "width": (area.size.width as f64 / scale).round(), "height": (area.size.height as f64 / scale).round() } })
    }).collect();
    json!({ "type": "screen", "cursor": { "x": (physical_cursor.x / cursor_scale).round(),
        "y": (physical_cursor.y / cursor_scale).round() }, "displays": displays })
}

pub fn dispatch(app: &AppHandle, host: Arc<Host>, message: Value) {
    let method = message["method"].as_str().unwrap_or("").to_string();
    let params = message["params"].clone();
    let id = message["id"].clone();
    let app = app.clone();
    if method == "app:confirmQuit" {
        host.request_close(&app, json!({ "type": "native-result", "id": id, "ok": true, "result": true }));
        return;
    }
    if method.starts_with("dialog:") || method == "notification:show" || method == "window:load" {
        std::thread::spawn(move || {
            // WebView2 must create additional windows outside a synchronous event handler.
            let reply = if method == "window:load" {
                native_command(&app, host.clone(), &method, &params)
            } else if method == "notification:show" {
                crate::dialogs::notify(&params)
            } else {
                crate::dialogs::dialog(&app, &method, &params)
            };
            host.native_response(id, reply);
        });
    } else {
        let callback_app = app.clone();
        let error_host = host.clone();
        let error_id = id.clone();
        if let Err(error) = app.run_on_main_thread(move || {
            host.native_response(
                id,
                native_command(&callback_app, host.clone(), &method, &params),
            );
        }) {
            error_host.native_response(error_id, Err(error.to_string()));
        }
    }
}

fn native_command(app: &AppHandle, host: Arc<Host>, method: &str, params: &Value) -> Reply {
    if method.starts_with("window:") {
        let label = params["label"].as_str().ok_or("缺少窗口名称。")?;
        if !matches!(label, "main" | "mini") {
            return Err("窗口名称无效。".into());
        }
        match method {
            "window:create" => {
                host.options
                    .lock()
                    .unwrap()
                    .insert(label.to_string(), params["options"].clone());
                return Ok(Value::Null);
            }
            "window:load" => {
                return create_window(app, host, label, params["page"].as_str().unwrap_or(""))
            }
            "window:destroy" => {
                host.loaded.lock().unwrap().remove(label);
                host.options.lock().unwrap().remove(label);
                if let Some(window) = app.get_webview_window(label) {
                    window.destroy().map_err(|error| error.to_string())?;
                }
                return Ok(Value::Null);
            }
            _ => {}
        }
        let window = app.get_webview_window(label).ok_or("窗口不存在。")?;
        let result = match method {
            "window:show" => window.show(),
            "window:hide" => window.hide(),
            "window:focus" => window.set_focus(),
            "window:minimize" => window.minimize(),
            "window:restore" => window.unminimize(),
            "window:setFocusable" => window.set_focusable(boolean(params, "focusable", false)),
            "window:setBounds" => {
                if params["width"].is_number() && params["height"].is_number() {
                    window
                        .set_size(LogicalSize::new(
                            number(params, "width", 1.0).max(1.0),
                            number(params, "height", 1.0).max(1.0),
                        ))
                        .map_err(|error| error.to_string())?;
                }
                if params["x"].is_number() && params["y"].is_number() {
                    window
                        .set_position(LogicalPosition::new(
                            number(params, "x", 0.0),
                            number(params, "y", 0.0),
                        ))
                        .map_err(|error| error.to_string())?;
                }
                Ok(())
            }
            _ => return Err(format!("未知窗口操作：{method}")),
        };
        result.map_err(|error| error.to_string())?;
        let event = match method {
            "window:show" => "show",
            "window:hide" => "hide",
            "window:minimize" => "minimize",
            "window:restore" => "restore",
            _ => "bounds",
        };
        window_event(&host, &window, event);
        return Ok(Value::Null);
    }
    match method {
        "shell:open" => {
            let input = params["url"].as_str().ok_or("链接无效。")?;
            let url = tauri::Url::parse(input).map_err(|error| error.to_string())?;
            if !matches!(url.scheme(), "http" | "https") || url.host_str().is_none() {
                return Err("仅支持 HTTP 和 HTTPS 链接。".into());
            }
            open::that(input).map_err(|error| error.to_string())?;
        }
        "tray:tooltip" => {
            app.tray_by_id("desktop")
                .ok_or("托盘不可用。")?
                .set_tooltip(params["value"].as_str())
                .map_err(|error| error.to_string())?;
        }
        "tray:menu" => {
            let menu = Menu::new(app).map_err(|error| error.to_string())?;
            for item in params["items"].as_array().ok_or("托盘菜单无效。")? {
                if item["separator"].as_bool() == Some(true) {
                    menu.append(
                        &PredefinedMenuItem::separator(app).map_err(|error| error.to_string())?,
                    )
                    .map_err(|error| error.to_string())?;
                } else {
                    menu.append(
                        &MenuItem::with_id(
                            app,
                            item["id"].as_str().ok_or("菜单 ID 无效。")?,
                            item["label"].as_str().unwrap_or(""),
                            true,
                            None::<&str>,
                        )
                        .map_err(|error| error.to_string())?,
                    )
                    .map_err(|error| error.to_string())?;
                }
            }
            app.tray_by_id("desktop")
                .ok_or("托盘不可用。")?
                .set_menu(Some(menu))
                .map_err(|error| error.to_string())?;
        }
        _ => return Err(format!("未知原生操作：{method}")),
    }
    Ok(Value::Null)
}
