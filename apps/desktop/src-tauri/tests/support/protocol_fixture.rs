use serde_json::{json, Value};
use std::{
    io::{self, BufRead, Write},
    thread,
    time::Duration,
};

fn reply(value: Value) {
    println!("{value}");
}

fn main() {
    let mut shutdown_delay = 0;
    let mut paused = std::env::args().any(|arg| arg == "--paused");
    let mut apps_enabled = false;
    for line in io::stdin().lock().lines() {
        let request: Value = serde_json::from_str(&line.unwrap()).unwrap();
        let id = request["id"].clone();
        assert_eq!(request["protocol"], 1);
        let result = match request["method"].as_str().unwrap() {
            "hello" => {
                json!({ "protocol": 1, "pid": std::process::id(), "args": std::env::args().collect::<Vec<_>>(), "paused":paused, "appCollection":{"enabled":apps_enabled} })
            }
            "setPaused" | "setAppCollection" if request["params"]["reject"] == true => {
                reply(
                    json!({"id":id,"ok":false,"error":{"code":"fixtureRejected","message":"rejected"}}),
                );
                continue;
            }
            "setPaused" => {
                paused = request["params"]["paused"].as_bool().unwrap();
                json!({"paused":paused})
            }
            "setAppCollection" => {
                apps_enabled = request["params"]["enabled"].as_bool().unwrap();
                json!({"appCollection":{"enabled":apps_enabled}})
            }
            "echo" => request["params"].clone(),
            "fail" => {
                reply(
                    json!({ "id": id, "ok": false, "error": { "code": "LegacyOverlap", "message": "重叠日期" } }),
                );
                continue;
            }
            "delay" => {
                thread::spawn(move || {
                    thread::sleep(Duration::from_millis(
                        request["params"]["ms"].as_u64().unwrap(),
                    ));
                    reply(json!({ "id": id, "ok": true, "result": request["params"] }));
                });
                continue;
            }
            "event" => {
                reply(json!({ "event": "live", "rxBytes": "9007199254740993" }));
                json!({})
            }
            "noise" => {
                println!("not JSON");
                let mut out = io::stdout().lock();
                let response = format!(
                    "{}\r\n",
                    json!({"id":id,"ok":true,"result":{"name":"无线网络"}})
                );
                for byte in response.as_bytes() {
                    out.write_all(&[*byte]).unwrap();
                    out.flush().unwrap();
                }
                continue;
            }
            "crash" => std::process::exit(7),
            "shutdownDelay" => {
                shutdown_delay = request["params"]["ms"].as_u64().unwrap();
                json!({})
            }
            "shutdown" => {
                reply(json!({ "id": id, "ok": true, "result": {} }));
                thread::sleep(Duration::from_millis(shutdown_delay));
                return;
            }
            method => panic!("unknown fixture method {method}"),
        };
        reply(json!({ "id": id, "ok": true, "result": result }));
    }
}
