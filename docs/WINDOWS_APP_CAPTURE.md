# Windows 应用采集

应用采集由非回环 ETW 与回环 TCP EStats 两个来源组成。采集开关只在当前后端会话有效，默认关闭。普通后端通过专用本机管道启动 `wifimeter-app-capture.exe`；需要时由用户通过 UAC 授权该辅助进程，桌面程序和普通后端继续使用调用者权限。已经提升权限的后端直接隐藏启动 helper。

停止、暂停和退出会关闭管道，辅助进程停止 EStats 采样线程并结束自己的 ETW 会话。授权期间取消采集后，晚启动的辅助进程因管道已关闭而退出，不会创建采集会话。不同后端会话不能共用已连接的 helper；管道会校验所属进程。

## 统计口径

ETW 使用独立名称和 GUID 的 SystemTraceProvider 会话，只订阅 TCP/IP 网络事件，不控制全局 Kernel Logger。它解析非回环 TCP、UDP 的 IPv4/IPv6 收发事件，TCP 重传计入发送，连接、失败及复制事件不计入字节。累计值来自系统事件的 size，不额外估算协议头，与 Linux IP 层计数、网卡计数可能不同。

ETW 使用事件 payload 中的 PID，可执行路径用于应用归并，进程开始时间用于区分实例。进程退出或 PID 重用后会更新缓存，旧实例计数标记为非活动。IP Helper 的本机单播地址、接口 LUID 和别名用于关联接口；缺少 IPv6 scope 时的重复地址不猜测归属。无法识别进程的 ETW 字节归入未识别应用；未知事件版本、接口不可读及丢失事件等情况报告 partial。

TCP EStats 复用 v1.1.1 的差分原则，每秒读取 IPv4/IPv6 回环连接的 DataBytesIn/DataBytesOut。新连接、计数回退、进程代际变化及采样中断重新建立基线，不补算首次发现前的字节。ETW 明确排除回环事件，避免同一回环流量从两个来源重复计入。若 ETW 无法启动但 EStats 可用，仍提供回环数据，状态为 partial 并保留 ETW 错误原因。

只把能够归属到已关联 Wi-Fi 接口的应用计数写入网络历史；Wi-Fi 切换边界丢弃无法归属的区间并记录缺失。回环行使用 `networkId: ""`、`scope: "loopback"`、`source: "WindowsTcpEStats"`，供本机 TCP 实时展示，不写入 Wi-Fi 应用累计，也不影响网卡统计和额度账本。

## 代理客户端与实时协议

`live.appProcesses` 与 `snapshot.appProcesses` 包含回环连接端点的实测累计字节及 B/s 速率。新基线不能形成差分时 `measurementAvailable=false`，速率为 null。客户端可以按应用聚合这些行，但不能将回环总量与物理接口总量相加。

`live.proxy` 与 `snapshot.proxy` 使用相同结构。`proxy.clients` 按客户端 appId 和完整四元组匹配 EStats 字节，不要求读取代理进程的可执行路径。它只使用客户端方向的回环连接，排除反向服务端连接及代理物理接口字节。实测字段带 `estimated=false`、`measurementAvailable` 和 `sampledConnections`；无证据时字节和速率均为 null。连接发现按 5 秒缓存，EStats 每秒采样，实时事件随服务采样更新。

客户端累计是当前已观测且可测连接的累计之和；连接消失或清零后可能下降，不能当作当日总量。历史 `proxyEstimatedRecords` 继续使用连接权重估算并标记 `estimated=true`，与实时实测值分开。完整字段与生命周期说明见 [后端合约](../backend/platform/win32/APP_TRAFFIC.md)。

## 权限与采样边界

ETW 和 EStats 启用需要相应管理员权限，采样模块自身不触发 UAC。普通权限下真实 helper 返回 permission / error 5。为避免影响并发消费者，退出时不关闭连接的系统级 EStats 开关，连接关闭后由系统释放统计。

EStats 轮询可能遗漏两次采样之间建立并关闭的短连接、首次发现前及关闭前最后一段字节。四元组在未观测到断开的情况下快速重用，且计数没有回退时，无法可靠区分。回环 UDP/QUIC 不在当前采样范围内。ETW 的进程不可读、事件丢失与接口归属限制仍然存在，应用总量不保证等于网卡总量。

