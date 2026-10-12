# Changelog / 更新日志

Changes are listed by release.

更新内容按版本记录。

## Unreleased / 未发布

- Consolidate Windows startup registration, report synchronization failures and hide collector and test helper consoles. Reuse verified complete update downloads instead of downloading them again.
- Preserve form drafts and failed-save retries, finish retention cleanup after a partial failure, synchronize restored settings and collection gaps, and retain failed database transactions for rollback or retry.
- Preserve directional firewall rules, improve history and proxy refreshes, and reuse network filters and application icon extraction. Move form persistence into a dedicated renderer module.
- Keep native windows hidden throughout background tests and simulate visibility changes for renderer checks. Organize local diagnostics under ignored directories, document module and tag requirements, discover new renderer tests automatically, and reject release tags with outdated README version information. These changes are not included in the published 1.3.2 installers.

- 合并 Windows 重复开机启动登记，显示同步失败原因，隐藏采集器和测试辅助进程控制台；更新重试复用已完整校验的安装包。
- 保留表单草稿和保存失败重试，补齐保留期清理失败后的后续操作，同步恢复的设置与采集缺失区间；数据库提交失败后保留事务以便回滚或重试。
- 保留单向防火墙规则，改进历史与代理数据刷新，复用网络筛选和应用图标提取；表单保存逻辑移入独立页面模块。
- 后台测试全程保持原生窗口隐藏，通过可见状态替身验证页面刷新；本地诊断文件归入忽略目录，补齐模块与标签规范。CI 自动发现新增界面测试，并阻止 README 版本信息过期的标签发布。这些改动尚未包含在已发布的 1.3.2 安装包中。

## [1.3.2]

- Automate Windows update download, length and SHA-256 verification, data saving, silent installation and restart, with progress and failure recovery. Recover matching WiFiMeter installations when an old uninstall entry points to a missing uninstaller.
- Require corresponding Chinese and English release notes, reuse verified five-platform artifacts and compilation caches, and package a pinned official Node.js runtime. See the [release notes](docs/releases/v1.3.2.md) for installation and platform limits.

- Windows 更新自动完成下载、长度与 SHA-256 校验、数据保存、静默安装和重启，显示进度并恢复失败状态；匹配 WiFiMeter 身份的旧卸载记录缺少卸载程序时可继续升级。
- 发布说明必须中英对应，复用五平台已验证产物和编译缓存，随包使用固定版本的官方 Node.js。安装方法和平台限制见[发布说明](docs/releases/v1.3.2.md)。

## [1.3.1]

- Restore the complete Windows x64, x86 and ARM64 and Linux x64 and ARM64 release matrix, providing nine installers after all required checks pass.
- Remove public portable archives and checksum TXT assets while retaining internal SHA-256 verification. Preserve existing features and user data. See the [release notes](docs/releases/v1.3.1.md) for this version's runtime configuration and validation.

- 恢复 Windows x64、x86、ARM64 与 Linux x64、ARM64 完整发布矩阵，全部必要检查通过后公开九个安装包。
- 取消公开便携压缩包和校验 TXT 附件，保留内部 SHA-256 验证，沿用现有功能与用户数据。本版运行时配置和验证结果见[发布说明](docs/releases/v1.3.1.md)。

## [1.3.0] - 2026-10-10

- Migrate the desktop host to Tauri and the system WebView, with Windows x64 as the only release target for this version. Bundle the Node business worker and C++ collector while retaining the existing data directory. Electron 1.2.x users migrate with the Tauri installer from Releases; subsequent Tauri updates select Tauri installers.
- Add custom local times with minute precision, including the ending minute, and network/application minute history, backups and exports. Earlier records retain their original precision. Reload minute records when navigating between pages after a date change.
- Keep core overview metrics in the first screen and place the complete live application ranking in the scrolling area below.
- Allow upload and download limits to be set or removed independently on Windows. Downloads use WinDivert while WiFiMeter runs; upload limits continue to use QoS. Clean up failed native capture and discard stale flow ownership.
- Expand the floating window with per-application live rates and saved usage ranges: the current calendar minute, that minute plus the previous 4 or 59 minutes, or a custom 1–10080 minutes.
- Keep daily, monthly and all-time quotas consistent across midnight, prevent concurrent legacy and Tauri collection of the same profile, and reset exit confirmation after a canceled quit or failed update.

