<p align="center">
  <a href="docs/assets/logo.svg"><img src="docs/assets/banner.svg" alt="WiFiMeter: Wi-Fi usage by network" width="100%" /></a>
</p>

<p align="center">
  <a href="docs/releases/v1.3.2.md"><img src="https://img.shields.io/badge/version-1.3.2-6366F1?style=for-the-badge&amp;labelColor=182033" alt="Version 1.3.2" /></a>
  <a href="docs/PACKAGING-MATRIX.md"><img src="https://img.shields.io/badge/release-Windows%20%2F%20Linux-0284C7?style=for-the-badge&amp;labelColor=182033" alt="Windows and Linux release targets" /></a>
  <a href="docs/ARCHITECTURE.md#c-后端"><img src="https://img.shields.io/badge/backend-C%2B%2B20-8B5CF6?style=for-the-badge&amp;labelColor=182033" alt="C++20 backend" /></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-16A34A?style=for-the-badge&amp;labelColor=182033" alt="MIT License" /></a>
</p>

<p align="center">
  <a href="docs/ARCHITECTURE.md#当前数据流"><img src="https://img.shields.io/badge/UI-Tauri-0D9488?style=for-the-badge&amp;labelColor=182033" alt="Tauri interface" /></a>
  <a href="docs/MIGRATION.md"><img src="https://img.shields.io/badge/storage-SQLite-2563EB?style=for-the-badge&amp;labelColor=182033" alt="SQLite storage" /></a>
  <a href="README.md"><img src="https://img.shields.io/badge/languages-EN%20%2F%20ZH-DB7093?style=for-the-badge&amp;labelColor=182033" alt="English and Simplified Chinese" /></a>
</p>

<p align="center">
  <a href="#构建与测试">构建与测试</a> &nbsp;·&nbsp;
  <a href="docs/MIGRATION.md">数据迁移</a> &nbsp;·&nbsp;
  <a href="docs/PACKAGING-MATRIX.md">平台与安装包</a> &nbsp;·&nbsp;
  <a href="https://github.com/chronicle12345/WiFiMeter/releases">版本下载</a>
</p>

<p align="center"><a href="README.md">English</a> &nbsp;|&nbsp; <strong>简体中文</strong></p>

