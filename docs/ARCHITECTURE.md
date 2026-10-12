# 项目架构

共享的 Tauri 桌面应用位于 `apps/desktop/`，同一套页面和宿主代码面向 Windows/Linux。Rust 提供系统 WebView 和原生桌面能力，Node 辅助进程复用已有业务模块。真实网络采集与业务存储由本机 C++ 后端负责，两个平台层都已实现。当前发布覆盖 Windows x64、x86、ARM64 和 Linux x64、ARM64，具体能力与验证边界见[构建与发布矩阵](PACKAGING-MATRIX.md)。

## 当前数据流

```text
renderer/app.js → data/backend-client.js → tauri/bridge.js → Rust → Node 业务进程 → wifimeter-backend（按行 JSON）
       └──────────────────────────────────→ data/model.js（校验与计算）
页面 → tauri/bridge.js → Rust → 系统文件对话框、窗口、托盘、系统通知
                           → Node → 开机启动、数据导入、文件读写、更新和流量控制
```

`client.js` 是页面创建数据对象的唯一入口，统一使用 `backend-client.js` 读取本机后端。`mock.js` 仅用于测试。数据定义与计算放在 `model.js`。

`renderer/app.js` 组合页面渲染、导航与事件。可复用的输入和显示逻辑放在 `renderer/ui/`，数据访问与计算放在 `renderer/data/`。`ui/form-autosave.js` 管理设置、网络额度、总额度与代理表单的字段校验、保存状态、重试、保留期清理及草稿放弃；它通过回调调用现有宿主和数据接口，页面入口负责确认窗口及刷新界面。新增业务应按职责进入对应模块，并直接测试模块接口。

Node 业务进程用 `host/backend.cjs` 拉起后端并按 id 配对请求与响应，事件（`live`、`usage`、`alert`）单独推送；后端失败以 `{ ok: false, error }` 形式回给页面，保留错误码与消息。历史、额度和网络设置以 C++ 后端为准。

`host/desktop-runtime.cjs` 显式接收 `tauri/native-adapter.cjs` 提供的桌面能力，`host/main.cjs` 调用该接口组合业务，不拦截 Node 模块加载，也不依赖 Electron SDK。业务单元测试使用接口替身。开发态界面回归在无头浏览器中加载真实页面及 Tauri 桥接，并运行隔离的 Node 业务宿主；操作系统窗口、托盘和对话框由测试替身处理。真实 WebView、窗口、安装资源和原生采集继续由对应平台的安装包集成测试验证。

页面先完成当前范围查询，再按需读取分钟历史；同范围的并发分钟查询共用请求，晚到的旧请求不会覆盖当前范围。小时导出由后端处理，完整日期可导出旧小时记录，部分时段按分钟边界计算小时合计。自定义范围使用本地日期和时分，完整包含结束分钟。

## C++ 后端

`backend/platform/network_platform.h` 定义平台无关的采集、身份识别与断开控制接口，两个实现：

| 实现 | 计数来源 | 身份来源 | 断开方式 |
| --- | --- | --- | --- |
| `backend/platform/linux/` | `/proc/net/dev` | `nmcli`（只解析与语言环境无关的部分） | `nmcli dev disconnect` + 复核 |
| `backend/platform/win32/` | IP Helper `GetIfTable2` | WLAN API `WlanQueryInterface` | `WlanDisconnect` + 轮询复核 |

接口只报告事实与类型化失败，不生成界面文案；读取计数前后各确认一次身份，期间切换网络则丢弃样本；断开先判定、再执行、最后复核，只在关联到期望网络时才动手。

Windows 的实现分成两层，这是它可测试的关键：

```text
platform/win32/      只做系统调用与字段搬运（WlanOpenHandle、GetIfTable2、WlanDisconnect）
platform/windows/    采样与断开的判断逻辑，通过 SystemApi 依赖注入，不调用任何 Win32 API
```

采样期间切换网络时丢弃样本、等待异步断开结果、区分未关联状态等判断，可以在 Linux 开发机上验证；`platform/win32/` 负责系统调用。身份字段（UTF-16 → UTF-8、代理对、非法字节）与计数器转换同样在 `platform/windows/` 里，不依赖 Windows 类型。

