use serde_json::{json, Value};
use std::{
    collections::{HashMap, VecDeque},
    sync::Mutex,
    time::{Duration, Instant},
};

#[derive(Default)]
pub struct AppIcons {
    cache: Mutex<Cache>,
}

#[derive(Default)]
struct Cache {
    icons: VecDeque<((String, String), String)>,
    snapshots: VecDeque<(String, Instant, HashMap<String, String>)>,
}

fn month_query(date: &str) -> Option<(String, Value)> {
    if date.is_empty() {
        return Some((String::new(), json!({})));
    }
    let bytes = date.as_bytes();
    if bytes.len() != 10
        || bytes[4] != b'-'
        || bytes[7] != b'-'
        || bytes
            .iter()
            .enumerate()
            .any(|(i, b)| i != 4 && i != 7 && !b.is_ascii_digit())
    {
        return None;
    }
    let year: u32 = date[..4].parse().ok()?;
    let month: u32 = date[5..7].parse().ok()?;
    let day: u32 = date[8..].parse().ok()?;
    let days = match month {
        2 if year % 4 == 0 && (year % 100 != 0 || year % 400 == 0) => 29,
        2 => 28,
        4 | 6 | 9 | 11 => 30,
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        _ => return None,
    };
    if day == 0 || day > days {
        return None;
    }
    let month = &date[..7];
    Some((
        month.into(),
        json!({"from":format!("{month}-01"),"to":format!("{month}-{days}")}),
    ))
}

pub fn executable_path(value: &str, windows: bool) -> Option<String> {
    if value.is_empty() || value.len() > 4096 || value.chars().any(|c| c < ' ') {
        return None;
    }
    if windows {
        let bytes = value.as_bytes();
        if bytes.len() < 7
            || !bytes[0].is_ascii_alphabetic()
            || bytes[1] != b':'
            || !matches!(bytes[2], b'/' | b'\\')
            || !value.to_ascii_lowercase().ends_with(".exe")
            || value[2..].contains([':', '*', '?', '"', '<', '>', '|'])
            || value
                .split(['/', '\\'])
                .any(|part| matches!(part, "." | ".."))
        {
            return None;
        }
        Some(value.replace('/', "\\"))
    } else {
        (value.starts_with('/')
            && !value.starts_with("//")
            && !value.split('/').any(|part| part == ".."))
        .then(|| value.into())
    }
}

