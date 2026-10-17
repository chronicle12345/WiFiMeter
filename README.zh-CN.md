<p align="center">
  <a href="docs/assets/logo.svg"><img src="docs/assets/banner.svg" alt="WiFiMeter: Wi-Fi usage by network" width="100%" /></a>
</p>

<p align="center">
  <a href="docs/releases/v1.3.6.md#中文"><img src="https://img.shields.io/badge/version-1.3.6-6366F1?style=for-the-badge&amp;labelColor=182033" alt="Version 1.3.6" /></a>
  <a href="docs/PACKAGING-MATRIX.zh-CN.md"><img src="https://img.shields.io/badge/release-Windows%20x64-0284C7?style=for-the-badge&amp;labelColor=182033" alt="Windows x64 release target" /></a>
  <a href="docs/ARCHITECTURE.zh-CN.md#c-后端"><img src="https://img.shields.io/badge/backend-C%2B%2B20-8B5CF6?style=for-the-badge&amp;labelColor=182033" alt="C++20 backend" /></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-16A34A?style=for-the-badge&amp;labelColor=182033" alt="MIT License" /></a>
</p>

<p align="center">
  <a href="docs/ARCHITECTURE.zh-CN.md#当前数据流"><img src="https://img.shields.io/badge/UI-Tauri-0D9488?style=for-the-badge&amp;labelColor=182033" alt="Tauri interface" /></a>
  <a href="docs/MIGRATION.zh-CN.md"><img src="https://img.shields.io/badge/storage-SQLite-2563EB?style=for-the-badge&amp;labelColor=182033" alt="SQLite storage" /></a>
  <a href="README.md"><img src="https://img.shields.io/badge/languages-EN%20%2F%20ZH-DB7093?style=for-the-badge&amp;labelColor=182033" alt="English and Simplified Chinese" /></a>
</p>

<p align="center">
  <a href="#构建与测试">构建与测试</a> &nbsp;·&nbsp;
  <a href="docs/MIGRATION.zh-CN.md">数据迁移</a> &nbsp;·&nbsp;
  <a href="docs/PACKAGING-MATRIX.zh-CN.md">平台与安装包</a> &nbsp;·&nbsp;
  <a href="https://github.com/chronicle12345/WiFiMeter/releases">版本下载</a>
</p>

<p align="center"><a href="README.md">English</a> &nbsp;|&nbsp; <strong>简体中文</strong></p>