`core/` 实现与平台无关的业务规则：字节格式转换、本地日历键、网络键映射、用量累计与额度。计数回落、身份变化或网卡从完整报告中消失时，丢弃累计基线并上报类型化事件，避免把无法归属的流量记到错误的网络。

`storage/` 用 SQLite 增量保存每日、小时、分钟及应用用量，并存储网络、额度账本和偏好。schema 6 新增 `minute_usage`、`app_minute_usage`，旧数据保留已有精度；采样跨分钟时按时间分配字节并保持总量不变。分钟记录纳入完整备份、恢复、清空、删除网络及保留策略。`coverage_gaps` 单独记录缺失区间，界面将其与真实零流量区分。Linux 用系统 `libsqlite3`，Windows（含交叉编译）用 `backend/third_party/sqlite` 的合并源码。

`ipc/` 是协议与事件循环：请求 `{id, method, params}`、响应 `{id, ok, result|error}`、事件 `{event, ...}`。输入输出循环按平台选择——POSIX 用 `poll` 同时等待标准输入与采样定时器，Windows 用 `WaitForSingleObject` 等待管道句柄——协议与业务逻辑完全共用。

## 职责边界

| 模块 | 职责 |
| --- | --- |
| 页面 | 展示、输入、筛选、交互状态 |
| Tauri / Rust | 系统 WebView、窗口、托盘、对话框、受限 IPC |
| Node 辅助进程 | 后端进程管理、迁移、更新、文件读写、系统设置与流量控制 |
| C++ 后端 | 真实采集、累计、额度判断、业务存储 |
| 平台适配 | 隔离 Windows/Linux 系统 API |
| contracts | 描述前后端需要共享的数据与协议约定 |
| packaging | 按系统组装安装包 |

只有实际出现平台差异时才在宿主或后端中增加平台适配代码。

## 构建与旧版隔离

根目录 npm 命令转发到桌面应用，锁文件与依赖保留在应用目录。

- **Linux 源码构建**：`npm run dist:linux` 使用本机工具链构建采集器与 Tauri，生成 deb、rpm、AppImage。
- **Windows（本机）**：`npm run dist:windows` 用本机 CMake 构建后端，准备 Node、原生控制模块和页面，再由 Tauri CLI 构建 NSIS 安装包，输出到 `dist/windows/`。
- **页面回归**：`npm run test:ui` 使用无头浏览器；当前源码、依赖与构建入口均不需要 Electron 运行时。

C++ 中间产物位于根目录 `build/`（Linux 在 `build/`，Windows 在 `build/windows/`），安装包随包分发对应的 `wifimeter-backend` 可执行文件。Windows 使用独立的应用标识与数据目录，不读取 Linux 的运行组件路径。

两个平台的产品名统一为 `WiFiMeter`：Windows 沿用应用标识 `io.wifimeter.demo`
与数据目录 `%APPDATA%\WiFiMeter Demo`；Linux 使用 `WiFiMeter` 与标准的 XDG 目录。
身份定义集中在 `apps/desktop/host/product.cjs` 并有单元测试；显示名称更新时保留
Windows 的原有应用标识与数据路径，使升级后仍能读取已有记录。

Electron 1.2.x 用户通过下载对应系统和 CPU 架构的 Tauri 安装版完成迁移；Tauri 后续更新只选择对应的 Tauri 安装包。

Windows 宿主在启动 Node 和后端之前持有 Electron 使用的 `lockfile`，锁的范围为用户数据目录。新旧版本不能同时使用同一目录采集，进程退出后由系统释放锁；WebView2 的缓存保存在该目录下独立的 `webview2` 子目录。

`.github/workflows/tauri.yml` 负责当前五个平台目标的 Tauri 构建、测试和 `v1.3.*` 标签发布。开发态页面回归在 Windows 与 Linux 的独立任务中分片并行执行，打包任务无需先等待完整页面回归；汇总和发布同时要求两类检查成功。`legacy-powershell.yml` 用于保留的旧 PowerShell 版本。正式 CI 使用固定版本的官方 Node.js 运行时，复用已验证的编译缓存和同一提交的发布产物。各流程的范围见[构建与发布矩阵](PACKAGING-MATRIX.md)。
