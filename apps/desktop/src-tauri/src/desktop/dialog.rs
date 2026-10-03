use tauri::{Manager, WebviewWindow};
#[cfg(windows)]
use windows_sys::Win32::UI::Controls::{
    TaskDialogIndirect, TASKDIALOGCONFIG, TASKDIALOG_BUTTON, TDF_ALLOW_DIALOG_CANCELLATION,
    TDF_SIZE_TO_CONTENT,
};

#[cfg(windows)]
fn wide(text: &str) -> Vec<u16> {
    text.encode_utf16().chain(Some(0)).collect()
}

// Tauri dialog 当前没有 defaultId；使用同样的 Windows TaskDialog，保留按钮顺序和默认取消。
// 仅从阻塞工作线程调用，所有字符串和按钮数组在同步调用返回前保持存活。
fn choose(window: &WebviewWindow, kind: &str, version: Option<&str>) -> Option<(usize, bool)> {
    // The fallback and themed dialogs share exactly the same localized text and button order.
    let copy: serde_json::Value =
        serde_json::from_str(include_str!("../../../renderer/host/dialog-copy.json")).ok()?;
    let config = &copy[kind];
    let language = crate::shell::localized(window.app_handle(), "zh", "en");
    let content = &config[language];
    let title = content[0].as_str()?;
    let message = content[1]
        .as_str()?
        .replace("{version}", version.unwrap_or(""));
    let labels: Vec<_> = content[2]
        .as_array()?
        .iter()
        .filter_map(|label| label.as_str())
        .collect();
    let default = config["default"].as_u64()? as usize;
    let verification = (kind == "close").then(|| {
        crate::shell::localized(window.app_handle(), "记住我的选择", "Remember my choice")
    });
    if let Some(answer) = crate::shell::themed_dialog(window, kind, labels.len(), version) {
        return answer;
    }
    #[cfg(target_os = "linux")]
    {
        crate::linux_desktop::choose(window, title, &message, &labels, default, verification)
    }
    #[cfg(windows)]
    {
        fallback(window, title, &message, &labels, default, verification)
    }
}

#[cfg(windows)]
fn fallback(
    window: &WebviewWindow,
    title: &str,
    message: &str,
    labels: &[&str],
    default: usize,
    verification: Option<&str>,
) -> Option<(usize, bool)> {
    let title = wide(title);
    let message = wide(&message);
    let labels: Vec<_> = labels.iter().map(|label| wide(label)).collect();
    let buttons: Vec<_> = labels
        .iter()
        .enumerate()
        .map(|(index, label)| TASKDIALOG_BUTTON {
            nButtonID: 100 + index as i32,
            pszButtonText: label.as_ptr(),
        })
        .collect();
    let verification = verification.map(wide);
    let Ok(parent) = window.hwnd() else {
        return None;
    };
    let config = TASKDIALOGCONFIG {
        cbSize: std::mem::size_of::<TASKDIALOGCONFIG>() as u32,
        hwndParent: parent.0,
        dwFlags: TDF_ALLOW_DIALOG_CANCELLATION | TDF_SIZE_TO_CONTENT,
        pszWindowTitle: title.as_ptr(),
        pszContent: message.as_ptr(),
        cButtons: buttons.len() as u32,
        pButtons: buttons.as_ptr(),
        nDefaultButton: 100 + default as i32,
        pszVerificationText: verification
            .as_ref()
            .map_or(std::ptr::null(), |text| text.as_ptr()),
        ..Default::default()
    };
    let mut selected = 0;
    let mut checked = 0;
    let success = unsafe {
        TaskDialogIndirect(&config, &mut selected, std::ptr::null_mut(), &mut checked) >= 0
    };
    (success && selected >= 100 && (selected - 100) < labels.len() as i32)
        .then_some(((selected - 100).max(0) as usize, checked != 0))
}

pub fn close_action(window: &WebviewWindow) -> Option<(&'static str, bool)> {
    match choose(window, "close", None) {
        Some((1, remember)) => Some(("tray", remember)),
        Some((2, remember)) => Some(("exit", remember)),
        _ => None,
    }
}

pub fn confirm_discard(window: &WebviewWindow) -> bool {
    choose(window, "discard", None).is_some_and(|(index, _)| index == 0)
}

pub fn confirm_resume(window: &WebviewWindow) -> bool {
    choose(window, "resume", None).is_some_and(|(index, _)| index == 0)
}

pub fn confirm_overlap(window: &WebviewWindow) -> bool {
    choose(window, "overlap", None).is_some_and(|(index, _)| index == 0)
}

pub fn confirm_update(window: &WebviewWindow, version: &str, install: bool) -> bool {
    choose(
        window,
        if install {
            "update-install"
        } else {
            "update-manual"
        },
        Some(version),
    )
    .is_some_and(|(index, _)| index == 0)
}
