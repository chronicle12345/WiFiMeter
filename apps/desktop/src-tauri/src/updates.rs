use crate::files::atomic_write;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{cmp::Ordering, fs, io, path::PathBuf, sync::Mutex};
use url::Url;

pub const REPOSITORY: &str = "https://github.com/chronicle12345/WiFiMeter";
pub const API: &str = "https://api.github.com/repos/chronicle12345/WiFiMeter/releases/latest";
const DAY_MS: f64 = 86_400_000.0;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum UpdateError {
    Version,
    Release,
    Preferences,
    Network,
    Download,
    Install,
    Cancelled,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Version {
    pub version: String,
    core: [String; 3],
    prerelease: Vec<String>,
}

fn numeric(value: &str) -> bool {
    !value.is_empty() && value.bytes().all(|byte| byte.is_ascii_digit())
}

fn identifiers(value: &str) -> bool {
    value.split('.').all(|part| {
        !part.is_empty()
            && part
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
    })
}

fn decimal_cmp(left: &str, right: &str) -> Ordering {
    left.len().cmp(&right.len()).then_with(|| left.cmp(right))
}

impl Version {
    pub fn parse(value: &str) -> Result<Self, UpdateError> {
        let version = value.strip_prefix('v').unwrap_or(value);
        let without_build = match version.split_once('+') {
            Some((version, build)) if identifiers(build) => version,
            Some(_) => return Err(UpdateError::Version),
            None => version,
        };
        let (core, prerelease) = match without_build.split_once('-') {
            Some((core, pre)) if identifiers(pre) => (core, pre.split('.').collect::<Vec<_>>()),
            Some(_) => return Err(UpdateError::Version),
            None => (without_build, vec![]),
        };
        let core: Vec<_> = core.split('.').collect();
        if core.len() != 3
            || core
                .iter()
                .any(|part| !numeric(part) || (part.len() > 1 && part.starts_with('0')))
            || prerelease
                .iter()
                .any(|part| numeric(part) && part.len() > 1 && part.starts_with('0'))
        {
            return Err(UpdateError::Version);
        }
        Ok(Self {
            version: version.into(),
            core: [core[0].into(), core[1].into(), core[2].into()],
            prerelease: prerelease.into_iter().map(String::from).collect(),
        })
    }

    // 与旧版 BigInt 比较保持一致；版本整数不受机器字长限制，构建元数据不参与比较。
    pub fn compare(&self, other: &Self) -> Ordering {
        for (left, right) in self.core.iter().zip(&other.core) {
            let order = decimal_cmp(left, right);
            if order != Ordering::Equal {
                return order;
            }
        }
        if self.prerelease.is_empty() || other.prerelease.is_empty() {
            return self.prerelease.is_empty().cmp(&other.prerelease.is_empty());
        }
        for (left, right) in self.prerelease.iter().zip(&other.prerelease) {
            let order = match (numeric(left), numeric(right)) {
                (true, true) => decimal_cmp(left, right),
                (true, false) => Ordering::Less,
                (false, true) => Ordering::Greater,
                (false, false) => left.cmp(right),
            };
            if order != Ordering::Equal {
                return order;
            }
        }
        self.prerelease.len().cmp(&other.prerelease.len())
    }
}

// JS encodeURIComponent 的字符集合；保留旧版本标签及包含构建元数据的资产 URL。
fn component(value: &str) -> String {
    let mut encoded = String::new();
    for byte in value.bytes() {
        if byte.is_ascii_alphanumeric() || b"-_.!~*'()".contains(&byte) {
            encoded.push(byte as char);
        } else {
            use std::fmt::Write;
            write!(encoded, "%{byte:02X}").unwrap();
        }
    }
    encoded
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Asset {
    pub name: String,
    pub url: String,
    pub digest: String,
}

#[derive(Debug, Clone)]
pub struct Release {
    pub newer: bool,
    pub version: String,
    pub notes: String,
    pub url: String,
    pub asset: Option<Asset>,
}

pub fn select_release(
    current: &Version,
    release: &Value,
    platform: &str,
    arch: &str,
) -> Result<Release, UpdateError> {
    let tag = release["tag_name"].as_str().ok_or(UpdateError::Release)?;
    let latest = Version::parse(tag)?;
    if !latest.prerelease.is_empty()
        || ["draft", "prerelease"]
            .iter()
            .any(|key| !release[*key].is_null() && release[*key] != false)
    {
        return Err(UpdateError::Release);
    }
    let newer = latest.compare(current) == Ordering::Greater;
    let mut asset = None;
    if newer && platform == "win32" && ["x64", "ia32", "arm64"].contains(&arch) {
        let names = [
            format!("WiFiMeter-{}-windows-{arch}-Setup.exe", latest.version),
            format!("WiFiMeter-{}-{arch}-Setup.exe", latest.version),
        ];
        if let Some(assets) = release["assets"].as_array() {
            // 首选命名存在但损坏时不回退旧名，避免安装另一份意外资产。
            if let Some(name) = names
                .iter()
                .find(|name| assets.iter().any(|a| a["name"] == **name))
            {
                let url = format!(
                    "{REPOSITORY}/releases/download/{}/{}",
                    component(tag),
                    component(name)
                );
                let matches: Vec<_> = assets
                    .iter()
                    .filter_map(|entry| {
                        let digest = entry["digest"].as_str()?.strip_prefix("sha256:")?;
                        (entry["name"] == *name
                            && entry["browser_download_url"] == url
                            && digest.len() == 64
                            && digest.bytes().all(|byte| byte.is_ascii_hexdigit()))
                        .then(|| digest.to_ascii_lowercase())
                    })
                    .collect();
                if matches.len() == 1 {
                    asset = Some(Asset {
                        name: name.clone(),
                        url,
                        digest: matches[0].clone(),
                    });
                }
            }
        }
    }
    Ok(Release {
        newer,
        version: latest.version,
        notes: release["body"].as_str().unwrap_or("").into(),
        url: format!("{REPOSITORY}/releases/tag/{}", component(tag)),
        asset,
    })
}

pub fn redirect_allowed(value: &str, original: &str) -> bool {
    let Ok(url) = Url::parse(value) else {
        return false;
    };
    if url.scheme() != "https"
        || !url.username().is_empty()
        || url.password().is_some()
        || url.port().is_some()
        || url.fragment().is_some()
    {
        return false;
    }
    if value == original {
        return true;
    }
    if !matches!(
        url.host_str(),
        Some("release-assets.githubusercontent.com" | "objects.githubusercontent.com")
    ) {
        return false;
    }
    let Some(path) = url.path().strip_prefix("/github-production-release-asset") else {
        return false;
    };
    if path.starts_with('/') {
        return true;
    }
    path.strip_prefix('-')
        .and_then(|path| path.split_once('/'))
        .is_some_and(|(suffix, _)| {
            !suffix.is_empty()
                && suffix
                    .bytes()
                    .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
        })
}

pub fn external_url(value: &str) -> Result<String, UpdateError> {
    let url = Url::parse(value).map_err(|_| UpdateError::Release)?;
    if url.scheme() != "https"
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return Err(UpdateError::Release);
    }
    Ok(url.into())
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct UpdatePreferences {
    pub check_on_startup: bool,
    #[serde(default)]
    pub last_automatic_at: f64,
}

#[derive(Default)]
struct PreferenceState {
    saved: Option<UpdatePreferences>,
    failed: bool,
}

pub struct Preferences {
    file: PathBuf,
    state: Mutex<PreferenceState>,
}

impl Preferences {
    pub fn new(profile: PathBuf) -> Self {
        Self {
            file: profile.join("update-preferences.json"),
            state: Mutex::default(),
        }
    }

    fn load(&self, state: &mut PreferenceState) -> Result<UpdatePreferences, UpdateError> {
        if let Some(saved) = &state.saved {
            return Ok(saved.clone());
        }
        let result = match fs::read(&self.file) {
            Ok(bytes) => serde_json::from_slice::<UpdatePreferences>(&bytes)
                .map_err(|_| UpdateError::Preferences),
            Err(error) if error.kind() == io::ErrorKind::NotFound && !state.failed => {
                Ok(UpdatePreferences {
                    check_on_startup: true,
                    last_automatic_at: 0.0,
                })
            }
            Err(_) => Err(UpdateError::Preferences),
        }
        .and_then(|saved| {
            if saved.last_automatic_at.is_finite() && saved.last_automatic_at >= 0.0 {
                Ok(saved)
            } else {
                Err(UpdateError::Preferences)
            }
        });
        match result {
            Ok(saved) => {
                state.saved = Some(saved.clone());
                state.failed = false;
                Ok(saved)
            }
            Err(error) => {
                state.failed = true;
                Err(error)
            }
        }
    }

    fn save(
        &self,
        state: &mut PreferenceState,
        next: UpdatePreferences,
    ) -> Result<(), UpdateError> {
        let write = || -> io::Result<()> {
            fs::create_dir_all(self.file.parent().unwrap())?;
            let body = serde_json::to_string_pretty(&next)? + "\n";
            atomic_write(&self.file, body.as_bytes())
        };
        if write().is_err() {
            state.saved = None;
            state.failed = true;
            return Err(UpdateError::Preferences);
        }
        state.saved = Some(next);
        state.failed = false;
        Ok(())
    }

    pub fn read(&self) -> Result<UpdatePreferences, UpdateError> {
        self.load(&mut self.state.lock().unwrap())
    }

    pub fn enabled(&self) -> bool {
        let state = self.state.lock().unwrap();
        !state.failed
            && state
                .saved
                .as_ref()
                .is_none_or(|saved| saved.check_on_startup)
    }

    pub fn set_enabled(&self, enabled: bool) -> Result<(), UpdateError> {
        let mut state = self.state.lock().unwrap();
        let mut next = self.load(&mut state)?;
        next.check_on_startup = enabled;
        self.save(&mut state, next)
    }

    // 在发出网络请求前保存限频时间；失败的请求也占用本次自动检查机会。
    pub fn begin_check(
        &self,
        automatic: bool,
        now_ms: f64,
    ) -> Result<Option<&'static str>, UpdateError> {
        let mut state = self.state.lock().unwrap();
        let mut next = self.load(&mut state)?;
        if automatic {
            if !next.check_on_startup {
                return Ok(Some("disabled"));
            }
            if next.last_automatic_at != 0.0 && now_ms - next.last_automatic_at < DAY_MS {
                return Ok(Some("cached"));
            }
            next.last_automatic_at = now_ms;
            self.save(&mut state, next)?;
        }
        Ok(None)
    }
}
