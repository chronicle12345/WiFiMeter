# Linux 应用采集

应用采集在网络详情的「应用分布」中主动启用，只在当前后端会话有效。
系统授权只用于 `wifimeter-app-capture`，Electron 和普通采集后端不以 root 运行。
停止、暂停或退出会关闭辅助进程的管道并卸载它自身的 BPF links；不会修改 Wi-Fi、路由或包内容。

## 统计口径

- cgroup v2 的 ingress/egress hook 累计 socket 的 IPv4/IPv6 字节，包含 IP/传输层头部，覆盖 TCP 和 UDP。
- socket 创建时记录进程身份，并通过内核 socket storage 随生命周期保存；accepted socket 继承监听 socket 的身份。
  通过 fork 或描述符传递共享 socket 时，流量仍归于创建它的进程，而非接收描述符的进程。
- 可执行文件路径作为可读的应用标识，进程开始时间及可执行文件 inode 一同校验 PID 重用与 exec。
- 同一 generation 的累计计数不会在读取时清零。已退出的进程保留最终计数，历史按应用归并。
- 无法读取身份的已测字节进入「未识别应用」；计数容量不足、接口不可读或身份不明会报告 `partial`。
  采集启用前已经存在的 socket 可能无法识别；不会用网卡总量减去已识别应用来虚构它的流量。
- 仅将经过已关联 Wi-Fi 接口的计数写入该网络。Wi-Fi 切换或身份不明的边界区间丢弃并记录缺失。
- VPN/代理的物理接口流量可能归到隧道或代理进程。应用总量和网卡总量分别展示，不要求相等。
- 源停止、权限失败与恢复时重新建立基线，应用统计不影响网卡记录和额度账本。

## 构建与运行条件

需要带 BTF 和 cgroup v2 的 Linux 内核，以及允许加载 BPF 的系统授权。
构建依赖支持 BPF 的 clang、`libbpf-dev >= 1.0`、`libelf-dev`，运行授权依赖 `pkexec`。
构建时找到依赖则生成辅助进程和 `wifimeter-app-capture.bpf.o`；可以显式设置
`-DWIFIMETER_LINUX_APP_CAPTURE=ON`，依赖不足会报错。
`.deb` 随包分发辅助进程及 BPF 对象。libbpf 静态链接并携带 BSD 授权声明，运行时不依赖系统旧版 libbpf；
辅助进程仍使用系统 `libelf1`。`dist:linux` 要求原生采集构建成功，不会生成缺少采集器的安装包。

## 真实内核验证

先构建，再运行：

```bash
npm run test:backend
sudo python3 backend/tests/linux_app_capture_smoke.py build/app/wifimeter-app-capture
```

脚本只通过本机回环发送测试数据，验证 TCP/UDP、IPv4/IPv6、两个进程的收发、应用归并、
重复快照和退出后的最终计数。需要系统授权的测试在普通用户 `ctest` 中明确标为跳过，不能据此声称真实采集通过。
GitHub Linux 工作流单独以 root 运行该脚本；桌面、普通后端和其余测试继续使用普通权限。
