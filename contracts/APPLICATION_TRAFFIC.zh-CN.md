# 应用流量采集与代理归属

[English](APPLICATION_TRAFFIC.md) | 简体中文

本参考文档展开[数据格式与协议边界](README.zh-CN.md)中的应用流量契约。

## 应用采集链路

`setAppCollection` 接受 `{enabled: boolean}`。启用仅在当前后端会话生效，重启后默认关闭；没有采集源时返回 `unavailable`。
状态包括 `disabled`、`starting`、`running`、`paused`、`permission`、`unavailable`、`partial`。
全局 `setPaused` 同时暂停应用采集，恢复时建立新基线；停止应用采集保留已有历史。

`live` 事件携带 `appCollection` 和 `appProcesses`；独立的 `appUsage` 事件携带每日增量 `records` 和新增缺失 `gaps`。
应用增量不更新网卡总量或额度账本。数据库结构版本 3 为 `coverage_gaps` 增加 `scope`，旧记录迁移为 `network`，应用记录使用 `apps`。

采集源输出 `{state, generation, detail, samples}`，每个 sample 包含 `{interfaceId, appId, name, instanceId, processId, rxBytes, txBytes, active}`。
字节计数从同一个 generation 开始累计；首份快照只建基线，新进程实例随后从零计入。
`instanceId` 区分 PID 重用，`appId` 用于跨进程归并；已退出进程设 `active: false`，累计计数保留到确认保存成功。
接口的 Wi-Fi 身份变化或不明时丢弃边界区间，计数重置、源重启和权限失败留下独立的缺失记录。

Windows helper 报告可选声明 `retirementSupported: true`。应用事务提交成功后，后端通过 `acknowledge <report JSON>` 确认已保存的非活动 ETW 样本。helper 只回收确认的字节，晚到增量继续进入按应用和接口归并的独立累计流，实例标识以 `retired:` 开头。后端保留原实例基线，直到后续支持回收的报告确认它已消失。旧 helper 不声明能力，不接收确认命令，继续保留原有累计行为。应用事务失败后保留原报告、网络归属和时间，重试提交成功前不发送确认。
测试使用 `--fake-apps <JSON 文件>` 或 `WIFIMETER_FAKE_APPS`，与真实进程、IPC 和数据库配合运行。
Linux 原生源仅在构建辅助进程时可用，仍默认不采集；统计口径与授权验证见 [Linux 应用采集](../docs/LINUX_APP_CAPTURE.zh-CN.md)。
Windows 原生源也默认不采集，通过专用管道连接授权辅助进程；详见 [Windows 应用采集](../docs/WINDOWS_APP_CAPTURE.zh-CN.md)。

## 代理客户端与应用详情

`proxy.clients` 报告当前观测到的本地代理连接。每项包含 `appId`、`name`、`proxyAppId`、`proxyName`、`connections`、`pathAvailable` 和 `measurementAvailable`，可测量时同时提供字节计数与速率。连接归属已知时，`proxyAppId` 保存观测到的代理应用标识；仅检测到客户端且代理路径不可用时，该字段为空字符串，`pathAvailable` 为 `false`。显示名称不能作为身份依据，也不能用于推断缺失标识。身份是否已知与流量是否可测量分别报告。

本地 TCP 速率来自连接测量，数值单位为字节每秒。`measurementAvailable` 为 false 时，即使仍有旧数值字段，页面也显示横线，避免将不可测量当作零流量。停止或暂停采集后，页面中的代理速率不可用。这些速率与网卡总量、额度账本及已存历史估算分别处理，无法据此还原 UDP/QUIC 流量或精确的客户端历史用量。应用详情根据客户端 `appId` 或明确的 `proxyAppId` 匹配；Windows 路径先统一分隔符，并忽略大小写。

`proxyEstimatedRecords` 保存每日归属记录，字段为 `{networkId, date, proxyAppId, appId, name, rxBytes, txBytes, estimated, unattributed}`。历史归属按观测到的连接权重估算。页面替换原生代理记录前，同一网络、日期和代理标识的下载、上传估算合计必须分别等于原生总量，否则继续显示原生记录；客户端直接记录继续保留。详情沿用所选网络与日期范围，选中具体日期或月份时进一步筛选估算行；部分日期范围及分钟/小时详情不显示每日估算。
