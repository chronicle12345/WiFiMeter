use crate::{
    backend::{Backend, BackendError},
    close_check::CloseCheck,
    collector::Collector,
    dialog_requests::DialogRequests,
    files, identity, ipc_policy, native_dialog,
    preferences::Preferences,
    tray,
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
    close_prompt: AtomicBool,
    main_ready: AtomicBool,
    close_check: CloseCheck,
    dialogs: DialogRequests,
    settings: Mutex<Value>,
    tray_lock: Mutex<()>,
}

pub(crate) fn localized<'a>(app: &tauri::AppHandle, chinese: &'a str, english: &'a str) -> &'a str {
    if app.state::<Desktop>().settings.lock().unwrap()["language"] == "en" {
        english
    } else {
        chinese
    }
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

pub(crate) fn show_main(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
        let _ = window.emit("window:visibility", true);
    }
}

fn ensure_tray(app: &tauri::AppHandle) -> Result<(), String> {
    let state = app.state::<Desktop>();
    let _tray = state.tray_lock.lock().unwrap();
    let language = state.settings.lock().unwrap()["language"]
        .as_str()
        .unwrap_or("zh-CN")
        .to_string();
    tray::ensure(app, &language).map_err(|error| error.to_string())
}

fn apply_runtime_settings(app: &tauri::AppHandle, settings: &Value) {
    *app.state::<Desktop>().settings.lock().unwrap() = settings.clone();
    if let Err(error) = ensure_tray(app) {
        eprintln!("[tray] {error}");
    }
}

fn close_main(window: WebviewWindow) {
    let app = window.app_handle().clone();
    let state = app.state::<Desktop>();
    let result = (|| -> Result<(), String> {
        let preferences = state.preferences.read();
        let action = preferences["closeAction"].as_str().unwrap_or("tray");
        let (action, remember) = if action == "ask" {
            let Some(choice) = native_dialog::close_action(&window) else {
                return Ok(());
            };
            choice
        } else {
            (action, false)
        };
        if action == "tray" {
            ensure_tray(&app)?;
            window.hide().map_err(|error| error.to_string())?;
            let _ = window.emit("window:visibility", false);
        }
        if remember {
            state
                .preferences
                .update(json!({"closeAction":action}))
                .map_err(|error| error.to_string())?;
            publish_preferences(&app)?;
        }
        if action == "exit" {
            app.exit(0);
        }
        Ok(())
    })();
    state.close_prompt.store(false, Ordering::SeqCst);
    if let Err(error) = result {
        show_main(&app);
        app.dialog()
            .message(error)
            .title("WiFiMeter")
            .blocking_show();
    }
}

fn can_quit(app: &tauri::AppHandle) -> Result<bool, String> {
    let state = app.state::<Desktop>();
    let Some(window) = app.get_webview_window("main") else {
        return Ok(true);
    };
    if !state.main_ready.load(Ordering::SeqCst) {
        return Ok(true);
    }
    let (id, response) = state.close_check.begin();
    let result = window
        .emit("window:before-close", id)
        .map_err(|error| error.to_string())
        .and_then(|_| {
            response
                .recv_timeout(Duration::from_secs(5))
                .map_err(|_| "窗口尚未完成保存检查，请稍后重试。".to_string())
        });
    state.close_check.cancel(id);
    Ok(!result? || native_dialog::confirm_discard(&window))
}

#[tauri::command]
fn desktop_close_reply(window: WebviewWindow, id: u64, dirty: bool) -> Result<(), String> {
    trusted(&window, Some("window:close-reply"))?;
    window.state::<Desktop>().close_check.reply(id, dirty);
    Ok(())
}

// Only called from blocking workers; the WebView remains responsive while the user decides.
pub(crate) fn themed_dialog(
    window: &WebviewWindow,
    kind: &str,
    buttons: usize,
) -> Option<crate::dialog_requests::Answer> {
    let state = window.state::<Desktop>();
    if !state.main_ready.load(Ordering::SeqCst) {
        return None;
    }
    let (id, response) = state.dialogs.begin(buttons);
    show_main(window.app_handle());
    if window
        .emit("desktop:dialog", json!({"id":id,"kind":kind}))
        .is_err()
    {
        state.dialogs.reply(id, None, false);
    }
    Some(response.recv().ok().flatten())
}

