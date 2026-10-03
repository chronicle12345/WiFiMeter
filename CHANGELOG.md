# Changelog / 更新日志

Released changes are listed by release. Unreleased describes source changes that are not part of a published version yet.

已发布内容按版本记录。Unreleased 记录当前源码中尚未发布的改动。

## Unreleased

### English

- Settings > Data & storage can move the SQLite database to another folder. Switching stops the collector, copies the current `wifimeter.db` (including an unmerged `-wal` file) into the selected folder, verifies the copy, records the new location in `data-location.json` inside the default profile directory and keeps the original database file. A database already in the target folder is never overwritten: use it as the new data, or archive it as `wifimeter.db.replaced-<UTC timestamp>` before replacing it. Window preferences, migration backups, update downloads and WebView data stay in the default profile directory.
- A failed switch removes the partial copy, restores an archived target database and keeps collecting from the previous database. When a custom folder cannot be created or written at startup, the app asks whether to choose another folder, use the default location for that run, or leave the setting unchanged. Using the default for one run does not change the saved location.

### 简体中文

- 「设置 → 数据与存储」可把 SQLite 数据库移到其他文件夹。切换时先停止采集器，把当前 `wifimeter.db`（含尚未合并的 `-wal`）复制到所选文件夹，校验通过后在默认配置目录的 `data-location.json` 记录新位置，并保留原数据库文件。目标文件夹已有数据库时不会覆盖：可以选择使用该数据库，或先把它归档为 `wifimeter.db.replaced-<UTC 时间戳>` 再替换。窗口偏好、迁移备份、更新下载和 WebView 数据仍留在默认配置目录。
- 切换失败会删除半成品副本、还原已归档的目标数据库，并继续使用原数据库采集。自定义文件夹在启动时无法创建或写入时，程序会询问重新选择文件夹、本次运行使用默认位置，或保持设置不变。本次运行使用默认位置不会改动已保存的位置。

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

[1.2.2]: https://github.com/chronicle12345/WiFiMeter/releases/tag/v1.2.2
