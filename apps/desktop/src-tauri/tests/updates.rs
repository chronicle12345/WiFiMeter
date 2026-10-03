use serde_json::{json, Value};
use std::{cmp::Ordering, fs, sync::Arc};
use wifimeter_desktop::updates::{
    redirect_allowed, select_release, Preferences, UpdateError, Version, REPOSITORY,
};

fn asset(version: &str, arch: &str, modern: bool) -> Value {
    let platform = if modern { "windows-" } else { "" };
    let name = format!("WiFiMeter-{version}-{platform}{arch}-Setup.exe");
    json!({"name":name, "digest":format!("sha256:{}", "AB".repeat(32)),
        "browser_download_url":format!("{REPOSITORY}/releases/download/v{version}/{name}")})
}

fn release() -> Value {
    json!({"tag_name":"v1.3.0", "body":"Release notes", "draft":false, "prerelease":false,
    "html_url":"https://untrusted.example/release", "assets":[
        asset("1.3.0", "x64", true), asset("1.3.0", "ia32", true), asset("1.3.0", "arm64", true)
    ]})
}

#[test]
fn semver_orders_numeric_prerelease_and_arbitrarily_large_integers() {
    let ordered = [
        "1.0.0-alpha",
        "1.0.0-alpha.1",
        "1.0.0-alpha.beta",
        "1.0.0-beta",
        "1.0.0-beta.2",
        "1.0.0-beta.11",
        "1.0.0-rc.1",
        "1.0.0",
        "1.0.1",
        "1.10.0",
        "18446744073709551616.0.0",
        "18446744073709551617.0.0",
    ];
    for pair in ordered.windows(2) {
        let left = Version::parse(pair[0]).unwrap();
        let right = Version::parse(pair[1]).unwrap();
        assert_eq!(left.compare(&right), Ordering::Less, "{pair:?}");
        assert_eq!(right.compare(&left), Ordering::Greater);
    }
    assert_eq!(
        Version::parse("v1.3.0+local.01")
            .unwrap()
            .compare(&Version::parse("1.3.0").unwrap()),
        Ordering::Equal
    );
    assert_eq!(
        Version::parse("1.0.0-18446744073709551616")
            .unwrap()
            .compare(&Version::parse("1.0.0-18446744073709551617").unwrap()),
        Ordering::Less
    );
    for invalid in [
        "",
        "V1.0.0",
        " 1.0.0",
        "1.0.0\n",
        "1.0",
        "01.0.0",
        "1.01.0",
        "1.0.01",
        "1.0.0-01",
        "1.0.0-rc.01",
        "1.0.0-",
        "1.0.0+",
        "1.0.0+foo+bar",
        "1.0.0-rc..1",
        "1.0.0-中文",
    ] {
        assert_eq!(
            Version::parse(invalid),
            Err(UpdateError::Version),
            "{invalid}"
        );
    }
}

#[test]
fn stable_release_selection_preserves_versions_notes_and_manual_platforms() {
    for (current, tag, newer) in [
        ("1.2.0", "v1.1.1", false),
        ("1.3.0+local", "v1.3.0", false),
        ("1.2.0", "v1.10.0", true),
        ("1.3.0-rc.2", "v1.3.0", true),
    ] {
        let mut data = release();
        data["tag_name"] = json!(tag);
        let result =
            select_release(&Version::parse(current).unwrap(), &data, "win32", "x64").unwrap();
        assert_eq!(result.newer, newer);
        assert_eq!(result.notes, "Release notes");
        assert_eq!(result.url, format!("{REPOSITORY}/releases/tag/{tag}"));
        if !newer {
            assert!(result.asset.is_none());
        }
    }
    let current = Version::parse("1.2.0").unwrap();
    for (platform, arch) in [
        ("linux", "x64"),
        ("win32", "unsupported"),
        ("darwin", "arm64"),
    ] {
        let result = select_release(&current, &release(), platform, arch).unwrap();
        assert!(result.newer);
        assert!(result.asset.is_none());
    }
    for patch in [
        json!({"draft":true}),
        json!({"prerelease":true}),
        json!({"tag_name":"v1.4.0-rc.1"}),
        json!({"tag_name":null}),
    ] {
        let mut data = release();
        data.as_object_mut()
            .unwrap()
            .extend(patch.as_object().unwrap().clone());
        assert!(select_release(&current, &data, "win32", "x64").is_err());
    }
    let mut data = release();
    data["tag_name"] = json!("v1.3.0+build.01");
    data["body"] = json!({"invalid":true});
    let result = select_release(&current, &data, "linux", "x64").unwrap();
    assert_eq!(result.version, "1.3.0+build.01");
    assert!(result.url.ends_with("v1.3.0%2Bbuild.01"));
    assert_eq!(result.notes, "");
}

