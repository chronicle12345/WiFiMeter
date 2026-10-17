# 项目架构

[English](ARCHITECTURE.md) | 简体中文

共享桌面应用位于 `apps/desktop/`，Windows 与 Linux 共用页面和宿主。Tauri/Rust 提供系统 WebView 与桌面能力，Node 运行业务模块，本机 C++ 后端负责原生采集和业务存储。当前目标见 [CI 与发布矩阵](PACKAGING-MATRIX.zh-CN.md)。

## 当前数据流

```text
renderer/app.js → data/backend-client.js → tauri/bridge.js → Rust → Node → wifimeter-backend (JSON Lines)
       └──────────────────────────────────→ data/model.js
renderer → tauri/bridge.js → Rust → dialogs, windows, tray, notifications
                                → Node → autostart, migration, file I/O, updates, traffic control
```

`renderer/app.js` 负责组合导航、显示和事件。可复用输入与显示放在 `renderer/ui/`，查询和计算放在 `renderer/data/`。`ui/form-autosave.js` 通过回调管理校验、保存状态、重试、保留期清理和草稿放弃，入口负责确认和刷新。`tests/fixtures/snapshot.js` 的虚构快照不进入正式资源。

`ui/application-workspace.js` 和 `ui/application-table.js` 共用视图控件与五列表格。应用页初始为实时视图，网络抽屉初始为历史视图，各视图分别保留搜索、排序和来源选择。实时使用速度单位，历史使用字节单位。缺少测量时显示横线，标识区分实测或不可测速率、原生记录和估算；两个视图共用应用抽屉和控制。

`data/proxy-live.mjs::proxyLiveProcesses` 经 `data/application-view.js` 与悬浮窗调用，按当前客户端 TCP 连接数分配已识别代理的物理网络实测速率。客户端直连行保留，估算份额带标记，已归属代理速率被替换，合计只计算一次；未知客户端和未分配份额作为估算未归属。身份、权重或测量不足时保留原生值或不可用状态，不改变网卡计数、额度和存储记录。应用页和网络抽屉分别保留本次会话的实时选择，重启后回到原生采集。悬浮窗将 `miniIncludeProxyEstimates` 与代理排除偏好分开保存，累计用量读取真实分钟记录。

`data/history.js` 归并应用，`data/application-view.js` 每次显示计算列表、搜索前总量和导出状态。`ui/app-icons.js` 共用请求、限制并发，并丢弃没有连接且标识匹配头像的排队请求。`data/application-proxy.js` 只匹配已知应用、代理标识和路径，不根据显示名猜身份。历史估算仅在同一网络、日期、代理的下载和上传合计分别匹配原生值时替换代理行；客户端直连保留，部分日期及分钟、小时明细不显示每日估算。本地 TCP 速率与历史字节、网卡总量和额度分别处理，字段见[数据合约](../contracts/README.zh-CN.md)。

代理详情仅检查候选组，按历史版本、来源数组、身份和范围缓存一个结果。快照、应用增量、估算替换、清空和代理配置保存递增版本，速度事件不递增；当前客户端和测量可用状态重新读取。关闭抽屉释放历史引用；没有版本的调用者不缓存，因为其数组可能就地修改。

Node 的 `host/backend.cjs` 启动后端，按请求 id 配对响应，事件单独推送。错误以 `{ ok: false, error }` 回到页面并保留错误码和消息。历史、额度和网络设置以 C++ 为准。`host/desktop-runtime.cjs` 接收 `tauri/native-adapter.cjs` 能力，`host/main.cjs` 组合业务，不拦截模块加载或使用 Electron SDK。浏览器测试运行真实页面、桥接和隔离 Node 宿主，系统能力使用替身；原生宿主另行验证。

`window-preferences.json` 中的 `promptAppCollection` 默认 `true`。启动和迁移成功、主窗口显示后询问本次采集，只有同意才发送 `setAppCollection({ enabled: true })` 并允许辅助进程请求授权。拒绝任一询问后保持关闭，不再自动尝试，网卡统计继续。采集不可用或迁移失败时跳过询问。关闭偏好后不再询问，手动控制不改变偏好；后端开关每次会话默认关闭。

`host/updates.cjs` 区分 `updates:check`、`updates:download` 和 `updates:install`。检查只读官方元数据并选择匹配附件，启动检查仅通知。确认下载后校验长度与 SHA-256，复用完整缓存并停在 `downloaded`，不停止采集。安装另行确认，先再次验证缓存，再保存设置与数据库、正常停止并交接安装器；暂缓保留文件。异步等待设置确认后，宿主在停止采集前重新检查导入、退出和恢复状态。

