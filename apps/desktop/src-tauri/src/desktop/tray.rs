use tauri::{
    menu::{Menu, MenuItem, PredefinedMenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle,
};

pub fn ensure(app: &AppHandle, language: &str) -> tauri::Result<()> {
    let english = language == "en";
    let open = MenuItem::with_id(
        app,
        "open",
        if english {
            "Open WiFiMeter"
        } else {
            "打开 WiFiMeter"
        },
        true,
        None::<&str>,
    )?;
    let quit = MenuItem::with_id(
        app,
        "quit",
        if english { "Quit" } else { "退出" },
        true,
        None::<&str>,
    )?;
    let menu = Menu::with_items(app, &[&open, &PredefinedMenuItem::separator(app)?, &quit])?;
    if let Some(tray) = app.tray_by_id("main") {
        return tray.set_menu(Some(menu));
    }
    TrayIconBuilder::with_id("main")
        .icon(tauri::image::Image::from_bytes(include_bytes!(
            "../../../assets/icon.png"
        ))?)
        .tooltip("WiFiMeter")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "open" => crate::shell::show_main(app),
            "quit" => app.exit(0),
            _ => (),
        })
        .on_tray_icon_event(|tray, event| {
            if matches!(
                event,
                TrayIconEvent::Click {
                    button: MouseButton::Left,
                    button_state: MouseButtonState::Up,
                    ..
                }
            ) {
                crate::shell::show_main(tray.app_handle());
            }
        })
        .build(app)?;
    Ok(())
}
