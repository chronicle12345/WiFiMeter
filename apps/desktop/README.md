# WiFiMeter 桌面应用

Windows 和 Linux 共用原有页面，Tauri/Rust 提供窗口、托盘、双语弹窗、文件操作、自启动、通知和更新；C++ 子进程负责采集及 SQLite 存储。运行时不需要 Node.js。

## 目录

| 目录 | 职责 |
| --- | --- |
| `renderer/` | 页面、样式、数据模型及渲染客户端 |
| `renderer/host/` | 桌面桥、退出检查、跟随主题和语言的弹窗 |
| `renderer/mini/` | 与主界面共享样式和速率格式的浮窗 |
| `src-tauri/src/collection/` | 后端协议、采集会话与旧数据迁移 |
| `src-tauri/src/desktop/` | IPC、主窗口、浮窗、托盘和对话框 |
| `src-tauri/src/update/` | 版本判断、下载校验与安装流程 |
| `src-tauri/src/platform/` | Windows / Linux 系统能力 |
| `native/windows/` | 嵌入 Rust 宿主的应用网络控制模块 |
| `scripts/` | 开发入口及前端构建 |
| `tests/` | 页面与桥接测试；`e2e/` 为系统 WebView 测试，`support/` 为夹具 |

整体数据流及职责见[架构说明](../../docs/ARCHITECTURE.md)。构建输出进入 `dist/tauri/` 和 `src-tauri/target/`，发布包进入仓库根目录 `dist/`。

## 开发与测试

安装 Node.js 24、Rust 和[平台依赖](../../packaging/README.md)，在仓库根目录运行：

```sh
npm ci --prefix apps/desktop
npm run build:backend
npm start
```

开发入口选择 `build/app/wifimeter-backend`（Linux）或 `build/windows/app/wifimeter-backend.exe`（Windows）。`WIFIMETER_BACKEND` 可覆盖路径；`WIFIMETER_USER_DATA` 可指定独立数据目录。打包只在 Linux 执行，见[三个打包入口](../../packaging/README.md)。

```sh
npm --prefix apps/desktop exec -- playwright install chromium
npm run test:unit
npm run test:rust
npm run test:ui
```

测试分层见 [tests/README.md](tests/README.md)。Rust 核心测试不依赖 GTK；需要真实后端的测试显式启用：

```sh
WIFIMETER_BACKEND="$PWD/build/app/wifimeter-backend" \
  cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml --features test-fixture -- --include-ignored
```

Linux 原生界面测试需要图形会话、会话 D-Bus、中文字体及 `webkit2gtk-driver`：

```sh
npm --prefix apps/desktop run build:frontend
cargo build --manifest-path apps/desktop/src-tauri/Cargo.toml --features custom-protocol,test-fixture --bin WiFiMeter
WIFIMETER_EXECUTABLE="$PWD/apps/desktop/src-tauri/target/debug/WiFiMeter" \
WIFIMETER_BACKEND="$PWD/build/app/wifimeter-backend" \
  dbus-run-session -- node apps/desktop/tests/e2e/smoke-linux.mjs
```

Windows 调试宿主也在 Linux 交叉编译：

```sh
cargo build --manifest-path apps/desktop/src-tauri/Cargo.toml --target x86_64-pc-windows-gnu --features custom-protocol,test-fixture --bin WiFiMeter
```

随后用 Windows Node 运行测试：

```powershell
$env:WIFIMETER_EXECUTABLE = (Resolve-Path 'apps/desktop/src-tauri/target/x86_64-pc-windows-gnu/debug/WiFiMeter.exe').Path
$env:WIFIMETER_BACKEND = (Resolve-Path 'build/windows/app/wifimeter-backend.exe').Path
node apps/desktop/tests/e2e/smoke-windows.mjs
```

Windows 拖拽和悬停检查需要可接受鼠标定位的输入桌面。`--skip-native-input` 明确跳过这三项并在输出中标记；不能把该结果算作完整输入验收。CDP 只在测试进程启用。更新夹具只存在于启用 `test-fixture` 的隔离调试构建中，不执行安装器。隔离测试不会修改真实登录项或发送真实通知。

发布目录测试使用 Linux 脚本的 `--packaged` 参数，或 Windows 的 `e2e/smoke-package-windows.mjs`。两者都清除被测应用的后端路径覆盖，验证随包资源。安装、升级和卸载的人工检查见 [Windows 验收](../../packaging/windows/ACCEPTANCE.md)。

## 数据与接口

Windows 沿用 `%APPDATA%\WiFiMeter Demo` 与 `io.wifimeter.demo`，Linux 沿用 `$XDG_CONFIG_HOME/WiFiMeter`（默认 `~/.config/WiFiMeter`）。产品显示名称统一为 WiFiMeter。宿主始终向采集器传入明确的 `--db` 路径；已有数据库和窗口偏好可继续读取。

数据库位置可在「设置 → 数据与存储」中更改，桌面通道为 `data-location:read|choose|reset`（桥接对象 `window.desktop.dataLocation`）。自定义位置记录在配置目录的 `data-location.json`，指针与数据位置分开，因此数据目录丢失时仍能回退；`WIFIMETER_USER_DATA` 隔离目录内同样带指针文件，测试互不影响。`src-tauri/src/data_location.rs` 负责校验目标目录、复制数据库（含 `-wal`）、校验结果、归档同名文件与写指针；`Collector::relocate_database` 在一次写锁内完成「暂停 → 停止后端 → 换 `--db` → 复制并写指针 → 恢复采集」，失败退回原路径与采集状态。目标已有数据库时由宿主弹窗选择采用或替换，替换前把目标库归档为 `wifimeter.db.replaced-<UTC 时间戳>`；自定义目录不可用时启动弹窗提供重新选择、本次运行使用默认位置或保持现状。窗口偏好、迁移备份、更新下载和 WebView 数据仍留在默认配置目录。

`renderer/data/client.js` 选择真实后端客户端或浏览器 mock。`window.desktop` 保留原有请求、事件、文件保存/打开及偏好接口；取消仍作为独立结果返回。后端错误保留错误码，页面按当前语言显示文案。浮窗只能调用自身窗口操作，不能直接访问后端或文件接口。

全量 JSON 备份带 `wifimeter-backend-backup` 标记；CSV 用于导出，不能作为完整备份恢复。恢复前暂停采集。旧数据导入保留原文和恢复备份，重叠日期需明确选择；后端异常重启会恢复最后确认的暂停及应用采集状态。

显示单位使用十进制或 IEC 自动缩放，最多两位小数并去掉尾零；测量值 0 与缺失 `—` 区分。图表共用按峰值选择的单位，CSV 使用所选 GB/GiB 单位和六位小数。

应用采集每次会话需要启用，关闭不会删除历史。权限失败及采集缺失与总流量分别记录。Windows 应用防火墙/上传限速复用原有 PowerShell 模块，Linux 仍不支持此功能；Linux 更新通过发布页手动安装。见 [Linux 采集](../../docs/LINUX_APP_CAPTURE.md)和 [Windows 采集](../../docs/WINDOWS_APP_CAPTURE.md)。
