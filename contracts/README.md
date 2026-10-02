# 数据格式与协议边界

这里记录前后端共享的数据约定。实际 JSON Lines 通信协议及方法见 `backend/ipc/messages.h`，桌面客户端见 `apps/desktop/renderer/data/backend-client.js`。

## 现有快照

数据校验实现位于 `apps/desktop/renderer/data/model.js` 的 `validateSnapshot`；后端快照沿用 `version: 1`，来源为 `backend`。

| 字段 | 内容 |
| --- | --- |
| `version`、`source` | 数据版本与来源，实际采集来源为 `backend` |
| `networks` | 网络标识、SSID、备注、额度与提醒设置 |
| `records` | 按本地日期、网络归档的上传和下载字节数 |
| `hourly` | 小时明细 |
| `appRecords` | 从 SQLite 查询的独立应用每日用量，不与网卡总量相加 |
| `appCollection` | `enabled`、`available`、`state` 与错误说明 `detail` |
| `appProcesses` | 最近采样的进程实例、PID、所属网络和下载/上传速率 |
| `appGaps` | 独立于网卡覆盖记录的应用采集缺失区间 |
| `settings` | 显示单位、刷新间隔、保留时长和偏好 |
| `live` | 本机连接、采集状态、速率和更新时间 |

字节计数采用十进制字符串，JavaScript 累计使用 `BigInt`。日期键采用本地日期 `YYYY-MM-DD`。
流量导出使用 `type: "usage-export"`，不是完整备份；`wifimeter-ui-demo` 仅用于旧的演示测试夹具。

应用记录格式为 `{networkId, date, appId, name, rxBytes, txBytes}`。`appId` 是稳定应用标识，不能用 PID 作为历史标识。
`snapshot` 使用 `networkKey`、`from`、`to` 查询相应应用记录。完整后端备份标记为 `backupType: "wifimeter-backend-backup"`，
包含 `appRecords`；恢复接受缺少该字段的旧版备份，但拒绝无效日期、未知网络、无效字节与重复的应用每日记录。
Linux 原生采集接入 eBPF，Windows 接入 ETW；不会把网卡总量按比例分摊给应用。

## 应用采集链路

`setAppCollection` 接受 `{enabled: boolean}`。启用仅在当前后端会话生效，重启后默认关闭；没有采集源时返回 `unavailable`。
状态包括 `disabled`、`starting`、`running`、`paused`、`permission`、`unavailable`、`partial`。
全局 `setPaused` 同时暂停应用采集，恢复时建立新基线；停止应用采集保留已有历史。

`live` 事件携带 `appCollection` 和 `appProcesses`；独立的 `appUsage` 事件携带每日增量 `records` 和新增缺失 `gaps`。
应用增量不更新网卡总量或额度账本。数据库结构版本 3 为 `coverage_gaps` 增加 `scope`，旧记录迁移为 `network`，应用记录使用 `apps`。

采集源输出 `{state, generation, detail, samples}`，每个 sample 包含 `{interfaceId, appId, name, instanceId, processId, rxBytes, txBytes, active}`。
字节计数从同一个 generation 开始累计；首份快照只建基线，新进程实例随后从零计入。
`instanceId` 区分 PID 重用，`appId` 用于跨进程归并；已退出进程应保留 generation 内的累计计数并设 `active: false`。
接口的 Wi-Fi 身份变化或不明时丢弃边界区间，计数重置、源重启和权限失败留下独立的缺失记录。
测试使用 `--fake-apps <JSON 文件>` 或 `WIFIMETER_FAKE_APPS`，与真实进程、IPC 和数据库配合运行。
Linux 原生源仅在构建辅助进程时可用，仍默认不采集；统计口径与授权验证见 [Linux 应用采集](../docs/LINUX_APP_CAPTURE.md)。
Windows 原生源也默认不采集，通过专用管道连接授权辅助进程；详见 [Windows 应用采集](../docs/WINDOWS_APP_CAPTURE.md)。

## 待定的接入约定

- 网络身份：`core/network_key.h` 已确定取键策略——优先用连接配置 UUID（跨重启稳定，天然满足 `network.id` 的 `^[-a-zA-Z0-9_]+$`），拿不到时退回 `ssid_` 加 SSID 的 FNV-1a 散列。代价是删除并重建 Wi-Fi 配置会让历史分成两条记录，上层可按 `ssid` 归并显示。
- 记录层：`storage/` 已确定落盘结构（`daily_usage` / `hourly_usage` / `networks` / `quota_ledgers` / `settings` / `coverage_gaps`），账本是当前周期用量的权威来源，跨周期归零而不是从记录重算。仍需在接口层定下来的是：界面查询的粒度（按区间取记录还是取聚合值）、以及备份文件格式。
- 覆盖空档：数据库用 `reason` 记录 `paused` / `offline` / `counter_reset` / `reattributed` / `detached` / `identity_unknown`，这些取值会进入协议，属于对外约定，改动需要兼容处理。
- `live.connections[].since`：Linux 侧目前没有可靠的“本次连接开始时间”来源，可由上层根据身份变化的时间自行记录。
- `live.connections[].adapterAlias`：Linux 侧当前取网卡的厂商与产品名（如 `AICSemi AIC8800DC`），是否再加工成更短的名称待定。

## 多档额度提醒

网络设置和总 WiFi 额度设置同时返回 `warnPercents` 与兼容字段 `warnPercent`。
`warnPercents` 为非空数字数组，每项为有限数字且在 1..100 之间，允许小数；后端去重、升序保存。
项数不另设限制，受现有 IPC 请求大小限制。`warnPercent` 返回排序后的首项。
更新同时提供两个字段时使用数组，仅提供旧标量时升级为单元素数组；两者都省略时保留当前设置。
传入的旧标量若存在也必须合法。网络使用 `quotaPeriod`，总额度使用 `period`。

例如 `{ "warnPercents": [90, 50, 75.5, 50] }` 保存后返回
`{ "warnPercents": [50, 75.5, 90], "warnPercent": 50 }`。
网络及总额度每档在同一周期只提醒一次，跨多档时各发一条 `quotaWarn`，事件 `warnPercent` 标识触发档位。
通知档位写入账本 `notifiedWarnPercents`，重启、备份恢复后继续去重，跨周期或清空用量后重新计数。
总额度达到 100% 仍发出原有 `quotaLimit`；100% 提醒档位与额度上限事件是两个独立事件。
新增或删除提醒档位不会清空其他档位的通知记录；总额度上限变化沿用原有通知重置行为。

完整备份保存两种设置字段与账本的 `notifiedWarnPercents`。旧备份及旧版导入的标量自动升级；
旧总额度 `warningNotified: true` 升级为对应单档的通知记录，避免恢复后再次提示同一档。
