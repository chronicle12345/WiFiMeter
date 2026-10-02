use crate::{
    backend::{Backend, BackendError},
    collector::Collector,
    files, identity, ipc_policy, native_dialog,
    preferences::Preferences,
};
use serde_json::{json, Value};
use std::{
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    time::Duration,
};
use tauri::{Emitter, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder};
use tauri_plugin_dialog::DialogExt;

struct Desktop {
    collector: Collector,
    preferences: Preferences,
    last_live: Mutex<Option<Value>>,
    quitting: AtomicBool,
    closing: AtomicBool,
}

fn trusted(window: &WebviewWindow, channel: Option<&str>) -> Result<(), String> {
    let url = window.url().map_err(|error| error.to_string())?;
    ipc_policy::authorize(
        window.label(),
        url.scheme(),
        url.host_str(),
        url.path(),
        channel,
    )
}

fn show_main(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
        let _ = window.emit("window:visibility", true);
    }
}

fn publish_preferences(app: &tauri::AppHandle) -> Result<Value, String> {
    let state = app.state::<Desktop>();
    let value = state.preferences.read();
    app.emit("window-preferences:changed", &value)
        .map_err(|error| error.to_string())?;
    Ok(value)
}

#[tauri::command]
async fn desktop_request(
    window: WebviewWindow,
    channel: String,
    payload: Option<Value>,
) -> Result<Value, String> {
    trusted(&window, Some(&channel))?;
    let app = window.app_handle().clone();
    // IPC、磁盘写入和原生对话框在阻塞线程执行，避免冻结 WebView UI。
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<Desktop>();
        let payload = payload.unwrap_or(Value::Null);
        match channel.as_str() {
            "backend:request" => {
                let method = payload["method"].as_str().unwrap_or("");
                let params = payload.get("params").cloned().unwrap_or_else(|| json!({}));
                Ok(
                    match state
                        .collector
                        .request(method, params, || native_dialog::confirm_resume(&window))
                    {
                        Ok(result) => json!({"ok":true,"result":result}),
                        Err(error) => json!({"ok":false,"error":error}),
                    },
                )
            }
            "legacy:status" => Ok(state.collector.migration_status()),
            "legacy:import" => Ok(state.collector.import_selected(
                || {
                    let mut dialog = app
                        .dialog()
                        .file()
                        .set_parent(&window)
                        .set_title("Import WiFiMeter 1.x data / 导入旧版数据");
                    if let Some(directory) =
                        legacy_directory().or_else(|| app.path().document_dir().ok())
                    {
                        dialog = dialog.set_directory(directory);
                    }
                    dialog
                        .blocking_pick_folder()
                        .map(|selected| {
                            selected
                                .into_path()
                                .map_err(|error| BackendError::new("unavailable", error))
                        })
                        .transpose()
                },
                || native_dialog::confirm_overlap(&window),
            )),
            "window-preferences:read" => Ok(state.preferences.read()),
            "window-preferences:update" => {
                state
                    .preferences
                    .update(payload)
                    .map_err(|error| error.to_string())?;
                publish_preferences(&app)
            }
            "files:save" => {
                let save = || -> Result<Value, String> {
                    let body = payload["body"].as_str().ok_or("文件内容无效。")?;
                    let name = payload["filename"].as_str().ok_or("文件内容无效。")?;
                    let filename =
                        files::export_filename(name, body).map_err(|error| error.to_string())?;
                    let extension = filename.rsplit('.').next().unwrap();
                    let selected = app
                        .dialog()
                        .file()
                        .set_parent(&window)
                        .set_title("保存 WiFiMeter 数据")
                        .set_file_name(&filename)
                        .add_filter(extension.to_uppercase(), &[extension])
                        .blocking_save_file();
                    let Some(selected) = selected else {
                        return Ok(json!({"canceled":true}));
                    };
                    let path = selected.into_path().map_err(|error| error.to_string())?;
                    files::atomic_write(&path, body.as_bytes())
                        .map_err(|error| error.to_string())?;
                    Ok(json!({"canceled":false}))
                };
                Ok(save().unwrap_or_else(|error| json!({"error":format!("保存失败：{error}")})))
            }
            "files:open-backup" => {
                let open = || -> Result<Value, String> {
                    let selected = app
                        .dialog()
                        .file()
                        .set_parent(&window)
                        .set_title("恢复 WiFiMeter 备份")
                        .add_filter("JSON 备份", &["json"])
                        .blocking_pick_file();
                    let Some(selected) = selected else {
                        return Ok(json!({"canceled":true}));
                    };
                    let path = selected.into_path().map_err(|error| error.to_string())?;
                    let body = files::read_backup(&path).map_err(|error| error.to_string())?;
                    Ok(json!({"body":body,"canceled":false}))
                };
                Ok(
                    open()
                        .unwrap_or_else(|error| json!({"error":format!("无法读取备份：{error}")})),
                )
            }
            "mini:open-main" => {
                show_main(&app);
                Ok(Value::Null)
            }
            "mini:close" => {
                state
                    .preferences
                    .update(json!({"miniWindow":false}))
                    .map_err(|error| error.to_string())?;
                if let Some(mini) = app.get_webview_window("mini") {
                    mini.destroy().map_err(|error| error.to_string())?;
                }
                publish_preferences(&app)
            }
            _ => Err(format!("尚未迁移的桌面操作：{channel}")),
        }
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
fn desktop_ready(window: WebviewWindow) -> Result<(), String> {
    trusted(&window, None)?;
    let state = window.state::<Desktop>();
    window
        .emit("window-preferences:changed", state.preferences.read())
        .map_err(|error| error.to_string())?;
    if window.label() == "main" {
        window
            .emit("window:visibility", window.is_visible().unwrap_or(false))
            .map_err(|error| error.to_string())?;
    } else {
        window
            .emit("mini:state", json!({"collapsed":false,"edge":null}))
            .map_err(|error| error.to_string())?;
        if let Some(live) = state.last_live.lock().unwrap().as_ref() {
            window
                .emit("mini:live", live)
                .map_err(|error| error.to_string())?;
        }
    }
    Ok(())
}

fn legacy_directory() -> Option<PathBuf> {
    identity::legacy_directory(
        std::env::var_os("LOCALAPPDATA")
            .map(PathBuf::from)
            .as_deref(),
        std::env::var_os("WIFIMETER_USER_DATA").is_some(),
        std::env::var_os("WIFIMETER_LEGACY_DIRECTORY")
            .map(PathBuf::from)
            .as_deref(),
    )
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _, _| {
            show_main(app)
        }))
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![desktop_request, desktop_ready])
        .setup(|app| {
            let override_directory = std::env::var_os("WIFIMETER_USER_DATA").map(PathBuf::from);
            let app_data = app.path().data_dir()?;
            let profile = identity::profile_directory(&app_data, override_directory.as_deref());
            std::fs::create_dir_all(&profile)?;
            let executable = std::env::var_os("WIFIMETER_BACKEND")
                .map(PathBuf::from)
                .unwrap_or_else(|| {
                    app.path()
                        .resource_dir()
                        .unwrap()
                        .join("wifimeter-backend.exe")
                });
            let handle = app.handle().clone();
            let backend = Arc::new(Backend::new(
                executable,
                profile.join("wifimeter.db"),
                vec!["--paused".into()],
                Arc::new(move |message| {
                    if let Some(main) = handle.get_webview_window("main") {
                        let _ = main.emit("backend:event", &message);
                    }
                    if message["event"] == "live" {
                        if let Some(state) = handle.try_state::<Desktop>() {
                            *state.last_live.lock().unwrap() = Some(message.clone());
                        }
                        if let Some(mini) = handle.get_webview_window("mini") {
                            let _ = mini.emit("mini:live", &message);
                        }
                    }
                }),
            ));
            app.manage(Desktop {
                collector: Collector::new(backend, profile.clone(), legacy_directory()),
                preferences: Preferences::load(profile.clone()),
                last_live: Mutex::new(None),
                quitting: AtomicBool::new(false),
                closing: AtomicBool::new(false),
            });
            WebviewWindowBuilder::new(app, "main", WebviewUrl::App("renderer/index.html".into()))
                .title(identity::PRODUCT_NAME)
                .inner_size(1280.0, 900.0)
                .min_inner_size(900.0, 650.0)
                .data_directory(profile.join("WebView2"))
                .on_navigation(|url| {
                    url.host_str() == Some("tauri.localhost")
                        && url.path() == "/renderer/index.html"
                })
                .build()?;
            let handle = app.handle().clone();
            tauri::async_runtime::spawn_blocking(move || {
                let state = handle.state::<Desktop>();
                let migration = state.collector.migration_status();
                if let Some(error) = migration["error"].as_str().filter(|error| !error.is_empty()) {
                    handle.dialog().message(format!("{error}\nCollection is paused. Original files are unchanged. / 统计已暂停，原文件未修改。"))
                        .title("WiFiMeter data import / 数据导入").blocking_show();
                }
            });
            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                if !window.state::<Desktop>().quitting.load(Ordering::SeqCst) {
                    api.prevent_close();
                    window.app_handle().exit(0);
                }
            }
        })
        .build(tauri::generate_context!())
        .expect("Unable to start WiFiMeter")
        .run(|app, event| {
            if let tauri::RunEvent::ExitRequested { api, .. } = event {
                let state = app.state::<Desktop>();
                if state.quitting.load(Ordering::SeqCst) {
                    return;
                }
                api.prevent_exit();
                if state.closing.swap(true, Ordering::SeqCst) {
                    return;
                }
                let app = app.clone();
                tauri::async_runtime::spawn_blocking(move || {
                    let state = app.state::<Desktop>();
                    match state.collector.stop_gracefully(Duration::from_secs(30)) {
                        Ok(()) => {
                            state.quitting.store(true, Ordering::SeqCst);
                            app.exit(0);
                        }
                        Err(error) => {
                            state.closing.store(false, Ordering::SeqCst);
                            show_main(&app);
                            app.dialog()
                                .message(error.message)
                                .title("WiFiMeter")
                                .blocking_show();
                        }
                    }
                });
            }
        });
}