#[test]
fn windows_selects_one_verified_installer_for_the_matching_architecture() {
    let current = Version::parse("1.2.0").unwrap();
    for arch in ["x64", "ia32", "arm64"] {
        for modern in [true, false] {
            let mut data = release();
            data["assets"] = json!([asset("1.3.0", arch, modern)]);
            let selected = select_release(&current, &data, "win32", arch)
                .unwrap()
                .asset
                .unwrap();
            assert_eq!(selected.name, data["assets"][0]["name"]);
            assert_eq!(selected.digest, "ab".repeat(32));
        }
    }
    for bad_assets in [
        Value::Null,
        json!({}),
        json!([null]),
        json!([asset("1.3.0", "x64", true), asset("1.3.0", "x64", true)]),
    ] {
        let mut data = release();
        data["assets"] = bad_assets;
        assert!(select_release(&current, &data, "win32", "x64")
            .unwrap()
            .asset
            .is_none());
    }
    for patch in [
        json!({"digest":null}),
        json!({"digest":"sha256:bad"}),
        json!({"digest":format!("sha256:{}", "g".repeat(64))}),
        json!({"browser_download_url":"https://evil.example/Setup.exe"}),
        json!({"browser_download_url":format!("{REPOSITORY}/releases/download/v1.3.0/WiFiMeter-1.3.0-windows-x64-Setup.exe?token=secret")}),
    ] {
        let mut data = release();
        data["assets"][0]
            .as_object_mut()
            .unwrap()
            .extend(patch.as_object().unwrap().clone());
        data["assets"]
            .as_array_mut()
            .unwrap()
            .push(asset("1.3.0", "x64", false));
        assert!(
            select_release(&current, &data, "win32", "x64")
                .unwrap()
                .asset
                .is_none(),
            "{patch}"
        );
    }
}

#[test]
fn redirects_accept_only_official_asset_storage() {
    let original = format!("{REPOSITORY}/releases/download/v1.3.0/Setup.exe");
    assert!(redirect_allowed(&original, &original));
    for allowed in ["https://release-assets.githubusercontent.com/github-production-release-asset/123?sig=secret",
        "https://objects.githubusercontent.com/github-production-release-asset-2e65be/123?download=1"] {
        assert!(redirect_allowed(allowed, &original), "{allowed}");
    }
    for rejected in [
        "not a URL",
        "http://objects.githubusercontent.com/github-production-release-asset/1",
        "https://objects.githubusercontent.com/elsewhere/Setup.exe",
        "https://objects.githubusercontent.com/github-production-release-asset-/1",
        "https://objects.githubusercontent.com/github-production-release-asset-XYZ/1",
        "https://objects.githubusercontent.com/github-production-release-assets/1",
        "https://objects.githubusercontent.com/github-production-release-asset/1#fragment",
        "https://objects.githubusercontent.com:444/github-production-release-asset/1",
        "https://user:password@objects.githubusercontent.com/github-production-release-asset/1",
        "https://objects.githubusercontent.com.evil.example/github-production-release-asset/1",
        "https://github.com/elsewhere/Setup.exe",
    ] {
        assert!(!redirect_allowed(rejected, &original), "{rejected}");
    }
}

