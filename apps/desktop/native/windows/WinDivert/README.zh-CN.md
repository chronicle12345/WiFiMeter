# WinDivert 说明与下载限速

[English](README.md) | 简体中文

WinDivert 2.2.2-A 按 LGPL v3 许可证原样随包分发，未作修改。

官方发布：https://github.com/basil00/WinDivert/releases/tag/v2.2.2
源码：https://github.com/basil00/WinDivert/tree/v2.2.2
压缩包：https://github.com/basil00/WinDivert/releases/download/v2.2.2/WinDivert-2.2.2-A.zip
压缩包 SHA256：63CB41763BB4B20F600B6DE04E991A9C2BE73279E317D4D82F237B150C5F3F15

完整的上游许可原文保存在 LICENSE。DLL 作为独立原生资源分发，可用用户自行构建且兼容的 WinDivert 2.2 库替换。x64 与 x86 目录包含上游 DLL 和已签名驱动。该上游版本不支持 ARM64。

DownloadLimiter.cs 使用 WinDivert NETWORK 拦截和 FLOW 进程 ID；对启动前已建立的连接，使用 Windows IP Helper OWNER_PID 表确定归属。仅将匹配应用的入站 TCP/UDP 有效负载放入队列。不匹配、归属不明确或格式无效的数据包立即重新注入。回环流量及由独立代理程序接收的流量，无法通过限制原应用进行控制。下载限速仅在 WiFiMeter 运行时生效。

每个应用的队列上限为 4 MiB 和 4096 个数据包，所有应用的队列总上限为 16 MiB。达到容量上限时，仅丢弃超出的目标数据包；TCP 可以重传，UDP 可能丢包。调度器按有效负载字节数计算限速额度，允许以数据包大小为单位的有限突发。停止时排空待处理数据包并关闭采集句柄。驱动或工作线程失败时，关闭句柄并恢复正常转发。进程突然终止可能导致队列中已有的数据包丢失。
