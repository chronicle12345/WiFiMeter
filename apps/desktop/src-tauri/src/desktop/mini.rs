use crate::mini_geometry::{pixels, reseat, size, Layout, Rect, Sample, COLLAPSE_STEP};
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

// 常态采样间隔；动效期间改用 COLLAPSE_STEP 逐帧落位。
const SAMPLE: u64 = 100;

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
            WebviewUrl::App("renderer/mini/index.html".into()),
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
                "/renderer/mini/index.html",
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
    let mut session = Session::new(bounds);
    while !instance.stop.load(Ordering::SeqCst) {
        let elapsed = clock.elapsed().as_millis() as u64;
        // 收起/展开动效要逐帧落位，其余时间保持低频采样。
        thread::sleep(Duration::from_millis(
            if session.layout.animating(elapsed) {
                COLLAPSE_STEP
            } else {
                SAMPLE
            },
        ));
        if !instance.ready.load(Ordering::SeqCst) {
            continue;
        }
        if let Err(error) = tick(window, instance, &mut session, background, &clock) {
            if instance.stop.load(Ordering::SeqCst) {
                break;
            }
            session.report(error);
        }
    }
    Ok(())
}

// 小窗一次采样的全部状态：布局、偏好、上一次观察到的位置和已处理的落点。
struct Session {
    layout: Layout,
    preferences: Value,
    display: Option<(Rect, f64)>,
    state: Value,
    shown: bool,
    observed: Option<Rect>,
    placed: Option<Rect>,
    last_move: u64,
    was_animating: bool,
    failure: Option<String>,
}

impl Session {
    fn new(bounds: Rect) -> Self {
        Self {
            layout: Layout::new(bounds),
            preferences: Value::Null,
            display: None,
            state: Value::Null,
            shown: false,
            observed: None,
            placed: None,
            last_move: 0,
            was_animating: false,
            failure: None,
        }
    }
    // 偶发失败不该让小窗从此不再吸附和隐藏，因此只记录错误变化，循环继续。
    fn report(&mut self, error: impl std::fmt::Display) {
        let message = error.to_string();
        if self.failure.as_deref() != Some(message.as_str()) {
            eprintln!("[mini] {message}");
            self.failure = Some(message);
        }
    }
}

// 平台能读到指针左键时用它判断拖动，读不到时由位置变化兜底。
#[cfg(windows)]
fn pointer_pressed(_window: &WebviewWindow) -> bool {
    unsafe { GetAsyncKeyState(VK_LBUTTON as i32) < 0 }
}

#[cfg(target_os = "linux")]
fn pointer_pressed(window: &WebviewWindow) -> bool {
    crate::linux_desktop::left_button_down(window.app_handle())
}

fn tick(
    window: &WebviewWindow,
    instance: &Instance,
    session: &mut Session,
    background: bool,
    clock: &Instant,
) -> tauri::Result<()> {
    let preferences = instance.preferences.lock().unwrap().clone();
    let shape = preferences["miniShape"].as_str().unwrap_or("bar");
    let snapping = preferences["miniSnap"] == true;
    let auto_hide = preferences["miniAutoHide"] == true;
    let now = clock.elapsed().as_millis() as u64;
    let actual = actual_bounds(window)?;
    let monitor = window.current_monitor()?.or(window.primary_monitor()?);
    let Some(monitor) = monitor else {
        return Ok(());
    };
    let scale = monitor.scale_factor();
    let area = work_area(&monitor);
    let (width, height) = size(shape, scale);
    let changed_display = session.display != Some((area, scale));
    let resize = session.preferences["miniShape"] != preferences["miniShape"] || changed_display;
    let reflow =
        !session.shown || resize || session.preferences["miniSnap"] != preferences["miniSnap"];
    let animating = session.layout.animating(now);
    let settling = session.layout.settling(now);
    if background {
        session.layout.expanded = Rect {
            x: -32000,
            y: -32000,
            width,
            height,
        };
    } else {
        let expected = session
            .layout
            .bounds(session.display.map_or(scale, |(_, scale)| scale));
        if session.observed != Some(actual) {
            session.last_move = now;
        }
        let sample = Sample {
            observed: actual,
            expected,
            previous: session.observed,
            placed: session.placed,
            reflow,
            collapsed: session.layout.collapsed,
            animating,
            settling,
            pressed: !animating && actual != expected && pointer_pressed(window),
            now,
            last_move: session.last_move,
        };
        let dragging = sample.dragging();
        if reseat(&sample) {
            // 收起时窗口只有一条边条，布局里的展开位置才是用户放下的位置。
            let settled = if session.layout.collapsed {
                session.layout.expanded
            } else {
                actual
            };
            session
                .layout
                .place(settled, area, (width, height), resize, snapping, scale, now);
            session.placed = Some(actual);
        }
        let cursor = window.cursor_position()?;
        session.layout.hover(
            (cursor.x, cursor.y),
            snapping && auto_hide,
            dragging,
            scale,
            now,
        );
        if dragging {
            session.observed = Some(actual);
            session.was_animating = animating;
            return Ok(());
        }
    }
    publish_state(window, session)?;
    // 动效期间按帧落位；动效刚结束的下一帧仍要补齐最后一帧，之后再遇到窗口不在目标位置上，
    // 更可能是用户刚把它放下：宽限期内不抢，等宽限期结束按落点重排。
    let frame = session.layout.frame(scale, now);
    let foreign = settling && !animating && !session.was_animating && actual != frame;
    // 记录"窗口这时应该在哪"：落到帧上就记帧，没抢的时候记读到的位置。
    if foreign {
        session.observed = Some(actual);
    } else {
        apply_bounds(window, frame, actual)?;
        session.observed = Some(frame);
    }
    if !session.shown {
        window.show()?;
        session.shown = true;
    }
    session.was_animating = animating;
    session.preferences = preferences;
    session.display = Some((area, scale));
    Ok(())
}

fn publish_state(window: &WebviewWindow, session: &mut Session) -> tauri::Result<()> {
    let state = json!({"collapsed":session.layout.collapsed,"edge":session.layout.edge});
    if state != session.state {
        window.emit("mini:state", &state)?;
        session.state = state;
    }
    Ok(())
}
