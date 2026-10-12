<p align="center">
  <a href="docs/assets/logo.svg"><img src="docs/assets/banner.svg" alt="WiFiMeter: Wi-Fi usage by network" width="100%" /></a>
</p>

<p align="center">
  <a href="docs/releases/v1.3.2.md"><img src="https://img.shields.io/badge/version-1.3.2-6366F1?style=for-the-badge&amp;labelColor=182033" alt="Version 1.3.2" /></a>
  <a href="docs/PACKAGING-MATRIX.md"><img src="https://img.shields.io/badge/release-Windows%20%2F%20Linux-0284C7?style=for-the-badge&amp;labelColor=182033" alt="Windows and Linux release targets" /></a>
  <a href="backend/README.md"><img src="https://img.shields.io/badge/backend-C%2B%2B20-8B5CF6?style=for-the-badge&amp;labelColor=182033" alt="C++20 backend" /></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-16A34A?style=for-the-badge&amp;labelColor=182033" alt="MIT License" /></a>
</p>

<p align="center">
  <a href="apps/desktop/README.md"><img src="https://img.shields.io/badge/UI-Tauri-0D9488?style=for-the-badge&amp;labelColor=182033" alt="Tauri interface" /></a>
  <a href="docs/MIGRATION.md"><img src="https://img.shields.io/badge/storage-SQLite-2563EB?style=for-the-badge&amp;labelColor=182033" alt="SQLite storage" /></a>
  <a href="README.zh-CN.md"><img src="https://img.shields.io/badge/languages-EN%20%2F%20ZH-DB7093?style=for-the-badge&amp;labelColor=182033" alt="English and Simplified Chinese" /></a>
</p>

<p align="center">
  <a href="#build-and-test">Build and test</a> &nbsp;·&nbsp;
  <a href="docs/MIGRATION.md">Migration guide</a> &nbsp;·&nbsp;
  <a href="docs/PACKAGING-MATRIX.md">Platforms and packages</a> &nbsp;·&nbsp;
  <a href="https://github.com/chronicle12345/WiFiMeter/releases">Releases</a>
</p>

<p align="center"><strong>English</strong> &nbsp;|&nbsp; <a href="README.zh-CN.md">简体中文</a></p>