- 桌面宿主迁移到 Tauri 和系统 WebView，本轮发布仅面向 Windows x64。随包提供 Node 业务进程与 C++ 采集器，沿用已有数据目录；Electron 1.2.x 用户从 Releases 下载 Tauri 安装版迁移，后续更新选择 Tauri 安装包。
- 自定义范围支持本地时分并包含结束分钟，网络与应用提供分钟明细并纳入备份和导出，旧数据保留原有精度；切换日期后进入明细页会自动重新加载。
- 总览首屏保留核心指标，完整应用实时排行位于下方滚动区。
- Windows 上传和下载限速可独立设置、取消。下载通过 WinDivert 在 WiFiMeter 运行期间生效，上传继续使用 QoS；修复原生捕获失效后的清理与旧连接归属缓存问题。详见[发布说明](docs/releases/v1.3.0.md)。
- 悬浮窗新增应用实时速度与分钟累计用量，范围自动保存；1 分钟为当前日历分钟，5 分钟、1 小时分别包含当前分钟及之前 4 个、59 个分钟，自定义支持 1 到 10080 分钟。
- 跨午夜采样的日、月和累计额度保持一致；新旧宿主不能同时采集同一数据目录，取消退出或更新失败恢复后重新确认退出。

## [1.2.3] - 2026-10-03

- Fix Windows installer handoff readiness and keep the update helper running after the application exits; report failures by update stage.
- Align the overview network selector with Refresh and Export, expand the network quota card, and clarify comma-separated proxy port entry. See the [release notes](docs/releases/v1.2.3.md) for upgrading from affected older versions.

- 修复 Windows 更新安装交接的就绪通信，确保应用退出后辅助进程仍可运行；按更新阶段显示失败原因。
- 将网络选择器与刷新、导出对齐，扩大网络额度卡片，并明确英文逗号分隔多个代理端口的输入方式。从旧版更新的方法见[发布说明](docs/releases/v1.2.3.md)。

## [1.2.2] - 2026-10-02

- Render update release notes as sanitized Markdown, show download bytes and phase-specific progress, and let the overview trend chart fill the remaining viewport height.
- Resolve Windows proxy identities from fresh, matching helper evidence and replace affected cumulative estimate groups without double counting. Download and upload totals must each match native totals before estimated rows replace native proxy rows.
- Historical attribution remains a connection-weight estimate, not exact per-client history. Original usage and network totals are unchanged; old records without observations cannot be precisely reconstructed. The lightweight PowerShell v1.1.1 edition remains unchanged. See the [release notes](docs/releases/v1.2.2.md) for scope and validation limits.

- 更新说明支持 Markdown 渲染与安全清理，新增下载字节数及分阶段进度，总览趋势图填充视口剩余高度。
- Windows 代理身份通过新鲜且匹配的 helper 证据补全；受影响的累计估算按组替换，避免重复计数。下载和上传分别满足总量守恒后，才用估算行替换代理原始行。
- 历史归属仍按连接权重估算，不代表精确的客户端历史用量。原始用量和网卡总量不改，缺少观测的旧记录无法精确还原。轻量 PowerShell v1.1.1 原版保持不变。统计范围与验证限制见[发布说明](docs/releases/v1.2.2.md)。

## [1.2.1] - 2026-10-02

- Added automatic saving with status and retry feedback, an application drawer and icons, multiple quota thresholds, a compact traffic window and theme selection; refreshed the overview and improved legacy import access and record handling.
- Added live Windows proxy-client TCP EStats measurements and fixed duplicate-snapshot rate calculations using source timestamps. Realtime proxy data covers observed loopback TCP clients only, excludes UDP/QUIC and Wi-Fi totals, and remains separate from historical estimates.
- The lightweight PowerShell v1.1.1 edition remains unchanged. Native validation is platform-dependent; complete administrator-level validation of the updated Windows hybrid ETW/EStats path is still required. See the [release notes](docs/releases/v1.2.1.md) for measurement limits and migration guidance.

- 新增自动保存状态与失败重试、应用抽屉与图标、多阈值额度提醒、流量小窗和主题选择；调整总览，改进旧版导入入口及记录处理。
- Windows 代理客户端新增 TCP EStats 实时测量，按采集源时间戳修复重复快照造成的速率异常。代理实时数据仅覆盖已观测回环 TCP 客户端，不含 UDP/QUIC，不计入 Wi-Fi 总量，并与历史估算分开。
- 轻量 PowerShell v1.1.1 原版保持不变。原生验证需按平台完成；更新后的 Windows ETW/EStats 混合流程仍需完整的管理员权限验收。测量限制与迁移说明见[发布说明](docs/releases/v1.2.1.md)。