impl AppIcons {
    // Serialize extraction on IPC workers, sharing one snapshot and one icon per key.
    // Keep only the same bounded metadata as the old host; failures remain retryable.
    pub fn get(
        &self,
        input: &Value,
        windows: bool,
        mut snapshot: impl FnMut(Value) -> Option<Value>,
        mut extract: impl FnMut(&str) -> Option<String>,
    ) -> Option<String> {
        let id = input["appId"].as_str()?;
        if id.is_empty() || id.len() > 4096 || id.chars().any(|c| c < ' ') {
            return None;
        }
        let date = match input.get("date") {
            None | Some(Value::Null) => "",
            Some(value) => value.as_str()?,
        };
        let (month, params) = month_query(date)?;
        let key = (id.to_string(), date.to_string());
        let mut cache = self.cache.lock().unwrap();
        if let Some((_, icon)) = cache.icons.iter().find(|(item, _)| item == &key) {
            return Some(icon.clone());
        }
        let cached = cache
            .snapshots
            .iter()
            .position(|(item, at, _)| item == &month && at.elapsed() < Duration::from_secs(5));
        let index = if let Some(index) = cached {
            index
        } else {
            let data = snapshot(params)?;
            let mut known = HashMap::new();
            for row in ["appProcesses", "appRecords"]
                .iter()
                .flat_map(|field| data[field].as_array().into_iter().flatten())
            {
                if known.len() >= 4096 {
                    break;
                }
                let Some(id) = row["appId"].as_str() else {
                    continue;
                };
                let path = ["path", "appPath", "executablePath", "appId"]
                    .iter()
                    .find_map(|field| row[field].as_str().filter(|s| !s.is_empty()));
                if let Some(path) = path.and_then(|value| executable_path(value, windows)) {
                    known.insert(id.into(), path);
                }
            }
            cache.snapshots.retain(|(item, _, _)| item != &month);
            cache.snapshots.push_back((month, Instant::now(), known));
            if cache.snapshots.len() > 8 {
                cache.snapshots.pop_front();
            }
            cache.snapshots.len() - 1
        };
        let path = cache.snapshots[index].2.get(id)?;
        let icon = extract(path)?;
        let encoded = icon.strip_prefix("data:image/png;base64,")?;
        if icon.len() > 512 * 1024
            || encoded.is_empty()
            || !encoded
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'+' | b'/' | b'='))
        {
            return None;
        }
        cache.icons.push_back((key, icon.clone()));
        if cache.icons.len() > 256 {
            cache.icons.pop_front();
        }
        Some(icon)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    const ID: &str = "C:\\Apps\\Browser.exe";
    const PNG: &str = "data:image/png;base64,aWNvbg==";

    #[test]
    fn concurrent_requests_share_extraction_and_expired_lookups_refresh() {
        use std::sync::{
            atomic::{AtomicUsize, Ordering},
            Arc, Barrier,
        };
        let icons = Arc::new(AppIcons::default());
        let start = Arc::new(Barrier::new(4));
        let queries = Arc::new(AtomicUsize::new(0));
        let extractions = Arc::new(AtomicUsize::new(0));
        let threads: Vec<_> = (0..4)
            .map(|_| {
                let (icons, start, queries, extractions) = (
                    icons.clone(),
                    start.clone(),
                    queries.clone(),
                    extractions.clone(),
                );
                std::thread::spawn(move || {
                    start.wait();
                    icons.get(
                        &json!({"appId":ID}),
                        true,
                        |_| {
                            queries.fetch_add(1, Ordering::SeqCst);
                            Some(json!({"appRecords":[{"appId":ID}]}))
                        },
                        |_| {
                            extractions.fetch_add(1, Ordering::SeqCst);
                            Some(PNG.into())
                        },
                    )
                })
            })
            .collect();
        for thread in threads {
            assert_eq!(thread.join().unwrap(), Some(PNG.into()));
        }
        assert_eq!(queries.load(Ordering::SeqCst), 1);
        assert_eq!(extractions.load(Ordering::SeqCst), 1);
        icons.cache.lock().unwrap().snapshots[0].1 = Instant::now() - Duration::from_secs(6);
        assert_eq!(
            icons.get(
                &json!({"appId":"C:\\New.exe"}),
                true,
                |_| Some(json!({"appProcesses":[{"appId":"C:\\New.exe"}]})),
                |_| Some(PNG.into())
            ),
            Some(PNG.into())
        );
    }

    #[test]
    fn only_known_executables_reach_native_extraction() {
        let icons = AppIcons::default();
        for input in [
            Value::Null,
            json!({}),
            json!({"appId":"C:\\secret.exe"}),
            json!({"appId":ID,"date":"2026-02-31"}),
        ] {
            assert!(icons
                .get(
                    &input,
                    true,
                    |_| Some(json!({"appRecords":[{"appId":ID}]})),
                    |_| panic!("unexpected extraction")
                )
                .is_none());
        }
        for path in [
            "C:\\Apps\\..\\secret.exe",
            "\\\\server\\app.exe",
            "C:\\app.exe:stream.exe",
            "C:\\app.txt",
            "app.exe",
        ] {
            assert!(AppIcons::default()
                .get(
                    &json!({"appId":ID}),
                    true,
                    |_| Some(json!({"appRecords":[{"appId":ID,"path":path}]})),
                    |_| panic!("unexpected extraction")
                )
                .is_none());
        }
    }

    #[test]
    fn historical_lookup_caches_month_and_ignores_renderer_path() {
        let icons = AppIcons::default();
        let input = json!({"appId":ID,"date":"2020-02-29","path":"C:\\secret.exe"});
        assert_eq!(
            icons.get(
                &input,
                true,
                |params| {
                    assert_eq!(params, json!({"from":"2020-02-01","to":"2020-02-29"}));
                    Some(json!({"appRecords":[{"appId":ID},{"appId":"C:\\Other.exe"}]}))
                },
                |path| {
                    assert_eq!(path, ID);
                    Some(PNG.into())
                }
            ),
            Some(PNG.into())
        );
        assert_eq!(
            icons.get(&input, true, |_| panic!(), |_| panic!()),
            Some(PNG.into())
        );
        assert_eq!(
            icons.get(
                &json!({"appId":"C:\\Other.exe","date":"2020-02-01"}),
                true,
                |_| panic!(),
                |_| Some(PNG.into())
            ),
            Some(PNG.into())
        );
        assert!(month_query("1900-02-29").is_none());
        assert!(month_query("2000-02-29").is_some());
    }

    #[test]
    fn failed_extraction_retries_and_caches_are_bounded() {
        let icons = AppIcons::default();
        let data = || json!({"appRecords":(0..257).map(|i| json!({"appId":format!("C:\\App{i}.exe")})).collect::<Vec<_>>()});
        let input = json!({"appId":"C:\\App0.exe"});
        assert!(icons
            .get(&input, true, |_| Some(data()), |_| None)
            .is_none());
        for i in 0..257 {
            assert!(icons
                .get(
                    &json!({"appId":format!("C:\\App{i}.exe")}),
                    true,
                    |_| panic!(),
                    |_| Some(PNG.into())
                )
                .is_some());
        }
        assert_eq!(icons.cache.lock().unwrap().icons.len(), 256);
        let mut extracted = false;
        icons.get(
            &input,
            true,
            |_| panic!(),
            |_| {
                extracted = true;
                Some(PNG.into())
            },
        );
        assert!(extracted);
        for month in 1..=9 {
            icons.get(
                &json!({"appId":"unknown","date":format!("2026-{month:02}-01")}),
                true,
                |_| Some(data()),
                |_| panic!(),
            );
        }
        assert_eq!(icons.cache.lock().unwrap().snapshots.len(), 8);
    }
}
