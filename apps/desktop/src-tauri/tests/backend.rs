#![cfg(feature = "test-fixture")]
use serde_json::{json, Value};
use std::{
    sync::{mpsc, Arc},
    thread,
    time::Duration,
};
use tempfile::TempDir;
use wifimeter_desktop::backend::Backend;

const TIMEOUT: Duration = Duration::from_secs(3);

fn fixture() -> (Arc<Backend>, mpsc::Receiver<Value>, TempDir) {
    let directory = tempfile::tempdir().unwrap();
    let (sender, receiver) = mpsc::channel();
    let compiled = std::path::PathBuf::from(env!("CARGO_BIN_EXE_protocol-fixture"));
    // 交叉编译后在 Windows 执行时，Cargo 写入的构建机绝对路径不可用。
    let executable = if compiled.is_file() {
        compiled
    } else {
        std::env::current_exe()
            .unwrap()
            .parent()
            .unwrap()
            .parent()
            .unwrap()
            .join(format!("protocol-fixture{}", std::env::consts::EXE_SUFFIX))
    };
    let backend = Backend::new(
        executable,
        directory.path().join("无线 网络.db"),
        vec!["--paused".into()],
        Arc::new(move |event| {
            let _ = sender.send(event);
        }),
    );
    (Arc::new(backend), receiver, directory)
}

#[test]
fn protocol_arguments_exact_bytes_and_events() {
    let (backend, events, dir) = fixture();
    let hello = backend.request("hello", json!({}), TIMEOUT).unwrap();
    assert_eq!(hello["protocol"], 1);
    assert_eq!(hello["args"][1], "--paused");
    assert_eq!(hello["args"][2], "--db");
    assert_eq!(
        hello["args"][3],
        dir.path().join("无线 网络.db").to_str().unwrap()
    );
    let params = json!({ "bytes": "18446744073709551615", "enabled": false, "text": "中文\n换行" });
    assert_eq!(
        backend.request("echo", params.clone(), TIMEOUT).unwrap(),
        params
    );
    backend.request("event", json!({}), TIMEOUT).unwrap();
    assert_eq!(
        events.recv_timeout(TIMEOUT).unwrap()["rxBytes"],
        "9007199254740993"
    );
    assert_eq!(
        backend.request("noise", json!({}), TIMEOUT).unwrap()["name"],
        "无线网络"
    );
    backend.stop_gracefully(TIMEOUT).unwrap();
}

#[test]
fn concurrent_responses_are_correlated_and_errors_preserved() {
    let (backend, _, _dir) = fixture();
    let threads: Vec<_> = (0..8)
        .map(|i| {
            let backend = backend.clone();
            thread::spawn(move || {
                let params = json!({ "ms": (8-i)*10, "sequence": i });
                assert_eq!(
                    backend.request("delay", params.clone(), TIMEOUT).unwrap(),
                    params
                );
            })
        })
        .collect();
    for handle in threads {
        handle.join().unwrap();
    }
    let error = backend.request("fail", json!({}), TIMEOUT).unwrap_err();
    assert_eq!(error.code, "LegacyOverlap");
    assert_eq!(error.message, "重叠日期");
    assert!(backend.request("hello", json!({}), TIMEOUT).is_ok());
    backend.stop_gracefully(TIMEOUT).unwrap();
}

#[test]
fn timeout_and_late_reply_do_not_corrupt_next_request() {
    let (backend, _, _dir) = fixture();
    backend.request("hello", json!({}), TIMEOUT).unwrap();
    let error = backend
        .request("delay", json!({ "ms": 100 }), Duration::from_millis(10))
        .unwrap_err();
    assert_eq!(error.code, "timeout");
    let result = backend
        .request("delay", json!({ "ms": 160, "result": "next" }), TIMEOUT)
        .unwrap();
    assert_eq!(result["result"], "next");
    backend.stop_gracefully(TIMEOUT).unwrap();
}

#[test]
fn crash_rejects_waiters_and_next_request_restarts() {
    let (backend, _, _dir) = fixture();
    let pid = backend.request("hello", json!({}), TIMEOUT).unwrap()["pid"].clone();
    assert_eq!(
        backend
            .request("crash", json!({}), TIMEOUT)
            .unwrap_err()
            .code,
        "unavailable"
    );
    // stdout 关闭可能略早于操作系统报告退出；此期间不能再拉起采集器。
    let mut next = None;
    for _ in 0..100 {
        if let Ok(value) = backend.request("hello", json!({}), TIMEOUT) {
            next = Some(value);
            break;
        }
        thread::sleep(Duration::from_millis(10));
    }
    assert_ne!(next.unwrap()["pid"], pid);
    backend.stop_gracefully(TIMEOUT).unwrap();
}

#[test]
fn shutdown_timeout_never_kills_or_restarts_saving_collector() {
    let (backend, _, _dir) = fixture();
    backend
        .request("shutdownDelay", json!({ "ms": 200 }), TIMEOUT)
        .unwrap();
    assert_eq!(
        backend
            .stop_gracefully(Duration::from_millis(20))
            .unwrap_err()
            .code,
        "timeout"
    );
    assert_eq!(
        backend
            .request("hello", json!({}), TIMEOUT)
            .unwrap_err()
            .code,
        "unavailable"
    );
    backend.wait_for_shutdown(TIMEOUT).unwrap();
    assert!(backend.request("hello", json!({}), TIMEOUT).is_ok());
    backend.stop_gracefully(TIMEOUT).unwrap();
}

#[test]
fn missing_executable_and_empty_method_fail_without_hanging() {
    let dir = tempfile::tempdir().unwrap();
    let backend = Backend::new(
        dir.path().join("missing.exe"),
        dir.path().join("meter.db"),
        vec![],
        Arc::new(|_| {}),
    );
    assert_eq!(
        backend.request("", json!({}), TIMEOUT).unwrap_err().code,
        "badRequest"
    );
    assert_eq!(
        backend
            .request("hello", json!({}), TIMEOUT)
            .unwrap_err()
            .code,
        "unavailable"
    );
    backend.stop_gracefully(TIMEOUT).unwrap();
}