## 构建与验收

Windows 本机构建及 Linux 交叉编译都会生成 `wifimeter-app-capture.exe`，安装包与后端一起分发。在已获授权的 Windows 管理员终端，可单独运行当前 EStats 真机测试：

```powershell
.\build\windows\tests\windows_estats_smoke_test.exe
```

该测试创建独立 IPv4/IPv6 本地 TCP 连接，验证客户端 tx=65536、rx=32768 字节及进程身份，不访问用户数据库。普通权限返回 77，由 ctest 标记 skipped；跳过不代表实测通过。普通管道、解析、后端与界面测试使用夹具，无需提权。

`backend/tests/windows_app_capture_smoke.py` 现按生产 hybrid 合约验证，继续作为必需原生验证运行：

```powershell
python backend/tests/windows_app_capture_smoke.py build/windows/app/wifimeter-app-capture.exe --require-native
```

ETW 组枚举本机已配置且可绑定的非回环地址，使用本地 TCP/UDP 连接验证 IPv4/IPv6 字节、双进程归属、重复快照和进程退出后保留的非活动计数。每行必须带 source=WindowsEtw，不能用 EStats 行满足 ETW 断言。缺少一个地址族时单独报告；两个地址族都没有非回环地址则失败，至少要完成一个地址族的 TCP 与 UDP 验证，不允许整组跳过。枚举地址不查询 DNS，也不向外部主机发送请求。

回环组分别建立 IPv4/IPv6 TCP 长连接，等待两个端点的 EStats 零基线出现后才传输。每个端点必须准确读到 rx=65536、tx=65536，source 必须为 WindowsTcpEStats，且不得出现 ETW 重复行。连接在完成读取前保持打开；关闭后允许采样行消失，不要求保留 ETW 风格的最终行。测试使用生产 helper，没有绕过回环过滤的测试开关。

无需管理员权限的脚本自测可运行 `python backend/tests/windows_app_capture_smoke_test.py`，验证等待预热、保持连接以及无非回环地址时明确失败。helper 和地址查询子进程使用 CREATE_NO_WINDOW。`--require-native` 在非原生系统或非管理员环境中返回失败，不把跳过视为验收成功。新版完整 hybrid 管理员验证的 RunAs 请求已被用户取消：hybrid-native.ps1 未执行，也未生成本次验证日志。因此新版 hybrid CI 脚本尚未完成本机管理员验收，非回环 ETW 与回环 EStats 的整组验证不能标记为通过。此前 EStats IPv4/IPv6 与 7897 真实链路的成功验收仍有效，但不代替这一项；取消后不再触发授权。

本机已完成以下验收：

- Windows 全量构建成功；普通权限 ctest 为 32 项通过、1 项管理员测试跳过。
- 明确授权的管理员隐藏 runner 运行 EStats 真机测试，IPv4/IPv6 客户端均测得 rx=32768、tx=65536，8 项检查、0 失败、退出码 0。日志为 `artifacts/estats-admin-test.log`。
- 7897 真实代理链路授权隐藏采样共 4 次，间隔 5 秒；collector 均为 running，4 个客户端具有实测值，采样连接数 14–15，回环行数 50–54。客户端汇总 rx 从 0 增至 352699、tx 从 0 增至 19808，退出码 0。日志为 `artifacts/proxy-estats-native.log`。
- 父任务报告 renderer 的 proxy/live 聚合测试 8 项全部通过。此项验证界面数据消费，独立于原生日志的字节验证。

上述 EStats、7897 退出码和 renderer 测试结果由执行验收的父任务确认。随后修复 hybrid 必选验证脚本，并新增原生来源字段及握手自测；此前的真实采样记录与新版 hybrid 验证分别记录。

系统接口参考：
[TCP/IP](https://learn.microsoft.com/en-us/windows/win32/etw/tcpip)、
[UDP/IP](https://learn.microsoft.com/en-us/windows/win32/etw/udpip)、
[SystemTraceProvider 会话](https://learn.microsoft.com/en-us/windows/win32/etw/configuring-and-starting-a-systemtraceprovider-session)、
[GetPerTcpConnectionEStats](https://learn.microsoft.com/en-us/windows/win32/api/iphlpapi/nf-iphlpapi-getpertcpconnectionestats)。
