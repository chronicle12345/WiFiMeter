<p align="center">
  <a href="docs/assets/logo.svg"><img src="docs/assets/banner.svg" alt="WiFiMeter: Wi-Fi usage by network" width="100%" /></a>
</p>

<p align="center">
  <a href="docs/releases/v1.3.6.md#中文"><img src="https://img.shields.io/badge/version-1.3.6-6366F1?style=for-the-badge&amp;labelColor=182033" alt="Version 1.3.6" /></a>
  <a href="docs/PACKAGING-MATRIX.zh-CN.md"><img src="https://img.shields.io/badge/release-Windows%20x64-0284C7?style=for-the-badge&amp;labelColor=182033" alt="Windows x64" /></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-16A34A?style=for-the-badge&amp;labelColor=182033" alt="MIT License" /></a>
</p>

<p align="center"><a href="README.md">English</a> &nbsp;|&nbsp; <strong>简体中文</strong></p>

WiFiMeter 是桌面流量统计工具，支持实时网速、应用用量、历史查询和额度提醒，数据保存在本机。

## 下载

[下载 Windows x64 版](https://github.com/chronicle12345/WiFiMeter/releases/latest) · [平台支持](docs/PACKAGING-MATRIX.zh-CN.md)

![使用示例数据的流量总览](docs/assets/screenshot.png)

## 功能

- Wi-Fi 和有线网络的实时上传、下载速度及累计用量。
- 应用流量统计，按分钟、小时、日或月查询历史。
- 网络额度、多档提醒及可选的 Wi-Fi 自动断开。
- Windows 悬浮窗，支持应用网速、固定和贴边隐藏。
- Windows 应用联网控制，分别设置上传和下载限速。
- CSV/JSON 导出、数据备份和中英文界面。

开启应用采集和网络控制时，按提示完成系统授权。

## 使用与开发

- [悬浮窗](docs/FLOATING_WINDOW.zh-CN.md)
- [数据迁移与恢复](docs/MIGRATION.zh-CN.md)
- [开发流程](docs/DEVELOPMENT.zh-CN.md) · [测试指南](docs/TESTING.zh-CN.md) · [源码构建](packaging/README.zh-CN.md)
- [项目架构](docs/ARCHITECTURE.zh-CN.md) · [数据协议](contracts/README.zh-CN.md)

[MIT 许可证](LICENSE) · [第三方说明](backend/third_party/README.zh-CN.md) · [WinDivert](apps/desktop/native/windows/WinDivert/README.zh-CN.md)
