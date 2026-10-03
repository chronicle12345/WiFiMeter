use crate::updates::{redirect_allowed, Asset, UpdateError, API};
use reqwest::{blocking::Client, header, redirect};
use serde::Serialize;
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{
    fs,
    io::{BufReader, Read, Write},
    path::Path,
    time::{Duration, Instant},
};
use tempfile::TempPath;
use url::Url;

pub struct Response {
    pub status: u16,
    pub location: Option<String>,
    pub length: Option<String>,
    pub body: Box<dyn Read + Send>,
}

pub trait Transport: Send + Sync {
    fn get(&self, url: &str, timeout: Duration) -> Result<Response, UpdateError>;
}

// 仅显式测试构建使用本地夹具；正式发布不包含此路径。
#[cfg(all(feature = "test-fixture", debug_assertions))]
pub(crate) struct FixtureTransport(pub std::path::PathBuf);

#[cfg(all(feature = "test-fixture", debug_assertions))]
impl Transport for FixtureTransport {
    fn get(&self, url: &str, _: Duration) -> Result<Response, UpdateError> {
        let file = fs::File::open(self.0.join(if url == API {
            "release.json"
        } else {
            "installer.exe"
        }))
        .map_err(|_| UpdateError::Network)?;
        let length = file
            .metadata()
            .map_err(|_| UpdateError::Network)?
            .len()
            .to_string();
        Ok(Response {
            status: 200,
            location: None,
            length: Some(length),
            body: Box::new(file),
        })
    }
}

pub struct HttpTransport(Client);

impl HttpTransport {
    // 由桌面阻塞线程创建和调用，不占用 WebView 事件线程。
    pub fn new() -> Result<Self, UpdateError> {
        Self::builder()
            .https_only(true)
            .build()
            .map(Self)
            .map_err(|_| UpdateError::Network)
    }

    fn builder() -> reqwest::blocking::ClientBuilder {
        Client::builder()
            .redirect(redirect::Policy::none())
            .referer(false)
            .user_agent(concat!("WiFiMeter/", env!("CARGO_PKG_VERSION")))
    }
}

impl Transport for HttpTransport {
    fn get(&self, url: &str, timeout: Duration) -> Result<Response, UpdateError> {
        let response = self
            .0
            .get(url)
            .timeout(timeout)
            .header(
                header::ACCEPT,
                if url == API {
                    "application/vnd.github+json"
                } else {
                    "application/octet-stream"
                },
            )
            .send()
            .map_err(|_| UpdateError::Network)?;
        Ok(Response {
            status: response.status().as_u16(),
            location: response
                .headers()
                .get(header::LOCATION)
                .and_then(|v| v.to_str().ok())
                .map(String::from),
            length: response
                .headers()
                .get(header::CONTENT_LENGTH)
                .and_then(|v| v.to_str().ok())
                .map(String::from),
            body: Box::new(response),
        })
    }
}

