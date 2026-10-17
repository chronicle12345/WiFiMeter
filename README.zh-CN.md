<p align="center">
  <a href="docs/assets/logo.svg"><img src="docs/assets/banner.svg" alt="WiFiMeter: Wi-Fi usage by network" width="100%" /></a>
</p>

<p align="center">
  <a href="docs/releases/v1.3.6.md#中文"><img src="https://img.shields.io/badge/version-1.3.6-6366F1?style=for-the-badge&amp;labelColor=182033" alt="Version 1.3.6" /></a>
  <a href="docs/PACKAGING-MATRIX.zh-CN.md"><img src="https://img.shields.io/badge/release-Windows%20x64-0284C7?style=for-the-badge&amp;labelColor=182033" alt="Windows x64" /></a>
  <a href="docs/ARCHITECTURE.zh-CN.md"><img src="https://img.shields.io/badge/UI-Tauri-0D9488?style=for-the-badge&amp;labelColor=182033" alt="Tauri interface" /></a>
  <a href="docs/ARCHITECTURE.zh-CN.md"><img src="https://img.shields.io/badge/backend-C%2B%2B20-8B5CF6?style=for-the-badge&amp;labelColor=182033" alt="C++20 backend" /></a>
  <a href="docs/MIGRATION.zh-CN.md"><img src="https://img.shields.io/badge/storage-SQLite-2563EB?style=for-the-badge&amp;labelColor=182033" alt="SQLite storage" /></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-16A34A?style=for-the-badge&amp;labelColor=182033" alt="MIT License" /></a>
</p>

<p align="center"><a href="README.md">English</a> &nbsp;|&nbsp; <strong>简体中文</strong></p>

WiFiMeter 是面向 Windows 和 Linux 的桌面流量统计工具。按网络和应用查看用量、查询历史、设置额度，并通过悬浮窗持续查看实时网速。界面采用 Tauri，C++ 后端采集流量，SQLite 在本机保存数据。

[下载](#下载) · [功能](#功能) · [界面预览](#界面预览) · [开始使用](#开始使用) · [文档](#文档)

## 下载

[下载 Windows x64 安装包](https://github.com/chronicle12345/WiFiMeter/releases/latest)

1.3.6 提供 Windows x64 安装包。Linux 和其他 Windows 架构的构建暂停，源码构建工具和历史版本继续保留。当前支持目标见[平台与安装包矩阵](docs/PACKAGING-MATRIX.zh-CN.md)。

## 功能

### 网络与应用流量

- 查看 Wi-Fi 和物理有线网卡的实时上传、下载速度及累计用量，支持网络备注、历史搜索和按连接分别统计。
- 通过 Windows ETW/TCP EStats 或 Linux eBPF 查看应用流量，界面显示权限和采集覆盖状态。
- Windows 主窗口和悬浮窗均可在原生采集与端口代理估算之间切换应用实时来源。估算份额单独标记，网络总量和额度采用实测流量。主窗口选择在当前会话有效，悬浮窗选择在重启后保留。

### 历史、额度与数据

- 自定义本地日期和时间范围，按分钟、小时、日或月汇总应用用量，支持搜索、排序和导出所选记录。Windows 下可选择原生历史或包含每日代理归属估算，适用于完整日期范围。
- 设置单网络额度和 Wi-Fi 总额度，支持每日、每月或累计周期、多档提醒及可选的 Wi-Fi 自动断开。总额度仅统计 Wi-Fi 用量。
- 导出 CSV/JSON、创建完整备份并设置历史保留时长，旧 Windows 文件版数据可通过迁移工具导入。

### 桌面工具

- Windows 悬浮窗显示合计网速和最近时段应用用量，支持切换形状、固定位置、保持可见、代理筛选和左右贴边隐藏。详见[悬浮窗指南](docs/FLOATING_WINDOW.zh-CN.md)。
- Windows 支持按应用禁止联网，分别设置上传和下载限速。下载限速在 WiFiMeter 运行时生效；使用代理传输时，对代理程序设置限制。
- 支持中英文界面、托盘模式和开机启动，方便日常监测。

## 界面预览

截图使用示例数据。

![流量总览](docs/assets/screenshot.png)

![按月汇总的应用流量](docs/assets/applications-zh-CN.png)

## 开始使用

运行 Windows x64 安装包，启动 WiFiMeter，按应用采集提示完成授权。在主窗口查看网络统计、应用历史和额度，在设置中打开悬浮窗。缺少 WebView2 时，Windows 安装器会安装所需运行时。

Windows x64 用户可在应用内检查更新，下载和安装分别确认。Linux 用户从[版本页](https://github.com/chronicle12345/WiFiMeter/releases)手动安装匹配版本。手动升级前正常退出 WiFiMeter。Electron 1.2.x 用户先安装一次 Tauri 版本；已有 SQLite 配置保留数据位置。旧 Windows 文件版用户先停止旧采集器，再在设置中导入原目录。[迁移指南](docs/MIGRATION.zh-CN.md)说明备份、导入和恢复方法。

## 从源码运行

安装 Node.js、Rust、CMake、支持 C++20 的编译器及 [Tauri 平台依赖](https://v2.tauri.app/start/prerequisites/) 后运行：

```sh
git clone https://github.com/chronicle12345/WiFiMeter.git
cd WiFiMeter
git switch dev
npm ci --prefix apps/desktop
npm run build:backend
npm start
```

桌面检查可运行 `npm run test:unit` 和 `npm run test:ui`。后端与原生宿主验证见[测试指南](docs/TESTING.zh-CN.md)，安装包构建见[打包说明](packaging/README.zh-CN.md)。

## 文档

- [Windows 采集](docs/WINDOWS_APP_CAPTURE.zh-CN.md) · [Linux 采集](docs/LINUX_APP_CAPTURE.zh-CN.md) · [Linux 应用图标](docs/LINUX_APPLICATION_ICONS.zh-CN.md)
- [开发流程](docs/DEVELOPMENT.zh-CN.md) · [项目架构](docs/ARCHITECTURE.zh-CN.md) · [数据协议](contracts/README.zh-CN.md)
- [CI 与发布](docs/PACKAGING-MATRIX.zh-CN.md) · [更新记录](CHANGELOG.md)

## 许可证

WiFiMeter 采用 [MIT 许可证](LICENSE)。依赖许可见[第三方说明](backend/third_party/README.zh-CN.md)和 [WinDivert 说明](apps/desktop/native/windows/WinDivert/README.zh-CN.md)。
