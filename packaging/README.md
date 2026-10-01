# 多架构打包与后台性能验证

以下是构建入口支持的目标，不代表这些目标已经完成安装或实机验收。性能基准环境为 Windows x64、Node.js 24.14.1。当前 npm ci 已完成，Electron 可运行；本机已有 VS18 和 Ninja/MinGW 工具链，build/windows 已构建。新增架构和安装格式仍需分别验证。

## 构建入口

从仓库根目录运行。先按现有流程安装 apps/desktop 的 npm 依赖。版本来自现有 package.json，脚本不修改版本、不发布、不安装产物。

```powershell
node packaging/windows/build.cjs --arch x64 --formats nsis,portable
node packaging/windows/build.cjs --arch arm64 --formats nsis,portable
node packaging/windows/build.cjs --arch ia32 --formats nsis,portable
```

Windows 本机构建优先复用已有同架构 CMakeCache，包括现有的 Ninja/MinGW 构建。新目录可通过 CMAKE_GENERATOR 指定生成器；未指定时从 CMake capabilities 选择可用的最新 Visual Studio 生成器，兼容 VS18。只有 Visual Studio 生成器传入 -A x64、ARM64、Win32。Ninja/MinGW 默认使用本机架构，跨架构需通过 CMAKE_TOOLCHAIN_FILE 显式指定工具链；已有不同架构产物会直接拒绝复用。需要对应的 C++ 工具链及 SDK；使用动态 MSVC 运行库时目标机也需安装对应运行库。Electron 运行时由 electron-builder 按指定架构获取，下载不可用时构建失败，不以另一种架构代替。

Linux x64 主机可以沿用现有 Zig/Wine 链路生成 Windows x64；该链路的编译目标固定为 x86_64-windows-gnu，因此拒绝交叉生成 Windows ARM64、ia32。其他宿主平台也会直接拒绝。

```bash
# 在 Linux x64 主机
node packaging/linux/build.cjs --arch x64 --formats deb,rpm,AppImage
# 在 Linux ARM64 主机
node packaging/linux/build.cjs --arch arm64 --formats deb
```

Linux 只接受与运行 Node.js 相同架构的本机编译，支持 x64、arm64，拒绝 ia32 和跨架构请求。需要 CMake、C++20 编译器、SQLite 开发库、支持 BPF 的 clang、libbpf >= 1.0 的静态库和头文件、libelf、zlib、readelf。不会为了打包省略应用流量采集辅助进程。

deb 继续使用已有 dpkg-deb 路径，避免引入 fpm 下载。rpm 和 AppImage 使用 electron-builder 的对应目标；rpm 需要兼容构建主机的 fpm/rpmbuild，AppImage 需要兼容构建主机的 AppImage 工具。ARM64 上建议先生成 deb；其他格式的外部工具可用性未在本次环境验证，不保证构建成功。所有格式均保留现有应用资源和 Electron 运行库。Windows 通过 extraResources 将 AppNetworkControl.psm1 复制到 resources/native/windows/AppNetworkControl.psm1，位于 asar 外，与 createAppControl 的固定查找路径一致。

rpm 的依赖名针对 Fedora 系列配置，其他 RPM 发行版需单独核对。AppImage 未打包后端的系统动态库，运行机器仍需 SQLite、libelf、zlib、桌面运行库、pkexec、适当的内核 BPF 支持；它不等同于完全自包含的离线包。应用采集授权、FUSE、sandbox 和发行版兼容性需要目标机验收。

两个入口都接受 `--formats dir`，用于仅组装目录。未知参数、架构和格式会在编译或下载前报错。

## 架构检查和输出

打包前读取后端与采集辅助进程的 PE/ELF 文件头，打包后的 afterPack 再检查 Electron 主程序及两个后端程序。文件缺失、格式损坏、系统或 CPU 架构不一致都会中止构建。检查每个文件只读取 64 字节及必要的 PE 头，不会把大型可执行文件整体载入内存。

