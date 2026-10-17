# 数据格式与协议边界

[English](README.md) | 简体中文

这里记录前后端共享的数据约定。实际 JSON Lines 通信协议及方法见 `backend/ipc/messages.h`，桌面客户端见 `apps/desktop/renderer/data/backend-client.js`。

## 现有快照

数据校验实现位于 `apps/desktop/renderer/data/model.js` 的 `validateSnapshot`；后端快照沿用 `version: 1`，来源为 `backend`。

| 字段 | 内容 |
| --- | --- |
| `version`、`source` | 数据版本与来源，实际采集来源为 `backend` |
| `networks` | 网络标识、SSID、备注、额度与提醒设置 |
| `records` | 按本地日期、网络归档的上传和下载字节数 |
| `hourly` | 小时明细 |
| `minuteRecords` | 网络分钟用量，包含 `date`、`time`、`hour`、`minute`、`networkId` 和双向字节数 |
| `appMinuteRecords` | 应用分钟用量，在网络分钟字段基础上增加 `appId` 和 `name` |
| `usageRevision` | 本次会话的采样提交序号，以十进制字符串传递 |
| `appRecords` | 从 SQLite 查询的独立应用每日用量，不与网卡总量相加 |
| `appCollection` | `enabled`、`available`、`state` 与错误说明 `detail` |
| `appProcesses` | 最近采样的进程实例、PID、所属网络和下载/上传速率 |
| `appGaps` | 独立于网卡覆盖记录的应用采集缺失区间 |
| `settings` | 显示单位、刷新间隔、保留时长和偏好 |
| `live` | 本机连接、采集状态、速率和更新时间 |

字节计数采用十进制字符串，JavaScript 累计使用 `BigInt`。日期键采用本地日期 `YYYY-MM-DD`。
流量导出使用 `type: "usage-export"`，不属于完整备份；`wifimeter-ui-demo` 仅用于旧的演示测试夹具。

应用记录格式为 `{networkId, date, appId, name, rxBytes, txBytes}`。`appId` 是稳定应用标识，不能用 PID 作为历史标识。
`snapshot` 使用 `networkKey`、`from`、`to` 查询相应应用记录。完整后端备份标记为 `backupType: "wifimeter-backend-backup"`，
包含 `appRecords`；恢复接受缺少该字段的旧版备份，但拒绝无效日期、未知网络、无效字节与重复的应用每日记录。
Linux 原生采集接入 eBPF，Windows 接入 ETW；不会把网卡总量按比例分摊给应用。

## 应用采集链路

应用采集使用会话级状态，并单独统计。采集源、采样和持久化规则见[应用采集契约](APPLICATION_TRAFFIC.zh-CN.md#应用采集链路)。

## 代理客户端与应用详情

身份可用性、实测速率、应用匹配和每日归属限制见[代理与应用详情契约](APPLICATION_TRAFFIC.zh-CN.md#代理客户端与应用详情)。

## 数据与平台约定

- 网络身份：`core/network_key.h` 已确定取键策略——优先用连接配置 UUID（跨重启稳定，天然满足 `network.id` 的 `^[-a-zA-Z0-9_]+$`），拿不到时退回 `ssid_` 加 SSID 的 FNV-1a 散列。代价是删除并重建 Wi-Fi 配置会让历史分成两条记录，上层可按 `ssid` 归并显示。
- 记录层：`storage/` 增量保存日、小时、分钟与应用记录，账本是当前周期用量的权威来源，跨周期归零，不根据记录重算。`snapshot` 按日期和网络范围查询，分钟查询按需启用；完整备份标记为 `wifimeter-backend-backup`，与用量导出分开。具体查询与备份字段见下文和[迁移与恢复](../docs/MIGRATION.zh-CN.md)。
- 覆盖空档：数据库用 `reason` 记录 `paused` / `offline` / `counter_reset` / `reattributed` / `detached` / `identity_unknown`，这些取值会进入协议，属于对外约定，改动需要兼容处理。
- `live.connections[].since`：后端记录首次观察到当前连接的时间，不能将它当作系统报告的实际连接开始时间。
- `live.connections[].adapterAlias`：Linux 侧取网卡的厂商与产品名，取不到时回退到内核接口名。

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

## 分钟查询

数据库结构版本 6 新增 `minute_usage` 和 `app_minute_usage`，升级不会把已有每日或小时记录分配到分钟。分钟统计从升级后的实际采集开始。跨分钟采样按各分钟覆盖的秒数分配，整数余数保留到后续分钟，所有分钟之和等于原采样增量；新增采样的每日、小时、分钟统计使用同一分配结果，已有每日与小时记录保持原值。

`snapshot` 和 `exportUsage` 可传 `fromTime`、`toTime`，格式为 `HH:mm`，默认分别为 `00:00`、`23:59`。跨日期查询只裁剪起始日与结束日，结束分钟整体包含。部分日期区间的 `records` 与 `appRecords` 按真实分钟数据汇总；完整日期区间继续返回原每日统计。`exportUsage` 的 `grouping` 可为 `minute`、`hour` 或默认的 `day`，分组明细位于 `records`，分钟明细同时位于 `minuteRecords`。

`usage` 与 `appUsage` 事件新增 `minuteRecords` 和 `usageRevision`，应用事件中的分钟行包含应用字段。同一轮采样的两个事件共用序号。采样与请求在同一服务线程执行，快照读取不会插入到网络与应用提交之间；客户端只重放序号大于快照序号的后续增量。完整备份包含两类分钟数据，恢复也接受缺少分钟字段的旧备份。保留期裁剪、清空和删除网络同步处理分钟记录。

为避免日、月、全部统计自动读取大量应用分钟行，`snapshot` 默认不读取分钟表，返回空分钟数组及 `minuteRecordsIncluded: false`。需要分钟图表或明细时传 `includeMinutes: true`；带有 `fromTime` 或 `toTime` 的查询自动读取分钟，返回 `minuteRecordsIncluded: true`。分钟增量事件始终包含真实分钟行。默认每日导出也不读取分钟表。
