# Terminology / 术语

[English guide](README.md) | [中文指南](README.zh-CN.md)

Use this shared table when editing either language. Keep code identifiers unchanged. / 编辑任一语言时参考此表，代码标识符保持原样。

| English | 简体中文 | Context / 使用说明 |
| --- | --- | --- |
| network interface | 网络接口 | Operating-system interface / 操作系统接口 |
| physical adapter | 物理网卡 | Distinguish from virtual adapters / 与虚拟网卡区分 |
| network identity | 网络身份 | Attribution and network switches / 流量归属及网络切换 |
| application capture | 应用采集 | Native per-application traffic collection / 原生应用流量采集 |
| native capture | 原生采集 | ETW, TCP EStats, or eBPF; retain source names / 保留来源名称 |
| loopback | 回环 | Local TCP traffic / 本机 TCP 流量 |
| measured traffic | 实测流量 | Keep separate from estimates / 与估算分开 |
| proxy attribution estimate | 代理流量归属估算 | Estimated shares retain their marker / 估算份额保留标记 |
| unavailable | 不可用 | Missing evidence is not a measured zero / 缺少证据不等于实测为零 |
| baseline | 基线 | Counter differences and reset handling / 计数差值及重置处理 |
| coverage gap | 采集缺失 | Preserve protocol reason identifiers / 保留协议原因标识符 |
| quota ledger | 额度账本 | Separate from historical aggregation / 独立于历史汇总 |
| backend | 后端 | C++ collector and storage service / C++ 采集与存储服务 |
| business host | 业务宿主 | Node process / Node 进程 |
| native host | 原生宿主 | Tauri/Rust host / Tauri/Rust 宿主 |
| page bridge | 页面桥接 | Renderer-to-host communication / 页面与宿主通信 |
| floating window | 悬浮窗 | Windows mini window / Windows 小窗口 |
| fixture | 测试夹具 | Synthetic or isolated test inputs / 虚构或隔离的测试输入 |
| test double | 测试替身 | Substitute for a system dependency / 替代系统依赖 |
| skipped | 跳过 | Report separately from passed / 与通过分开记录 |
| artifact | 构建产物 | CI or package output / CI 或打包输出 |
| installer | 安装包 | NSIS, deb, rpm, AppImage as applicable / 按平台指明格式 |
| pull request | 拉取请求 | PR abbreviation may follow / 可在后文使用 PR |
| pair record | 双语登记记录 | Reviewed whole-file hashes / 已审阅文件的整文件摘要 |
| implemented Note | 已实施 Note | Current decision facts remain maintained / 继续维护当前决策事实 |
| archived Note | 已归档 Note | Frozen historical record / 冻结的历史记录 |
