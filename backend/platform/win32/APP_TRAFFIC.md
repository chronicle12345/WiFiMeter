# Windows 应用实时采样与代理客户端合约

## 数据来源

对照 v1.1.1 的 `src/AppNetworkSampler.cs` 与 `src/AppMonitor.psm1`：原版以 TCP EStats 数据字节计数做差分，每秒采样，包含回环连接，首轮与计数回退只建立基线。连接快照和历史连接权重估算是另一条数据链路。

当前实现保留 ETW 的非回环网络事件。`TcpEStatsCapture` 在已启动的 helper 内每秒读取 IPv4/IPv6 回环 TCP EStats，通过进程创建时间和四元组区分连接。首次出现、采样中断、进程代际变化及计数回退都重新建立基线。ETW 明确排除回环事件，避免与 EStats 重复计数。ETW 无法启动但 EStats 可用时，仍提供回环采样，报告 partial 和 ETW 失败原因。

EStats 返回 DataBytesIn/DataBytesOut 的差分累计，不估算连接的字节数；新连接第一次发现前的字节不补算。原生 IPC 使用 interfaceId=loopback，connectionKey 使用与代理连接快照相同的地址长度、地址与端口编码。该标识不代表 Wi-Fi 接口，不映射任何 Wi-Fi networkId。原生 helper IPC 另带 source 字段，ETW 行为 WindowsEtw、EStats 行为 WindowsTcpEStats，供原生验证区分实际来源；旧快照省略此字段仍可解析。

## 客户端 JSON

snapshot.appProcesses 和 live.appProcesses 的回环行：

```json
{
  "networkId": "",
  "appId": "C:\\Apps\\client.exe",
  "name": "client.exe",
  "processId": 123,
  "instanceId": "123:processCreationTime:socketGeneration",
  "connectionKey": "9:127.0.0.1:50001>9:127.0.0.1:7897",
  "source": "WindowsTcpEStats",
  "scope": "loopback",
  "measurementAvailable": true,
  "rxBytes": "600",
  "txBytes": "200",
  "rxPerSecond": "300",
  "txPerSecond": "100"
}
```

每条回环行对应一个当前连接端点，不是一条应用汇总行。rxBytes/txBytes 是该连接在本次服务基线之后的实测累计值；速率单位为 B/s，以服务接收快照的实际时间差计算。首轮、计数重置等无法形成有效差分时 measurementAvailable=false，速率为 null。暂停、清零、重新启用、恢复数据库以及采集 generation 变化均清除实时基线。连接消失后该行消失，不提供关闭后的最终累计。

原有 Wi-Fi 行仍使用实际 networkId，增加 name、source=native、scope=wifi；保留原有速率语义。回环专有的累计值、connectionKey 和 measurementAvailable 不保证出现在其他来源的行中。界面不可把 loopback 字节累加到 Wi-Fi 或物理接口总量。

live.proxy 与 snapshot.proxy 为同一结构。proxy.clients 保留 appId/name/proxyName/connections/pathAvailable，新增：

- source=WindowsTcpEStats、scope=loopback、estimated=false。
- measurementAvailable：至少一个当前客户端四元组具有可用差分。
- sampledConnections：本轮具有字节证据的去重客户端连接数；可能少于 connections。
- rxBytes、txBytes、rxPerSecond、txPerSecond：十进制字符串；无字节证据时全部为 null。

代理客户端字节只按 appId 和客户端方向的完整四元组匹配，不要求代理可执行路径可读。监听器只有 PID 而路径不可读时，detectedClients 也保留客户端四元组，并使用同一匹配规则。反向服务端连接及代理物理接口字节不会进入客户端实测值。

proxy.clients 的累计是当前已观测且可测连接的累计之和，不是当日总量；连接关闭、代理快照更换或清零后可能下降。连接发现仍按 5 秒缓存，EStats 按 1 秒采样，live 每次服务采样更新。新连接可能先出现在 appProcesses，稍后出现在 proxy.clients。历史 proxyEstimatedRecords 保持 estimated=true，不能与实时实测值合并求和。

## 权限、边界与验证

EStats 启用需要管理员令牌。采样模块不触发 UAC；已有 helper 授权流程负责获取权限。非管理员令牌明确返回 permission。为避免影响并发消费者，采集器不在退出时关闭系统级连接 EStats 开关，系统在连接关闭时释放统计。

轮询可能漏掉两次采样之间建立并关闭的短连接、首次发现前的字节以及连接关闭前的最后一段字节。未观测到断开且四元组被快速重用、计数又未回退的情况不能可靠识别。回环 UDP/QUIC 不在此实现范围内。ETW 非回环采样仍保留其事件丢失与进程不可读限制。

测试入口：

- loopback_live_test：累计与速率分离、首轮基线、回退、PID 代际、连接消失、清零、源重启、权限、四元组去重和原生 IPC 序列化。
- proxy_service_test：隔离 SQLite 数据库，验证回环实时字节、代理路径不可读时的字节匹配、live.proxy 以及不写入 app_usage。
- windows_app_network_event_test：IPv4、IPv6、IPv4-mapped IPv6 回环识别。
- windows_app_capture_smoke.py：非回环 IPv4/IPv6 TCP/UDP 必需 ETW 覆盖；回环 TCP 长连接预热后验证 EStats 字节和关闭语义。至少一个非回环地址族必须完成 TCP 与 UDP，不能整组跳过，详见 Windows 采集文档。
- windows_app_capture_smoke_test.py：普通权限验证预热握手、连接保持及无非回环地址时明确失败。
- windows_estats_smoke_test：管理员环境下创建独立 IPv4/IPv6 本地连接，检查客户端 tx=65536、rx=32768 字节和进程身份；非管理员返回 77，由 ctest 标记 skipped，不触发 UAC，不访问数据库。

