use crate::host::Reply;
use serde_json::{json, Value};
use std::{path::Path, process::Command};
use tauri::{AppHandle, Manager};

fn background_dialog_reply(method: &str, params: &Value, background_test: bool) -> Option<Reply> {
    if !background_test {
        return None;
    }
    let result = match method {
        "dialog:open" => json!({ "canceled": true, "filePaths": [] }),
        "dialog:save" => json!({ "canceled": true, "filePath": null }),
        "dialog:message" => json!({
            "response": params["options"]["cancelId"].as_u64().unwrap_or(0),
            "checkboxChecked": false
        }),
        _ => return None,
    };
    Some(Ok(result))
}

fn file_dialog(app: &AppHandle, params: &Value) -> rfd::FileDialog {
    let options = &params["options"];
    let mut dialog = rfd::FileDialog::new();
    if let Some(title) = options["title"].as_str() {
        dialog = dialog.set_title(title);
    }
    if let Some(default) = options["defaultPath"].as_str() {
        let path = Path::new(default);
        if path.is_dir() {
            dialog = dialog.set_directory(path);
        } else {
            if let Some(parent) = path.parent().filter(|path| !path.as_os_str().is_empty()) {
                dialog = dialog.set_directory(parent);
            }
            if let Some(name) = path.file_name() {
                dialog = dialog.set_file_name(name.to_string_lossy());
            }
        }
    }
    if let Some(filters) = options["filters"].as_array() {
        for filter in filters {
            let extensions: Vec<&str> = filter["extensions"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(Value::as_str)
                .collect();
            dialog = dialog.add_filter(filter["name"].as_str().unwrap_or("Files"), &extensions);
        }
    }
    if let Some(window) = app.get_webview_window(params["parent"].as_str().unwrap_or("main")) {
        dialog = dialog.set_parent(&window);
    }
    dialog
}

pub fn dialog(app: &AppHandle, method: &str, params: &Value) -> Reply {
    if let Some(reply) =
        background_dialog_reply(method, params, crate::native::isolated_background_test())
    {
        return reply;
    }
    let options = &params["options"];
    match method {
        "dialog:open" => {
            let properties = options["properties"]
                .as_array()
                .cloned()
                .unwrap_or_default();
            let directory = properties.iter().any(|value| value == "openDirectory");
            let multiple = properties.iter().any(|value| value == "multiSelections");
            let dialog = file_dialog(app, params);
            let paths = match (directory, multiple) {
                (true, true) => dialog.pick_folders(),
                (true, false) => dialog.pick_folder().map(|path| vec![path]),
                (false, true) => dialog.pick_files(),
                (false, false) => dialog.pick_file().map(|path| vec![path]),
            };
            Ok(
                json!({ "canceled": paths.is_none(), "filePaths": paths.unwrap_or_default()
                .iter().map(|path| path.to_string_lossy().to_string()).collect::<Vec<_>>() }),
            )
        }
        "dialog:save" => {
            let path = file_dialog(app, params).save_file();
            Ok(
                json!({ "canceled": path.is_none(), "filePath": path.map(|path| path.to_string_lossy().to_string()) }),
            )
        }
        "dialog:message" => message(app, params),
        _ => Err(format!("未知对话框操作：{method}")),
    }
}

#[cfg(windows)]
fn message(app: &AppHandle, params: &Value) -> Reply {
    use windows_sys::Win32::UI::Controls::{
        TaskDialogIndirect, TASKDIALOGCONFIG, TASKDIALOG_BUTTON, TDF_ALLOW_DIALOG_CANCELLATION,
        TDF_POSITION_RELATIVE_TO_WINDOW, TDF_VERIFICATION_FLAG_CHECKED,
    };
    let options = &params["options"];
    let wide = |text: &str| {
        text.encode_utf16()
            .chain(std::iter::once(0))
            .collect::<Vec<u16>>()
    };
    let title = wide(options["title"].as_str().unwrap_or("WiFiMeter"));
    let instruction = wide(options["message"].as_str().unwrap_or(""));
    let detail = wide(options["detail"].as_str().unwrap_or(""));
    let checkbox = options["checkboxLabel"].as_str().map(wide);
    let labels: Vec<Vec<u16>> = options["buttons"]
        .as_array()
        .filter(|buttons| !buttons.is_empty())
        .map(|buttons| {
            buttons
                .iter()
                .map(|button| wide(button.as_str().unwrap_or("OK")))
                .collect()
        })
        .unwrap_or_else(|| vec![wide("确定 / OK")]);
    let buttons: Vec<TASKDIALOG_BUTTON> = labels
        .iter()
        .enumerate()
        .map(|(index, label)| TASKDIALOG_BUTTON {
            nButtonID: 100 + index as i32,
            pszButtonText: label.as_ptr(),
        })
        .collect();
    let mut config = TASKDIALOGCONFIG {
        cbSize: std::mem::size_of::<TASKDIALOGCONFIG>() as u32,
        pszWindowTitle: title.as_ptr(),
        pszMainInstruction: instruction.as_ptr(),
        pszContent: detail.as_ptr(),
        cButtons: buttons.len() as u32,
        pButtons: buttons.as_ptr(),
        nDefaultButton: 100 + options["defaultId"].as_i64().unwrap_or(0) as i32,
        dwFlags: TDF_ALLOW_DIALOG_CANCELLATION | TDF_POSITION_RELATIVE_TO_WINDOW,
        ..Default::default()
    };
    if let Some(window) = app.get_webview_window(params["parent"].as_str().unwrap_or("main")) {
        config.hwndParent = window.hwnd().map_err(|error| error.to_string())?.0;
    }
    if let Some(checkbox) = &checkbox {
        config.pszVerificationText = checkbox.as_ptr();
    }
    if options["checkboxChecked"].as_bool() == Some(true) {
        config.dwFlags |= TDF_VERIFICATION_FLAG_CHECKED;
    }
    let mut selected = 0;
    let mut checked = 0;
    // Every pointer above owns a UTF-16 buffer that remains alive for this blocking call.
    let result =
        unsafe { TaskDialogIndirect(&config, &mut selected, std::ptr::null_mut(), &mut checked) };
    if result < 0 {
        return Err(format!(
            "无法显示系统对话框：HRESULT 0x{:08X}",
            result as u32
        ));
    }
    let response = if selected >= 100 {
        selected - 100
    } else {
        options["cancelId"].as_i64().unwrap_or(0) as i32
    };
    Ok(json!({ "response": response, "checkboxChecked": checked != 0 }))
}

#[cfg(not(windows))]
fn message(app: &AppHandle, params: &Value) -> Reply {
    let options = &params["options"];
    let buttons: Vec<String> = options["buttons"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .map(str::to_string)
        .collect();
    let choices = match buttons.as_slice() {
        [first] => rfd::MessageButtons::OkCustom(first.clone()),
        [first, second] => rfd::MessageButtons::OkCancelCustom(first.clone(), second.clone()),
        [first, second, third] => {
            rfd::MessageButtons::YesNoCancelCustom(first.clone(), second.clone(), third.clone())
        }
        _ => rfd::MessageButtons::Ok,
    };
    let description = format!(
        "{}\n{}",
        options["message"].as_str().unwrap_or(""),
        options["detail"].as_str().unwrap_or("")
    );
    let mut dialog = rfd::MessageDialog::new()
        .set_title(options["title"].as_str().unwrap_or("WiFiMeter"))
        .set_description(description)
        .set_buttons(choices);
    if let Some(window) = app.get_webview_window(params["parent"].as_str().unwrap_or("main")) {
        dialog = dialog.set_parent(&window);
    }
    let result = dialog.show();
    let response = match result {
        rfd::MessageDialogResult::Custom(label) => buttons
            .iter()
            .position(|button| button == &label)
            .unwrap_or(0),
        rfd::MessageDialogResult::Cancel => options["cancelId"].as_u64().unwrap_or(0) as usize,
        _ => 0,
    };
    Ok(json!({ "response": response, "checkboxChecked": false }))
}

pub fn notify(params: &Value) -> Reply {
    if crate::native::isolated_background_test() {
        return Ok(Value::Null);
    }
    let title = params["title"].as_str().unwrap_or("WiFiMeter");
    let body = params["body"].as_str().unwrap_or("");
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        let xml_escape = |value: &str| {
            value
                .replace('&', "&amp;")
                .replace('<', "&lt;")
                .replace('>', "&gt;")
        };
        let xml = format!("<toast><visual><binding template='ToastGeneric'><text>{}</text><text>{}</text></binding></visual></toast>",
            xml_escape(title), xml_escape(body)).replace('\'', "''");
        let script = format!("$ErrorActionPreference='Stop'; $null=[Windows.UI.Notifications.ToastNotificationManager,Windows.UI.Notifications,ContentType=WindowsRuntime]; $null=[Windows.Data.Xml.Dom.XmlDocument,Windows.Data.Xml.Dom.XmlDocument,ContentType=WindowsRuntime]; $xml=New-Object Windows.Data.Xml.Dom.XmlDocument; $xml.LoadXml('{xml}'); $toast=[Windows.UI.Notifications.ToastNotification]::new($xml); [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('io.wifimeter.demo').Show($toast)");
        let executable = std::path::PathBuf::from(
            std::env::var_os("SystemRoot").unwrap_or_else(|| "C:\\Windows".into()),
        )
        .join("System32/WindowsPowerShell/v1.0/powershell.exe");
        let output = Command::new(executable)
            .args([
                "-NoLogo",
                "-NoProfile",
                "-NonInteractive",
                "-Command",
                &script,
            ])
            .creation_flags(0x08000000)
            .output()
            .map_err(|error| error.to_string())?;
        if !output.status.success() {
            return Err(String::from_utf8_lossy(&output.stderr).to_string());
        }
    }
    #[cfg(not(windows))]
    {
        let status = Command::new("notify-send")
            .args(["--app-name=WiFiMeter", title, body])
            .status()
            .map_err(|error| error.to_string())?;
        if !status.success() {
            return Err("无法显示系统通知。".into());
        }
    }
    Ok(Value::Null)
}

#[cfg(test)]
mod tests {
    use super::background_dialog_reply;
    use serde_json::json;

    #[test]
    fn background_dialogs_return_cancellation_without_a_native_prompt() {
        let params = json!({ "options": { "cancelId": 2, "checkboxChecked": true } });
        assert_eq!(
            background_dialog_reply("dialog:message", &params, true)
                .unwrap()
                .unwrap(),
            json!({ "response": 2, "checkboxChecked": false })
        );
        assert_eq!(
            background_dialog_reply("dialog:open", &params, true)
                .unwrap()
                .unwrap(),
            json!({ "canceled": true, "filePaths": [] })
        );
        assert_eq!(
            background_dialog_reply("dialog:save", &params, true)
                .unwrap()
                .unwrap(),
            json!({ "canceled": true, "filePath": null })
        );
    }

    #[test]
    fn normal_dialogs_keep_native_user_interaction() {
        for method in ["dialog:message", "dialog:open", "dialog:save"] {
            assert!(background_dialog_reply(method, &json!({}), false).is_none());
        }
    }
}
