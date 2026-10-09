# 分钟流量与双向限速实施计划

> 使用 superpowers:subagent-driven-development 并行实现独立模块，再检查接口、测试与实际行为。用户已授权完成可撤销的实现工作，无需另行确认设计。

目标：自定义范围精确到本地时分，提供网络与应用分钟明细、完整实时应用排行，以及 Windows 应用下载限速。

架构：沿用桌面页面、C++ 采样和 SQLite 存储，已有 Electron 业务通过 Tauri 与随包 Node 进程复用。新增真实分钟记录；每日与每小时记录继续兼容。Windows 上传沿用 QoS，下载由签名 WinDivert 驱动和独立辅助进程延迟目标应用入站数据包，仅在 WiFiMeter 运行期间生效。

技术：JavaScript、Tauri、Rust、Node.js、C++20、SQLite、PowerShell、C#、WinDivert；Electron 保留共用页面回归入口。本轮验收与发布仅面向 Windows x64。

- [x] 后端新增分钟采样与网络、应用表，snapshot 返回 minuteRecords/appMinuteRecords，支持 fromTime/toTime，并接入备份、恢复、删除和保留策略；旧数据保留已有精度。
- [x] 数据客户端和页面保留所选时分，按需加载分钟历史并处理并发、旧请求晚到；小时导出使用后端接口。相关 minute-data、history-requests 和 mini-usage 单元回归通过。
- [x] 页面提供时分控件、分钟与小时明细、趋势和导出；总览首屏保留核心指标，完整实时排行放在下方滚动区。总览中英布局、尺寸、滚动与额度状态回归通过。
- [x] 网络控制新增 downloadKBps 和取消 direction 参数，上传和下载可独立设置、取消；下载辅助代码通过 .NET Framework 编译及隔离模拟，覆盖连接识别、异常清理、重新设置和退出清理。
- [x] 打包资源包含辅助程序、官方驱动和许可证，资源与发布清单测试通过；中英文文档同步本轮范围、升级方式及分钟精度。
- [x] 完成 Windows x64 单元与界面回归、后端构建和 CTest，确认跨分钟字节守恒、时间边界、额度归属及旧库迁移，并通过独立代码审查。
- [x] 完成 Tauri 安装版和便携 ZIP 的解包校验与原生集成，实际体积和结果已记录在发布说明；完整安装/卸载、真实限速吞吐、UAC、驱动加载及 QoS 系统修改未计入本轮验证结论。

分钟行字段：date、time、hour、minute、networkId、rxBytes、txBytes；应用行另带 appId/name。时间按本地归档，结束分钟包含整分钟；旧每日与小时记录不转换为虚构分钟值。

限速接口：throttle 可带 uploadKBps、downloadKBps 任一或两项；unthrottle 可带 direction=upload/download/both，缺省 both。状态增加 DownloadSupported、DownloadThrottled、DownloadKbps、DownloadError。

悬浮窗按本地日历分钟累计：1 分钟为当前分钟，5 分钟和 1 小时分别包含当前分钟及之前 4 个、59 个分钟，自定义支持 1 到 10080 分钟；列表收起后停止发起历史查询。
