# 数据格式与协议边界

这里记录前后端将共享的约定。当前只有前端演示数据，没有已实现的 C++ 通信协议、请求方法或事件接口。

## 现有快照

当前校验实现位于 `apps/desktop/renderer/data/model.js` 的 `validateSnapshot`，沿用 HTML 演示中的 `version: 1`。

| 字段 | 内容 |
| --- | --- |
| `version`、`source` | 数据版本与来源，当前来源为 `demo` |
| `networks` | 网络标识、SSID、备注、额度与提醒设置 |
| `records` | 按本地日期、网络归档的上传和下载字节数 |
| `hourly` | 小时明细 |
| `appRecords` | 独立的应用示例用量，不与网卡总量相加 |
| `settings` | 显示单位、刷新间隔、保留时长和偏好 |
| `live` | 模拟连接、采集状态、速率和更新时间 |

字节计数采用十进制字符串，JavaScript 累计使用 `BigInt`。日期键采用本地日期 `YYYY-MM-DD`。完整备份附加 `backupType: "wifimeter-ui-demo"`；流量导出使用 `type: "usage-export"`，不是完整备份。

这些是已有数据和文件格式，不表示后端已接受这些字段。后端接入时再明确传输方式、请求编号、方法、错误和事件，以及版本兼容规则；届时添加实际需要的 schemas 和消息示例。

## 待定的接入约定

- 网络身份：`core/network_key.h` 已确定取键策略——优先用连接配置 UUID（跨重启稳定，天然满足 `network.id` 的 `^[-a-zA-Z0-9_]+$`），拿不到时退回 `ssid_` 加 SSID 的 FNV-1a 散列。代价是删除并重建 Wi-Fi 配置会让历史分成两条记录，上层可按 `ssid` 归并显示。
- 记录层：`storage/` 已确定落盘结构（`daily_usage` / `hourly_usage` / `networks` / `quota_ledgers` / `settings` / `coverage_gaps`），账本是当前周期用量的权威来源，跨周期归零而不是从记录重算。仍需在接口层定下来的是：界面查询的粒度（按区间取记录还是取聚合值）、以及备份文件格式。
- 覆盖空档：数据库用 `reason` 记录 `paused` / `offline` / `counter_reset` / `reattributed` / `detached` / `identity_unknown`，这些取值会进入协议，属于对外约定，改动需要兼容处理。
- `live.connections[].since`：Linux 侧目前没有可靠的“本次连接开始时间”来源，可由上层根据身份变化的时间自行记录。
- `live.connections[].adapterAlias`：Linux 侧当前取网卡的厂商与产品名（如 `AICSemi AIC8800DC`），是否再加工成更短的名称待定。
