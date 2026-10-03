use crate::backend::BackendError;
use base64::{engine::general_purpose::STANDARD, Engine};
use serde_json::{json, Value};
use std::io::{self, Read, Seek, SeekFrom};

pub struct Request {
    pub action: &'static str,
    pub path: String,
    pub upload_kbps: u64,
}

fn invalid(message: &str) -> BackendError {
    BackendError::new("invalidRequest", message)
}

pub fn local_exe_path(path: &str) -> Result<String, BackendError> {
    let bytes = path.as_bytes();
    if bytes.len() < 7
        || !bytes[0].is_ascii_alphabetic()
        || bytes[1..3] != *b":\\"
        || !path.to_ascii_lowercase().ends_with(".exe")
        || path
            .rsplit('\\')
            .next()
            .unwrap()
            .eq_ignore_ascii_case(".exe")
        || path[2..]
            .chars()
            .any(|c| c < ' ' || ":*?\"<>|/".contains(c))
        || path[3..]
            .split('\\')
            .any(|s| s.ends_with([' ', '.']) && !matches!(s, "." | ".."))
    {
        return Err(invalid(
            "必须提供本地磁盘上的绝对程序路径，不能包含通配符或备用数据流。",
        ));
    }
    let mut parts = Vec::new();
    for part in path[3..].split('\\') {
        match part {
            "" | "." => (),
            ".." => {
                parts.pop();
            }
            _ => parts.push(part),
        }
    }
    Ok(format!("{}\\{}", &path[..2], parts.join("\\")))
}

impl Request {
    pub fn parse(input: &Value) -> Result<Self, BackendError> {
        let fields = input
            .as_object()
            .ok_or_else(|| invalid("应用联网请求无效。"))?;
        if fields
            .keys()
            .any(|key| !matches!(key.as_str(), "action" | "path" | "uploadKBps"))
        {
            return Err(invalid("应用联网请求无效。"));
        }
        let action = match input["action"].as_str() {
            Some("read") => "Read",
            Some("block") => "Block",
            Some("unblock") => "Unblock",
            Some("throttle") => "Throttle",
            Some("unthrottle") => "Unthrottle",
            _ => return Err(invalid("应用联网请求无效。")),
        };
        let path = local_exe_path(
            input["path"]
                .as_str()
                .ok_or_else(|| invalid("程序路径无效。"))?,
        )?;
        let upload_kbps = if action == "Throttle" {
            let rate = input["uploadKBps"].as_f64().unwrap_or(f64::NAN) * 8.0;
            if !rate.is_finite() || rate.fract() != 0.0 || !(1.0..=1_000_000_000.0).contains(&rate)
            {
                return Err(invalid(
                    "上传速率必须在每秒 0.125 到 125000000 千字节之间，并能换算为整数千比特。",
                ));
            }
            rate as u64
        } else {
            if fields.contains_key("uploadKBps") {
                return Err(invalid("只有上传限速操作允许指定速率。"));
            }
            0
        };
        Ok(Self {
            action,
            path,
            upload_kbps,
        })
    }

    pub fn encoded_command(&self, module: &str) -> String {
        let data = json!({"Module":module,"Path":self.path,"Action":self.action,"UploadKbps":self.upload_kbps});
        let script = include_str!("app_control.ps1")
            .replace("__PAYLOAD__", &STANDARD.encode(data.to_string()));
        STANDARD.encode(
            script
                .encode_utf16()
                .flat_map(u16::to_le_bytes)
                .collect::<Vec<_>>(),
        )
    }
}

// Inspect headers only; never execute the selected program.
pub fn validate_pe(file: &mut (impl Read + Seek), size: u64) -> io::Result<()> {
    let invalid = || io::Error::new(io::ErrorKind::InvalidData, "所选文件不是有效的可执行程序。");
    if size < 64 {
        return Err(invalid());
    }
    let mut dos = [0; 64];
    file.read_exact(&mut dos)?;
    if &dos[..2] != b"MZ" {
        return Err(invalid());
    }
    let offset = u32::from_le_bytes(dos[60..64].try_into().unwrap()) as u64;
    if offset < 64 || offset + 26 > size {
        return Err(invalid());
    }
    file.seek(SeekFrom::Start(offset))?;
    let mut pe = [0; 26];
    file.read_exact(&mut pe)?;
    let word = |n| u16::from_le_bytes([pe[n], pe[n + 1]]);
    let sections = u64::from(word(6));
    let optional = u64::from(word(20));
    let flags = word(22);
    let magic = word(24);
    if &pe[..4] != b"PE\0\0"
        || flags & 2 == 0
        || flags & 0x2000 != 0
        || !matches!(magic, 0x10b | 0x20b)
        || sections == 0
        || optional < if magic == 0x20b { 112 } else { 96 }
        || offset + 24 + optional + sections * 40 > size
    {
        return Err(invalid());
    }
    Ok(())
}

