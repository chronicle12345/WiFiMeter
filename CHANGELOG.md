# Changelog / 更新日志

Changes are listed by release.

更新内容按版本记录。

## 1.2.0 — release candidate

Cross-platform integration, legacy JSON migration, complete backups, application controls and history, Ethernet accounting, total Wi-Fi quotas, bilingual UI and multi-architecture packaging. See [release notes](docs/releases/v1.2.0.md). Publication is gated by the complete CI matrix.

跨平台整合、旧 JSON 迁移、完整备份、应用控制与历史、有线统计、总 Wi-Fi 额度、中英界面和多架构打包。详见[发布说明](docs/releases/v1.2.0.md)，完整 CI 矩阵通过后发布。

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
