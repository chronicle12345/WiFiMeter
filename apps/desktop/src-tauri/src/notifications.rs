use serde_json::Value;

// Keep the existing quota wording; network names and system error details are user data.
pub fn body(settings: &Value, alert: &Value) -> Option<String> {
    if settings["notifications"] != true || alert["event"] != "alert" {
        return None;
    }
    let english = settings["language"] == "en";
    let text = |zh, en| if english { en } else { zh };
    let name = if alert["scope"] == "total" {
        text("Wi-Fi 总额度", "Total Wi-Fi")
    } else {
        alert["alias"]
            .as_str()
            .filter(|value| !value.is_empty())
            .or_else(|| alert["ssid"].as_str().filter(|value| !value.is_empty()))
            .unwrap_or(text("当前网络", "Current network"))
    };
    Some(match alert["kind"].as_str()? {
        "quotaWarn" => {
            // JS toFixed(0) rounds positive halves up, unlike Rust's default formatting.
            let percent = alert["percent"].as_f64().unwrap_or(0.0).round();
            if english {
                format!("{name} has used {percent:.0}% of its quota.")
            } else {
                format!("{name} 已使用额度的 {percent:.0}%。")
            }
        }
        "quotaLimit" => format!(
            "{name} {}",
            text("已达到额度上限。", "has reached its quota.")
        ),
        "quotaDisconnect" if alert["outcome"] == 0 => format!(
            "{name} {}",
            text(
                "已达到额度上限，连接已断开。",
                "reached its quota and was disconnected."
            )
        ),
        "quotaDisconnect" => {
            let detail = alert["detail"]
                .as_str()
                .filter(|value| !value.is_empty())
                .unwrap_or(text("请检查系统状态", "Check the system status."));
            if english {
                format!("{name} reached its quota but could not be disconnected: {detail}")
            } else {
                format!("{name} 已达到额度上限，但未能断开：{detail}")
            }
        }
        _ => return None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn warnings_preserve_names_rounding_and_language() {
        let mut alert = json!({"event":"alert","kind":"quotaWarn","ssid":"Habitat_5G","alias":"家里的 Wi-Fi","percent":84.5});
        let zh = json!({"notifications":true,"language":"zh-CN"});
        let en = json!({"notifications":true,"language":"en"});
        assert_eq!(
            body(&zh, &alert).unwrap(),
            "家里的 Wi-Fi 已使用额度的 85%。"
        );
        alert["alias"] = "".into();
        assert_eq!(
            body(&en, &alert).unwrap(),
            "Habitat_5G has used 85% of its quota."
        );
        alert["ssid"] = "".into();
        assert_eq!(
            body(&en, &alert).unwrap(),
            "Current network has used 85% of its quota."
        );
        alert["scope"] = "total".into();
        assert_eq!(
            body(&zh, &alert).unwrap(),
            "Wi-Fi 总额度 已使用额度的 85%。"
        );
        assert_eq!(
            body(&en, &alert).unwrap(),
            "Total Wi-Fi has used 85% of its quota."
        );
    }

    #[test]
    fn limit_and_disconnect_results_remain_distinct() {
        for (language, limit, success, failure) in [
            ("zh-CN", "当前网络 已达到额度上限。", "当前网络 已达到额度上限，连接已断开。", "当前网络 已达到额度上限，但未能断开：请检查系统状态"),
            ("en", "Current network has reached its quota.", "Current network reached its quota and was disconnected.", "Current network reached its quota but could not be disconnected: Check the system status."),
        ] {
            let settings = json!({"notifications":true,"language":language});
            let mut alert = json!({"event":"alert","kind":"quotaLimit"});
            assert_eq!(body(&settings, &alert).unwrap(), limit);
            alert["kind"] = "quotaDisconnect".into();
            alert["outcome"] = 0.into();
            assert_eq!(body(&settings, &alert).unwrap(), success);
            alert["outcome"] = 5.into();
            assert_eq!(body(&settings, &alert).unwrap(), failure);
            alert["detail"] = "Access denied <5> & retry".into();
            assert!(body(&settings, &alert).unwrap().ends_with("Access denied <5> & retry"));
        }
    }

    #[test]
    fn disabled_notifications_and_non_alert_events_are_ignored() {
        let enabled = json!({"notifications":true});
        let alert = json!({"event":"alert","kind":"quotaWarn"});
        assert!(body(&json!({"notifications":false}), &alert).is_none());
        assert!(body(&json!({}), &alert).is_none());
        assert!(body(&enabled, &json!({"event":"live"})).is_none());
        assert!(body(&enabled, &json!({"event":"alert","kind":"unknown"})).is_none());
        assert_eq!(
            body(&enabled, &alert).unwrap(),
            "当前网络 已使用额度的 0%。"
        );
    }
}
