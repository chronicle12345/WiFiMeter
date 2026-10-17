# Windows 应用流量合约

[English](APP_TRAFFIC.md) | 简体中文

## 来源与统计

`TcpEStatsCapture` 在原生辅助进程内每秒读取 IPv4/IPv6 回环 TCP，通过进程创建时间和四元组区分连接。首次发现、中断、实例变化和计数回退建立基线，不补算发现前字节。ETW 提供非回环事件并排除回环；ETW 失败而 EStats 可用时，回环继续，以 `partial` 保留 ETW 错误。

原生 IPC 使用 `interfaceId=loopback`，不对应 Wi-Fi `networkId`；`connectionKey` 与代理快照共用地址长度、地址、端口编码。`source` 为 `WindowsEtw` 或 `WindowsTcpEStats`，旧快照缺少此字段仍可解析。回环只用于实时显示，`AppUsageAccumulator` 不将它写入 Wi-Fi `app_usage`，消费者不把它与物理总量或历史估算相加。

`GetIfEntry2` 的 `InOctets` 对应 RX，`OutOctets` 对应 TX。ETW 10/26 发送、11/27 接收，14/30 TCP 重传计入发送，连接和复制事件不增加字节。网卡首次建立基线后记录差值，应用记录和代理估算不增加网卡总量。

## 客户端行

`snapshot.appProcesses` 和 `live.appProcesses` 表示各当前回环端点：

```json
{
  "networkId": "",
  "appId": "C:\\Apps\\client.exe",
  "name": "client.exe",
  "processId": 123,
  "instanceId": "123:processCreationTime:socketGeneration",
  "connectionKey": "9:127.0.0.1:50001>9:127.0.0.1:8080",
  "source": "WindowsTcpEStats",
  "scope": "loopback",
  "measurementAvailable": true,
  "rxBytes": "600",
  "txBytes": "200",
  "rxPerSecond": "300",
  "txPerSecond": "100"
}
```

`rxBytes`/`txBytes` 为本次服务基线后的实测累计，不是应用汇总；速率单位 B/s。差值无效时 `measurementAvailable=false`、速率为 `null`。暂停、清零、重启采集、恢复数据库和代际变化清除基线。连接消失后行消失，不提供关闭后的最终累计行。

Wi-Fi 行保留实际 `networkId`，含 `name`、`source=native`、`scope=wifi`。其他来源不保证具有回环累计字段、`connectionKey` 和 `measurementAvailable`。Wi-Fi 速率也可能按下文规则不可用。

## ETW 回收确认

辅助进程可声明 `retirementSupported=true`。后端仅在应用事务提交后，对保存的非活动 `WindowsEtw` 样本发送 `acknowledge <report JSON>`。辅助进程释放已确认计数，将晚到增量留在独立应用/接口流，以代际内稳定的 `retired:` 标识表示，并限制最近进程身份数量。

旧确认不得回收已经发出的新报告中的 RX 或 TX。确认可重复且按代际隔离；后端保留已确认基线，直到后续支持回收的报告不再包含该实例。旧辅助进程不声明能力，继续保留非活动累计，EStats 生命周期不变。

## 采样时钟与速率失效

报告可选含 JSON 整数 `sampledAtMs`，表示 ETW 快照时间；`loopbackSampledAtMs` 表示 EStats 缓存实际更新时间。两者使用采集端 `GetTickCount64` 单调毫秒，不是 Unix 或日期时间。仅 EStats 工作时相同。缺失或为零时兼容旧格式，使用服务读取时间；同时更新两个二进制才能启用完整来源时钟行为。

同代际重复或倒序时间戳不推进基线。EStats 独立使用 `loopbackSampledAtMs`，新 ETW 报告也可能带旧 EStats 数据。新样本按实际毫秒间隔和字节增量计算 B/s，新零增量返回零。代际变化、暂停、权限或存储失败清除实时速率基线。应用写入失败保留原报告、Wi-Fi 归属和时间，事务成功后才推进统计基线，不需要新增数据库字段。

重复样本暂保留最后有效速率。超过 `max(5 seconds, 2 × intervalSeconds)` 没有新样本后，`measurementAvailable=false`，两个速率为 `null`。失效时间按服务首次收到快照后经过的时间计算，不混用采集端时钟。2/5/10 秒间隔分别在 5/10/20 秒失效，新到有效快照不会因间隔较长就已过期。字段名称和 B/s 单位不变。

## 实时代理客户端

`live.proxy` 与 `snapshot.proxy` 结构相同。`proxy.clients` 保留 `appId`、`name`、`proxyName`、`connections`、`pathAvailable`，并含：

- `source=WindowsTcpEStats`、`scope=loopback`、`estimated=false`。
- `measurementAvailable`：至少一个当前客户端四元组有有效差值。
- `sampledConnections`：有字节证据的去重连接数，可能少于 `connections`。
- `rxBytes`、`txBytes`、`rxPerSecond`、`txPerSecond`：十进制字符串，缺少证据时全部为 `null`。

只按客户端 `appId` 和客户端方向完整四元组匹配。代理路径不可读不影响字节匹配，监听 PID 已知时 `detectedClients` 保留四元组。反向服务端连接和代理物理字节被排除。

累计值为当前可测连接之和，关闭、更换代理快照或重置后可下降，不代表每日总量。发现缓存 5 秒，EStats 每秒采样，实时事件随服务采样更新。连接可能先进入 `appProcesses`，再进入 `proxy.clients`。身份补全和历史 `estimated=true` 分组由[代理归属](PROXY_ATTRIBUTION.zh-CN.md)维护，估算不与实时实测相加。

## 权限、限制与验证

EStats 需要管理员令牌，采样模块不触发 UAC，未授权时明确返回 `permission`，由辅助进程授权流程获取权限。退出保留系统 EStats 开关，避免影响其他使用者，连接关闭后由系统释放。

轮询可能遗漏短连接、发现前及最后一段字节。未观测断开且计数不回退时，四元组重用无法可靠识别。回环 UDP/QUIC 不在支持范围；ETW 保留进程不可读和事件丢失限制。

CTest 入口包括：

- `loopback_live_test`：基线、速率、重置、进程实例、连接消失、代际与权限变化、去重和 IPC。
- `proxy_service_test`：隔离验证代理路径不可读时的实时字节匹配，以及不写 `app_usage`。
- `windows_app_network_event_test`：IPv4/IPv6 和 IPv4-mapped 回环识别。

真实 ETW/EStats 与辅助脚本验证由 [Windows 采集](../../../docs/WINDOWS_APP_CAPTURE.zh-CN.md#构建与验收)维护。[测试指南](../../../docs/TESTING.zh-CN.md)规定其他入口和证据边界，需要授权的测试被跳过不代表原生验证成功。
