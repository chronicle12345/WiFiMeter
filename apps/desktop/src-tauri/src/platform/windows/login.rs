use crate::{
    autostart::{LoginItems, LoginState},
    identity::WINDOWS_APP_ID,
};
use std::{io, ptr};
use windows_sys::Win32::{
    Foundation::{ERROR_FILE_NOT_FOUND, ERROR_PATH_NOT_FOUND, ERROR_SUCCESS},
    System::Registry::*,
};

pub struct WindowsLogin {
    run: String,
    approved: String,
    executable: String,
}

fn wide(value: &str) -> Vec<u16> {
    value.encode_utf16().chain(Some(0)).collect()
}
fn check(code: u32) -> Result<(), String> {
    if code == ERROR_SUCCESS {
        Ok(())
    } else {
        Err(io::Error::from_raw_os_error(code as i32).to_string())
    }
}
fn read_value(key: &str, flags: u32) -> Result<Option<Vec<u8>>, String> {
    let key = wide(key);
    let name = wide(WINDOWS_APP_ID);
    let mut length = 0;
    let result = unsafe {
        RegGetValueW(
            HKEY_CURRENT_USER,
            key.as_ptr(),
            name.as_ptr(),
            flags,
            ptr::null_mut(),
            ptr::null_mut(),
            &mut length,
        )
    };
    if matches!(result, ERROR_FILE_NOT_FOUND | ERROR_PATH_NOT_FOUND) {
        return Ok(None);
    }
    check(result)?;
    let mut bytes = vec![0; length as usize];
    check(unsafe {
        RegGetValueW(
            HKEY_CURRENT_USER,
            key.as_ptr(),
            name.as_ptr(),
            flags,
            ptr::null_mut(),
            bytes.as_mut_ptr().cast(),
            &mut length,
        )
    })?;
    bytes.truncate(length as usize);
    Ok(Some(bytes))
}
fn delete_value(key: &str) -> Result<(), String> {
    let result = unsafe {
        RegDeleteKeyValueW(
            HKEY_CURRENT_USER,
            wide(key).as_ptr(),
            wide(WINDOWS_APP_ID).as_ptr(),
        )
    };
    if matches!(result, ERROR_FILE_NOT_FOUND | ERROR_PATH_NOT_FOUND) {
        Ok(())
    } else {
        check(result)
    }
}
fn write_command(key: &str, command: &str) -> Result<(), String> {
    let data = wide(command);
    check(unsafe {
        RegSetKeyValueW(
            HKEY_CURRENT_USER,
            wide(key).as_ptr(),
            wide(WINDOWS_APP_ID).as_ptr(),
            REG_SZ,
            data.as_ptr().cast(),
            (data.len() * 2) as u32,
        )
    })
}

impl WindowsLogin {
    pub fn new(executable: String) -> Self {
        Self {
            run: r"Software\Microsoft\Windows\CurrentVersion\Run".into(),
            approved: r"Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run"
                .into(),
            executable,
        }
    }
}

impl LoginItems for WindowsLogin {
    fn read(&self) -> Result<LoginState, String> {
        let Some(raw) = read_value(&self.run, RRF_RT_REG_SZ)? else {
            return Ok(LoginState::Missing);
        };
        let utf16: Vec<_> = raw
            .chunks_exact(2)
            .map(|pair| u16::from_le_bytes([pair[0], pair[1]]))
            .take_while(|unit| *unit != 0)
            .collect();
        let command = String::from_utf16(&utf16).map_err(|error| error.to_string())?;
        // Packaged Electron and Tauri launch the executable without extra arguments.
        // Preserve another portable path or a development Electron command as-is.
        if !command
            .trim()
            .trim_matches('"')
            .replace('/', "\\")
            .eq_ignore_ascii_case(&self.executable.replace('/', "\\"))
        {
            return Ok(LoginState::Other);
        }
        let approved = read_value(&self.approved, RRF_RT_REG_BINARY)?;
        let enabled = approved
            .as_ref()
            .is_none_or(|bytes| matches!(bytes.first(), Some(0 | 2)));
        Ok(LoginState::Current(enabled))
    }
    fn write(&self, enabled: bool) -> Result<bool, String> {
        if enabled {
            write_command(&self.run, &format!("\"{}\"", self.executable))?;
            delete_value(&self.approved)?;
        } else {
            delete_value(&self.run)?;
            delete_value(&self.approved)?;
        }
        Ok(matches!(self.read()?, LoginState::Current(true)))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn windows_registry_round_trip_does_not_touch_real_startup_keys() {
        let key = format!(
            r"Software\WiFiMeterTest\{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        );
        struct Cleanup(String);
        impl Drop for Cleanup {
            fn drop(&mut self) {
                unsafe {
                    RegDeleteTreeW(HKEY_CURRENT_USER, wide(&self.0).as_ptr());
                }
            }
        }
        let _cleanup = Cleanup(key.clone());
        let registry = WindowsLogin {
            run: format!(r"{key}\Run"),
            approved: format!(r"{key}\Approved"),
            executable: r"C:\含空格目录\WiFi Meter\WiFiMeter.exe".into(),
        };
        assert_eq!(registry.read().unwrap(), LoginState::Missing);
        assert!(registry.write(true).unwrap());
        assert_eq!(registry.read().unwrap(), LoginState::Current(true));
        let disabled = [3u8, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
        check(unsafe {
            RegSetKeyValueW(
                HKEY_CURRENT_USER,
                wide(&registry.approved).as_ptr(),
                wide(WINDOWS_APP_ID).as_ptr(),
                REG_BINARY,
                disabled.as_ptr().cast(),
                disabled.len() as u32,
            )
        })
        .unwrap();
        assert_eq!(registry.read().unwrap(), LoginState::Current(false));
        assert!(registry.write(true).unwrap());
        write_command(&registry.run, r#""D:\Other Portable\WiFiMeter.exe""#).unwrap();
        assert_eq!(registry.read().unwrap(), LoginState::Other);
        assert!(!registry.write(false).unwrap());
        assert_eq!(registry.read().unwrap(), LoginState::Missing);
    }
}