## 1.2.0

Cross-platform integration, legacy JSON migration, complete backups, application controls and history, Ethernet accounting, total Wi-Fi quotas, bilingual UI and multi-architecture packaging. See [release notes](docs/releases/v1.2.0.md).

跨平台整合、旧 JSON 迁移、完整备份、应用控制与历史、有线统计、总 Wi-Fi 额度、中英界面和多架构打包。详见[发布说明](docs/releases/v1.2.0.md)。

## [1.1.1] - 2026-10-01

### English

- Replace the Live apps connection-count cards with a TCP speed table showing application download/upload rates and connection counts. Unavailable rates display a dash. Windows TCP EStats is sampled every second with administrator rights, and processes with the same AppId are combined. UDP and QUIC are excluded; loopback and proxy connections are counted independently, and short connections or final bytes before disconnection may be missed.
- Show application network controls when a program is selected, allow the panel to be closed, and preserve the selected application during table refreshes. Keep Refresh and Export CSV together in the overview toolbar.
- Extend application history with a daily or per-application monthly grouping switch over the selected custom date range. Monthly subtotals include only the selected days and keep different application identifiers separate.
- Add application-history CSV export matching the active table, application search, grouping and sort order. Disable export for pending queries, empty results and custom date edits that have not been applied.
- Update the English and Chinese README and user guides. Add release notes reconstructed from the published v1.0.0–v1.1.0 commits, and use version-specific notes files in the release workflow.

### 简体中文

- 将实时应用连接数卡片改为 TCP 网速表格，显示应用下载、上传速度和连接数，不可用速率显示横线。通过 Windows TCP EStats 每秒采样，需要管理员权限，同一 AppId 的进程合并显示。不包含 UDP 和 QUIC；环回及代理各连接独立计数，可能漏掉短连接或断开前的末尾流量。
- 选择程序后显示网络控制，可关闭控制面板，表格刷新时保留应用选择。概览工具栏中的刷新与导出 CSV 放在一起。
- 应用历史增加按具体日期或按应用、月份汇总的切换，沿用所选自定义日期范围。月汇总只包含选中日期，应用标识不同的记录分别统计。
- 新增应用历史 CSV 导出，遵循当前标签页、应用搜索、汇总方式和排序。查询进行中、没有记录或自选日期修改后尚未应用时，禁用导出。
- 更新中英文 README 与使用指南；根据已发布的 v1.0.0 至 v1.1.0 提交补充发布说明，发布流程改用对应版本的说明文件。

See the [complete bilingual release notes](docs/releases/v1.1.1.md).

完整内容见[中英文发布说明](docs/releases/v1.1.1.md)。

## [1.1.0] - 2026-10-01

- Added a refreshed interface, a dedicated Live apps page with connection counts and delayed today usage, and application firewall/upload controls.
- Added wired-network accounting, total Wi-Fi quotas, daily trends, network search, application icons and shared application-history filters.
- Added estimated proxy attribution with port-only setup, fixed IPv6 parsing and virtual-adapter handling, and improved installer shortcuts, diagnostics and release automation.
- Added the MIT license. See the [complete bilingual release notes](docs/releases/v1.1.0.md) for details and usage limits.

- 更新界面，新增显示连接数和延迟当日用量的独立实时应用页，以及应用防火墙控制和上传限速。
- 新增有线网络统计、Wi-Fi 总额度、每日趋势、网络搜索、应用图标和共用的应用历史筛选。
- 新增仅配置端口即可使用的代理归属估算，修复 IPv6 解析和虚拟网卡处理，改进安装快捷方式、诊断日志及发布流程。
- 新增 MIT 许可证。完整功能与使用限制见[中英文发布说明](docs/releases/v1.1.0.md)。

[1.1.1]: https://github.com/chronicle12345/WiFiMeter/releases/tag/v1.1.1
[1.1.0]: https://github.com/chronicle12345/WiFiMeter/releases/tag/v1.1.0

[1.2.1]: https://github.com/chronicle12345/WiFiMeter/releases/tag/v1.2.1

[1.2.3]: https://github.com/chronicle12345/WiFiMeter/releases/tag/v1.2.3
[1.2.2]: https://github.com/chronicle12345/WiFiMeter/releases/tag/v1.2.2
[1.3.0]: docs/releases/v1.3.0.md
[1.3.1]: docs/releases/v1.3.1.md
[1.3.2]: docs/releases/v1.3.2.md
