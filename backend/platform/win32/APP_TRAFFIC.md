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


## 2026-10-02 采样时序修复

设置页代理列表停留在首次快照的问题由 UI 修复。后端另外存在可独立复现的采样问题：WindowsAppTrafficSource 等待 100 毫秒后可能返回同一 helper 报告；EStats 每秒更新缓存，ETW 的新报告也可能携带同一份 EStats 计数。原先每次读取都推进计数与时间基线，导致重复读取变成 0 B/s，下一次增量又除以错误的间隔。Wi-Fi 应用行还使用整秒间隔计算速率。

helper 报告新增两个可选 JSON 整数字段：sampledAtMs 是采集端 GetTickCount64 单调时钟毫秒数，标记 ETW 快照时间；loopbackSampledAtMs 是 EStats 缓存实际更新时间。仅 EStats 工作时二者相同。缺省或 0 表示旧格式，沿用服务读取时间。字段不表示 Unix 时间，不能直接与 snapshot 的日期字段相减。应同时更新 backend 与 app-capture 二进制以获得完整修复。

同 generation 中时间戳相同或倒退的报告不推进基线；EStats 独立使用 loopbackSampledAtMs。新快照按字节增量除以实际毫秒间隔计算 B/s，新快照字节不变时仍返回 0。generation 变化、暂停、权限失败和存储失败继续清除基线。没有新增数据库字段。

实时 appProcesses / proxy.clients 的速度字段名称和单位保持不变。重复快照暂时保留最后一次有效速率，超过 max(5 秒, 2 × intervalSeconds) 没有新样本时，measurementAvailable 为 false，rxPerSecond / txPerSecond 为 null。Wi-Fi 行也可能出现这组不可测量值。过期时间计算使用服务端从首次接收到该快照以来的时间差，不与采集端单调时钟混算。2、5、10 秒采样间隔分别使用 5、10、20 秒阈值，新到达的有效快照不会因采样间隔长而被当作过期。

回归先复现后修复：1250 毫秒内增加 1000 字节，原 loopback 路径先得到 500 B/s，重复读取变成 0，下一轮变成 1111；修复后均按源采样时间得到 800 B/s。服务 Wi-Fi 路径对应得到 500、0、1000，修复后为 800、800、800，且数据库累计仍为 2000 字节。测试另覆盖新零增量、过期、乱序、generation 重启及 2/5/10 秒设置。


## 2026-10-02 代理身份补全与历史估算事件

普通权限后端读取 GetExtendedTcpTable 可以确认代理端 PID，但 QueryFullProcessImageName 可能失败。仅配置端口且 processNames 为空时，原实现只生成 detectedClients，不保存 proxy_apps 或 proxy_observations；历史估算没有路径或配置名称可以匹配，因此为空。该情况会导致已有代理原生记录无法匹配客户端估算。

现在 detectedClients 在后端内部保留 proxyProcessId。服务只使用本轮新到达的 helper EStats 快照补全：必须有非空 generation 和递增 loopbackSampledAtMs，同一份快照同时包含客户端完整四元组及代理端反向四元组，代理 PID 与 TCP 查询结果一致。进程实例带创建时间，同 PID 出现不同创建时间或路径、缺少客户端端点、路径未知、来源不符、重复或乱序快照时均不补全。不维护跨轮 PID 到路径缓存。新 generation 重新验证本轮证据，不沿用旧连接身份。

通过验证后，将观测当日的真实代理路径和去重连接键保存到现有表；不补写过去日期的客户端权重，不修改 app_usage。缺少当日观测的旧记录只允许形成 proxy/unattributed，不将今天的客户端连接用于过去日期。历史估算仍按连接数量分配，并非逐客户端实测历史。

live 新增可选字段 proxyEstimatedUpdates，格式如下：

```json
{"proxyEstimatedUpdates":[{"networkId":"network-key","date":"2026-10-02","proxyAppId":"C:\\proxy.exe","records":[]}]}
```

每组 records 是该网络、日期和代理完整路径的累计估算行，字段与 snapshot.proxyEstimatedRecords 相同。消费者整组替换，不能按增量加法处理；空数组清除对应组。后端只重算采样当日应用记录，并与上次发送组比较，原生累计或观测权重变化时发送变化组。跨日不清除前一日历史。首次采样可发送全部当日估算组，完整历史仍由 snapshot 获取。路径比较忽略大小写，不用文件名代替完整路径。前端必须分别校验 RX、TX 守恒后替换代理原生行，不能将估算行与同一代理原始行同时累计。

上传方向核查：GetIfEntry2 的 InOctets 对应 RX，OutOctets 对应 TX；ETW 10/26 为发送、11/27 为接收，TCP 14/30 重传计入发送，连接及复制事件不计入。网卡 core 首次读取只建基线，后续记录差值；应用记录、回环实时数据与代理估算不加入网卡总量。

回环只用于实时显示，AppUsageAccumulator 不把 loopback 映射成 Wi-Fi networkId。长期不双计方案应保留网卡及代理原生账本，将已验证的客户端回环字节另存为独立范围的历史；若用于外网归属，应按同一时间窗口和方向，将代理外网额度分配给客户端，保留未归属差额，并标为估算，不能直接相加。本轮未扩展数据库或改变这一合同。