<p align="center">
  <a href="docs/assets/logo.svg"><img src="docs/assets/banner.svg" alt="WiFiMeter: Wi-Fi usage by network" width="100%" /></a>
</p>

<p align="center">
  <a href="docs/releases/v1.3.6.md"><img src="https://img.shields.io/badge/version-1.3.6-6366F1?style=for-the-badge&amp;labelColor=182033" alt="Version 1.3.6" /></a>
  <a href="docs/PACKAGING-MATRIX.md"><img src="https://img.shields.io/badge/release-Windows%20x64-0284C7?style=for-the-badge&amp;labelColor=182033" alt="Windows x64" /></a>
  <a href="docs/ARCHITECTURE.md"><img src="https://img.shields.io/badge/UI-Tauri-0D9488?style=for-the-badge&amp;labelColor=182033" alt="Tauri interface" /></a>
  <a href="docs/ARCHITECTURE.md"><img src="https://img.shields.io/badge/backend-C%2B%2B20-8B5CF6?style=for-the-badge&amp;labelColor=182033" alt="C++20 backend" /></a>
  <a href="docs/MIGRATION.md"><img src="https://img.shields.io/badge/storage-SQLite-2563EB?style=for-the-badge&amp;labelColor=182033" alt="SQLite storage" /></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-16A34A?style=for-the-badge&amp;labelColor=182033" alt="MIT License" /></a>
</p>

<p align="center"><strong>English</strong> &nbsp;|&nbsp; <a href="README.zh-CN.md">简体中文</a></p>

WiFiMeter is a desktop network usage monitor for Windows and Linux. Track traffic by network and application, review history, set quotas and keep live speeds visible in a floating window. The interface uses Tauri, a C++ backend collects traffic, and SQLite stores data locally.

[Download](#download) · [Features](#features) · [Screenshots](#screenshots) · [Getting started](#getting-started) · [Documentation](#documentation)

## Download

[Download the Windows x64 installer](https://github.com/chronicle12345/WiFiMeter/releases/latest)

Version 1.3.6 publishes a Windows x64 installer. Linux and other Windows architecture builds are paused; their source build helpers and older releases remain available. See the [platform and package matrix](docs/PACKAGING-MATRIX.md) for supported targets.

## Features

### Network and application traffic

- Monitor Wi-Fi and physical Ethernet upload/download speeds and totals. Name networks, search their history and track usage separately for each connection.
- View application traffic through Windows ETW/TCP EStats or Linux eBPF, with permission and capture-coverage status shown in the interface.
- On Windows, switch live application rates between native capture and port-based proxy estimates in both the main window and floating window. Estimated shares are marked; network totals and quotas use measured traffic. The main window keeps its choice for the session, and the floating window saves its choice across restarts.

### History, quotas and data

- Query custom local date/time ranges and group application usage by minute, hour, day or month. Search, sort and export the selected records. On Windows, choose native history or include daily proxy-attribution estimates for complete date ranges.
- Set individual network quotas and a combined Wi-Fi quota, with daily, monthly or cumulative periods, multiple warning thresholds and optional Wi-Fi disconnection. The combined quota accounts only for Wi-Fi usage.
- Export CSV/JSON, create complete backups and configure history retention. Existing file-based Windows records can be imported through the migration tools.

### Desktop tools

- Use the Windows floating window for combined live speeds and recent application usage. Choose its shape, pin its position, keep it visible, filter proxy traffic or enable left/right edge hiding. See the [floating-window guide](docs/FLOATING_WINDOW.md).
- Block network access for Windows applications or set upload and download limits independently. Download limits apply while WiFiMeter runs; for proxied transfers, apply limits to the proxy application.
- Use the English/Chinese interface, tray mode and login startup for daily monitoring.

## Screenshots

The screenshots use sample data.

![Usage overview](docs/assets/screenshot-en.png)

![Monthly application history](docs/assets/applications-en.png)

## Getting started

Run the Windows x64 installer, launch WiFiMeter and follow the application-capture authorization prompt. Network statistics, application history and quotas are available from the main window; enable the floating window in Settings. Windows installs WebView2 when needed.

Windows x64 users can check for updates in the application; download and installation are confirmed separately. Linux users install matching versions manually from [Releases](https://github.com/chronicle12345/WiFiMeter/releases). Exit WiFiMeter normally before a manual upgrade. Electron 1.2.x users install the Tauri version once; existing SQLite profiles keep their data location. For the older Windows file-based version, stop the old collector and import its directory in Settings. The [migration guide](docs/MIGRATION.md) covers backups, import and recovery.

## Run from source

Install Node.js, Rust, CMake, a C++20 compiler and the [Tauri platform prerequisites](https://v2.tauri.app/start/prerequisites/), then:

```sh
git clone https://github.com/chronicle12345/WiFiMeter.git
cd WiFiMeter
git switch dev
npm ci --prefix apps/desktop
npm run build:backend
npm start
```

Run `npm run test:unit` and `npm run test:ui` for desktop checks. The [testing guide](docs/TESTING.md) lists backend and native-host verification; [packaging](packaging/README.md) describes installer builds.

## Documentation

- [Windows capture](docs/WINDOWS_APP_CAPTURE.md) · [Linux capture](docs/LINUX_APP_CAPTURE.md) · [Linux application icons](docs/LINUX_APPLICATION_ICONS.md)
- [Development workflow](docs/DEVELOPMENT.md) · [Architecture](docs/ARCHITECTURE.md) · [Data contracts](contracts/README.md)
- [CI and releases](docs/PACKAGING-MATRIX.md) · [Changelog](CHANGELOG.md)

## License

WiFiMeter uses the [MIT license](LICENSE). Dependency licenses are documented in [third-party notices](backend/third_party/README.md) and [WinDivert notices](apps/desktop/native/windows/WinDivert/README.md).
