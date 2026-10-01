# CI 与发布矩阵

## 当前状态

工作流已配置五组原生构建目标，并在本地验证了工作流语法、发布清单校验和 UI 结果检查。尚未触发 GitHub Actions，也没有创建标签或发布 release。下表描述必须执行的验证流程，不代表这些 hosted runner 已通过实测。

| 目标 | GitHub runner | Node.js 架构 | Electron runtime | CMake 目标 | 发布格式 |
| --- | --- | --- | --- | --- | --- |
| Windows x64 | windows-latest | x64 | 44.4.5 | x64 | NSIS Setup.exe、Portable.exe |
| Windows ia32 | windows-latest | x86 | 43.7.7 兼容分支 | Win32 | NSIS Setup.exe、Portable.exe |
| Windows ARM64 | windows-11-arm | arm64 | 44.4.5 | ARM64 | NSIS Setup.exe、Portable.exe |
| Linux x64 | ubuntu-24.04 | x64 | 44.4.5 | Ubuntu 22.04 容器 / Ninja | deb、rpm、AppImage |
| Linux ARM64 | ubuntu-24.04-arm | arm64 | 44.4.5 | Ubuntu 22.04 容器 / Ninja | deb、rpm、AppImage |

Electron 44.4.5 官方 win32-ia32 资产不存在，因此 Windows ia32 单独固定 Electron 43.7.7。x64/ARM64 使用 44.4.5，不宣称同一个 Electron runtime 覆盖全部架构。ia32 兼容分支的后续升级需要再次核实官方资产及测试结果。

Windows ia32 在 x64 runner 上执行 32 位 Node、Electron、后端和测试程序；Python 使用宿主 x64。这验证了 Windows x64 的 32 位兼容执行环境，不等于已在独立的 32 位 Windows 系统上验收。ARM64 不回退到 x64 仿真目标。仓库若无法使用指定 ARM runner，任务会等待或失败，不能作为已支持的平台发布。

## 分支验证

