use tauri::WebviewWindow;
use windows_sys::Win32::UI::Controls::{
    TaskDialogIndirect, TASKDIALOGCONFIG, TASKDIALOG_BUTTON, TDF_ALLOW_DIALOG_CANCELLATION,
    TDF_SIZE_TO_CONTENT,
};

fn wide(text: &str) -> Vec<u16> {
    text.encode_utf16().chain(Some(0)).collect()
}

// Tauri dialog 当前没有 defaultId；使用同样的 Windows TaskDialog，保留按钮顺序和默认取消。
// 仅从阻塞工作线程调用，所有字符串和按钮数组在同步调用返回前保持存活。
fn choose(
    window: &WebviewWindow,
    title: &str,
    message: &str,
    labels: &[&str],
    default: usize,
    verification: Option<&str>,
) -> Option<(usize, bool)> {
    let title = wide(title);
    let message = wide(message);
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

fn confirm(window: &WebviewWindow, title: &str, message: &str, affirmative: &str) -> bool {
    choose(
        window,
        title,
        message,
        &[affirmative, "取消 / Cancel"],
        1,
        None,
    )
    .is_some_and(|(index, _)| index == 0)
}

pub fn close_action(window: &WebviewWindow) -> Option<(&'static str, bool)> {
    match choose(
        window,
        "关闭 WiFiMeter",
        "关闭窗口后如何处理？",
        &["取消", "最小化到托盘", "退出应用"],
        0,
        Some("记住我的选择"),
    ) {
        Some((1, remember)) => Some(("tray", remember)),
        Some((2, remember)) => Some(("exit", remember)),
        _ => None,
    }
}

pub fn confirm_discard(window: &WebviewWindow) -> bool {
    confirm(
        window,
        "WiFiMeter",
        "您所做的更改可能尚未保存。是否退出？ / Changes may not be saved. Exit anyway?",
        "退出应用 / Exit",
    )
}

pub fn confirm_resume(window: &WebviewWindow) -> bool {
    confirm(
        window,
        "WiFiMeter",
        "旧数据尚未导入，是否先恢复当前统计？ / Resume collection without importing old data?",
        "恢复统计 / Resume",
    )
}

pub fn confirm_overlap(window: &WebviewWindow) -> bool {
    confirm(window, "Import old data / 导入旧数据", "发现相同网络和日期的记录 / Overlapping network dates\n\n保留当前数据库中已有日期的记录，只导入其余旧日期。不会相加或覆盖；旧数据原文及导入前备份均保留。 / Keep existing dates and import only non-conflicting dates. Original data and recovery backups are retained.", "保留现有并导入其他日期 / Keep existing")
}