pub fn fetch_release(transport: &dyn Transport) -> Result<Value, UpdateError> {
    let response = transport.get(API, Duration::from_secs(30))?;
    if !(200..300).contains(&response.status) {
        return Err(UpdateError::Network);
    }
    serde_json::from_reader(BufReader::new(response.body)).map_err(|_| UpdateError::Network)
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Progress {
    pub phase: &'static str,
    pub received_bytes: u64,
    pub total_bytes: Option<u64>,
    pub percent: Option<f64>,
}

fn content_length(value: Option<&str>) -> Option<u64> {
    let value = value?;
    if value.is_empty() || !value.bytes().all(|byte| byte.is_ascii_digit()) {
        return None;
    }
    value
        .parse::<u64>()
        .ok()
        .filter(|length| *length > 0 && *length <= 9_007_199_254_740_991)
}

pub fn download(
    transport: &dyn Transport,
    asset: &Asset,
    directory: &Path,
    progress: impl FnMut(Progress),
) -> Result<TempPath, UpdateError> {
    download_with_timeout(
        transport,
        asset,
        directory,
        Duration::from_secs(600),
        progress,
    )
}

fn download_with_timeout(
    transport: &dyn Transport,
    asset: &Asset,
    directory: &Path,
    timeout: Duration,
    mut progress: impl FnMut(Progress),
) -> Result<TempPath, UpdateError> {
    let deadline = Instant::now() + timeout;
    let mut current = Progress {
        phase: "downloading",
        received_bytes: 0,
        total_bytes: None,
        percent: None,
    };
    progress(current.clone());
    let mut url = asset.url.clone();
    let mut response = None;
    for redirects in 0..=5 {
        let remaining = deadline
            .checked_duration_since(Instant::now())
            .ok_or(UpdateError::Download)?;
        let fetched = transport.get(&url, remaining)?;
        if ![301, 302, 303, 307, 308].contains(&fetched.status) {
            response = Some(fetched);
            break;
        }
        if redirects == 5 {
            return Err(UpdateError::Download);
        }
        let location = fetched
            .location
            .as_deref()
            .filter(|location| !location.is_empty())
            .ok_or(UpdateError::Download)?;
        url = Url::parse(&url)
            .and_then(|base| base.join(location))
            .map_err(|_| UpdateError::Download)?
            .into();
        if !redirect_allowed(&url, &asset.url) {
            return Err(UpdateError::Download);
        }
        // 丢弃重定向响应，不读取无用正文，也不保存带签名参数的地址。
    }
    let mut response = response.ok_or(UpdateError::Download)?;
    if !(200..300).contains(&response.status) {
        return Err(UpdateError::Download);
    }
    current.total_bytes = content_length(response.length.as_deref());
    current.percent = current.total_bytes.map(|_| 0.0);
    progress(current.clone());
    fs::create_dir_all(directory).map_err(|_| UpdateError::Download)?;
    let mut temporary = tempfile::Builder::new()
        .prefix(".download-")
        .suffix(".tmp")
        .tempfile_in(directory)
        .map_err(|_| UpdateError::Download)?;
    let mut hash = Sha256::new();
    let mut buffer = [0u8; 64 * 1024];
    let mut last_progress = Instant::now();
    loop {
        if Instant::now() >= deadline {
            return Err(UpdateError::Download);
        }
        let count = response
            .body
            .read(&mut buffer)
            .map_err(|_| UpdateError::Download)?;
        if Instant::now() >= deadline {
            return Err(UpdateError::Download);
        }
        if count == 0 {
            break;
        }
        temporary
            .write_all(&buffer[..count])
            .map_err(|_| UpdateError::Download)?;
        hash.update(&buffer[..count]);
        current.received_bytes += count as u64;
        current.percent = current
            .total_bytes
            .map(|total| (current.received_bytes as f64 / total as f64 * 100.0).min(100.0));
        if last_progress.elapsed() >= Duration::from_millis(100) {
            progress(current.clone());
            last_progress = Instant::now();
        }
    }
    progress(current.clone());
    current.phase = "verifying";
    current.percent = None;
    progress(current);
    if format!("{:x}", hash.finalize()) != asset.digest {
        return Err(UpdateError::DigestMismatch);
    }
    temporary
        .as_file()
        .sync_all()
        .map_err(|_| UpdateError::Download)?;
    let destination = temporary.path().with_extension("exe");
    temporary
        .persist_noclobber(&destination)
        .map_err(|_| UpdateError::Download)?;
    // 持有到安装交接成功；调用方失败或取消时自动清除已经校验的文件。
    TempPath::try_from_path(destination).map_err(|_| UpdateError::Download)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        collections::VecDeque,
        io::{self, Cursor},
        net::TcpListener,
        sync::Mutex,
        thread,
    };

    const BYTES: &[u8] = b"fixture installer bytes";

    fn asset() -> Asset {
        Asset { name: "WiFiMeter-1.3.0-windows-x64-Setup.exe".into(),
            url: "https://github.com/chronicle12345/WiFiMeter/releases/download/v1.3.0/WiFiMeter-1.3.0-windows-x64-Setup.exe".into(),
            digest: format!("{:x}", Sha256::digest(BYTES)) }
    }

    fn response(status: u16, body: &[u8]) -> Response {
        Response {
            status,
            location: None,
            length: Some(body.len().to_string()),
            body: Box::new(Cursor::new(body.to_vec())),
        }
    }

    struct Mock {
        responses: Mutex<VecDeque<Response>>,
        calls: Mutex<Vec<(String, Duration)>>,
    }

    impl Mock {
        fn new(responses: Vec<Response>) -> Self {
            Self {
                responses: Mutex::new(responses.into()),
                calls: Mutex::default(),
            }
        }
    }

    impl Transport for Mock {
        fn get(&self, url: &str, timeout: Duration) -> Result<Response, UpdateError> {
            self.calls.lock().unwrap().push((url.into(), timeout));
            self.responses
                .lock()
                .unwrap()
                .pop_front()
                .ok_or(UpdateError::Network)
        }
    }

    #[test]
    fn streams_verified_bytes_and_cleans_files_until_handoff_keeps_them() {
        for length in [
            None,
            Some("0"),
            Some("garbage"),
            Some("9007199254740992"),
            Some("22"),
        ] {
            let directory = tempfile::tempdir().unwrap();
            let mut reply = response(200, BYTES);
            reply.length = length.map(String::from);
            let mock = Mock::new(vec![reply]);
            let mut progress = vec![];
            let file = download(&mock, &asset(), directory.path(), |p| progress.push(p)).unwrap();
            assert_eq!(fs::read(&file).unwrap(), BYTES);
            assert_eq!(file.extension().unwrap(), "exe");
            assert_eq!(fs::read_dir(directory.path()).unwrap().count(), 1);
            let complete = &progress[progress.len() - 2];
            assert_eq!(complete.received_bytes, BYTES.len() as u64);
            assert_eq!(complete.phase, "downloading");
            assert_eq!(
                complete.percent,
                length.filter(|v| *v == "22").map(|_| 100.0)
            );
            let verified = progress.last().unwrap();
            assert_eq!(verified.phase, "verifying");
            assert_eq!(verified.percent, None);
            assert_eq!(verified.received_bytes, BYTES.len() as u64);
            drop(file);
            assert_eq!(fs::read_dir(directory.path()).unwrap().count(), 0);
        }
        let directory = tempfile::tempdir().unwrap();
        let mock = Mock::new(vec![response(200, BYTES)]);
        let file = download(&mock, &asset(), directory.path(), |_| {})
            .unwrap()
            .keep()
            .unwrap();
        assert_eq!(fs::read(file).unwrap(), BYTES);
    }

    struct BrokenStream;
    impl Read for BrokenStream {
        fn read(&mut self, _: &mut [u8]) -> io::Result<usize> {
            Err(io::Error::new(
                io::ErrorKind::ConnectionReset,
                "secret signed URL",
            ))
        }
    }

    #[test]
    fn digest_and_stream_failures_remove_partial_files_before_preparation() {
        let mut broken = response(200, b"");
        broken.body = Box::new(Cursor::new(BYTES.to_vec()).chain(BrokenStream));
        for reply in [
            response(200, b"wrong bytes"),
            broken,
            response(404, b"not found"),
        ] {
            let directory = tempfile::tempdir().unwrap();
            let mock = Mock::new(vec![reply]);
            let mut phases = vec![];
            assert!(download(&mock, &asset(), directory.path(), |p| phases.push(p.phase)).is_err());
            assert!(phases
                .iter()
                .all(|phase| ["downloading", "verifying"].contains(phase)));
            assert_eq!(fs::read_dir(directory.path()).unwrap().count(), 0);
        }
    }

    fn redirect(location: &str) -> Response {
        let mut reply = response(302, b"");
        reply.location = Some(location.into());
        reply
    }

    #[test]
    fn redirects_are_checked_before_requesting_the_next_url_and_share_a_deadline() {
        let directory = tempfile::tempdir().unwrap();
        let storage = "https://objects.githubusercontent.com/github-production-release-asset-2e65be/123?signature=secret";
        let mock = Mock::new(vec![
            redirect(storage),
            redirect("/github-production-release-asset/456"),
            response(200, BYTES),
        ]);
        let file = download(&mock, &asset(), directory.path(), |_| {}).unwrap();
        let calls = mock.calls.lock().unwrap();
        assert_eq!(calls.len(), 3);
        assert_eq!(calls[1].0, storage);
        assert_eq!(
            calls[2].0,
            "https://objects.githubusercontent.com/github-production-release-asset/456"
        );
        assert!(calls.windows(2).all(|pair| pair[1].1 <= pair[0].1));
        assert!(!file.to_string_lossy().contains("signature"));
        for bad in [
            "https://evil.example/Setup.exe",
            "http://objects.githubusercontent.com/github-production-release-asset/123",
            "",
        ] {
            let mock = Mock::new(vec![redirect(bad)]);
            assert!(download(&mock, &asset(), directory.path(), |_| {}).is_err());
            assert_eq!(mock.calls.lock().unwrap().len(), 1);
        }
        let mock = Mock::new((0..6).map(|_| redirect(storage)).collect());
        assert!(download(&mock, &asset(), directory.path(), |_| {}).is_err());
        assert_eq!(mock.calls.lock().unwrap().len(), 6);
    }

    #[test]
    fn release_fetch_rejects_redirects_and_invalid_json_without_exposing_network_details() {
        let mock = Mock::new(vec![response(200, b"{\"tag_name\":\"v1.3.0\"}")]);
        assert_eq!(fetch_release(&mock).unwrap()["tag_name"], "v1.3.0");
        assert_eq!(
            mock.calls.lock().unwrap()[0],
            (API.into(), Duration::from_secs(30))
        );
        for reply in [
            redirect("https://evil.example/secret"),
            response(500, b"secret"),
            response(200, b"bad json"),
        ] {
            let mock = Mock::new(vec![reply]);
            assert_eq!(fetch_release(&mock), Err(UpdateError::Network));
        }
    }

    struct SlowStream;
    impl Read for SlowStream {
        fn read(&mut self, buffer: &mut [u8]) -> io::Result<usize> {
            thread::sleep(Duration::from_millis(30));
            buffer[0] = b'x';
            Ok(1)
        }
    }

    #[test]
    fn expired_download_never_returns_a_verified_file() {
        let directory = tempfile::tempdir().unwrap();
        let mut reply = response(200, b"");
        reply.body = Box::new(SlowStream);
        let mock = Mock::new(vec![reply]);
        assert!(download_with_timeout(
            &mock,
            &asset(),
            directory.path(),
            Duration::from_millis(10),
            |_| {}
        )
        .is_err());
        assert_eq!(fs::read_dir(directory.path()).unwrap().count(), 0);
    }

    fn server(
        body: impl FnOnce(std::net::TcpStream) + Send + 'static,
    ) -> (String, thread::JoinHandle<String>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}/fixture", listener.local_addr().unwrap());
        let handle = thread::spawn(move || {
            let (mut socket, _) = listener.accept().unwrap();
            socket
                .set_read_timeout(Some(Duration::from_secs(3)))
                .unwrap();
            let mut request = Vec::new();
            let mut byte = [0];
            while !request.ends_with(b"\r\n\r\n") {
                socket.read_exact(&mut byte).unwrap();
                request.push(byte[0]);
            }
            body(socket);
            String::from_utf8(request).unwrap()
        });
        (url, handle)
    }

    #[test]
    fn native_http_transport_sends_identification_and_never_follows_redirects() {
        let (url, handle) = server(|mut socket| {
            socket.write_all(b"HTTP/1.1 302 Found\r\nContent-Length: 0\r\nLocation: https://evil.example/secret\r\nConnection: close\r\n\r\n").unwrap();
        });
        let client = HttpTransport(HttpTransport::builder().no_proxy().build().unwrap());
        let reply = client.get(&url, Duration::from_secs(3)).unwrap();
        assert_eq!(reply.status, 302);
        assert_eq!(
            reply.location.as_deref(),
            Some("https://evil.example/secret")
        );
        let request = handle.join().unwrap().to_ascii_lowercase();
        assert!(request.contains("user-agent: wifimeter/"));
        assert!(request.contains("accept: application/octet-stream"));
        assert!(!request.contains("authorization:") && !request.contains("cookie:"));
        assert!(HttpTransport::new()
            .unwrap()
            .get(&url, Duration::from_millis(50))
            .is_err());
    }

    #[test]
    fn native_http_body_timeout_includes_time_already_spent_receiving_headers() {
        let (url, handle) = server(|mut socket| {
            thread::sleep(Duration::from_millis(100));
            let _ = socket
                .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 3\r\nConnection: close\r\n\r\na");
            thread::sleep(Duration::from_millis(120));
            let _ = socket.write_all(b"b");
            thread::sleep(Duration::from_millis(120));
            let _ = socket.write_all(b"c");
        });
        let client = HttpTransport(HttpTransport::builder().no_proxy().build().unwrap());
        let mut reply = client.get(&url, Duration::from_millis(280)).unwrap();
        assert!(reply.body.read_to_end(&mut Vec::new()).is_err());
        handle.join().unwrap();
    }
}
