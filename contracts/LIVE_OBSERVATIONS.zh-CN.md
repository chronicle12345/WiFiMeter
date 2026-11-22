# 实时速率与控制器观测

[English](LIVE_OBSERVATIONS.md) | 简体中文

本文展开[数据契约](README.zh-CN.md)中的实时观测字段。

## 采样与图表

`settings.interval` 支持 0.25..3600 秒，最多三位小数，兼容原有整数设置和备份。原生采样、速率和分钟分配使用实际毫秒跨度，`live.updatedAt` 包含毫秒。连接缺少有效区间时，`measurementAvailable` 为 false，速率为 null；实际观测到零速率时仍返回十进制零。

页面的最近五分钟缓存只包含本次会话样本，按速率积分的用量会标记为估算，不写成原生用量。缺失样本和网卡集合变化会中断连续性。页面可见时，滚动窗口至少每秒检查并移除过期样本，即使原生采样间隔更长也会持续更新。窗口偏好 `chartStyle` 可选 `line` 或 `bar`。

已完成的覆盖缺失区间在内部保留毫秒边界，存储时将起点向下、终点向上取整到秒。因此不足一秒的已完成空档也有明确终点，覆盖时长至少一秒。网络、原因、详情和范围相同的已关闭空档若重叠或相邻，会合并为区间并集，避免取整后重复计算相同秒数。尚未完成的空档继续明确保持开放，直到关闭。字节分配独立保留毫秒精度，不随覆盖显示取整。

## 控制器通道与记录

主窗口通过独立桌面通道 `connections:status`、`connections:read`、`connections:configure`、`connections:refresh` 和 `connections:clear` 读取本机 Clash / Mihomo 控制器的会话观测。宿主读取 `/connections` 和 `/proxies`，不提供修改控制器的接口。状态仅返回 `hasSecret`，不返回密钥。

查询增加 `records`、`total`、`active`、`matched` 和 `applications`，支持 `id`、`search`、`application`、`route`、`state` 筛选及 1..5000 条上限。可选的 `id` 用于查询一条保留的连接记录；不传其他筛选条件时，查询不受页面筛选影响。应用标识保留程序完整路径身份，Windows 路径按不区分大小写的规则规范化。

每条记录包含 `id`、目标域名/IP/端口、来源 IP/端口、`network`、`type`、`process`、`processPath`、`chains`、`rule` 和 `rulePayload`。`uploadBytes` 与 `downloadBytes` 为精确非负十进制字符串或 null；速率为非负数值或 null，`measurementAvailable` 表示是否具备连续有效的计数证据。观测时间包括 `start`、`firstSeen`、`lastSeen` 和 `end`。

`route` 为 `direct`、`proxy`、`blocked` 或 `unknown`，根据最终出站和当前类型证据分类。`active` 表示当前观测状态。`endReason: closed` 表示完整快照已不包含该连接；`disconnected`、`configured`、`disabled` 和 `unobserved` 表示观测中断。

这些数据不更新原生快照、流量账本、额度和备份。配置、凭据及观测范围由[连接监听](../docs/CONNECTION_MONITORING.zh-CN.md)维护。