`Integration CI and release` 在 integration-1.2.0、main、cross-platform、feature/** 的 push，以及 pull_request 和手动运行时验证。Windows 工作流仅保留 workflow_call，由这个入口调用，不再单独响应 main/integration 的 push 或 PR。旧 cross-Wine 自动任务已移除，由五组原生矩阵覆盖必需检查；一次提交不会再自动运行第二套重复工作流。

每个架构执行完整 C++ 后端构建和 CTest，运行实际后端的 `--version` 并与桌面 package metadata 比较。Node 单元测试设置正确的 `WIFIMETER_BACKEND`，使后端协议与数据库测试使用目标架构程序。所有路径从 packaging/targets.cjs 生成。

原生采集验证为必需步骤。Windows 使用 `windows_app_capture_smoke.py --require-native`；非原生环境或缺少管理员权限直接失败。Linux 的非特权 CTest 排除会返回 77 的采集 smoke，随后单独使用 sudo 运行真实 eBPF 测试，非零退出均失败。这里验证本机回环上的 TCP/UDP、IPv4/IPv6 采集，不能代替真实无线网卡、驱动及断网策略验收。

UI 使用真实 Electron、真实后端和现有网卡/计数夹具。开发态执行 desktop、renderer-backend、renderer-history 三组 Playwright spec；打包后执行四个页面的夹具 smoke。Linux 使用 Xvfb 和独立 D-Bus 会话。测试报告必须有实际通过的用例，skipped、unexpected、flaky 和全局错误均为零。Windows ARM runner 若不能启动 Electron 或没有可用图形环境，任务明确失败；不会跳过 UI 后继续发布。

## 产物验证

Windows 构建 NSIS 和 Portable，核对解包目录中 Electron、后端、采集辅助程序的 PE 架构，运行随包后端 `--version`，比较 asar 外 AppNetworkControl.psm1 与源码内容，并运行打包后 Electron。发现 smoke 在实际 Electron 主进程读取 process.platform、process.arch、process.versions.electron，并要求 app.isPackaged 为真：ia32 必须实际运行 43.7.7/ia32，不能拿开发态或 x64 runtime 替代。安装器和便携启动器检查 PE 标记；CI 没有执行 NSIS 安装/卸载，也不将解包目录测试描述为安装验收。本轮保留主线程新增的 installer.nsh 和 stop-legacy.ps1；构建会使用现有 NSIS 配置，Node 单元测试按整个 tests/*.test.js 集合执行，但这不代替安装器与旧 collector 保存握手的实机验收。

Linux 每种格式必须真正生成，再分别解包。deb 核对包内版本和 Debian 架构；rpm 核对 RPM 架构。三个格式均检查包内 ELF 架构、后端运行版本、BPF 对象和许可证，并启动各自包内的 Electron 做夹具 smoke。AppImage 通过自身 `--appimage-extract` 解包，避免把 FUSE 挂载是否可用混入基础验证；FUSE 启动方式仍需目标机验收。另外在两种系统上运行语言无关的打包发现 smoke：移除后端路径和假采集环境变量，确认 app.isPackaged 为真，并通过主进程完成后端 hello 握手。现有 packaging.spec.js 含默认中文界面断言，不作为这个发现检查的替代，也不会把它的跳过计为成功。

只有本架构所有构建、测试和格式验证均成功，才把产物复制到 RUNNER_TEMP 下的发布暂存目录，生成应用版本、Electron runtime 版本、架构、文件大小和 SHA-256 清单，然后上传 release-* artifact。失败日志使用单独的 diagnostics-* 名称，不进入发布清单。未通过的格式不会上传为可发布产物；当前策略也不会从失败矩阵中挑选部分格式公开发布。

## 发布条件与权限

只有 push 的 v1.2.* 标签可以进入 publish，PR、普通分支 push 和手动运行不会发布。标签必须等于 `v` 加桌面 package metadata 的版本，且 `docs/releases/${tag}.md` 已存在、非空。发布版本和产物名均由 metadata 读取，没有固定为某次旧版本。

publish 显式依赖 metadata、Windows 全矩阵、Linux 全矩阵和 Required integration checks。汇总任务把失败、取消、跳过均视为未完成。发布前再次验证五组清单齐全、版本一致、十二个预期文件齐全且 SHA-256 匹配，才调用 GitHub CLI 的 `--verify-tag --notes-file` 创建草稿并上传全部文件，最后公开草稿。

重复运行不会自动覆盖已存在的 release。若上传中途失败并留下草稿，应先检查该草稿，再决定如何处理；不能把它视为已公开的完整发布。预发布标签还需检查打包工具对 deb/rpm 版本的规范化行为，工作流不会绕过版本验证。

默认权限仅 `contents: read`，checkout 不持久保存凭据；没有 pull_request_target、个人令牌或签名凭据。只有 publish job 提升为 `contents: write`，发布步骤仅使用当前运行的 `GITHUB_TOKEN`。GitHub runner 自带的构建工具和 gh CLI 不额外下载安装。

## 固定依赖与 Linux 基线

- Actions 固定为官方提交 SHA：checkout 4.2.2、setup-node 4.4.0、setup-python 5.6.0、upload-artifact 4.6.2、download-artifact 4.3.0。SHA 已对照各官方仓库标签核实。
- Node.js 固定 22.22.0。官方发布校验清单包含 Windows x86/x64/ARM64 和 Linux x64/ARM64。24.14.1 没有 Windows x86 安装包，因此不用于这套统一矩阵。
- Python 固定 3.13.7，使用 actions/python-versions；各 hosted runner 的下载及运行仍待实际 CI 验证。
- npm 使用已提交的 package-lock.json 和 npm ci。Windows ia32 使用 npm ci --ignore-scripts 安装锁定依赖，再由锁定的官方 @electron/get 下载 43.7.7/ia32 并校验官方 SHASUMS256.txt，使用 runner 的 PowerShell 解包。夹具通过 ELECTRON_OVERRIDE_DIST_PATH 使用这个实际 ia32 runtime，避免 Electron 44 的自动下载和缺少 ia32 预编译绑定的解包器；仅写入 CI 生成的 node_modules/electron/path.txt，不修改已提交的 package metadata。打包仍调用现有 packagingConfig 的 43.7.7 覆盖配置，并独立验证包内 runtime。其他架构、Playwright、electron-builder 继续随锁文件固定；不使用 npx 临时下载最新版。
- actionlint 固定 1.7.12，使用官方 release 包并验证固定 SHA-256。
- Linux apt 使用 Ubuntu 官方 `20261001T000000Z` 快照；clang 明确使用 clang-18。没有个人 PPA、无版本 curl 安装脚本或临时安装最新版 gem。electron-builder 26.15.3 的官方工具清单已固定 FPM 1.17.0/Ruby 3.4.3 和 AppImage 工具版本与校验和，包含 ARM64 对应路径。

两个 Linux runner 在 Ubuntu 22.04 容器中编译后端，并在 Ubuntu 24.04 宿主验证。后端检查 glibc 依赖不超过 2.35，libbpf 1.3.3 按源码校验值固定并静态链接；同时保留 SQLite、libelf、zlib、pkexec、桌面运行库等依赖。deb 的依赖声明沿用项目配置；rpm 依赖名针对 Fedora 系列，但本流程在 Ubuntu 上仅解包运行，尚未证明 Fedora/RHEL 的包管理安装兼容性。

Windows 和 Ubuntu hosted runner 镜像会更新；固定下载版本和 Ubuntu 快照不等于固定整个 runner 镜像，也不保证二进制逐字节可复现。快照需定期审查、更新，并验证与 runner 预装包的依赖关系，失败时不能静默切回滚动仓库。

后端采用 glibc 2.35 构建基线；完整应用仍需目标发行版的 Electron、桌面库和内核采集支持。AppImage 不会自动消除这些要求，不能仅凭格式宣称所有 Linux 发行版均兼容。

## 本地可运行检查

```text
node --test .github/workflows/scripts/ci.test.cjs
actionlint
```

完整验证须由上述 runner 实际执行。目前尚不能确认 Windows ARM64/ia32 的 UI、ETW，以及 Linux ARM64 的 eBPF、rpm/AppImage 构建与启动结果；Windows x64 和 Linux x64 的新工作流也尚未在 hosted runner 上运行。Release 会在这些必需任务全部成功之后才公开。

参考：[Ubuntu 官方快照说明](https://snapshot.ubuntu.com/)、[Node.js 22.22.0 官方校验清单](https://nodejs.org/dist/v22.22.0/SHASUMS256.txt)、[GitHub hosted runners](https://docs.github.com/en/actions/reference/runners/github-hosted-runners)、[actionlint 1.7.12](https://github.com/rhysd/actionlint/releases/tag/v1.7.12)。

## Linux compatibility build baseline

The release pipeline builds the C++ backend in an architecture-matched Ubuntu 22.04 container pinned by its multi-architecture image digest. libbpf 1.3.3 is statically linked from its checksum-verified upstream source. CTest runs in that userspace and again on the Ubuntu 24.04 host; native eBPF and Electron UI tests remain mandatory on the host. Packages use `--skip-rebuild` with PE/ELF architecture checks so packaging cannot silently raise the backend ABI baseline. The backend GLIBC requirement is checked against 2.35. Full distribution compatibility still depends on Electron, desktop libraries and kernel capture support; Debian/RPM package format alone is not a compatibility guarantee.
