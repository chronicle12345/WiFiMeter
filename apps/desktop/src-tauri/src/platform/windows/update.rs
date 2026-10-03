use crate::updates::UpdateError;
use base64::{engine::general_purpose::STANDARD, Engine};
use sha2::{Digest, Sha256};
use std::{
    fs::{self, File},
    io::{BufRead, BufReader, Read, Write},
    os::windows::process::CommandExt,
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::mpsc,
    thread,
    time::Duration,
};

fn verified_target(file: &Path, profile: &Path, digest: &str) -> Result<PathBuf, UpdateError> {
    if digest.len() != 64
        || !digest
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    {
        return Err(UpdateError::Install);
    }
    let target = fs::canonicalize(file).map_err(|_| UpdateError::Install)?;
    let directory = fs::canonicalize(profile.join("updates")).map_err(|_| UpdateError::Install)?;
    if target.parent() != Some(directory.as_path())
        || !target
            .extension()
            .is_some_and(|extension| extension.eq_ignore_ascii_case("exe"))
    {
        return Err(UpdateError::Install);
    }
    let mut file = File::open(&target).map_err(|_| UpdateError::Install)?;
    let mut buffer = [0; 64 * 1024];
    let mut hash = Sha256::new();
    loop {
        let count = file.read(&mut buffer).map_err(|_| UpdateError::Install)?;
        if count == 0 {
            break;
        }
        hash.update(&buffer[..count]);
    }
    if format!("{:x}", hash.finalize()) != digest {
        return Err(UpdateError::Install);
    }
    Ok(target)
}

fn script(target: &Path, digest: &str, parent: u32, english: bool) -> String {
    let (message, title) = if english {
        (
            "Update could not start. Close and reopen WiFiMeter, then try again.",
            "WiFiMeter update",
        )
    } else {
        (
            "无法启动更新，请关闭并重新打开 WiFiMeter 后重试。",
            "WiFiMeter 软件更新",
        )
    };
    include_str!("update_handoff.ps1")
        .replace(
            "__PATH__",
            &STANDARD.encode(target.to_string_lossy().as_bytes()),
        )
        .replace("__MESSAGE__", &STANDARD.encode(message.as_bytes()))
        .replace("__TITLE__", &STANDARD.encode(title.as_bytes()))
        .replace("__PARENT__", &parent.to_string())
        .replace("__DIGEST__", digest)
}

fn command(script: &str) -> Command {
    let powershell =
        PathBuf::from(std::env::var_os("SystemRoot").unwrap_or_else(|| "C:\\Windows".into()))
            .join("System32/WindowsPowerShell/v1.0/powershell.exe");
    let encoded = STANDARD.encode(
        script
            .encode_utf16()
            .flat_map(u16::to_le_bytes)
            .collect::<Vec<_>>(),
    );
    let mut command = Command::new(powershell);
    command
        .args([
            "-NoLogo",
            "-NoProfile",
            "-NonInteractive",
            "-EncodedCommand",
            &encoded,
        ])
        .creation_flags(0x08000000 | 0x00000200) // CREATE_NO_WINDOW | CREATE_NEW_PROCESS_GROUP
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    command
}

fn authorize(child: &mut Child, timeout: Duration) -> Result<(), UpdateError> {
    // 任一路径返回都会关闭 stdin；迟到的 READY 因收不到 GO 而取消，不会启动安装器。
    let mut input = child.stdin.take().ok_or(UpdateError::HandoffWrite)?;
    let output = child.stdout.take().ok_or(UpdateError::HandoffClosed)?;
    let (send, receive) = mpsc::channel();
    thread::spawn(move || {
        let mut line = Vec::new();
        let result = match BufReader::new(output.take(129)).read_until(b'\n', &mut line) {
            Ok(0) | Err(_) => Err(UpdateError::HandoffClosed),
            Ok(_) if line == b"READY\n" || line == b"READY\r\n" => Ok(()),
            Ok(_) => Err(UpdateError::HandoffInvalid),
        };
        let _ = send.send(result);
    });
    receive
        .recv_timeout(timeout)
        .map_err(|error| match error {
            mpsc::RecvTimeoutError::Timeout => UpdateError::HandoffTimeout,
            mpsc::RecvTimeoutError::Disconnected => UpdateError::HandoffClosed,
        })??;
    input
        .write_all(b"GO\n")
        .and_then(|_| input.flush())
        .map_err(|_| UpdateError::HandoffWrite)
}

pub fn launch(file: &Path, profile: &Path, digest: &str, english: bool) -> Result<(), UpdateError> {
    let target = verified_target(file, profile, digest)?;
    let mut child = command(&script(&target, digest, std::process::id(), english))
        .spawn()
        .map_err(|_| UpdateError::HandoffStart)?;
    let accepted = authorize(&mut child, Duration::from_secs(15));
    // 不杀死已授权的辅助进程；主进程退出后由它接续安装。失败路径也回收句柄。
    thread::spawn(move || {
        let _ = child.wait();
    });
    accepted
}