此检查针对解包目录中的程序。NSIS 安装器和便携启动器可能使用与应用不同的引导程序架构，不能用其 PE 头替代 Electron 架构检查。文件头一致性也不能证明动态库齐全或应用可以正常运行。

x64 保留 `build/windows`、`build`、`dist/windows`、`dist/linux`。其他架构使用 `build/windows-arm64`、`build/windows-ia32`、`build/linux-arm64` 和对应 `dist` 目录，防止复用错误架构的构建缓存。已有同架构缓存保留原生成器。CMake 命令优先使用 CMAKE_COMMAND 环境变量，其次使用缓存记录的命令路径，最后从 PATH 查找。脚本不会自动删除缓存。

Windows 产物名为 `WiFiMeter-<版本>-<架构>-Setup.exe` 和 `WiFiMeter-<版本>-<架构>-Portable.exe`。deb 架构名分别使用 amd64、arm64；rpm 和 AppImage 的文件名带 Electron 架构 x64 或 arm64。Portable 指无需安装的启动器，用户数据路径继续由现有主进程决定，不会改为与启动器同目录。

## 性能证据与回归命令

```bash
node --test apps/desktop/tests/backend-client.test.js apps/desktop/tests/system.test.js apps/desktop/tests/windows-packaging.test.js
node --expose-gc packaging/benchmark.cjs c87496f
# 已生成 Linux 包、安装 Playwright，且在对应架构的图形会话中
cd apps/desktop
npx playwright test tests/packaging.spec.js
```

基准比较 Git 提交 c87496f 与工作区，使用 4 MiB JSON、4 KiB 分段，取 5 次中位数。在上述 Windows 环境，IPC 接收从 781.33 ms 降至 6.01 ms；逐段采样的 JavaScript 堆增量从 145.54 MiB 降至 8.22 MiB。该数字来自合成负载和 Node.js，包含堆采样开销，不代表 Electron 常驻内存、RSS 或真实网络采样频率下的收益。大消息仍完整交付，不设置截断上限。

21 次保持自启动开启的设置同步，mkdir/writeFile 各从 21 次降至 1 次，新增 21 次读取。每次核对真实文件，因此外部修改和删除仍会恢复。基准使用临时目录模拟 Linux 自启动文件，不触碰用户现有设置或数据库。

测试还覆盖残缺 IPC 消息后的进程重启、完整 Unicode 内容、CRLF、连续消息、超时和退出、托盘、通知、Windows 登录项，以及架构不一致时拒绝打包。未构建的实际包检查会明确跳过。Linux 图形测试、本机后端集成测试、Windows ARM64/ia32 和 Linux 各格式的安装运行测试仍需在具备依赖的对应环境执行。

已在本地生成 Windows x64 安装包和便携包，单个约 104 MB。运行时只分发英文与简体中文语言资源，不删除业务数据或旧数据迁移逻辑。尚未完成 Linux 全部格式的本地安装验证，不能把 Windows 结果套用到 Linux。

窗口渲染使用统一调度：同一帧内的连续事件合并，原生窗口隐藏或最小化后暂停视觉刷新，仍接收采样增量，恢复后显示最新状态。2026-10-01 在同一虚构数据集的单次 Windows 测量中，隐藏窗口时 Electron 进程 CPU 合计从约 0.289% 降至 0.062%，工作集求和由约 405 MiB 降至 391 MiB。数字存在运行波动，工作集求和可能重复计算共享页，也不包含原生后端；不作为跨设备保证。可使用 `node packaging/measure-runtime.cjs` 复测。

### Live application history updates

`node --expose-gc packaging/benchmark-renderer.mjs 926cefc` compares the previous and current renderer data client with 50,000 synthetic history rows, 100 active applications, and 100 event batches. In one local Node.js run, warmed update processing changed from 11,727.7 ms to 13.2 ms. The improvement comes from looking up only currently active rows instead of scanning the full history for every event. This is a synthetic CPU-time measurement, not an application-wide speedup or memory-reduction claim. The lookup references existing row objects and is cleared on snapshot replacement, data clearing, subscription stop and a change of live day. Historical data is not deleted by this optimization.