WiFiMeter 是桌面流量统计工具，Windows 和 Linux 共用同一套源码。桌面宿主使用 Tauri 和系统 WebView，采样、计数和存储由 C++ 后端处理，历史记录保存在本机 SQLite 数据库中。1.3.6 仅构建并发布 Windows x64 安装包，Windows x86/ARM64 和 Linux x64/ARM64 的 CI 构建暂时注释；源码继续保留，旧版安装包仍可从[版本下载](https://github.com/chronicle12345/WiFiMeter/releases)获取。

1.3.6 在应用工作区与悬浮窗增加实时流量来源切换，可选择原生采集或包含端口估算。估算应用速率带有标记，并替换已归属的代理速率，避免重复计数；网卡总量和额度继续使用实测数据。同时减少设置页面底部空白，将 CI 和发布验证暂时集中于 Windows x64。发布说明记录了安装方法与限制。

以下总览和应用历史截图均使用虚构数据。

![流量总览](docs/assets/screenshot.png)

![按月汇总的应用流量表格](docs/assets/applications-zh-CN.png)

## 功能

- 统计 Wi-Fi 和物理有线网卡流量，显示实时下载、上传速度，支持网络备注与历史搜索。有线统计排除虚拟网卡。
- 使用 Windows ETW 采集非回环应用流量，使用 TCP EStats 实测回环及代理客户端的实时字节，或通过 Linux eBPF 采集，并显示权限和覆盖状态。总览首屏保留核心指标，完整应用实时排行位于下方滚动区。应用页与网络详情共用应用流量工作区，可切换实时流量与用量记录，各视图保留搜索和排序选择，并通过抽屉查看应用详情；历史支持按分钟、小时、日、月汇总，并导出当前筛选结果。
- 支持单网络额度和独立的 Wi-Fi 总额度，周期可选每日、每月或累计。有线流量不计入 Wi-Fi 总额度，可设置提醒及达到额度后断开 Wi-Fi。
- Windows 支持按应用禁止联网，以及独立设置和取消上传、下载限速。Windows x64 包随附 WinDivert 驱动，下载限速在 WiFiMeter 运行期间生效；经独立代理进程接收的流量需限制代理程序。Linux 暂不提供这些控制。
- Windows 支持可选的代理流量估算，与原生记录和本地 TCP 代理实测速率分开显示。实时视图可切换为包含端口估算，按当前客户端 TCP 连接数分配代理程序的本轮物理网络速率，客户端直连行与估算份额分别保留；替换已归属的代理行，避免合计重复，无法分配的份额保留为估算未归属。主窗口在本次会话内保留实时选择。每日历史估算依据已观测的 TCP 连接权重；合计不匹配时保留原生记录，部分日期及分钟/小时查询不显示每日估算。先在现有设置中配置代理端口，通过观测识别代理程序，也可选填进程名辅助确认；证据不足时保留原生数值或不可用状态。
- 自定义范围可选择具体小时和分钟，包含结束分钟；网络与应用都可查看分钟明细。分钟数据从升级后开始积累，旧数据保留已有精度。支持全部历史查询、CSV/JSON 导出、完整备份、保存天数、中英切换、托盘和开机启动。
- Windows 悬浮窗显示全部实时上传、下载速度，可展开应用列表，查看各应用实时速度和累计用量。应用实时来源可在原生采集与包含端口估算之间切换，悬浮窗会保存此选择，重启后继续使用；累计用量仍来自真实分钟记录。可固定位置、保持显示或选择排除代理程序流量；自动隐藏仅在屏幕左右边缘生效，固定后不吸附、不隐藏。1 分钟表示当前日历分钟，5 分钟和 1 小时分别包含当前分钟及之前 4 个、59 个分钟；自定义支持 1 到 10080 分钟，范围自动保存，详见[悬浮窗说明](docs/FLOATING_WINDOW.zh-CN.md)。

## 原有数据与升级

Windows x64 上使用 Electron 1.2.x 的用户可从[版本下载](https://github.com/chronicle12345/WiFiMeter/releases)获取本版 Tauri 安装包，程序会继续读取已有数据目录。其他架构在恢复构建前继续使用最近的对应安装包。安装 Tauri 后，后续更新检查会选择对应的 Tauri 安装包。

Windows x64 用户可通过应用内更新升级至 1.3.6，也可手动运行 Windows x64 安装包，升级时的提示由当前安装的版本决定。1.3.6 不提供 Windows x86/ARM64 或 Linux 安装包。Linux 更新检查打开官方版本页，由用户手动安装已有的对应版本。Windows 手动升级前请正常退出 WiFiMeter；受更新问题影响的旧版本也可能需要手动安装。

1.3.5 检查更新时仅读取版本信息；Windows 用户确认后下载对应安装包，长度和 SHA-256 校验通过后，再确认自动安装。安装时保存设置和数据库，静默安装并重启。不下载时不会传输安装包；暂不安装时保留已校验安装包，稍后使用前再次复核。启动检查仅提醒有可用更新。

1.3.5 还会在启动和迁移完成、主窗口显示后，询问本次是否开启应用采集；同意后再为采集辅助进程请求系统权限。选择不开启或拒绝系统授权后，本次不采集应用流量，网卡统计继续运行。设置 > 常规中的启动时询问应用采集默认开启，关闭后不再显示后续启动询问。应用页仍可手动开启、停止或重试采集。

Windows 会发现旧文件版的默认目录 `%LOCALAPPDATA%\WiFiMeter\data`，其他目录可在设置中选择。导入前需要停止旧采集器；Windows 安装程序会先请求旧采集器保存并退出，再替换程序。

迁移保留原文件，先生成恢复备份，再用数据库事务导入符合条件的记录。重复导入同一份数据不会再次累计流量。遇到冲突会拒绝导入，不会直接覆盖现有数据库。无法确定归属的应用缓存，以及不能精确转换的旧设置，会保留原文并列在导入报告中。

已有跨平台 SQLite 配置目录保持不变。Windows 继续使用 `%APPDATA%\WiFiMeter Demo\wifimeter.db`，以便读取之前的数据；Linux 沿用已有的 Electron 用户数据目录。卸载不会删除这些数据目录。

恢复方法、原文件保留方式和备份范围见[迁移说明](docs/MIGRATION.zh-CN.md)。原文件版 [v1.1.1](https://github.com/chronicle12345/WiFiMeter/releases/tag/v1.1.1) 仍可下载。

## 安装包

1.3.6 提供一个 Windows x64 NSIS 安装包。Windows x86/ARM64 和 Linux x64/ARM64 的 CI 任务暂时注释，源码构建工具继续保留，旧版本的安装包不变。便携压缩包已取消。校验清单仅用于 CI 内部验证，下载页面只列应用安装包。当前 Windows x64 的检查与暂停目标见[构建与发布矩阵](docs/PACKAGING-MATRIX.zh-CN.md)。

Tauri 安装包使用系统 WebView，随包提供 Node 辅助进程和 C++ 采集器，不再携带 Electron 或 Chromium。Windows 安装版会在缺少 WebView2 时下载并安装运行时，Linux 使用 WebKitGTK 4.1。各产物名称含 Tauri，构建会核对宿主、Node、后端和采集器的架构。macOS 和 32 位 Linux 暂不在发布目标中，Windows ARM64 暂不支持 WinDivert 下载限速。

应用采集需要系统支持和相应权限。Linux eBPF 另有内核要求，详见 [Linux 采集](docs/LINUX_APP_CAPTURE.zh-CN.md)及 [Windows 采集](docs/WINDOWS_APP_CAPTURE.zh-CN.md)。应用网络控制会请求管理员授权。防火墙和 QoS 规则可能在退出或卸载后保留，不再需要时请先在应用内移除。

## 构建与测试

日常开发先切换到 `dev`，并保持与 `origin/dev` 同步。`main` 保留稳定代码，验证通过后将 `dev` 合并至 `main`。已合并且没有独立提交的临时分支可以清理。

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

平台依赖及其他源码构建命令见[打包说明](packaging/README.zh-CN.md)。测试使用虚构数据和隔离目录。构建产物、运行数据、日志与本机凭据不提交 Git。当前发布流程要求两个 Windows 浏览器分片及 Windows x64 的后端、原生采集、Rust 宿主和安装包检查全部通过，再发布一个安装包。内部 SHA-256 清单与公开下载由 GitHub Actions 验证。

## 文档

项目文档默认英文，主要说明提供对应的 `.zh-CN.md` 中文版，页首可切换语言。两版的命令、功能、限制和验证结论须同步；发布说明与更新日志在同一文件中保留中英内容，英文在前。第三方许可证保留原文。

- [项目架构](docs/ARCHITECTURE.zh-CN.md)、[数据合约](contracts/README.zh-CN.md)与[迁移说明](docs/MIGRATION.zh-CN.md)。
- [Windows 采集](docs/WINDOWS_APP_CAPTURE.zh-CN.md)、[Linux 采集](docs/LINUX_APP_CAPTURE.zh-CN.md)与 [Linux 应用图标](docs/LINUX_APPLICATION_ICONS.zh-CN.md)。
- [悬浮窗](docs/FLOATING_WINDOW.zh-CN.md)。
- [源码打包](packaging/README.zh-CN.md)、[CI 与发布要求](docs/PACKAGING-MATRIX.zh-CN.md)及 [Windows 安装器来源](packaging/tauri/windows/SOURCES.zh-CN.md)。
- [第三方说明](backend/third_party/README.zh-CN.md)与 [WinDivert 说明](apps/desktop/native/windows/WinDivert/README.zh-CN.md)。

## 性能与许可

采样、计数和存储放在原生后端；界面按所选日期查询，避免反复加载全部历史。不重复写入未变的自启动设置，连续缺失区间合并保存，大型 IPC 消息按新增分段扫描。Tauri 使用系统 WebView 减小发行体积，原桌面业务由随包 Node 辅助进程复用；实际体积仍包含 Node、采集器和驱动，测量以完整发行包为准。

应用采用 [MIT 许可证](LICENSE)。第三方组件及 Linux BPF 程序的独立许可见[第三方说明](backend/third_party/README.zh-CN.md)。