pub fn failure(error: BackendError) -> Value {
    json!({"ok":false,"canceled":false,"error":error})
}

// Provider diagnostics can follow the operating system's language. Keep those
// details in the response, while the existing drawer receives localized UI text.
pub fn localize(mut reply: Value, english: bool) -> Value {
    let text = |zh: &str, en: &str| {
        if english {
            en.to_string()
        } else {
            zh.to_string()
        }
    };
    let message = |code: &str| {
        match code {
        "invalidRequest" | "InvalidRequest" => text("应用联网请求无效，请检查程序路径和上传速率。", "Invalid application network request. Check the program path and upload rate."),
        "invalidProgram" => text("无法读取有效的程序文件，请重新选择程序。", "Unable to read a valid executable. Choose the application again."),
        "invalidResponse" => text("系统返回的应用联网结果格式无效。", "The system returned an invalid application network result."),
        "UacCancelled" => text("已取消权限提升。", "Elevation was canceled."),
        "timeout" | "HelperTimeout" => text("等待系统操作超时；操作可能尚未完成，请主动查询状态。", "The system operation timed out and may still be running. Query its status again."),
        "VerificationFailed" => text("策略回读未确认请求的配置，请检查当前策略状态。", "Reading the policy back did not confirm the requested configuration. Check the current policy state."),
        "FirewallQueryFailed" => text("无法查询应用防火墙规则，当前状态未知。", "Unable to query the application's firewall rules. The current state is unknown."),
        "QosUnsupported" => text("当前系统不支持按程序路径设置上传限速。", "This system does not support upload throttling by executable path."),
        "QosQueryFailed" => text("无法查询应用上传限速策略，当前状态未知。", "Unable to query the application's upload policy. The current state is unknown."),
        "unsupported" => text("当前系统暂不支持按应用阻断联网或上传限速。", "This system does not support per-application network blocking or upload throttling."),
        "dialogFailed" => text("无法选择程序，请重试。", "Unable to select an application. Try again."),
        _ => text("应用联网操作未完成，可能存在部分修改，请查询当前状态。", "The application network operation did not finish. Partial changes may exist; query the current state."),
    }
    };
    if reply["error"].is_object() {
        reply["error"]["detail"] = reply["error"]["message"].clone();
        reply["error"]["message"] = message(reply["error"]["code"].as_str().unwrap_or("")).into();
    }
    if reply["result"].is_object() {
        let warning = text("系统防火墙对本地代理环回连接不一定可靠；规则状态不代表彻底阻断联网。上传限速只作用于匹配的进程，不限制下载或代理进程。", "Windows Firewall may not reliably block local proxy loopback connections; configured rules do not prove complete network blocking. Upload throttling applies only to the matching process, not downloads or proxy processes.");
        if reply["result"]["warning"].is_string() {
            reply["result"]["warning"] = warning.clone().into();
        }
        let state = &mut reply["result"]["state"];
        if state.is_object() {
            if state["Warning"].is_string() {
                state["Warning"] = warning.into();
            }
            for (field, code, detail) in [
                ("FirewallError", "FirewallErrorCode", "FirewallErrorDetail"),
                ("QosError", "QosErrorCode", "QosErrorDetail"),
            ] {
                if state[field].as_str().is_some_and(|s| !s.is_empty()) {
                    state[detail] = state[field].clone();
                    state[field] = message(state[code].as_str().unwrap_or("")).into();
                }
            }
        }
    }
    reply
}