页面先完成当前范围查询，再按需读取分钟数据。同范围分钟请求共用，旧响应不覆盖新范围。完整日期的小时导出可用旧小时记录，部分时段按分钟边界汇总。本地范围完整包含结束分钟。初始化失败后刷新重新握手并恢复订阅，握手期间所选日期继续生效。

## C++ 后端

`backend/platform/network_platform.h` 定义平台无关的采集、身份和断开接口：

| 实现 | 计数 | 身份 | 断开 |
| --- | --- | --- | --- |
| `backend/platform/linux/` | `/proc/net/dev` | 与语言无关的 `nmcli` 输出 | `nmcli dev disconnect` 后复核 |
| `backend/platform/win32/` | IP Helper `GetIfTable2` | WLAN `WlanQueryInterface` | `WlanDisconnect` 后轮询 |

适配层报告事实与类型化失败，不生成界面文字。读计数前后检查身份，跨切换样本丢弃；断开要求关联到预期网络，执行后再验证。Windows 将系统调用与可测试判断分开：

```text
platform/win32/      Win32 system calls and field transfer
platform/windows/   Sampling/disconnect decisions through injected SystemApi; UTF-16/UTF-8 and counter conversion
```

`core/` 负责字节格式、本地日期与网络键、累计和额度。首个样本、计数回退、身份变化或确认网卡消失时重建基线；身份短暂不可读时保留有限时长。无法归属的流量丢弃并报告类型化缺失事件。额度账本独立于历史汇总。字节接口使用十进制字符串和 JavaScript `BigInt`，SQLite 写入拒绝超出有符号 64 位范围的数值。

`storage/` 增量保存每日、小时、分钟、应用记录、网络、额度账本和偏好。schema 6 增加 `minute_usage` 与 `app_minute_usage`，旧记录保留原精度。按时间分配分钟字节时保留样本总量，备份、恢复、清空、删除网络及保留期清理都处理分钟数据。`coverage_gaps` 区分缺失和真实零。Linux 用系统 SQLite，Windows 用随源码提供的合并版本。

网络用量写入失败时，只在内存保留一批带原时间和归属的数据，新采样前先重试，不无限排队。成功清空或恢复后丢弃该批次；导入、保留期清理和正常退出前必须写入。强制终止可能丢失待写批次。缺失查询按本地日期边界覆盖保留期内历史。

`ipc/` 使用 `{id, method, params}` 请求、`{id, ok, result|error}` 响应和 `{event, ...}` 事件。POSIX 通过 `poll` 等待，Windows 使用 `WaitForSingleObject`。采集使用本机管道，不主动联网。Node 显式传入数据库路径，启动失败或异常退出保留错误并触发恢复。联网用于更新信息、下载安装包、用户打开版本页和安装缺失 WebView2。协议及导入保证由[数据合约](../contracts/README.zh-CN.md)与[迁移说明](MIGRATION.zh-CN.md)维护。

## 职责边界

| 模块 | 职责 |
| --- | --- |
| 页面 | 显示、输入、筛选、交互状态 |
| Tauri / Rust | 系统 WebView、窗口、托盘、对话框、受限 IPC |
| Node 业务宿主 | 进程、迁移、更新、文件、系统设置、网络控制 |
| C++ 后端 | 原生采集、统计、额度、业务存储 |
| 平台适配 | 隔离 Windows/Linux API |
| contracts | 共用字段和协议约定 |
| packaging | 组装目标安装包 |

只在实际存在平台差异时增加平台适配。

## 构建目录与兼容性

根 npm 命令提供入口，桌面依赖和锁文件留在 `apps/desktop/`。后端在 Linux 使用 `build/`，Windows 使用 `build/windows/`。安装包包含匹配后端，Windows 不读取 Linux 运行时路径。

产品身份集中在 `apps/desktop/host/product.cjs` 并接受测试。两个平台都使用 `WiFiMeter`。修改显示名称时保留 Windows 标识 `io.wifimeter.demo` 和 `%APPDATA%\WiFiMeter Demo`，Linux 用标准 XDG 目录。启动 Node 和后端前，Windows 持有与 Electron 兼容且限定用户数据目录的 `lockfile`，防止同时采集；退出后由系统释放。WebView2 使用独立 `webview2` 子目录。旧版恢复由[迁移说明](MIGRATION.zh-CN.md)维护。

构建命令见[打包说明](../packaging/README.zh-CN.md)，验证和证据见[测试指南](TESTING.zh-CN.md)，目标和发布见 [CI 矩阵](PACKAGING-MATRIX.zh-CN.md)。规则与决策记录遵循[开发流程](DEVELOPMENT.zh-CN.md)，翻译维护遵循[双语文档](i18n/README.zh-CN.md)。
