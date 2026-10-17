# 代理身份与历史归属

[English](PROXY_ATTRIBUTION.md) | 简体中文

本合约将代理身份证据、按连接权重估算的历史与[回环实时实测](APP_TRAFFIC.zh-CN.md)分开。连接数不能变成历史实测字节，估算也不增加网卡总量。

## 代理身份证据

普通后端可通过 `GetExtendedTcpTable` 获取监听 PID，但 `QueryFullProcessImageName` 可能无法读取路径。`detectedClients` 在内部保留 `proxyProcessId`。补全身份只使用本轮新到达的辅助进程 EStats 快照，必须全部满足：

- 非空 `generation` 且 `loopbackSampledAtMs` 递增。
- 同一快照同时含完整客户端四元组及代理端反向四元组。
- 代理 PID 匹配 TCP 查询结果，进程实例包含创建时间。
- `source=WindowsTcpEStats`，可执行路径和身份已知且一致。

同 PID 创建时间或路径不同、缺少客户端端点、路径未知、来源不符，以及快照重复或倒序时，不补全身份。不缓存跨轮 PID 到路径映射；新代际重新验证当前证据，不复用旧连接身份。

## 历史观测

身份验证后，将真实代理路径和去重连接键按观测日期写入现有表，不以当前客户端权重补写旧日期，不修改 `app_usage`。旧记录缺少所属日期观测时，只能形成 `proxy/unattributed`，不能用今天的连接归属昨天流量。

历史 `proxyEstimatedRecords` 按连接数权重估算，保留 `estimated=true`，与实时实测分开。完整路径是忽略大小写的标识，不得用文件名代替。待分配总量以原生代理数值为准，无法归属的份额明确保留。共用字段由[应用合约](../../../contracts/APPLICATION_TRAFFIC.zh-CN.md)定义。

## 估算更新事件

`live` 可包含 `proxyEstimatedUpdates`：

```json
{"proxyEstimatedUpdates":[{"networkId":"network-key","date":"2026-10-18","proxyAppId":"C:\\proxy.exe","records":[]}]}
```

各 `records` 组包含一个网络、日期及完整代理路径的累计行，字段与 `snapshot.proxyEstimatedRecords` 相同。消费者整组替换，不能作为增量累加，空数组清除匹配组。

后端只重算采样当日应用记录，并与上次发送组比较。原生累计或观测权重变化时发送变化组，首次采样可发送当日全部组，完整历史仍由 `snapshot` 提供。跨日不清空前一日。

替换代理原生行前，消费者分别校验同一网络、日期和代理组的 RX、TX 守恒，保留客户端原生直连行。同一代理的估算与原生行不能同时累计。部分日期和分钟、小时查询不使用每日估算，因为它无法确定短时段归属。

## 现有边界与验证

回环仅实时显示，不映射 Wi-Fi 历史，本合约没有引入独立回环历史账本。客户端本机实测、代理原生流量和估算份额是不同数值，不能直接相加。

使用 `proxy_service_test` 和相关桌面应用、代理测试，验证当前证据、重复及倒序快照、代际变化、缺失路径、同 PID 身份冲突、日期边界、空组替换及 RX/TX 守恒。[测试指南](../../../docs/TESTING.zh-CN.md)维护运行入口和证据边界；来源权限、轮询和事件丢失限制仍见[实时合约](APP_TRAFFIC.zh-CN.md#权限限制与验证)。