pub fn response(stdout: &str, path: &str) -> Result<Value, BackendError> {
    let invalid = || BackendError::new("invalidResponse", "系统返回的应用联网结果格式无效。");
    let reply: Value = serde_json::from_str(stdout.trim_start_matches('\u{feff}').trim())
        .map_err(|_| invalid())?;
    let status = reply["Status"].as_str().ok_or_else(invalid)?;
    if !matches!(status, "Succeeded" | "Failed" | "Cancelled")
        || (status == "Succeeded" && !reply["State"].is_object())
        || (status != "Succeeded" && !reply["ErrorCode"].is_string())
    {
        return Err(invalid());
    }
    let warning = reply
        .get("Warning")
        .filter(|v| !v.is_null())
        .unwrap_or(&reply["State"]["Warning"]);
    let mut result = json!({"ok":status=="Succeeded","canceled":status=="Cancelled","result":{"status":status,"path":path,"state":reply["State"],"warning":warning}});
    if status != "Succeeded" {
        result["error"] = json!({"code":reply["ErrorCode"],"message":reply["Error"].as_str().filter(|s| !s.is_empty()).unwrap_or("应用联网操作未完成。")});
    }
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    const PATH: &str = "C:\\Program Files\\Example\\app.exe";

    #[test]
    fn unsupported_platform_returns_a_localized_failure_without_policy_changes() {
        for english in [false, true] {
            let reply = localize(failure(BackendError::new("unsupported", "")), english);
            assert_eq!(reply["ok"], false);
            assert_eq!(reply["error"]["code"], "unsupported");
            let text = reply["error"]["message"].as_str().unwrap();
            assert!(!text.is_empty());
            assert_eq!(text.chars().any(|c| ('\u{3400}'..='\u{9fff}').contains(&c)), !english);
            if !english { assert!(!text.chars().any(|c| c.is_ascii_alphabetic())); }
        }
    }

    #[test]
    fn drawer_copy_follows_app_language_and_preserves_provider_diagnostics() {
        let original = json!({"ok":false,"canceled":false,"error":{"code":"VerificationFailed","message":"系统错误 / system error"},"result":{"warning":"provider warning","state":{"Blocked":null,"FirewallError":"access denied","FirewallErrorCode":"FirewallQueryFailed","QosError":"系统不支持","QosErrorCode":"QosUnsupported"}}});
        for english in [false, true] {
            let reply = localize(original.clone(), english);
            for value in [
                &reply["error"]["message"],
                &reply["result"]["warning"],
                &reply["result"]["state"]["FirewallError"],
                &reply["result"]["state"]["QosError"],
            ] {
                let text = value.as_str().unwrap();
                if english {
                    assert!(!text.chars().any(|c| ('\u{3400}'..='\u{9fff}').contains(&c)));
                } else {
                    assert!(!text.chars().any(|c| c.is_ascii_alphabetic()));
                }
            }
            assert_eq!(reply["error"]["detail"], original["error"]["message"]);
            assert_eq!(
                reply["result"]["state"]["FirewallErrorDetail"],
                "access denied"
            );
            assert_eq!(reply["result"]["state"]["Blocked"], Value::Null);
        }
    }

    #[test]
    fn validates_actions_paths_and_decimal_upload_rates() {
        for (action, native) in [
            ("read", "Read"),
            ("block", "Block"),
            ("unblock", "Unblock"),
            ("unthrottle", "Unthrottle"),
        ] {
            assert_eq!(
                Request::parse(&json!({"action":action,"path":PATH}))
                    .unwrap()
                    .action,
                native
            );
        }
        for (rate, expected) in [(0.125, 1), (12.5, 100), (125000000.0, 1000000000)] {
            assert_eq!(
                Request::parse(&json!({"action":"throttle","path":PATH,"uploadKBps":rate}))
                    .unwrap()
                    .upload_kbps,
                expected
            );
        }
        for path in [
            "app.exe",
            "C:app.exe",
            "C:\\x.ps1",
            "C:\\x.exe:evil.exe",
            "\\\\host\\x.exe",
            "C:/x.exe",
            "C:\\bad.\\x.exe",
            "C:\\x*.exe",
            "C:\\x\n.exe",
            "C:\\x.exe\\",
            "C:\\Apps\\.exe",
        ] {
            assert!(Request::parse(&json!({"action":"read","path":path})).is_err());
        }
        for rate in [
            Value::Null,
            json!("1"),
            json!(0),
            json!(-1),
            json!(0.01),
            json!(125000001),
        ] {
            assert!(
                Request::parse(&json!({"action":"throttle","path":PATH,"uploadKBps":rate}))
                    .is_err()
            );
        }
        for input in [
            Value::Null,
            json!([]),
            json!({}),
            json!({"action":"Block","path":PATH}),
            json!({"action":"read","path":PATH,"script":"evil"}),
            json!({"action":"read","path":PATH,"uploadKBps":null}),
        ] {
            assert!(Request::parse(&input).is_err());
        }
        assert_eq!(
            local_exe_path("C:\\Apps\\..\\app.exe").unwrap(),
            "C:\\app.exe"
        );
    }

    #[test]
    fn quoted_unicode_paths_remain_data_inside_fixed_script() {
        let path = "C:\\中文 空格\\x'; Write-Output INJECTED; #.exe";
        let request =
            Request::parse(&json!({"action":"throttle","path":path,"uploadKBps":12.5})).unwrap();
        let bytes = STANDARD
            .decode(request.encoded_command("C:\\中文 模块\\control.psm1"))
            .unwrap();
        let script = String::from_utf16(
            &bytes
                .chunks_exact(2)
                .map(|v| u16::from_le_bytes([v[0], v[1]]))
                .collect::<Vec<_>>(),
        )
        .unwrap();
        assert!(!script.contains("INJECTED"));
        let encoded = script
            .split("FromBase64String('")
            .nth(1)
            .unwrap()
            .split("')")
            .next()
            .unwrap();
        let data: Value = serde_json::from_slice(&STANDARD.decode(encoded).unwrap()).unwrap();
        assert_eq!(data["Path"], path);
        assert_eq!(data["UploadKbps"], 100);
        assert!(script.contains("Receive-MeterAppNetworkAction"));
    }

    #[test]
    fn rejects_scripts_dlls_and_truncated_pe_images() {
        let mut bytes = vec![0u8; 512];
        bytes[..2].copy_from_slice(b"MZ");
        bytes[60..64].copy_from_slice(&128u32.to_le_bytes());
        bytes[128..132].copy_from_slice(b"PE\0\0");
        bytes[134] = 1;
        bytes[148] = 240;
        bytes[150] = 2;
        bytes[152..154].copy_from_slice(&0x20bu16.to_le_bytes());
        let check = |bytes: Vec<u8>| {
            validate_pe(&mut std::io::Cursor::new(&bytes), bytes.len() as u64).is_ok()
        };
        assert!(check(bytes.clone()));
        let mut dll = bytes.clone();
        dll[151] = 0x20;
        assert!(!check(dll));
        assert!(!check(bytes[..170].to_vec()));
        assert!(!check(b"Write-Host malicious".to_vec()));
        bytes[60..64].copy_from_slice(&u32::MAX.to_le_bytes());
        assert!(!check(bytes));
    }

    #[test]
    fn preserves_cancellation_partial_state_and_invalid_result_errors() {
        for (status, code) in [
            ("Cancelled", "UacCancelled"),
            ("Failed", "VerificationFailed"),
            ("Failed", "HelperTimeout"),
        ] {
            let state = json!({"Blocked":null,"Throttled":true,"FirewallError":"access denied"});
            let result = response(
                &json!({"Status":status,"ErrorCode":code,"Error":"detail","State":state})
                    .to_string(),
                PATH,
            )
            .unwrap();
            assert_eq!(result["ok"], false);
            assert_eq!(result["canceled"], status == "Cancelled");
            assert_eq!(result["result"]["state"], state);
            assert_eq!(result["error"]["code"], code);
        }
        for output in [
            "",
            "noise\n{}",
            "{}",
            "null",
            r#"{"Status":"Running"}"#,
            r#"{"Status":"Succeeded"}"#,
        ] {
            assert_eq!(response(output, PATH).unwrap_err().code, "invalidResponse");
        }
        assert_eq!(
            response(
                "\u{feff}{\"Status\":\"Succeeded\",\"State\":{\"Blocked\":null}}",
                PATH
            )
            .unwrap()["result"]["state"]["Blocked"],
            Value::Null
        );
    }
}