本次 build/windows 全量构建成功；普通权限 ctest 共 33 项，32 项通过，windows_estats_smoke_test 因无管理员令牌跳过。另以 CREATE_NO_WINDOW 启动真实 wifimeter-app-capture --stdio，确认返回 permission / error 5。

随后父任务通过明确授权的 UAC 管理员隐藏 runner 单独运行 windows_estats_smoke_test。日志 artifacts/estats-admin-test.log 记录 IPv4 与 IPv6 客户端均为 rx=32768、tx=65536，8 项检查、0 项失败；父任务确认退出码为 0。至此已验证本机管理员环境下的真实 EStats 回环字节和普通权限下的真实 helper 拒绝路径。该管理员测试是独立补充验收，不修改此前普通权限 ctest 的跳过记录。

用户 7897 代理的现有真实传输链路已完成授权隐藏采样。日志 artifacts/proxy-estats-native.log 记录 4 次、间隔 5 秒的快照：collector 均为 running，source 均为 WindowsTcpEStats，measuredClients 均为 4，sampledConnections 为 14–15，loopbackRows 为 50–54。rxBytes 依次为 0、140644、198485、352699，txBytes 依次为 0、31、14612、19808；父任务确认退出码为 0。该结果验证已有真实代理客户端的字节随传输增加，未将连接数换算为字节。日志中的数值为当轮客户端实测累计汇总，不代表当日总量或完整网卡流量。

父任务另报告 renderer 的 proxy/live 聚合测试 8 项全部通过。此结果与原生采样验收分别记录：原生日志验证字节来源与客户端匹配，renderer 测试验证实时数据的消费与聚合。本轮仅更新文档，没有重复构建或运行测试。短连接、关闭前末尾字节和回环 UDP/QUIC 等限制仍按上文保留。

复测时可由已授权管理员 runner 隐藏启动后端并指定临时数据库，保存 ports=[7897]、启用应用采集，等待现有连接自然产生流量，无需制造对外请求。每个后端会创建并校验自己拥有的 helper 管道，不能把另一后端已连接的 helper 直接复用到本次临时数据库会话。

后续 CI 合约修复新增了 helper 原生 source 字段，并重写 windows_app_capture_smoke.py 的两组验证。普通权限握手自测 2 项通过，--require-native 在当前非管理员令牌下按约定返回 1。父任务随后通过 RunAs 请求运行 hybrid-native.ps1，系统返回操作已被用户取消；脚本未执行，也未生成本次 hybrid 日志。因此新版完整 hybrid CI 脚本尚未完成本机管理员验收，不能据此宣称非回环 ETW 与回环 EStats 的整组原生验证已通过。此前管理员 EStats IPv4/IPv6 与 7897 真实链路的成功记录仍然有效，不能代替新版 hybrid 验收。本次取消后不再触发授权。


## 2026-10-02 采样时序修复

设置页代理列表停留在首次快照的问题由 UI 修复。后端另外存在可独立复现的采样问题：WindowsAppTrafficSource 等待 100 毫秒后可能返回同一 helper 报告；EStats 每秒更新缓存，ETW 的新报告也可能携带同一份 EStats 计数。原先每次读取都推进计数与时间基线，导致重复读取变成 0 B/s，下一次增量又除以错误的间隔。Wi-Fi 应用行还使用整秒间隔计算速率。

helper 报告新增两个可选 JSON 整数字段：sampledAtMs 是采集端 GetTickCount64 单调时钟毫秒数，标记 ETW 快照时间；loopbackSampledAtMs 是 EStats 缓存实际更新时间。仅 EStats 工作时二者相同。缺省或 0 表示旧格式，沿用服务读取时间。字段不表示 Unix 时间，不能直接与 snapshot 的日期字段相减。应同时更新 backend 与 app-capture 二进制以获得完整修复。

同 generation 中时间戳相同或倒退的报告不推进基线；EStats 独立使用 loopbackSampledAtMs。新快照按字节增量除以实际毫秒间隔计算 B/s，新快照字节不变时仍返回 0。generation 变化、暂停、权限失败和存储失败继续清除基线。没有新增数据库字段。

实时 appProcesses / proxy.clients 的速度字段名称和单位保持不变。重复快照暂时保留最后一次有效速率，超过 max(5 秒, 2 × intervalSeconds) 没有新样本时，measurementAvailable 为 false，rxPerSecond / txPerSecond 为 null。Wi-Fi 行也可能出现这组不可测量值。过期时间计算使用服务端从首次接收到该快照以来的时间差，不与采集端单调时钟混算。2、5、10 秒采样间隔分别使用 5、10、20 秒阈值，新到达的有效快照不会因采样间隔长而被当作过期。

回归先复现后修复：1250 毫秒内增加 1000 字节，原 loopback 路径先得到 500 B/s，重复读取变成 0，下一轮变成 1111；修复后均按源采样时间得到 800 B/s。服务 Wi-Fi 路径对应得到 500、0、1000，修复后为 800、800、800，且数据库累计仍为 2000 字节。测试另覆盖新零增量、过期、乱序、generation 重启及 2/5/10 秒设置。

本次只读本机验证调用 GetPerTcpConnectionEStats，不调用 SetPerTcpConnectionEStats，不触发 UAC。64 条已启用的 IPv4 回环连接读取成功，无 API 错误。相隔 2 秒，verge-mihomo.exe（PID 20672）的同连接计数增加 rx=13440、tx=729 字节，另一个客户端 PID 7080 增加 rx=554、tx=13286 字节。这个观察确认当前连接有实际传输，不代表所有连接持续繁忙，也不能替代新版 helper 在授权环境下的传输冒烟测试。