A desktop network usage meter with shared source code for Windows and Linux. Tauri renders the interface using the system WebView; a native C++ backend samples traffic and stores history in SQLite. Data stays on the computer. Release targets cover Windows x64, x86 and ARM64, plus Linux x64 and ARM64; available builds are listed on [Releases](https://github.com/chronicle12345/WiFiMeter/releases).

The following overview and application history use synthetic data.

![Usage overview in English](docs/assets/screenshot-en.png)

![Monthly application history in English](docs/assets/applications-en.png)

## Features

- Wi-Fi and physical Ethernet traffic, live download/upload rates, network aliases, and searchable history. Virtual adapters are excluded from physical Ethernet accounting.
- Native per-application capture through Windows ETW for non-loopback traffic, Windows TCP EStats for live loopback/proxy-client bytes, or Linux eBPF, with explicit permission and coverage states. The overview keeps core metrics in its first screen, with the complete live application ranking in the scrolling area below. The applications page also shows all captured applications. Application history supports minute, hour, day and month grouping and export with current filters.
- Per-network quotas and a separate combined Wi-Fi quota, with daily, monthly or cumulative periods. Ethernet does not consume the combined Wi-Fi quota. Warnings and optional Wi-Fi disconnection are configurable.
- Windows application blocking, with upload and download limits that can be set or removed independently after selecting an application or executable. The Windows x64 package includes WinDivert for download limits, which apply while WiFiMeter runs. Traffic received by a separate proxy requires limiting that proxy executable. These controls are unavailable on Linux.
- Optional Windows proxy attribution estimates, clearly separated from native records. Estimates use observed TCP connections and retain unattributed traffic when evidence is missing.
- Custom local dates and times with minute precision, including the ending minute, and network/application minute details. Minute records accumulate after upgrading; earlier records retain their original precision. All-history queries, CSV/JSON export, complete backups, configurable retention, English/Chinese UI, tray mode and login startup.
- A Windows floating window shows combined live upload/download rates and an expandable application list with live rates and accumulated usage. Its 1-minute range is the current calendar minute; 5 minutes and 1 hour include the current minute and the previous 4 or 59 minutes. Custom ranges span 1–10080 minutes and are saved automatically. See the [floating-window guide](docs/FLOATING_WINDOW.md).

## Existing data and upgrades

For Electron 1.2.x, download the Tauri installer for your operating system and CPU from [Releases](https://github.com/chronicle12345/WiFiMeter/releases). It reuses the existing data directory. Once Tauri is installed, subsequent update checks select the matching Tauri installer.

On Windows, the app discovers the file-based version's default directory at `%LOCALAPPDATA%\WiFiMeter\data`. Other directories can be selected in Settings. Stop the old collector before importing; the Windows installer requests a graceful save and stop before replacing the application.

Migration preserves original files, creates a recovery backup and imports eligible records in one database transaction. Repeating the same import does not add the bytes again. Conflicting records are rejected instead of silently replacing an existing database. Ambiguous application-cache entries and unrepresentable legacy settings remain archived and are listed in the import report.

Existing cross-platform SQLite profiles keep their location. Windows continues to use `%APPDATA%\WiFiMeter Demo\wifimeter.db` for compatibility. Linux uses the existing Electron user-data location. Uninstalling does not remove these data directories.

See the [migration guide](docs/MIGRATION.md) for recovery, retained originals and backup scope. The file-based [v1.1.1 release](https://github.com/chronicle12345/WiFiMeter/releases/tag/v1.1.1) remains available.

## Packages

Windows x64, x86 and ARM64 use NSIS installers. Linux x64 and ARM64 use deb, rpm and AppImage packages. Portable archives have been discontinued. Checksums are verified internally in CI; the download page lists application packages. The [build and release matrix](docs/PACKAGING-MATRIX.md) describes the checks required for all five targets.

Tauri packages bundle the Node business worker and C++ collectors, with no Electron or Chromium runtime. Windows installers download WebView2 when needed. Linux uses WebKitGTK 4.1. Artifact names contain Tauri, and all executable architectures are checked together. macOS and Linux 32-bit are not release targets. Windows ARM64 does not support WinDivert download limits.

Application capture requires supported native facilities and permission. Linux eBPF has additional kernel requirements; see [Linux capture](docs/LINUX_APP_CAPTURE.md) and [Windows capture](docs/WINDOWS_APP_CAPTURE.md). Network controls request administrator approval. Firewall/QoS policies can persist after exit or uninstall; remove unwanted policies in the application before uninstalling.

## Build and test

Install Node.js, Rust, CMake, a C++20 compiler and the [Tauri platform prerequisites](https://v2.tauri.app/start/prerequisites/), then:

```sh
npm ci --prefix apps/desktop
npm run build:backend
npm run test:unit
npm run test:ui
```

Backend tests are built with CMake and run with CTest. The UI suite uses a headless browser, the actual Tauri page bridge and an isolated Node business host. On Windows it uses installed Microsoft Edge by default; otherwise install the Playwright Chromium version with `npm --prefix apps/desktop exec -- playwright install chromium`. No Electron runtime is required. Build the Windows x64 Tauri package and run its separate native WebView2 integration check with:

```sh
node packaging/tauri/build.cjs --platform win32 --arch x64 --formats nsis
node packaging/tauri/verify-windows.cjs
```

Platform dependencies and other source build commands are documented in [packaging](packaging/README.md). Tests use synthetic fixtures and isolated profiles. Builds, runtime data, traces and local credentials are excluded from Git. The 1.3.x release workflow requires all five targets to pass backend, Rust host and package checks before publishing the complete set of nine packages.

## Performance and license

The native backend handles sampling, counters and storage. The UI queries selected date ranges; unchanged login settings are not rewritten, contiguous coverage gaps are coalesced, and large IPC frames are scanned incrementally. Tauri uses the system WebView to reduce distribution size. The complete package still includes the Node business worker, collectors and drivers; size comparisons should use the full package.

The application is under the [MIT license](LICENSE). Third-party components and the separately licensed Linux BPF program are described in [third-party notices](backend/third_party/README.md).
