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
fn confirm(window: &WebviewWindow, title: &str, message: &str, affirmative: &str) -> bool {
    let title = wide(title);
    let message = wide(message);
    let affirmative = wide(affirmative);
    let cancel = wide("取消 / Cancel");
    let buttons = [
        TASKDIALOG_BUTTON {
            nButtonID: 100,
            pszButtonText: affirmative.as_ptr(),
        },
        TASKDIALOG_BUTTON {
            nButtonID: 101,
            pszButtonText: cancel.as_ptr(),
        },
    ];
    let Ok(parent) = window.hwnd() else {
        return false;
    };
    let config = TASKDIALOGCONFIG {
        cbSize: std::mem::size_of::<TASKDIALOGCONFIG>() as u32,
        hwndParent: parent.0,
        dwFlags: TDF_ALLOW_DIALOG_CANCELLATION | TDF_SIZE_TO_CONTENT,
        pszWindowTitle: title.as_ptr(),
        pszContent: message.as_ptr(),
        cButtons: buttons.len() as u32,
        pButtons: buttons.as_ptr(),
        nDefaultButton: 101,
        ..Default::default()
    };
    let mut selected = 0;
    unsafe {
        TaskDialogIndirect(
            &config,
            &mut selected,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
        ) >= 0
            && selected == 100
    }
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
