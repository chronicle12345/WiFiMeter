# WiFiMeter 共享桌面应用

此目录包含 Windows/Linux 共用的 Tauri 宿主和页面。Rust 提供窗口和原生桌面能力，随包 Node 辅助进程复用桌面业务模块并拉起 `wifimeter-backend`，按行交换 JSON，C++ 后端把采集结果写入本机 SQLite 数据库。发布包包含 Node 运行时，无须用户另装 Node。发布目标包含 Windows x64、x86、ARM64 及 Linux x64、ARM64。

从仓库根目录运行：

```bash
npm ci --prefix apps/desktop
npm start
npm test
npm run dist:windows
```

也可进入此目录执行这些命令。Windows 本机打包产物位于仓库根目录 `dist/windows/`。Linux 使用 `npm run dist:linux` 生成 deb、rpm、AppImage；各架构的安装包必须通过完整 CI 后才能发布。详见[构建与发布矩阵](../../docs/PACKAGING-MATRIX.md)。

## 模块

- `src-tauri/`：Rust 窗口、托盘、对话框和受限 IPC；仅本机页面可调用桌面接口。
- `tauri/`：页面桥接、Node 辅助进程入口和原生适配器。
- `electron/`：复用的桌面业务模块；Electron 入口保留用于迁移回归，发布包不包含 Electron 运行时。
- `renderer/app.js`、`index.html`、`styles.css`：页面与交互。
- `renderer/data/model.js`：快照校验、日期、单位和用量计算。
- `renderer/data/backend-client.js`：与后端通信的数据客户端，就地更新快照并接收事件。
- `renderer/data/client.js`：页面创建数据对象的统一入口。
- `renderer/data/mock.js`：示例数据生成，仅用于单元测试，不再被页面使用。
- `assets/`：应用图标。
- `tests/`：数据与文件操作单元测试、迁移界面回归和 Tauri 集成验证。

桌面桥通过只读的 `appName` 提供当前平台产品名，文件操作公开 `saveFile({ filename, body })` 和 `openBackup()`（取消返回 `canceled: true`，失败返回 `error`），后端通信公开 `backend.request(method, params)` 与 `backend.onEvent(handler)`。

用量按大小自动选择单位，最多保留两位小数并去掉尾零；真实零显示 `0 B`，无记录显示 `—`。
设置中的单位进制沿用已有偏好：十进制显示 B / KB / MB / GB，二进制显示 B / KiB / MiB / GiB。
趋势图按当前图的峰值选择共同单位；CSV 导出仍使用选定的 GB / GiB 固定单位与六位小数。

自定义范围使用本地日期与时分，包含结束分钟。网络与应用历史支持分钟、小时明细；应用明细分页显示，导出包含完整筛选结果。分钟历史按需加载，长区间图表按小时或日汇总，各分钟仍可在明细中查询。升级前的每日、小时记录保留原有精度。

总览首屏保留核心指标，完整应用实时排行位于下方滚动区；应用实时页也显示全部采集到的应用，可按下载、上传或总速度排序。Windows 上传和下载可分别设置、取消；下载辅助进程使用随包的 WinDivert 驱动，仅在 WiFiMeter 运行期间生效。下载限速依赖和适用范围见 [WinDivert 说明](native/windows/WinDivert/README.md)。

Windows 悬浮窗可展开应用列表，显示实时速度与分钟累计用量。1 分钟范围为当前日历分钟，5 分钟和 1 小时分别为当前分钟加之前 4 个、59 个分钟，自定义支持 1 到 10080 分钟。范围自动保存，仅在列表展开时读取分钟明细，详见[悬浮窗说明](../../docs/FLOATING_WINDOW.md)。

后端失败统一以 `{ ok: false, error: { code, message } }` 返回，保证错误码和消息经过桌面 IPC 后仍可供页面选择提示文案。

## 数据存放

历史、网络备注、额度与偏好都存在用户数据目录下的 `wifimeter.db`（SQLite）。备份文件标记为 `wifimeter-backend-backup`，恢复前会校验该标记，避免把流量导出文件当成完整备份。