#[tauri::command]
fn desktop_dialog_reply(
    window: WebviewWindow,
    id: u64,
    button: Option<usize>,
    remember: bool,
) -> Result<(), String> {
    trusted(&window, Some("window:dialog-reply"))?;
    window
        .state::<Desktop>()
        .dialogs
        .reply(id, button, remember);
    Ok(())
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
                        Ok(result) => {
                            if method == "updateSettings" && result["settings"].is_object() {
                                apply_runtime_settings(&app, &result["settings"]);
                            }
                            json!({"ok":true,"result":result})
                        }
                        Err(error) => json!({"ok":false,"error":error}),
                    },
                )
            }
            "legacy:status" => Ok(state.collector.migration_status()),
            "legacy:import" => Ok(state.collector.import_selected(
                || {
                    let mut dialog = app.dialog().file().set_parent(&window).set_title(localized(
                        &app,
                        "导入旧版数据",
                        "Import old data",
                    ));
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
                        .set_title(localized(
                            &app,
                            "保存 WiFiMeter 数据",
                            "Save WiFiMeter data",
                        ))
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
                        .set_title(localized(
                            &app,
                            "恢复 WiFiMeter 备份",
                            "Restore WiFiMeter backup",
                        ))
                        .add_filter(localized(&app, "JSON 备份", "JSON backup"), &["json"])
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
        state.main_ready.store(true, Ordering::SeqCst);
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
        .invoke_handler(tauri::generate_handler![
            desktop_request,
            desktop_ready,
            desktop_close_reply,
            desktop_dialog_reply
        ])
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
                close_prompt: AtomicBool::new(false),
                main_ready: AtomicBool::new(false),
                close_check: CloseCheck::default(),
                dialogs: DialogRequests::default(),
                settings: Mutex::new(json!({"language":"zh-CN"})),
                tray_lock: Mutex::new(()),
            });
            WebviewWindowBuilder::new(app, "main", WebviewUrl::App("renderer/index.html".into()))
                .title(identity::PRODUCT_NAME)
                .inner_size(1280.0, 900.0)
                .min_inner_size(900.0, 650.0)
                .data_directory(profile.join("WebView2"))
                .on_page_load(|window, payload| {
                    if matches!(payload.event(), tauri::webview::PageLoadEvent::Started) {
                        let state = window.state::<Desktop>();
                        state.main_ready.store(false, Ordering::SeqCst);
                        state.dialogs.cancel_all();
                    }
                })
                .on_navigation(|url| {
                    url.host_str() == Some("tauri.localhost")
                        && url.path() == "/renderer/index.html"
                })
                .build()?;
            if let Err(error) = ensure_tray(app.handle()) {
                eprintln!("[tray] {error}");
            }
            let handle = app.handle().clone();
            tauri::async_runtime::spawn_blocking(move || {
                let state = handle.state::<Desktop>();
                let migration = state.collector.migration_status();
                if let Ok(hello) = state.collector.request("hello", json!({}), || false) {
                    apply_runtime_settings(&handle, &hello["settings"]);
                }
                if let Some(error) = migration["error"]
                    .as_str()
                    .filter(|error| !error.is_empty())
                {
                    handle
                        .dialog()
                        .message(format!(
                            "{error}\n{}",
                            localized(
                                &handle,
                                "统计已暂停，原文件未修改。",
                                "Collection is paused. Original files are unchanged."
                            )
                        ))
                        .title(localized(&handle, "数据导入", "Data import"))
                        .blocking_show();
                }
            });
            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                if !window.state::<Desktop>().quitting.load(Ordering::SeqCst) {
                    api.prevent_close();
                    let state = window.state::<Desktop>();
                    if window.label() == "main" && !state.close_prompt.swap(true, Ordering::SeqCst)
                    {
                        if let Some(window) = window.app_handle().get_webview_window("main") {
                            tauri::async_runtime::spawn_blocking(move || close_main(window));
                        }
                    }
                }
            }
            if window.label() == "main"
                && matches!(
                    event,
                    tauri::WindowEvent::Focused(_) | tauri::WindowEvent::Resized(_)
                )
            {
                let visible =
                    window.is_visible().unwrap_or(false) && !window.is_minimized().unwrap_or(false);
                let _ = window.emit("window:visibility", visible);
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
                    match can_quit(&app) {
                        Ok(true) => (),
                        result => {
                            state.closing.store(false, Ordering::SeqCst);
                            if let Err(error) = result {
                                show_main(&app);
                                app.dialog()
                                    .message(error)
                                    .title("WiFiMeter")
                                    .blocking_show();
                            }
                            return;
                        }
                    }
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
