# Windows 应用采集

应用分布中的采集开关只在当前后端会话有效，默认关闭。
普通后端通过专用本机管道启动 `wifimeter-app-capture.exe`；需要时系统 UAC 只授权该辅助进程。
桌面程序和普通后端继续使用调用者权限。停止、暂停和退出关闭管道，辅助进程结束自己的 ETW 会话。
授权期间取消采集后，晚启动的辅助进程因管道已关闭而退出，不会创建采集会话。

## 统计口径

- 使用独立名称和 GUID 的 SystemTraceProvider 会话，只订阅 TCP/IP 网络事件；不控制全局 Kernel Logger。
- 解析 TCP、UDP 的 IPv4/IPv6 收发事件，TCP 重传计入发送，连接、失败及复制事件不计入字节。
  累计系统事件的 `size`，不额外估算协议头；该口径与 Linux 的 IP 层计数、网卡计数可能不同。
- 使用事件 payload 中的 PID，不使用记录事件的线程 PID。可执行文件路径用于跨进程归并，开始时间用于进程实例。
  采集会话保留已经查询到的进程句柄，避免进程退出后 PID 被复用；最后计数继续保留并标记非活动。
- IP Helper 的本机单播地址、接口 LUID 和别名用于关联接口，与 Wi-Fi 平台层的标识一致。
  缺少 IPv6 scope 时的重复地址不能确定接口，记为采集缺失。
- 无法读取进程身份的已测字节进入「未识别应用」。未知事件版本、接口不可读、计数容量不足及 ETW 丢失事件报告 `partial`。
  短时间内结束、保护级别较高或身份无法查询的进程可能无法归到应用；不会从网卡总量中推算它的流量。
- 只把已关联 Wi-Fi 接口的计数写入网络。切换 Wi-Fi 的边界区间丢弃并记录缺失，应用采集不改变网卡统计和额度账本。
- VPN、代理和本机回环可能有不同的接口归属。应用总量与网卡总量分别展示，不要求相等。

## 构建与原生验证

Windows 本机构建及 Linux 交叉编译都会生成 `wifimeter-app-capture.exe`，安装包随普通后端一起分发。
在 Windows 管理员终端运行：

```powershell
npm run build:backend
python backend/tests/windows_app_capture_smoke.py build/windows/app/wifimeter-app-capture.exe --require-native
```

脚本只用本机回环验证 TCP/UDP、IPv4/IPv6、两个进程的收发与应用归并、重复快照和退出后的最终计数。
`--require-native` 拒绝非 Windows、Wine 或非管理员会话，不能用跳过代替通过。
GitHub 原生 Windows 工作流单独运行此验证。普通管道、解析、后端、历史和界面测试使用夹具，无需授权。

事件格式和独立会话配置来自 Microsoft 文档：
[TCP/IP](https://learn.microsoft.com/en-us/windows/win32/etw/tcpip)、
[UDP/IP](https://learn.microsoft.com/en-us/windows/win32/etw/udpip)、
[SystemTraceProvider 会话](https://learn.microsoft.com/en-us/windows/win32/etw/configuring-and-starting-a-systemtraceprovider-session)。