WiFiMeter 是桌面流量统计工具，Windows 和 Linux 共用同一套源码。桌面宿主使用 Tauri 和系统 WebView，采样、计数和存储由 C++ 后端处理，历史记录保存在本机 SQLite 数据库中。发布目标包括 Windows x64、x86、ARM64 及 Linux x64、ARM64，当前可用安装包见[版本下载](https://github.com/chronicle12345/WiFiMeter/releases)。

以下总览和应用历史截图均使用虚构数据。

![流量总览](docs/assets/screenshot.png)

![按月汇总的应用流量表格](docs/assets/applications-zh-CN.png)

## 功能

- 统计 Wi-Fi 和物理有线网卡流量，显示实时下载、上传速度，支持网络备注与历史搜索。有线统计排除虚拟网卡。
- 使用 Windows ETW 或 Linux eBPF 采集应用流量，显示权限和缺失状态。总览首屏保留核心指标，完整应用实时排行位于下方滚动区，应用页也显示全部已采集应用；应用历史支持按分钟、小时、日、月汇总，并导出当前筛选结果。
- 支持单网络额度和独立的 Wi-Fi 总额度，周期可选每日、每月或累计。有线流量不计入 Wi-Fi 总额度，可设置提醒及达到额度后断开 Wi-Fi。
- Windows 支持按应用禁止联网，以及独立设置和取消上传、下载限速。Windows x64 包随附 WinDivert 驱动，下载限速在 WiFiMeter 运行期间生效；经独立代理进程接收的流量需限制代理程序。Linux 暂不提供这些控制。
- Windows 支持可选的代理流量估算，与原生记录分开显示。估算依据已观测的 TCP 连接，证据不足的部分保留为未归属流量。
- 自定义范围可选择具体小时和分钟，包含结束分钟；网络与应用都可查看分钟明细。分钟数据从升级后开始积累，旧数据保留已有精度。支持全部历史查询、CSV/JSON 导出、完整备份、保存天数、中英切换、托盘和开机启动。
- Windows 悬浮窗显示全部实时上传、下载速度，可展开应用列表，查看各应用实时速度和累计用量。1 分钟表示当前日历分钟，5 分钟和 1 小时分别包含当前分钟及之前 4 个、59 个分钟；自定义支持 1 到 10080 分钟，范围自动保存，详见[悬浮窗说明](docs/FLOATING_WINDOW.md)。

## 原有数据与升级

使用 Electron 1.2.x 的用户需从[版本下载](https://github.com/chronicle12345/WiFiMeter/releases)获取与系统及 CPU 架构匹配的 Tauri 安装版，程序会继续读取已有数据目录。安装 Tauri 后，后续更新检查会选择对应的 Tauri 安装包。

Windows 会发现旧文件版的默认目录 `%LOCALAPPDATA%\WiFiMeter\data`，其他目录可在设置中选择。导入前需要停止旧采集器；Windows 安装程序会先请求旧采集器保存并退出，再替换程序。

迁移保留原文件，先生成恢复备份，再用数据库事务导入符合条件的记录。重复导入同一份数据不会再次累计流量。遇到冲突会拒绝导入，不会直接覆盖现有数据库。无法确定归属的应用缓存，以及不能精确转换的旧设置，会保留原文并列在导入报告中。

已有跨平台 SQLite 配置目录保持不变。Windows 继续使用 `%APPDATA%\WiFiMeter Demo\wifimeter.db`，以便读取之前的数据；Linux 沿用已有的 Electron 用户数据目录。卸载不会删除这些数据目录。

恢复方法、原文件保留方式和备份范围见[迁移说明](docs/MIGRATION.md)。原文件版 [v1.1.1](https://github.com/chronicle12345/WiFiMeter/releases/tag/v1.1.1) 仍可下载。

## 安装包

Windows x64、x86、ARM64 分别提供 NSIS 安装程序，Linux x64、ARM64 分别提供 deb、rpm、AppImage。便携压缩包已取消。校验清单仅用于 CI 内部验证，下载页面只列应用安装包。五组目标的发布条件见[构建与发布矩阵](docs/PACKAGING-MATRIX.md)。

Tauri 安装包使用系统 WebView，随包提供 Node 辅助进程和 C++ 采集器，不再携带 Electron 或 Chromium。Windows 安装版会在缺少 WebView2 时下载并安装运行时，Linux 使用 WebKitGTK 4.1。各产物名称含 Tauri，构建会核对宿主、Node、后端和采集器的架构。macOS 和 32 位 Linux 暂不在发布目标中，Windows ARM64 暂不支持 WinDivert 下载限速。

应用采集需要系统支持和相应权限。Linux eBPF 另有内核要求，详见 [Linux 采集](docs/LINUX_APP_CAPTURE.md)及 [Windows 采集](docs/WINDOWS_APP_CAPTURE.md)。应用网络控制会请求管理员授权。防火墙和 QoS 规则可能在退出或卸载后保留，不再需要时请先在应用内移除。

## 构建与测试

安装 Node.js、Rust、CMake 和支持 C++20 的编译器，以及 [Tauri 平台依赖](https://v2.tauri.app/start/prerequisites/) 后运行：

```sh
npm ci --prefix apps/desktop
npm run build:backend
npm run test:unit
npm run test:ui
```

后端测试由 CMake 构建，通过 CTest 执行。界面测试使用无头浏览器、真实 Tauri 页面桥接和隔离的 Node 业务宿主。Windows 默认复用已安装的 Microsoft Edge；其他环境可运行 `npm --prefix apps/desktop exec -- playwright install chromium` 安装对应版本的测试浏览器，无需 Electron。Windows x64 Tauri 需要另行构建安装包，并运行真实 WebView2 集成检查：

```sh
node packaging/tauri/build.cjs --platform win32 --arch x64 --formats nsis
node packaging/tauri/verify-windows.cjs
```

平台依赖及其他源码构建命令见[打包说明](packaging/README.md)。测试使用虚构数据和隔离目录。构建产物、运行数据、日志与本机凭据不提交 Git。1.3.x 发布流程要求五组目标的后端、Rust 宿主和安装包检查全部通过，再发布完整的九个安装包。

## 性能与许可

采样、计数和存储放在原生后端；界面按所选日期查询，避免反复加载全部历史。不重复写入未变的自启动设置，连续缺失区间合并保存，大型 IPC 消息按新增分段扫描。Tauri 使用系统 WebView 减小发行体积，原桌面业务由随包 Node 辅助进程复用；实际体积仍包含 Node、采集器和驱动，测量以完整发行包为准。

应用采用 [MIT 许可证](LICENSE)。第三方组件及 Linux BPF 程序的独立许可见[第三方说明](backend/third_party/README.md)。
