use crate::{
    app_control::{self, Request},
    backend::BackendError,
    files,
};
use serde_json::Value;
use std::{
    fs::{self, File},
    io::{self, Read},
    os::windows::process::CommandExt,
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::mpsc,
    thread,
    time::{Duration, Instant},
};

pub struct WindowsControl {
    module: PathBuf,
}

impl WindowsControl {
    pub fn new(profile: &Path) -> Self {
        let module = profile
            .join("native")
            .join("windows")
            .join("AppNetworkControl.psm1");
        let install = || -> io::Result<()> {
            fs::create_dir_all(module.parent().unwrap())?;
            files::atomic_write(
                &module,
                include_bytes!("../../native/windows/AppNetworkControl.psm1"),
            )
        };
        if let Err(error) = install() {
            eprintln!("[app-control] {error}");
        }
        Self { module }
    }

    pub fn request(&self, input: &Value) -> Value {
        let execute = || -> Result<Value, BackendError> {
            let mut request = Request::parse(input)?;
            request.path = verified_executable(&request.path)
                .map_err(|e| BackendError::new("invalidProgram", e))?;
            let stdout = run(
                &request.encoded_command(&self.module.to_string_lossy()),
                Duration::from_secs(180),
            )?;
            app_control::response(&stdout, &request.path)
        };
        execute().unwrap_or_else(app_control::failure)
    }
}

fn verified_executable(path: &str) -> io::Result<String> {
    let resolved = fs::canonicalize(path)?;
    let resolved = resolved.to_string_lossy();
    let path = app_control::local_exe_path(resolved.strip_prefix(r"\\?\").unwrap_or(&resolved))
        .map_err(|error| io::Error::new(io::ErrorKind::InvalidInput, error))?;
    let mut file = File::open(&path)?;
    let metadata = file.metadata()?;
    if !metadata.is_file() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "所选路径不是程序文件。",
        ));
    }
    app_control::validate_pe(&mut file, metadata.len())?;
    Ok(path)
}

fn read_output(stream: impl Read + Send + 'static) -> mpsc::Receiver<io::Result<Vec<u8>>> {
    let (send, receive) = mpsc::channel();
    thread::spawn(move || {
        let mut output = Vec::new();
        let result = stream
            .take(1024 * 1024 + 1)
            .read_to_end(&mut output)
            .and_then(|_| {
                if output.len() > 1024 * 1024 {
                    Err(io::Error::new(
                        io::ErrorKind::InvalidData,
                        "系统输出超过大小限制。",
                    ))
                } else {
                    Ok(output)
                }
            });
        let _ = send.send(result);
    });
    receive
}

fn run(encoded: &str, timeout: Duration) -> Result<String, BackendError> {
    let executable =
        PathBuf::from(std::env::var_os("SystemRoot").unwrap_or_else(|| "C:\\Windows".into()))
            .join("System32")
            .join("WindowsPowerShell")
            .join("v1.0")
            .join("powershell.exe");
    let mut child = Command::new(executable)
        .args([
            "-NoLogo",
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy",
            "Bypass",
            "-EncodedCommand",
            encoded,
        ])
        .creation_flags(0x08000000)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| BackendError::new("runnerFailed", error))?;
    let stdout = read_output(child.stdout.take().unwrap());
    let stderr = read_output(child.stderr.take().unwrap());
    let deadline = Instant::now() + timeout;
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) if Instant::now() < deadline => thread::sleep(Duration::from_millis(25)),
            result => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(match result {
                    Err(error) => BackendError::new("runnerFailed", error),
                    _ => BackendError::new(
                        "timeout",
                        "等待系统操作超时；策略操作可能尚未完成，请主动查询状态。",
                    ),
                });
            }
        }
    };
    let receive = |receiver: mpsc::Receiver<io::Result<Vec<u8>>>| -> Result<Vec<u8>, BackendError> {
        receiver
            .recv_timeout(deadline.saturating_duration_since(Instant::now()))
            .map_err(|error| BackendError::new("timeout", error))?
            .map_err(|error| BackendError::new("runnerFailed", error))
    };
    let output = receive(stdout)?;
    let error = receive(stderr)?;
    if !status.success() {
        return Err(BackendError::new(
            "runnerFailed",
            String::from_utf8_lossy(&error),
        ));
    }
    String::from_utf8(output).map_err(|error| BackendError::new("invalidResponse", error))
}

#[cfg(test)]
mod tests {
    use super::*;
    use base64::{engine::general_purpose::STANDARD, Engine};
    use serde_json::json;

