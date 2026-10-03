use crate::{
    autostart::{LoginItems, LoginState},
    files,
};
use std::{
    fs, io,
    path::{Path, PathBuf},
};

pub struct LinuxLogin {
    file: PathBuf,
    executable: String,
}

// Desktop Entry string escaping precedes Exec argument unquoting. This is not a shell command.
fn quoted_exec(executable: &str) -> Result<String, String> {
    if !executable.starts_with('/') || executable.chars().any(|c| c.is_control() || c == '=') {
        return Err("Invalid autostart executable path".into());
    }
    let mut argument = String::from("\"");
    for ch in executable.chars() {
        match ch {
            '\\' => argument.push_str("\\\\\\\\"),
            '"' | '`' | '$' => {
                argument.push_str("\\\\");
                argument.push(ch);
            }
            '%' => argument.push_str("%%"),
            _ => argument.push(ch),
        }
    }
    argument.push('"');
    Ok(argument)
}

impl LinuxLogin {
    // APPIMAGE is the persistent launcher; current_exe points inside a temporary mount.
    pub fn new(config: &Path, executable: &Path, appimage: Option<&Path>) -> Result<Self, String> {
        let executable = appimage
            .unwrap_or(executable)
            .to_str()
            .ok_or("Autostart executable path is not UTF-8")?
            .to_owned();
        quoted_exec(&executable)?;
        Ok(Self {
            file: config.join("autostart/wifimeter.desktop"),
            executable,
        })
    }
}

impl LoginItems for LinuxLogin {
    fn read(&self) -> Result<LoginState, String> {
        let body = match fs::read_to_string(&self.file) {
            Ok(body) => body,
            Err(error) if error.kind() == io::ErrorKind::NotFound => {
                return Ok(LoginState::Missing)
            }
            Err(error) => return Err(error.to_string()),
        };
        let mut entry = false;
        let mut command = None;
        let mut enabled = true;
        for line in body.lines().map(str::trim) {
            if line.starts_with('[') {
                entry = line == "[Desktop Entry]";
            } else if entry {
                if let Some((key, value)) = line.split_once('=') {
                    match key.trim() {
                        "Exec" => command = Some(value.trim()),
                        "Hidden" if value.trim() == "true" => enabled = false,
                        "X-GNOME-Autostart-enabled" if value.trim() == "false" => enabled = false,
                        _ => (),
                    }
                }
            }
        }
        // Recognize the old Electron entry as well as our quoted entry. Preserve other installs.
        Ok(
            if command == Some(quoted_exec(&self.executable)?.as_str())
                || command == Some(&self.executable)
            {
                LoginState::Current(enabled)
            } else {
                LoginState::Other
            },
        )
    }

    fn write(&self, enabled: bool) -> Result<bool, String> {
        if enabled {
            let body = format!("[Desktop Entry]\nType=Application\nName=WiFiMeter\nExec={}\nTerminal=false\nX-GNOME-Autostart-enabled=true\n", quoted_exec(&self.executable)?);
            fs::create_dir_all(self.file.parent().unwrap()).map_err(|error| error.to_string())?;
            files::atomic_write(&self.file, body.as_bytes()).map_err(|error| error.to_string())?;
        } else if let Err(error) = fs::remove_file(&self.file) {
            if error.kind() != io::ErrorKind::NotFound {
                return Err(error.to_string());
            }
        }
        Ok(matches!(self.read()?, LoginState::Current(true)))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::autostart::Autostart;
    use serde_json::json;

    #[test]
    fn config_directory_and_appimage_launcher_survive_enable_disable() {
        let root = tempfile::tempdir().unwrap();
        let config = root.path().join("custom config");
        let launcher = Path::new("/home/user/下载/WiFi Meter.AppImage");
        let login = LinuxLogin::new(&config, Path::new("/tmp/.mount/app"), Some(launcher)).unwrap();
        assert_eq!(login.read().unwrap(), LoginState::Missing);
        assert!(login.write(true).unwrap());
        assert_eq!(login.read().unwrap(), LoginState::Current(true));
        let body = fs::read_to_string(&login.file).unwrap();
        assert!(body.contains("Exec=\"/home/user/下载/WiFi Meter.AppImage\"\n"));
        assert!(!body.contains(".mount"));
        assert!(!login.write(false).unwrap());
        assert!(!login.write(false).unwrap());
        assert_eq!(login.read().unwrap(), LoginState::Missing);
    }

    #[test]
    fn old_electron_entries_and_desktop_disabled_state_are_recognized() {
        let root = tempfile::tempdir().unwrap();
        let login =
            LinuxLogin::new(root.path(), Path::new("/opt/WiFiMeter/wifimeter"), None).unwrap();
        fs::create_dir_all(login.file.parent().unwrap()).unwrap();
        for (flag, enabled) in [
            ("", true),
            ("Hidden=true\n", false),
            ("X-GNOME-Autostart-enabled=false\n", false),
        ] {
            fs::write(&login.file, format!("[Desktop Entry]\nType=Application\nExec=/opt/WiFiMeter/wifimeter\n{flag}[Desktop Action other]\nExec=/other\n")).unwrap();
            assert_eq!(login.read().unwrap(), LoginState::Current(enabled));
        }
        fs::write(&login.file, "[Desktop Entry]\nExec=/opt/other/WiFiMeter\n").unwrap();
        assert_eq!(login.read().unwrap(), LoginState::Other);
        let file = login.file.clone();
        let manager = Autostart::new(Box::new(login), true, false);
        manager.prepare(&json!({"autoStart":false}), &json!({}));
        assert_eq!(manager.apply(&json!({"autoStart":false}), false), None);
        assert!(fs::read_to_string(&file).unwrap().contains("/opt/other/"));
        assert_eq!(manager.apply(&json!({"autoStart":true}), true), Some(true));
    }

    #[test]
    fn desktop_exec_quotes_reserved_characters_and_rejects_invalid_paths() {
        assert_eq!(
            quoted_exec("/tmp/a\\b\"c$d`e%f").unwrap(),
            "\"/tmp/a\\\\\\\\b\\\\\"c\\\\$d\\\\`e%%f\""
        );
        for path in [
            "relative",
            "/tmp/new\nExec=other",
            "/tmp/equal=name",
            "/tmp/zero\0",
        ] {
            assert!(quoted_exec(path).is_err());
        }
    }
}
