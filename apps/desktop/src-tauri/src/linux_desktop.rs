use crate::updates::{external_url, UpdateError};
use base64::{engine::general_purpose::STANDARD, Engine};
use gtk::{gdk, gio, prelude::*};
use std::{
    process::{Command, Stdio},
    sync::mpsc,
};
use tauri::{AppHandle, Manager, WebviewWindow};

// GTK objects stay on the main loop; callers are blocking IPC/mini workers.
fn on_main<T: Send + 'static>(
    app: &AppHandle,
    work: impl FnOnce() -> T + Send + 'static,
) -> Option<T> {
    let (send, receive) = mpsc::sync_channel(1);
    app.run_on_main_thread(move || {
        let _ = send.send(work());
    })
    .ok()?;
    receive.recv().ok()
}

pub fn extract_icon(app: &AppHandle, path: &str) -> Option<String> {
    let file = gio::File::for_path(path);
    let info = file
        .query_info(
            "standard::icon",
            gio::FileQueryInfoFlags::NONE,
            gio::Cancellable::NONE,
        )
        .ok()?;
    // Serialize the GIcon before moving it between the worker and GTK thread.
    let icon = gio::prelude::IconExt::to_string(&info.icon()?)?.to_string();
    on_main(app, move || {
        let icon = gio::Icon::for_string(&icon).ok()?;
        let pixbuf = gtk::IconTheme::default()?
            .lookup_by_gicon(&icon, 32, gtk::IconLookupFlags::FORCE_SIZE)?
            .load_icon()
            .ok()?;
        let png = pixbuf.save_to_bufferv("png", &[]).ok()?;
        Some(format!("data:image/png;base64,{}", STANDARD.encode(png)))
    })?
}

pub fn left_button_down(app: &AppHandle) -> bool {
    on_main(app, || {
        let display = gdk::Display::default()?;
        let pointer = display.default_seat()?.pointer()?;
        let root = gdk::Window::default_root_window();
        let (_, _, _, modifiers) = root.device_position(&pointer);
        Some(modifiers.contains(gdk::ModifierType::BUTTON1_MASK))
    })
    .flatten()
    .unwrap_or(false)
}

pub fn choose(
    window: &WebviewWindow,
    title: &str,
    message: &str,
    labels: &[&str],
    default: usize,
    verification: Option<&str>,
) -> Option<(usize, bool)> {
    let (send, receive) = mpsc::sync_channel(1);
    let parent = window.clone();
    let title = title.to_owned();
    let message = message.to_owned();
    let labels: Vec<String> = labels.iter().map(|label| (*label).to_owned()).collect();
    let verification = verification.map(str::to_owned);
    window
        .app_handle()
        .run_on_main_thread(move || {
            let Ok(parent) = parent.gtk_window() else {
                let _ = send.send(None);
                return;
            };
            let dialog = gtk::Dialog::builder()
                .title(&title)
                .transient_for(&parent)
                .modal(true)
                .destroy_with_parent(true)
                .build();
            let content = dialog.content_area();
            content.set_spacing(16);
            content.set_border_width(24);
            let text = gtk::Label::new(Some(&message));
            text.set_line_wrap(true);
            text.set_max_width_chars(60);
            content.add(&text);
            let check = verification.map(|label| {
                let check = gtk::CheckButton::with_label(&label);
                content.add(&check);
                check
            });
            for (index, label) in labels.iter().enumerate() {
                dialog.add_button(label, gtk::ResponseType::Other(index as u16));
            }
            dialog.set_default_response(gtk::ResponseType::Other(default as u16));
            dialog.connect_response(move |dialog, response| {
                let selected = match response {
                    gtk::ResponseType::Other(index) if (index as usize) < labels.len() => Some((
                        index as usize,
                        check.as_ref().is_some_and(|check| check.is_active()),
                    )),
                    _ => None,
                };
                let _ = send.send(selected);
                dialog.close();
            });
            dialog.show_all();
        })
        .ok()?;
    receive.recv().ok().flatten()
}

pub fn open_link(url: &str) -> Result<(), UpdateError> {
    let url = external_url(url)?;
    let mut child = Command::new("xdg-open")
        .arg(url)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|_| UpdateError::Install)?;
    std::thread::spawn(move || {
        let _ = child.wait();
    });
    Ok(())
}
