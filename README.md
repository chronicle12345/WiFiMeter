# WiFiMeter

English | [简体中文](README.zh-CN.md)

A desktop network-usage meter for Windows and Linux. The interface uses Electron; a native C++ backend samples traffic and stores history in SQLite. Data stays on the computer. This source tree targets version 1.2.0; published builds are listed on [Releases](https://github.com/chronicle12345/WiFiMeter/releases).

![Overview with synthetic data](docs/assets/screenshot.png)

## Features

- Wi-Fi and physical Ethernet traffic, live download/upload rates, network aliases, and searchable history. Virtual adapters are excluded from physical Ethernet accounting.
- Native per-application capture through Windows ETW or Linux eBPF, with explicit permission and coverage states. Application history can be grouped by day or month and exported with its current filters.
- Per-network quotas and a separate combined Wi-Fi quota, with daily, monthly or cumulative periods. Ethernet does not consume the combined Wi-Fi quota. Warnings and optional Wi-Fi disconnection are configurable.
- Windows application blocking and upload limits, shown after selecting an application or executable. Upload limits do not limit downloads. These controls are unavailable on Linux.
- Optional Windows proxy attribution estimates, clearly separated from native records. Estimates use observed TCP connections and retain unattributed traffic when evidence is missing.
- Inclusive custom dates and all-history queries, CSV/JSON export, complete backups, configurable retention, English/Chinese UI, tray mode and login startup.

## Existing data and upgrades

On Windows, the app discovers the file-based version's default directory at `%LOCALAPPDATA%\WiFiMeter\data`. Other directories can be selected in Settings. Stop the old collector before importing; the Windows installer requests a graceful save and stop before replacing the application.

Migration preserves original files, creates a recovery backup and imports eligible records in one database transaction. Repeating the same import does not add the bytes again. Conflicting records are rejected instead of silently replacing an existing database. Ambiguous application-cache entries and unrepresentable legacy settings remain archived and are listed in the import report.

Existing cross-platform SQLite profiles keep their location. Windows continues to use `%APPDATA%\WiFiMeter Demo\wifimeter.db` for compatibility. Linux uses the existing Electron user-data location. Uninstalling does not remove these data directories.

See the [migration guide](docs/MIGRATION.md) for recovery, retained originals and backup scope. The file-based [v1.1.1 release](https://github.com/chronicle12345/WiFiMeter/releases/tag/v1.1.1) remains available.

## Packages

The release pipeline verifies Windows x64, ARM64 and x86 compatibility packages, and Linux x64/ARM64 packages. Windows offers NSIS installation and portable executables; Linux offers deb, rpm and AppImage formats. A format name alone does not guarantee compatibility with every distribution or kernel: see the [tested build matrix](docs/PACKAGING-MATRIX.md).

Windows x86 uses the Electron 43 compatibility runtime; other targets use Electron 44. The backend and frontend executable architectures are checked together. macOS and Linux 32-bit are not release targets.

Application capture requires supported native facilities and permission. Linux eBPF has additional kernel requirements; see [Linux capture](docs/LINUX_APP_CAPTURE.md) and [Windows capture](docs/WINDOWS_APP_CAPTURE.md). Network controls request administrator approval. Firewall/QoS policies can persist after exit or uninstall; remove unwanted policies in the application before uninstalling.

## Build and test

Install Node.js, CMake and a C++20 compiler, then:

```sh
npm ci --prefix apps/desktop
npm run build:backend
npm run test:unit
npm run test:ui
```

Backend tests are built with CMake and run with CTest. Platform dependencies and package commands are documented in [packaging](packaging/README.md):

```sh
node packaging/windows/build.cjs --arch x64 --formats nsis,portable
node packaging/linux/build.cjs --arch x64 --formats deb,rpm,AppImage
```

Tests use synthetic fixtures and isolated profiles. Builds, runtime data, traces and local credentials are excluded from Git. The release workflow publishes a release only after the required architecture, migration, backend, UI and package checks succeed.

## Performance and license

The native backend handles sampling, counters and storage. The UI queries selected date ranges; unchanged login settings are not rewritten, contiguous coverage gaps are coalesced, and large IPC frames are scanned incrementally. Distributed Electron language resources are limited to English and Simplified Chinese. Electron still has more baseline memory and disk overhead than the earlier WPF application; measurements must distinguish that overhead from native-backend and IPC improvements.

The application is under the [MIT license](LICENSE). Third-party components and the separately licensed Linux BPF program are described in [third-party notices](backend/third_party/README.md).