Windows 使用名称 `WiFiMeter`，沿用应用标识 `io.wifimeter.demo` 和数据目录 `%APPDATA%\WiFiMeter Demo`，升级后继续读取已有记录；后端默认数据库位于 `%LOCALAPPDATA%\WiFiMeter\wifimeter.db`，桌面业务进程始终显式传入 `--db`，因此界面与后端用的是同一个文件。

从 Electron 1.2.x 升级需到 [Releases](https://github.com/chronicle12345/WiFiMeter/releases) 下载 Windows x64 Tauri 安装版并运行安装；后续 Tauri 更新只选择对应的 Tauri 安装包。

完整备份包含日、小时、分钟及应用记录、备注、额度账本、偏好和迁移档案；恢复后采集暂停，避免当前计数差立刻覆盖刚恢复的历史。CSV/JSON 流量导出不能代替完整备份。自启动设置会写入系统（Windows 用 `HKCU\Software\Microsoft\Windows\CurrentVersion\Run`，Linux 用 `~/.config/autostart`），额度提醒转成系统通知，超额断开由后端核对网络身份后真实执行。

Windows 的 Electron 和 Tauri 宿主统一使用 `WiFiMeter` 启动项。设置同步会合并同一程序路径的旧 `io.wifimeter.demo` 登记，并识别旧版的 `--tray` 和 `--background` 参数；关闭自启动会移除这些登记。其他程序路径或未知参数的项目会保留。同步时读取并保留 Windows 的禁用状态，只有用户在应用中明确开启自启动才恢复启用；新登记核对成功后才清理旧项。

已规范的 Windows 启动项每次同步只查询两项登记和一次批准状态，直接使用本次核对结果，避免再次启动注册表查询进程。下一次同步仍重新读取 Windows 的实际状态，任务管理器中的启用或禁用操作会生效。

## 后端进程

应用分布支持排行榜、搜索、排序和最近采样进程。采集源可用时，用户在网络详情中主动启用；
该开关仅在当前会话有效，停止或暂停保留已有历史。权限失败和缺失区间独立显示，不影响网卡统计和额度。
Linux 使用 eBPF，Windows 使用 ETW 原生采集辅助进程；统计口径与授权验证详见
[Linux 应用采集](../../docs/LINUX_APP_CAPTURE.md)和 [Windows 应用采集](../../docs/WINDOWS_APP_CAPTURE.md)。
自动测试通过 `WIFIMETER_FAKE_APPS` 注入进程计数，真实后端负责归属、落库和推送。

`electron/backend.cjs` 按平台查找后端可执行文件：`WIFIMETER_BACKEND` 环境变量优先，其次是打包后的 `resources/wifimeter-backend(.exe)`，最后是开发目录 `build/app/`（Linux）或 `build/windows/app/`（Windows）。Windows 上不检查可执行位（该系统没有这个概念）。

后端退出或启动失败时，下一次请求会自动重新拉起。数据库路径始终由桌面业务进程显式传给后端，两个进程使用同一份数据。

## 测试打包程序

从仓库根目录，在 Windows PowerShell 中构建 Tauri 包并检查 Rust 宿主、随包 Node、真实后端和 WebView2：

```powershell
npm run dist:windows
cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml --features custom-protocol --locked
node packaging/tauri/verify-windows.cjs
```

运行 `node packaging/tauri/verify-windows.cjs` 会从 NSIS 解包并运行集成脚本；也可通过 `WIFIMETER_TAURI_EXECUTABLE` 指定程序路径。隔离配置与检查报告位于 `build/tauri-smoke/`，安装器可下载缺少的 WebView2。

`npm test` 和 `npm run test:ui` 中的 Playwright 用例仍通过 Electron 入口验证共用页面。旧 Electron 打包程序回归可在 Windows PowerShell 中执行：

```powershell
$env:WIFIMETER_EXECUTABLE = (Resolve-Path '.\dist\windows\win-unpacked\WiFiMeter.exe').Path
npm run test:ui
```

Electron 界面回归的截图和失败跟踪位于此目录的 `test-results/`，测试使用临时配置目录。这些用例与 Tauri 原生集成检查分别执行。
