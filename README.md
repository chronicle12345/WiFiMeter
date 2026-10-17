<p align="center">
  <a href="docs/assets/logo.svg"><img src="docs/assets/banner.svg" alt="WiFiMeter: Wi-Fi usage by network" width="100%" /></a>
</p>

<p align="center">
  <a href="docs/releases/v1.3.6.md"><img src="https://img.shields.io/badge/version-1.3.6-6366F1?style=for-the-badge&amp;labelColor=182033" alt="Version 1.3.6" /></a>
  <a href="docs/PACKAGING-MATRIX.md"><img src="https://img.shields.io/badge/release-Windows%20x64-0284C7?style=for-the-badge&amp;labelColor=182033" alt="Windows x64" /></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-16A34A?style=for-the-badge&amp;labelColor=182033" alt="MIT License" /></a>
</p>

<p align="center"><strong>English</strong> &nbsp;|&nbsp; <a href="README.zh-CN.md">简体中文</a></p>

WiFiMeter tracks network and application traffic, with live speeds, usage history and quota alerts. Data is stored locally.

## Download

[Download for Windows x64](https://github.com/chronicle12345/WiFiMeter/releases/latest) · [Platform support](docs/PACKAGING-MATRIX.md)

![Usage overview with sample data](docs/assets/screenshot-en.png)

## Features

- Live upload/download speeds and usage totals for Wi-Fi and Ethernet.
- Application traffic and history grouped by minute, hour, day or month.
- Network quotas, multiple warning thresholds and optional Wi-Fi disconnection.
- A Windows floating window with application rates, pinning and edge hiding.
- Windows application blocking and separate upload/download limits.
- CSV/JSON export, backups and an English/Chinese interface.

Follow the authorization prompts to enable application capture and network controls.

## Guides

- [Floating window](docs/FLOATING_WINDOW.md)
- [Data migration and recovery](docs/MIGRATION.md)
- [Development](docs/DEVELOPMENT.md) · [Testing](docs/TESTING.md) · [Source builds](packaging/README.md)
- [Architecture](docs/ARCHITECTURE.md) · [Data contracts](contracts/README.md)

[MIT license](LICENSE) · [Third-party notices](backend/third_party/README.md) · [WinDivert](apps/desktop/native/windows/WinDivert/README.md)
