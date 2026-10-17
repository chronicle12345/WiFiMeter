<p align="center">
  <a href="docs/assets/logo.svg"><img src="docs/assets/banner.svg" alt="WiFiMeter: Wi-Fi usage by network" width="100%" /></a>
</p>

<p align="center">
  <a href="docs/releases/v1.3.6.md"><img src="https://img.shields.io/badge/version-1.3.6-6366F1?style=for-the-badge&amp;labelColor=182033" alt="Version 1.3.6" /></a>
  <a href="docs/PACKAGING-MATRIX.md"><img src="https://img.shields.io/badge/release-Windows%20x64-0284C7?style=for-the-badge&amp;labelColor=182033" alt="Windows x64 release target" /></a>
  <a href="docs/ARCHITECTURE.md#c-backend"><img src="https://img.shields.io/badge/backend-C%2B%2B20-8B5CF6?style=for-the-badge&amp;labelColor=182033" alt="C++20 backend" /></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-16A34A?style=for-the-badge&amp;labelColor=182033" alt="MIT License" /></a>
</p>

<p align="center">
  <a href="docs/ARCHITECTURE.md#current-data-flow"><img src="https://img.shields.io/badge/UI-Tauri-0D9488?style=for-the-badge&amp;labelColor=182033" alt="Tauri interface" /></a>
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

WiFiMeter is a desktop network usage meter with shared Windows and Linux source. Tauri uses the system WebView, a C++ backend samples traffic, and SQLite stores history locally. Version 1.3.6 publishes one Windows x64 installer. Other architecture builds are paused; older installers remain on [Releases](https://github.com/chronicle12345/WiFiMeter/releases).

The screenshots use synthetic data.

![Usage overview in English](docs/assets/screenshot-en.png)

![Monthly application history in English](docs/assets/applications-en.png)

## Features

- Wi-Fi and physical Ethernet totals, live upload/download rates, network aliases, and searchable history. Virtual adapters are excluded from physical Ethernet accounting.
- Native application traffic through Windows ETW for non-loopback traffic, TCP EStats for local loopback connections, or Linux eBPF. Permission and coverage states remain explicit; application totals can differ from adapter totals.
- Per-network quotas and a separate combined Wi-Fi quota, with daily, monthly, or cumulative periods, multiple warning thresholds, and optional Wi-Fi disconnection. Ethernet does not consume the Wi-Fi quota.
- Windows application blocking and independent upload/download limits. Windows x64 bundles WinDivert for download limits while WiFiMeter runs. Traffic received through a separate proxy requires limiting that proxy executable. Linux does not provide these controls.
- A shared application workspace for live traffic and usage history. Version 1.3.6 adds a live source switch for native capture or port-based proxy estimates. Estimated shares are marked and replace attributed proxy rates without double counting; measured adapter totals and quotas remain unchanged. Missing evidence stays unavailable or retains native records. History estimates remain separate from measured local TCP rates.
- Local date/time ranges including the ending minute, minute/hour/day/month grouping, CSV/JSON exports, complete backups, retention controls, English/Chinese UI, tray mode, and login startup. Minute history accumulates after upgrading; older data retains its precision. See the [data contracts](contracts/README.md) for accounting and query details.
- A Windows [floating window](docs/FLOATING_WINDOW.md) with live rates, expandable application usage, pinning, keep-visible and proxy-filter controls. Its live source choice persists separately; accumulated usage reads actual minute records. Edge hiding applies only on the left/right and is disabled when pinned.

## Existing data and upgrades

Windows x64 users can update to 1.3.6 in the application or run its Tauri installer from [Releases](https://github.com/chronicle12345/WiFiMeter/releases). Exit WiFiMeter normally before a manual upgrade. Electron 1.2.x users install Tauri once; subsequent update checks choose the matching Tauri installer. Other architectures should retain their latest matching release. Linux checks open the official release page for manual installation.

From 1.3.5, Windows update checks read metadata only. Download and installation require separate confirmations. Length and SHA-256 are verified before installation saves settings and the database, installs silently, and restarts. Declining download transfers no installer; postponing installation retains the verified cache and rechecks it before use. Startup checks notify about available updates.

Application capture starts disabled for each backend session. The startup question appears after successful startup and migration; accepting requests the helper's system authorization. Declining leaves adapter statistics running. Settings can disable future questions, and manual controls remain available. Platform behavior and limits are documented in [Windows capture](docs/WINDOWS_APP_CAPTURE.md) and [Linux capture](docs/LINUX_APP_CAPTURE.md).

The old Windows file-based directory is `%LOCALAPPDATA%\WiFiMeter\data`. Stop the old collector before import. Migration preserves originals, creates a recovery backup, imports eligible records transactionally, avoids duplicate imports, and reports conflicts or unrepresentable data. Existing SQLite profiles keep their location, including `%APPDATA%\WiFiMeter Demo\wifimeter.db` on Windows and the existing Electron user-data location on Linux. Uninstalling retains data. See [migration and recovery](docs/MIGRATION.md); the file-based [v1.1.1 release](https://github.com/chronicle12345/WiFiMeter/releases/tag/v1.1.1) remains available.

## Packages

Version 1.3.6 provides one Windows x64 NSIS installer; Windows x86/ARM64 and Linux x64/ARM64 CI builds are paused. Portable archives are discontinued. Packages bundle the Node business worker, C++ collectors, and licenses. Windows installs WebView2 when missing; Linux source builds use WebKitGTK 4.1. macOS and Linux 32-bit are not release targets. Windows ARM64 lacks WinDivert download limits. Current targets and integrity checks are maintained in the [CI and release matrix](docs/PACKAGING-MATRIX.md).

Network controls request administrator authorization. Firewall/QoS rules can persist after exit or uninstall; remove unwanted policies in the application first.

## Build and test

Start on `dev` and follow the [development workflow](docs/DEVELOPMENT.md). Install Node.js, Rust, CMake, a C++20 compiler, and the [Tauri platform prerequisites](https://v2.tauri.app/start/prerequisites/), then:

```sh
npm ci --prefix apps/desktop
npm run build:backend
npm run test:unit
npm run test:ui
```

The [testing guide](docs/TESTING.md) lists CTest, desktop, browser, Rust, documentation, and native checks separately. `npm test` covers only desktop unit/integration and browser tests. Platform dependencies and installer commands are maintained in [packaging](packaging/README.md).

## Documentation

English and Simplified Chinese guides have equal authority. Either language may be edited first; synchronize and review its counterpart, then register the pair. See [bilingual documentation](docs/i18n/README.md) and the [terminology table](docs/i18n/terminology.md).

- [Architecture](docs/ARCHITECTURE.md) and [Linux application icons](docs/LINUX_APPLICATION_ICONS.md).
- [Windows installer sources](packaging/tauri/windows/SOURCES.md).
- [Third-party notices](backend/third_party/README.md) and [WinDivert notices](apps/desktop/native/windows/WinDivert/README.md).

## Performance and license

The C++ backend handles sampling, counters, and storage; the UI queries selected ranges. Tauri uses the system WebView. Package comparisons include the bundled Node worker, collectors, and drivers; measurements apply to their recorded workload and environment.

The application uses the [MIT license](LICENSE). Dependency and Linux BPF license details are recorded in [third-party notices](backend/third_party/README.md).
