#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod dialogs;
mod host;
mod native;
mod security;

use host::Host;
use serde_json::Value;
use std::sync::{atomic::Ordering, Arc};
use tauri::{Manager, RunEvent, State, WebviewWindow, WindowEvent};

#[tauri::command]
async fn desktop_request(
    window: WebviewWindow,
    state: State<'_, Arc<Host>>,
    channel: String,
    args: Vec<Value>,
) -> Result<Value, String> {
    let label = window.label();
    if !security::allowed_channel(label, &channel) {
        return Err("不支持的页面请求。".into());
    }
    let page = format!("/{label}/index.html");
    let url = window.url().map_err(|error| error.to_string())?;
    if !native::trusted_url(&url, &page) {
        return Err("不支持的页面来源。".into());
    }
    if channel == "window:confirm-close" {
        let id = args
            .first()
            .and_then(|value| value["id"].as_u64())
            .ok_or("关闭确认无效。")?;
        let action = {
            let mut pending = state.close_action.lock().unwrap();
            if pending.as_ref().map(|entry| entry.0) != Some(id) {
                return Err("关闭确认已失效。".into());
            }
            pending.take().unwrap().1
        };
        let dirty = args
            .first()
            .and_then(|value| value["dirty"].as_bool())
            .unwrap_or(false);
        if dirty {
            let accepted = tauri::async_runtime::spawn_blocking(move || {
                rfd::MessageDialog::new()
                    .set_title("退出 WiFiMeter")
                    .set_description("有尚未保存的设置，仍然退出？")
                    .set_buttons(rfd::MessageButtons::OkCancelCustom(
                        "放弃更改并退出".into(),
                        "继续编辑".into(),
                    ))
                    .show()
                    == rfd::MessageDialogResult::Custom("放弃更改并退出".into())
            })
            .await
            .map_err(|error| error.to_string())?;
            if !accepted {
                if action["type"] == "native-result" {
                    let mut rejected = action;
                    rejected["result"] = Value::Bool(false);
                    state.send(rejected)?;
                }
                return Ok(Value::Bool(false));
            }
        }
        state.send(action)?;
        return Ok(Value::Bool(true));
    }
    if channel == "mini:drag" {
        state.send(
            serde_json::json!({ "type": "window-event", "window": "mini", "event": "will-move" }),
        )?;
        window.start_dragging().map_err(|error| error.to_string())?;
        return Ok(Value::Null);
    }
    state.request(label, channel, args).await
}

fn main() {
    #[cfg(windows)]
    unsafe {
        let app_id: Vec<u16> = "io.wifimeter.demo\0".encode_utf16().collect();
        windows_sys::Win32::UI::Shell::SetCurrentProcessExplicitAppUserModelID(app_id.as_ptr());
    }
    let host = Host::new();
    let setup_host = host.clone();
    let result = tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _, _| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.unminimize();
                let _ = window.show();
                let _ = window.set_focus();
            }
        }))
        .manage(host)
        .invoke_handler(tauri::generate_handler![desktop_request])
        .setup(move |app| {
            native::create_tray(app.handle(), setup_host.clone())?;
            host::start(app.handle(), setup_host.clone()).map_err(std::io::Error::other)?;
            Ok(())
        })
        .on_window_event(|window, event| {
            let state = window.state::<Arc<Host>>();
            match event {
                WindowEvent::CloseRequested { api, .. } => {
                    if !state.quitting.load(Ordering::SeqCst) {
                        api.prevent_close();
                        let action = serde_json::json!({ "type": "window-event",
                            "window": window.label(), "event": "close" });
                        let _ = state.send(action);
                    }
                }
                WindowEvent::Destroyed => {
                    let _ = state.send(serde_json::json!({ "type": "window-event",
                    "window": window.label(), "event": "closed" }));
                }
                WindowEvent::Moved(_) | WindowEvent::Resized(_) => {
                    if let Some(webview) = window.app_handle().get_webview_window(window.label()) {
                        native::window_event(
                            &state,
                            &webview,
                            if matches!(event, WindowEvent::Moved(_)) {
                                "moved"
                            } else {
                                "resized"
                            },
                        );
                    }
                }
                _ => {}
            }
        })
        .build(tauri::generate_context!());
    match result {
        Ok(app) => app.run(|handle, event| {
            let state = handle.state::<Arc<Host>>();
            if let RunEvent::ExitRequested { api, code, .. } = event {
                if code.is_none() && !state.quitting.load(Ordering::SeqCst) {
                    api.prevent_exit();
                    let _ = state.send(serde_json::json!({ "type": "window-event", "window": "main", "event": "close" }));
                }
            }
        }),
        Err(error) => {
            eprintln!("[desktop] {error}");
            rfd::MessageDialog::new().set_title("WiFiMeter").set_level(rfd::MessageLevel::Error)
                .set_description(format!("无法启动 WiFiMeter。\n{error}")).show();
            std::process::exit(1);
        }
    }
}
