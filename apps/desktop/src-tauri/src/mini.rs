use crate::mini_geometry::{pixels, size, Layout, Rect};
use serde_json::{json, Value};
use std::{
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    thread,
    time::{Duration, Instant},
};
use tauri::{
    Emitter, Manager, PhysicalPosition, PhysicalSize, WebviewUrl, WebviewWindow,
    WebviewWindowBuilder,
};
#[cfg(windows)]
use windows_sys::Win32::UI::Input::KeyboardAndMouse::{GetAsyncKeyState, VK_LBUTTON};

struct Instance {
    stop: AtomicBool,
    ready: AtomicBool,
    preferences: Mutex<Value>,
}

pub struct Controller {
    profile: PathBuf,
    current: Mutex<Option<Arc<Instance>>>,
}

impl Controller {
    pub fn new(profile: PathBuf) -> Self {
        Self {
            profile,
            current: Mutex::new(None),
        }
    }

    // Called on a worker: creating/destroying a WebView dispatches work to the main event loop.
    pub fn sync(&self, app: &tauri::AppHandle, preferences: &Value) -> Result<(), String> {
        let mut current = self.current.lock().unwrap();
        if preferences["miniWindow"] != true {
            if let Some(instance) = current.take() {
                instance.stop.store(true, Ordering::SeqCst);
            }
            if let Some(window) = app.get_webview_window("mini") {
                window.destroy().map_err(|error| error.to_string())?;
            }
            return Ok(());
        }
        if let Some(instance) = current
            .as_ref()
            .filter(|_| app.get_webview_window("mini").is_some())
        {
            *instance.preferences.lock().unwrap() = preferences.clone();
            return Ok(());
        }
        if let Some(instance) = current.take() {
            instance.stop.store(true, Ordering::SeqCst);
        }
        let monitor = app
            .primary_monitor()
            .map_err(|error| error.to_string())?
            .ok_or("无法获取显示器。")?;
        let scale = monitor.scale_factor();
        let area = work_area(&monitor);
        let shape = preferences["miniShape"].as_str().unwrap_or("bar");
        let (width, height) = size(shape, scale);
        let margin = pixels(12, scale);
        let background = std::env::var("WIFIMETER_BACKGROUND_TEST").as_deref() == Ok("1")
            && std::env::var_os("WIFIMETER_USER_DATA").is_some();
        let bounds = Rect {
            x: if background {
                -32000
            } else {
                area.x.max(area.x + area.width - width - margin)
            },
            y: if background {
                -32000
            } else {
                area.y.max(area.y + area.height - height - margin)
            },
            width,
            height,
        };
        let window = WebviewWindowBuilder::new(
            app,
            "mini",
            WebviewUrl::App("electron/mini/index.html".into()),
        )
        .title("WiFiMeter")
        .inner_size(width as f64 / scale, height as f64 / scale)
        .decorations(false)
        .resizable(false)
        .maximizable(false)
        .minimizable(false)
        .skip_taskbar(true)
        .always_on_top(true)
        .visible(false)
        .transparent(true)
        .background_color(tauri::window::Color(0, 0, 0, 0))
        .shadow(false)
        .focusable(false)
        .data_directory(self.profile.join(crate::identity::WEBVIEW_DIRECTORY))
        .initialization_script(crate::identity::platform_script())
        .on_navigation(|url| {
            crate::ipc_policy::local_page(
                url.scheme(),
                url.host_str(),
                url.path(),
                "/electron/mini/index.html",
            )
        })
        .build()
        .map_err(|error| error.to_string())?;
        window
            .set_position(PhysicalPosition::new(bounds.x, bounds.y))
            .map_err(|error| error.to_string())?;
        let instance = Arc::new(Instance {
            stop: AtomicBool::new(false),
            ready: AtomicBool::new(false),
            preferences: Mutex::new(preferences.clone()),
        });
        *current = Some(instance.clone());
        thread::spawn(move || {
            if let Err(error) = track(&window, &instance, bounds, background) {
                if !instance.stop.load(Ordering::SeqCst) {
                    eprintln!("[mini] {error}");
                }
            }
        });
        Ok(())
    }