#[test]
fn preferences_persist_disable_and_rate_limit_across_restarts() {
    let directory = tempfile::tempdir().unwrap();
    let preferences = Preferences::new(directory.path().into());
    assert!(preferences.read().unwrap().check_on_startup);
    assert_eq!(preferences.begin_check(true, 1_000.0).unwrap(), None);
    // 网络失败仍保留检查时间；手动检查不修改限频时间。
    let restarted = Preferences::new(directory.path().into());
    assert_eq!(
        restarted.begin_check(true, 2_000.0).unwrap(),
        Some("cached")
    );
    assert_eq!(restarted.begin_check(false, 2_000.0).unwrap(), None);
    assert_eq!(restarted.read().unwrap().last_automatic_at, 1_000.0);
    assert_eq!(restarted.begin_check(true, 86_401_000.0).unwrap(), None);
    restarted.set_enabled(false).unwrap();
    let restarted = Preferences::new(directory.path().into());
    assert_eq!(
        restarted.begin_check(true, 200_000_000.0).unwrap(),
        Some("disabled")
    );
    assert_eq!(restarted.begin_check(false, 200_000_000.0).unwrap(), None);
    assert!(!restarted.enabled());
    assert_eq!(fs::read_dir(directory.path()).unwrap().count(), 1);
}

#[test]
fn damaged_or_unreadable_preferences_require_repair_without_overwriting() {
    for contents in [
        "broken json",
        "null",
        "{}",
        "{\"checkOnStartup\":\"yes\"}",
        "{\"checkOnStartup\":true,\"lastAutomaticAt\":-1}",
        "{\"checkOnStartup\":true,\"lastAutomaticAt\":null}",
    ] {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("update-preferences.json");
        fs::write(&path, contents).unwrap();
        let preferences = Preferences::new(directory.path().into());
        assert_eq!(preferences.read(), Err(UpdateError::Preferences));
        assert!(!preferences.enabled());
        assert_eq!(preferences.set_enabled(true), Err(UpdateError::Preferences));
        assert_eq!(fs::read_to_string(&path).unwrap(), contents);
        fs::remove_file(&path).unwrap();
        assert_eq!(preferences.read(), Err(UpdateError::Preferences));
        fs::write(&path, "{\"checkOnStartup\":false}").unwrap();
        assert!(!preferences.read().unwrap().check_on_startup);
        preferences.set_enabled(true).unwrap();
        assert!(preferences.enabled());
    }
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("update-preferences.json");
    fs::create_dir(&path).unwrap();
    let preferences = Preferences::new(directory.path().into());
    assert_eq!(
        preferences.begin_check(true, 1000.0),
        Err(UpdateError::Preferences)
    );
    assert!(path.is_dir());
}

#[test]
fn failed_writes_invalidate_the_cache_and_remove_temporary_files() {
    let directory = tempfile::tempdir().unwrap();
    let preferences = Preferences::new(directory.path().into());
    preferences.read().unwrap();
    let path = directory.path().join("update-preferences.json");
    fs::create_dir(&path).unwrap();
    assert_eq!(
        preferences.set_enabled(false),
        Err(UpdateError::Preferences)
    );
    assert!(!preferences.enabled());
    assert_eq!(fs::read_dir(directory.path()).unwrap().count(), 1);
    fs::remove_dir(&path).unwrap();
    assert_eq!(
        preferences.begin_check(true, 1000.0),
        Err(UpdateError::Preferences)
    );
    fs::write(&path, "{\"checkOnStartup\":true}").unwrap();
    assert_eq!(preferences.begin_check(true, 1000.0).unwrap(), None);
    assert!(preferences.enabled());
}

#[test]
fn concurrent_automatic_checks_claim_one_time_slot() {
    let directory = tempfile::tempdir().unwrap();
    let preferences = Arc::new(Preferences::new(directory.path().into()));
    let handles: Vec<_> = (0..8)
        .map(|_| {
            let preferences = preferences.clone();
            std::thread::spawn(move || preferences.begin_check(true, 1_000.0).unwrap())
        })
        .collect();
    let results: Vec<_> = handles
        .into_iter()
        .map(|handle| handle.join().unwrap())
        .collect();
    assert_eq!(results.iter().filter(|result| result.is_none()).count(), 1);
    assert_eq!(
        results
            .iter()
            .filter(|result| **result == Some("cached"))
            .count(),
        7
    );
}
