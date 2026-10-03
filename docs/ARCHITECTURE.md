# 项目架构

桌面应用位于 `apps/desktop/`：同一套页面通过 Tauri 宿主面向 Windows/Linux，真实网络采集与业务存储由本机 C++ 后端负责。开发、测试与发布入口均已切换到 Tauri；原有页面和数据目录保留。

## 当前数据流

```text
renderer/app.js → data/backend-client.js → Tauri bridge → Rust 宿主 → wifimeter-backend（子进程，按行 JSON）
       └──────────────────────────────────→ data/model.js（校验与计算）
页面 → Tauri bridge → Rust 宿主 → 系统文件对话框
                                 → 开机启动、托盘、系统通知
```

`client.js` 是页面创建数据对象的唯一入口：有桌面桥时用 `backend-client.js`，没有时（例如浏览器里跑单元测试）退回 `mock.js`。数据定义与计算放在 `model.js`。

Rust 宿主用 `src-tauri/src/collection/backend.rs` 拉起后端并按 id 配对请求与响应，事件（`live`、`usage`、`alert`）单独推送；后端的失败以 `{ ok: false, error }` 形式回给页面，而不是抛异常，因为跨进程只保留错误消息、会丢掉页面用来决定文案的错误码。历史、额度和网络设置以 C++ 后端为准。

数据库默认位于配置目录，也可由用户在「设置 → 数据与存储」中改到其他文件夹。`src-tauri/src/data_location.rs` 在默认配置目录维护 `data-location.json` 指针，负责校验目标目录、复制数据库（含 `-wal`）、校验复制结果并归档同名文件；`Collector::relocate_database` 在一次写锁内完成「暂停 → 停止后端 → 换 `--db` → 复制并写指针 → 恢复采集」，失败则退回原路径与采集状态。后端只在启动参数上看到不同的 `--db`，协议与数据库 schema 不变；窗口偏好、迁移备份、更新下载和 WebView 数据始终留在默认配置目录。

## 桌面目录

`renderer/host/` 提供桌面桥接与统一弹窗，`renderer/mini/` 是浮窗页面，与主页面共用 `renderer/shared/` 的样式。`scripts/` 放前端构建，`tests/e2e/` 驱动真实系统 WebView，`tests/support/` 提供后端夹具。构建输出位于 `apps/desktop/dist/tauri/`，不混入源代码目录。

## Rust 宿主

`apps/desktop/src-tauri/` 保持 Tauri 标准工程入口，`src/` 按职责组织：

| 目录 | 职责 |
| --- | --- |
| `collection/` | 后端协议客户端、采集会话和旧数据迁移 |
| `update/` | 发布版本判断、校验下载与安装状态流程 |
| `desktop/` | Tauri IPC、主窗口、浮窗、托盘和宿主弹窗 |
| `platform/windows/` | 注册表自启动、Shell 图标、网络控制及安装交接 |
| `platform/linux/` | XDG 自启动和 GTK 桌面能力 |
| `lib.rs` 及共用模块 | 对外接口、偏好、文件操作和平台无关规则 |

业务规则不依赖 WebView；桌面模块按 `desktop-shell` 特性编译，平台实现通过 `cfg` 选择。根模块保留已有导出接口，避免目录变动影响调用方和行为测试。

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

因此“采样期间换网要丢弃样本”“断开异步生效要轮询到超时”“未关联不算失败”等判断在 Linux
开发机上就能验证；`platform/win32/` 只剩机械代码。身份字段（UTF-16 → UTF-8、代理对、非法字节）
与计数器转换同样在 `platform/windows/` 里，不依赖 Windows 类型。

`core/` 实现与平台无关的业务规则：字节格式转换、本地日历键、网络键映射、用量累计与额度。用量累计的重点是决定“基线何时失效”——计数回落、身份变化、网卡从完整报告中消失都丢弃基线并上报类型化事件，避免把无法归属的流量记到错误的网络。

`storage/` 用 SQLite 落盘：采集每几秒写一次，只做增量累加而不是重写整份历史；每日用量、小时明细、网络与额度账本、偏好设置各一张表，另有一张 `coverage_gaps` 记录“没有采集到数据的区间”，让界面能兑现“缺失记录不会伪装成零流量”。Linux 用系统 `libsqlite3`，Windows（含交叉编译）用 `backend/third_party/sqlite` 的合并源码。

`ipc/` 是协议与事件循环：请求 `{id, method, params}`、响应 `{id, ok, result|error}`、事件 `{event, ...}`。输入输出循环按平台选择——POSIX 用 `poll` 同时等待标准输入与采样定时器，Windows 用 `WaitForSingleObject` 等待管道句柄——协议与业务逻辑完全共用。

## 职责边界

| 模块 | 职责 |
| --- | --- |
| 页面 | 展示、输入、筛选、交互状态 |
| Tauri 宿主 | 窗口、桌面能力、文件对话框、后端进程管理 |
| C++ 后端 | 真实采集、累计、额度判断、业务存储 |
| 平台适配 | 隔离 Windows/Linux 系统 API |
| contracts | 描述前后端需要共享的数据与协议约定 |
| packaging | 按系统组装安装包 |

只有实际出现平台差异时才在宿主或后端中增加平台适配代码。

## 构建与旧版隔离

根目录 npm 命令转发到桌面应用，锁文件与依赖保留在应用目录。

三个发布入口 `packaging/build-windows.sh`、`build-linux.sh`、`build-all.sh` 均在 Linux 中运行，复用 `packaging/tauri.cjs`。Windows 使用 Zig 构建 C++ 后端、MinGW 构建 Rust，再由 NSIS 生成安装器；Linux 构建本机采集器及 Tauri 宿主，再组装安装包。具体依赖与输出见 [打包说明](../packaging/README.md)。

C++ 中间产物位于根目录 `build/`（Linux 在 `build/`，Windows 在 `build/windows/`），安装包随包分发对应的 `wifimeter-backend` 可执行文件。Windows 使用独立的应用标识与数据目录，不读取 Linux 的运行组件路径。

两个平台的产品名统一为 `WiFiMeter`：Windows 沿用应用标识 `io.wifimeter.demo`
与数据目录 `%APPDATA%\WiFiMeter Demo`；Linux 使用 `WiFiMeter` 与标准的 XDG 目录。
身份定义集中在 `apps/desktop/src-tauri/src/identity.rs` 并有单元测试；显示名称更新时保留
Windows 的原有应用标识与数据路径，使升级后仍能读取已有记录。

发布打包不修改用户数据。运行时保留原有数据目录和升级兼容逻辑；测试使用独立配置目录。桌面、采集器和打包工具分别验证，CI 入口位于 `.github/workflows/`，可复用脚本位于 `.github/scripts/`。
