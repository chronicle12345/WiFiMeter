use crate::files::atomic_write;
use serde_json::{json, Value};
use std::{fs, io, path::PathBuf, sync::Mutex};

pub fn defaults() -> Value {
    json!({ "miniWindow": false, "closeAction": "tray", "theme": "system",
        "miniShape": "bar", "miniPalette": "dark", "miniSnap": true, "miniAutoHide": true })
}

fn valid(key: &str, value: &Value) -> bool {
    match key {
        "miniWindow" | "miniSnap" | "miniAutoHide" => value.is_boolean(),
        "closeAction" => value
            .as_str()
            .is_some_and(|v| ["ask", "tray", "exit"].contains(&v)),
        "theme" => value
            .as_str()
            .is_some_and(|v| ["light", "dark", "system"].contains(&v)),
        "miniShape" => value
            .as_str()
            .is_some_and(|v| ["bar", "square", "circle"].contains(&v)),
        "miniPalette" => value
            .as_str()
            .is_some_and(|v| ["indigo", "dark", "light"].contains(&v)),
        _ => false,
    }
}

pub struct Preferences {
    file: PathBuf,
    value: Mutex<Value>,
}

impl Preferences {
    pub fn load(directory: PathBuf) -> Self {
        let file = directory.join("window-preferences.json");
        let mut value = defaults();
        match fs::read(&file) {
            Ok(bytes) => match serde_json::from_slice::<Value>(&bytes) {
                Ok(saved) => {
                    if let Some(fields) = saved.as_object() {
                        for (key, entry) in fields {
                            if valid(key, entry) {
                                value[key] = entry.clone();
                            }
                        }
                    }
                }
                Err(error) => eprintln!("[window-controls] 读取窗口偏好失败：{error}"),
            },
            Err(error) if error.kind() == io::ErrorKind::NotFound => (),
            Err(error) => eprintln!("[window-controls] 读取窗口偏好失败：{error}"),
        }
        Self {
            file,
            value: Mutex::new(value),
        }
    }

    pub fn read(&self) -> Value {
        self.value.lock().unwrap().clone()
    }

    pub fn update(&self, patch: Value) -> io::Result<Value> {
        let invalid = || io::Error::new(io::ErrorKind::InvalidInput, "窗口偏好无效。");
        let fields = patch.as_object().ok_or_else(invalid)?;
        if fields.iter().any(|(key, value)| !valid(key, value)) {
            return Err(invalid());
        }
        let mut current = self.value.lock().unwrap();
        let mut next = current.clone();
        for (key, value) in fields {
            next[key] = value.clone();
        }
        fs::create_dir_all(self.file.parent().unwrap())?;
        let body = serde_json::to_string_pretty(&next)? + "\n";
        atomic_write(&self.file, body.as_bytes())?;
        *current = next.clone();
        Ok(next)
    }
}