    pub fn ready(&self) {
        if let Some(instance) = self.current.lock().unwrap().as_ref() {
            instance.ready.store(true, Ordering::SeqCst);
        }
    }

    pub fn stop(&self) {
        if let Some(instance) = self.current.lock().unwrap().take() {
            instance.stop.store(true, Ordering::SeqCst);
        }
    }
}

fn work_area(monitor: &tauri::Monitor) -> Rect {
    let area = monitor.work_area();
    Rect {
        x: area.position.x,
        y: area.position.y,
        width: area.size.width as i32,
        height: area.size.height as i32,
    }
}

fn actual_bounds(window: &WebviewWindow) -> tauri::Result<Rect> {
    let position = window.outer_position()?;
    let size = window.inner_size()?;
    Ok(Rect {
        x: position.x,
        y: position.y,
        width: size.width as i32,
        height: size.height as i32,
    })
}

fn apply_bounds(window: &WebviewWindow, desired: Rect, actual: Rect) -> tauri::Result<()> {
    if (desired.width, desired.height) != (actual.width, actual.height) {
        window.set_size(PhysicalSize::new(
            desired.width as u32,
            desired.height as u32,
        ))?;
    }
    if (desired.x, desired.y) != (actual.x, actual.y) {
        window.set_position(PhysicalPosition::new(desired.x, desired.y))?;
    }
    Ok(())
}

fn track(
    window: &WebviewWindow,
    instance: &Instance,
    bounds: Rect,
    background: bool,
) -> tauri::Result<()> {
    let clock = Instant::now();
    let mut layout = Layout::new(bounds);
    let mut previous = Value::Null;
    let mut display = None;
    let mut shown = false;
    let mut last_state = Value::Null;
    while !instance.stop.load(Ordering::SeqCst) {
        thread::sleep(Duration::from_millis(100));
        if !instance.ready.load(Ordering::SeqCst) {
            continue;
        }
        let preferences = instance.preferences.lock().unwrap().clone();
        let shape = preferences["miniShape"].as_str().unwrap_or("bar");
        let snapping = preferences["miniSnap"] == true;
        let auto_hide = preferences["miniAutoHide"] == true;
        let now = clock.elapsed().as_millis() as u64;
        let actual = actual_bounds(window)?;
        let monitor = window.current_monitor()?.or(window.primary_monitor()?);
        let Some(monitor) = monitor else {
            continue;
        };
        let scale = monitor.scale_factor();
        let area = work_area(&monitor);
        let changed_display = display != Some((area, scale));
        let resize = previous["miniShape"] != preferences["miniShape"] || changed_display;
        let changed_snap = previous["miniSnap"] != preferences["miniSnap"];
        if background {
            let (width, height) = size(shape, scale);
            layout.expanded = Rect {
                x: -32000,
                y: -32000,
                width,
                height,
            };
        } else {
            let expected = layout.bounds(display.map_or(scale, |(_, scale)| scale));
            let moved = actual != expected;
            #[cfg(windows)]
            let dragging = moved && unsafe { GetAsyncKeyState(VK_LBUTTON as i32) < 0 };
            #[cfg(target_os = "linux")]
            let dragging = moved && crate::linux_desktop::left_button_down(window.app_handle());
            if !dragging && (!shown || resize || changed_snap || moved) {
                let base = if layout.collapsed {
                    layout.expanded
                } else {
                    actual
                };
                layout.place(base, area, size(shape, scale), resize, snapping, scale, now);
            }
            let cursor = window.cursor_position()?;
            layout.hover(
                (cursor.x, cursor.y),
                snapping && auto_hide,
                dragging,
                scale,
                now,
            );
            if dragging {
                continue;
            }
        }
        let state = json!({"collapsed":layout.collapsed,"edge":layout.edge});
        if state != last_state {
            window.emit("mini:state", &state)?;
            last_state = state;
        }
        apply_bounds(window, layout.bounds(scale), actual)?;
        if !shown {
            window.show()?;
            shown = true;
        }
        previous = preferences;
        display = Some((area, scale));
    }
    Ok(())
}