    #[test]
    fn fixed_runner_handles_all_actions_and_cancellation_without_policy_changes() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("中文 空格'; INJECTED; #.exe");
        fs::copy(std::env::current_exe().unwrap(), &path).unwrap();
        let module = directory.path().join("fixture.psm1");
        fs::write(&module,r#"
function Get-MeterAppNetworkState { param($Path) [pscustomobject]@{ Path=$Path; Blocked=$null; Throttled=$false; Warning='scope' } }
function Invoke-MeterAppNetworkAction {
    param($Path,$Action,$UploadKbps)
    if ($Action -eq 'Block') { $status='Cancelled'; $code='UacCancelled' }
    elseif ($Action -eq 'Unblock') { $status='Failed'; $code='VerificationFailed' }
    else { $status='Succeeded'; $code=$null }
    [pscustomobject]@{ Status=$status; State=[pscustomobject]@{ Action=$Action; UploadKbps=$UploadKbps; Blocked=$null }; Warning='scope'; Error='detail'; ErrorCode=$code; Process=$null }
}
Export-ModuleMember -Function Get-MeterAppNetworkState,Invoke-MeterAppNetworkAction
"#).unwrap();
        let control = WindowsControl { module };
        for action in ["read", "block", "unblock", "throttle", "unthrottle"] {
            let mut input = json!({"action":action,"path":path.to_string_lossy()});
            if action == "throttle" {
                input["uploadKBps"] = 12.5.into();
            }
            let reply = control.request(&input);
            assert_eq!(
                reply["ok"],
                !matches!(action, "block" | "unblock"),
                "{reply}"
            );
            assert_eq!(reply["canceled"], action == "block");
            assert_eq!(reply["result"]["path"], path.to_string_lossy().as_ref());
            assert_eq!(reply["result"]["state"]["Blocked"], Value::Null);
            if action == "throttle" {
                assert_eq!(reply["result"]["state"]["UploadKbps"], 100);
            }
        }
        fs::write(&path, "renamed script").unwrap();
        assert_eq!(
            control.request(&json!({"action":"read","path":path.to_string_lossy()}))["error"]
                ["code"],
            "invalidProgram"
        );
        let script = "Start-Sleep -Seconds 10";
        let encoded = STANDARD.encode(
            script
                .encode_utf16()
                .flat_map(u16::to_le_bytes)
                .collect::<Vec<_>>(),
        );
        assert_eq!(
            run(&encoded, Duration::from_millis(100)).unwrap_err().code,
            "timeout"
        );
        let encoded = STANDARD.encode(
            "throw '测试异常'"
                .encode_utf16()
                .flat_map(u16::to_le_bytes)
                .collect::<Vec<_>>(),
        );
        assert_eq!(
            run(&encoded, Duration::from_secs(30)).unwrap_err().code,
            "runnerFailed"
        );
    }

    #[test]
    fn real_windows_read_preserves_unknown_policy_states() {
        let directory = tempfile::tempdir().unwrap();
        let control = WindowsControl::new(directory.path());
        let path = format!("{}\\explorer.exe", std::env::var("SystemRoot").unwrap());
        let result = control.request(&json!({"action":"read","path":path}));
        assert_eq!(result["ok"], true, "{result}");
        let state = &result["result"]["state"];
        assert_eq!(state["Scope"], "LocalConfiguredPolicy");
        for (field, error) in [
            ("Blocked", "FirewallErrorCode"),
            ("Throttled", "QosErrorCode"),
        ] {
            if state[error].is_null() {
                assert!(state[field].is_boolean());
            } else {
                assert!(state[field].is_null());
            }
        }
    }

    #[test]
    fn elevated_helper_uses_private_module_and_session_policy() {
        let directory = tempfile::tempdir().unwrap();
        let control = WindowsControl::new(directory.path());
        let data = STANDARD.encode(control.module.to_string_lossy().as_bytes());
        // Intercept only Start-Process inside this isolated PowerShell process.
        let script = r#"
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object Text.UTF8Encoding($false)
$module = Import-Module ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('__MODULE__'))) -Force -PassThru -WarningAction SilentlyContinue
& $module {
    function script:Start-Process {
        param($FilePath,$ArgumentList,$Verb,$WindowStyle,[switch]$PassThru,$ErrorAction)
        [pscustomobject]@{Executable=$FilePath;Arguments=$ArgumentList;Verb=$Verb;WindowStyle=$WindowStyle}
    }
    Start-MeterNetworkHelper 'C:\Example.exe' 'Throttle' 100
} | ConvertTo-Json -Compress
"#.replace("__MODULE__",&data);
        let encoded = STANDARD.encode(
            script
                .encode_utf16()
                .flat_map(u16::to_le_bytes)
                .collect::<Vec<_>>(),
        );
        let result: Value =
            serde_json::from_str(&run(&encoded, Duration::from_secs(30)).unwrap()).unwrap();
        let args = result["Arguments"].as_array().unwrap();
        assert_eq!(args[2], "-ExecutionPolicy");
        assert_eq!(args[3], "Bypass");
        assert_eq!(result["Verb"], "RunAs");
        assert_eq!(result["WindowStyle"], "Hidden");
    }
}
