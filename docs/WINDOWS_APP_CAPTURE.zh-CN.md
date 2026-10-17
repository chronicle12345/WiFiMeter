# Windows 应用采集

[English](WINDOWS_APP_CAPTURE.md) | 简体中文

采集组合非回环 ETW 和回环 TCP EStats，后端开关每次会话默认关闭。普通后端通过专用本机管道启动 `wifimeter-app-capture.exe`，需要时只由辅助进程请求 UAC，桌面程序和普通后端保留调用者权限。已提升权限的后端隐藏启动辅助进程。

启动和迁移成功、主窗口显示后，宿主询问本次采集。同意才允许辅助进程请求授权，拒绝任一请求后保持关闭且不自动重试，网卡统计继续。设置 > 常规可关闭默认启用的启动询问，手动启停及重试不改变该偏好。采集不可用或迁移失败时跳过询问。

停止、暂停或退出会关闭管道、停止 EStats 线程并结束辅助进程自身的 ETW 会话。授权期间取消后，晚启动的辅助进程退出，不创建采集会话。已连接的辅助进程不能在后端会话之间共享，管道检查所属进程。

## 统计口径

ETW 使用独立 SystemTraceProvider 名称和 GUID，订阅 TCP/IP 事件，不控制全局 Kernel Logger。非回环 IPv4/IPv6 TCP/UDP 收发字节来自事件 `size`；TCP 重传计入发送，连接、失败和复制事件不增加字节。不额外估算协议头，因此可能与 Linux IP 层或网卡计数不同。

事件 payload 的 PID 标识进程，可执行路径归并应用，开始时间区分实例。退出或 PID 重用更新身份缓存，旧计数标为非活动。IP Helper 单播地址、接口 LUID 和别名确定接口归属，IPv6 重复地址缺少 scope 时不猜测。未知进程记入未识别应用；未知事件版本、接口不可读和事件丢失报告 `partial`。

EStats 每秒读取 IPv4/IPv6 回环 `DataBytesIn`/`DataBytesOut` 差值。新连接、计数回退、实例变化及中断重建基线，不补算发现前字节。ETW 排除回环，避免重复。ETW 失败时 EStats 可以继续，以 `partial` 保留 ETW 错误。

保存身份后关闭已退出进程句柄。ETW 最终计数保留至应用事务成功并确认具体值，再回收；晚到事件使用独立的应用/接口计数。退出身份有保留上限，之后无法识别的事件记入未识别并报告 `partial`。旧辅助进程继续原有行为，不接收确认。写入失败保留原批次，成功重试后暂停、停止或退出才能清除其基线。

只有能归属已关联 Wi-Fi 的计数写入网络历史，切换时无法归属的区间丢弃并记录缺失。回环行使用 `networkId: ""`、`scope: "loopback"`、`source: "WindowsTcpEStats"` 显示本机 TCP 实时流量，不进入 Wi-Fi 应用累计、网卡统计或额度账本。

## 代理客户端与实时协议

`live.appProcesses` 和 `snapshot.appProcesses` 含端点实测累计及 B/s 速率。基线无法形成有效差值时，`measurementAvailable=false`，速率为 `null`。按应用归并后也不能把回环总量加到物理接口上。

`live.proxy` 与 `snapshot.proxy` 结构一致，`proxy.clients` 按客户端 `appId` 和完整四元组匹配，无需代理可执行路径。只统计客户端方向回环连接，排除反向服务端连接和代理物理字节。字段含 `estimated=false`、`measurementAvailable`、`sampledConnections`，缺少证据时字节和速率为 `null`。连接发现缓存 5 秒，EStats 每秒采样，实时事件随服务采样更新。

客户端累计为当前可测连接之和，连接消失或重置后可能下降，不代表每日总量。历史 `proxyEstimatedRecords` 使用连接权重及 `estimated=true`，与实时实测分开。完整字段与生命周期见[后端合约](../backend/platform/win32/APP_TRAFFIC.zh-CN.md)。

## 权限与采样边界

ETW/EStats 需要管理员权限，采样模块不触发 UAC。未提升权限时，真实辅助进程返回 `permission` / error 5。退出不关闭连接的系统 EStats 开关，避免影响其他使用者，连接关闭后由系统释放。

轮询可能遗漏采样间完全结束的连接、发现前及最后一段字节。未观测断开且计数不回退时，四元组重用无法区分。回环 UDP/QUIC 不在支持范围。ETW 的进程身份、事件丢失及接口归属限制仍存在，应用和网卡总量无需相等。

## 构建与验收

本机构建将辅助进程与后端一同分发。完成 Visual Studio Release 测试构建后，已授权的 Windows 管理员终端可运行：

```powershell
./build/windows/tests/Release/windows_estats_smoke_test.exe
```

单配置生成器将其直接放在 `tests/`。隔离 IPv4/IPv6 TCP 测试验证客户端 `tx=65536`、`rx=32768` 及身份，不访问用户数据库。未提升权限时返回 77，CTest 标为跳过；普通夹具测试无需提权。

完整生产混合采集检查单独运行：

```powershell
python backend/tests/windows_app_capture_smoke.py build/windows/app/wifimeter-app-capture.exe --require-native
```

ETW 组枚举本机配置且可绑定的非回环地址，不访问 DNS 或外部网络。本机 TCP/UDP 验证 IPv4/IPv6 字节、双进程归属、重复快照和退出后保留计数。行必须带 `source=WindowsEtw`，EStats 不能满足断言。缺少地址族会报告；至少一个地址族完成 TCP 和 UDP，整组不得跳过。

回环组保持 IPv4/IPv6 TCP 连接，等两个 EStats 零基线就绪后传输。各端点必须准确得到 `rx=65536`、`tx=65536`、`source=WindowsTcpEStats`，且无重复 ETW 行。关闭后行可消失，不要求保留 ETW 风格最终计数，不绕过生产回环过滤。

`python backend/tests/windows_app_capture_smoke_test.py` 无需管理员权限，检查预热、连接存续及没有非回环地址时失败。辅助进程和地址查询子进程使用 `CREATE_NO_WINDOW`。`--require-native` 在非 Windows 或未提权时失败，跳过不算通过。

分别记录当前提交的 ETW 和 EStats 结果。夹具、独立 EStats 和旧原生结果不能替代完整混合采集验证。其他检查、隔离目录和私人诊断处理见[测试指南](TESTING.zh-CN.md)。

系统参考：[TCP/IP](https://learn.microsoft.com/en-us/windows/win32/etw/tcpip)、[UDP/IP](https://learn.microsoft.com/en-us/windows/win32/etw/udpip)、[SystemTraceProvider](https://learn.microsoft.com/en-us/windows/win32/etw/configuring-and-starting-a-systemtraceprovider-session) 和 [GetPerTcpConnectionEStats](https://learn.microsoft.com/en-us/windows/win32/api/iphlpapi/nf-iphlpapi-getpertcpconnectionestats)。