pub fn open_link(value: &str) -> Result<(), UpdateError> {
    let url = crate::updates::external_url(value)?;
    let url: Vec<u16> = url.encode_utf16().chain(Some(0)).collect();
    let operation: Vec<u16> = "open".encode_utf16().chain(Some(0)).collect();
    let result = unsafe {
        windows_sys::Win32::UI::Shell::ShellExecuteW(
            std::ptr::null_mut(),
            operation.as_ptr(),
            url.as_ptr(),
            std::ptr::null(),
            std::ptr::null(),
            1,
        )
    } as isize;
    if result > 32 {
        Ok(())
    } else {
        Err(UpdateError::Install)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Instant;

    fn digest() -> String {
        format!("{:x}", Sha256::digest(b"verified fixture"))
    }

    fn wait(child: &mut Child) -> std::process::ExitStatus {
        let deadline = Instant::now() + Duration::from_secs(20);
        loop {
            if let Some(status) = child.try_wait().unwrap() {
                return status;
            }
            if Instant::now() >= deadline {
                child.kill().unwrap();
                child.wait().unwrap();
                panic!("fixture helper did not exit");
            }
            thread::sleep(Duration::from_millis(10));
        }
    }

    #[test]
    fn validates_local_download_location_extension_and_unchanged_digest() {
        let root = tempfile::tempdir().unwrap();
        let directory = root.path().join("updates");
        fs::create_dir(&directory).unwrap();
        let file = directory.join("下载';ignored.exe");
        fs::write(&file, b"verified fixture").unwrap();
        let resolved = verified_target(&file, root.path(), &digest()).unwrap();
        assert_eq!(resolved, fs::canonicalize(&file).unwrap());
        assert!(verified_target(&file, root.path(), &"0".repeat(64)).is_err());
        assert!(verified_target(&file, root.path(), "bad").is_err());
        for outside in [
            root.path().join("outside.exe"),
            directory.join("script.ps1"),
        ] {
            fs::write(&outside, b"verified fixture").unwrap();
            assert!(verified_target(&outside, root.path(), &digest()).is_err());
        }
        fs::write(&file, b"replaced").unwrap();
        assert!(verified_target(&file, root.path(), &digest()).is_err());
    }

    #[test]
    #[ignore = "subprocess fixture for handoff_survives_parent_exit"]
    fn handoff_parent_fixture() {
        let Some(root) = std::env::var_os("WIFIMETER_HANDOFF_TEST_ROOT") else {
            return;
        };
        let root = PathBuf::from(root);
        let file = root.join("updates/verified';中文.exe");
        let target = verified_target(&file, &root, &digest()).unwrap();
        let marker = STANDARD.encode(root.join("launched.txt").to_string_lossy().as_bytes());
        // Only installer launch is stubbed. PowerShell waits for this real parent
        // process and must still hold the verified file lock after it exits.
        let stub = format!(
            r#"
function Start-Process {{
    param($FilePath,$WindowStyle)
    $blocked=$false
    try {{$writer=[IO.File]::Open($FilePath,[IO.FileMode]::Open,[IO.FileAccess]::Write,[IO.FileShare]::ReadWrite); $writer.Dispose()}} catch {{$blocked=$true}}
    if(-not $blocked){{throw 'Installer was not locked'}}
    $marker=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('{marker}'))
    [IO.File]::WriteAllText($marker,'PARENT-EXITED;INSTALLER-LOCKED')
}}
"#
        );
        let body = script(&target, &digest(), std::process::id(), true).replace(
            "[System.Windows.Forms.MessageBox]::Show($message, $title) | Out-Null",
            "[Console]::Error.WriteLine($message)",
        );
        let mut helper = command(&(stub + &body)).spawn().unwrap();
        authorize(&mut helper, Duration::from_secs(15)).unwrap();
        // Dropping Child closes handles without terminating the helper.
    }

    #[test]
    fn handoff_survives_parent_exit() {
        let root = tempfile::tempdir().unwrap();
        fs::create_dir(root.path().join("updates")).unwrap();
        fs::write(
            root.path().join("updates/verified';中文.exe"),
            b"verified fixture",
        )
        .unwrap();
        let mut parent = Command::new(std::env::current_exe().unwrap())
            .args([
                "--ignored",
                "--exact",
                "platform::windows::update::tests::handoff_parent_fixture",
            ])
            .env("WIFIMETER_HANDOFF_TEST_ROOT", root.path())
            .stdin(Stdio::null())
            .spawn()
            .unwrap();
        assert!(wait(&mut parent).success());
        let marker = root.path().join("launched.txt");
        let deadline = Instant::now() + Duration::from_secs(10);
        while !marker.exists() && Instant::now() < deadline {
            thread::sleep(Duration::from_millis(20));
        }
        assert_eq!(
            fs::read_to_string(marker).unwrap(),
            "PARENT-EXITED;INSTALLER-LOCKED"
        );
    }

    #[test]
    fn fixed_powershell_locks_file_requires_go_and_localizes_authorized_failures() {
        for english in [false, true] {
            for mode in ["GO", "EOF", "changed", "start-failure", "parent-timeout"] {
                let root = tempfile::tempdir().unwrap();
                let file = root.path().join("fixture';中文.exe");
                fs::write(
                    &file,
                    if mode == "changed" {
                        b"replaced fixture".as_slice()
                    } else {
                        b"verified fixture"
                    },
                )
                .unwrap();
                let target = fs::canonicalize(&file).unwrap();
                let body = script(&target, &digest(), std::process::id(), english)
                    .replace("[System.Windows.Forms.MessageBox]", "[TestMessageBox]");
                let stubs = format!(
                    r#"
Add-Type -TypeDefinition 'public class TestMessageBox {{ public static void Show(string message, string title) {{ System.Console.WriteLine("MESSAGE:" + System.Convert.ToBase64String(System.Text.Encoding.UTF8.GetBytes(title + "|" + message))); }} }}'
function Get-Process {{
    $fake=[pscustomobject]@{{Handle=1}}
    $fake | Add-Member -MemberType ScriptMethod -Name WaitForExit -Value {{param($timeout) return {parent_exits}}}
    return $fake
}}
function Start-Process {{
    param($FilePath,$WindowStyle)
    {start_failure}
    if($WindowStyle -ne 'Hidden'){{throw 'Wrong window style'}}
    $blocked=$false
    try {{$writer=[IO.File]::Open($FilePath,[IO.FileMode]::Open,[IO.FileAccess]::Write,[IO.FileShare]::ReadWrite); $writer.Dispose()}} catch {{$blocked=$true}}
    if(-not $blocked){{throw 'Installer was not locked'}}
    [Console]::Out.WriteLine('LAUNCH-STUB')
}}
"#,
                    parent_exits = if mode == "parent-timeout" {
                        "$false"
                    } else {
                        "$true"
                    },
                    start_failure = if mode == "start-failure" {
                        "throw 'Injected failure'"
                    } else {
                        ""
                    }
                );
                let mut child = command(&(stubs + &body))
                    .stderr(Stdio::piped())
                    .spawn()
                    .unwrap();
                let mut input = child.stdin.take().unwrap();
                if ["GO", "start-failure", "parent-timeout"].contains(&mode) {
                    input.write_all(b"GO\n").unwrap();
                }
                drop(input);
                wait(&mut child);
                let output = child.wait_with_output().unwrap();
                let stdout = String::from_utf8(output.stdout).unwrap();
                assert_eq!(
                    output.status.success(),
                    mode == "GO",
                    "{mode}: {stdout} {}",
                    String::from_utf8_lossy(&output.stderr)
                );
                assert_eq!(
                    stdout.contains("READY"),
                    mode != "changed",
                    "{mode}: {stdout}"
                );
                assert_eq!(stdout.contains("LAUNCH-STUB"), mode == "GO");
                let messages: Vec<_> = stdout
                    .lines()
                    .filter_map(|line| line.strip_prefix("MESSAGE:"))
                    .collect();
                if ["start-failure", "parent-timeout"].contains(&mode) {
                    assert_eq!(messages.len(), 1);
                    let copy = String::from_utf8(STANDARD.decode(messages[0]).unwrap()).unwrap();
                    if english {
                        assert!(copy.is_ascii());
                    } else {
                        assert!(!copy
                            .replace("WiFiMeter", "")
                            .chars()
                            .any(|c| c.is_ascii_alphabetic()));
                    }
                } else {
                    assert!(messages.is_empty());
                }
            }
        }
    }

    #[test]
    fn parent_authorizes_only_a_complete_ready_and_closes_input_on_timeout_or_bad_output() {
        for mode in ["ready", "bad", "long", "late", "exit"] {
            let root = tempfile::tempdir().unwrap();
            let marker = root.path().join("received.txt");
            let output = match mode {
                "ready" => "[Console]::Out.Write('REA'); [Console]::Out.Flush(); Start-Sleep -Milliseconds 30; [Console]::Out.WriteLine('DY')",
                "bad" => "[Console]::Out.WriteLine('WRONG')",
                "long" => "[Console]::Out.WriteLine(('X'*130))",
                "late" => "Start-Sleep -Milliseconds 1000; [Console]::Out.WriteLine('READY')",
                _ => "exit 1",
            };
            let body = format!("{output}; [Console]::Out.Flush(); $line=[Console]::In.ReadLine(); [IO.File]::WriteAllText([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('{}')), [string]$line)", STANDARD.encode(marker.to_string_lossy().as_bytes()));
            let mut child = command(&body).spawn().unwrap();
            let result = authorize(
                &mut child,
                if mode == "late" {
                    Duration::from_millis(100)
                } else {
                    Duration::from_secs(10)
                },
            );
            assert_eq!(
                result,
                match mode {
                    "ready" => Ok(()),
                    "bad" | "long" => Err(UpdateError::HandoffInvalid),
                    "late" => Err(UpdateError::HandoffTimeout),
                    _ => Err(UpdateError::HandoffClosed),
                },
                "{mode}"
            );
            wait(&mut child);
            if mode != "exit" {
                assert_eq!(
                    fs::read_to_string(marker).unwrap(),
                    if mode == "ready" { "GO" } else { "" }
                );
            }
        }
    }
}
