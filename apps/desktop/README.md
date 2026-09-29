# WiFiMeter 共享桌面应用

此目录包含 Windows/Linux 共用的 Electron 宿主和页面。页面数据来自本机后端进程（`backend/`）：主进程拉起 `wifimeter-backend`，按行交换 JSON，后端把采集结果写入本机 SQLite 数据库。

从仓库根目录运行：

```bash
npm ci --prefix apps/desktop
npm start
npm test
npm run dist:linux
```

也可进入此目录执行 `npm start`、`npm test` 和 `npm run dist:linux`。Linux 产物位于仓库根目录 `dist/linux/`；Windows 本机执行 `npm run dist:windows`，产物位于 `dist/windows/`。详见 [Windows 构建说明](../../packaging/windows/README.md)。

## 模块

- `electron/`：窗口、后端进程管理（`backend.cjs`）、受限 preload 接口、桌面文件读写。
- `renderer/app.js`、`index.html`、`styles.css`：页面与交互。
- `renderer/data/model.js`：快照校验、日期、单位和用量计算。
- `renderer/data/backend-client.js`：与后端通信的数据客户端，就地更新快照并接收事件。
- `renderer/data/client.js`：页面创建数据对象的统一入口。
- `renderer/data/mock.js`：示例数据生成，仅用于单元测试，不再被页面使用。
- `assets/`：应用图标。
- `tests/`：数据与文件操作单元测试、Electron 界面测试。

桌面桥通过只读的 `appName` 提供当前平台产品名，文件操作公开 `saveFile({ filename, body })` 和 `openBackup()`（取消返回 `canceled: true`，失败返回 `error`），后端通信公开 `backend.request(method, params)` 与 `backend.onEvent(handler)`。

后端失败以 `{ ok: false, error: { code, message } }` 返回而不是抛出：Electron 跨进程只保留错误消息，抛出会丢掉错误码，而页面需要靠错误码决定提示文案。

## 数据存放

历史、网络备注、额度与偏好都存在用户数据目录下的 `wifimeter.db`（SQLite）。备份文件标记为 `wifimeter-backend-backup`，恢复前会校验该标记，避免把流量导出文件当成完整备份。

Windows 使用名称 `WiFiMeter Demo`、应用标识 `io.wifimeter.demo` 和独立数据目录 `%APPDATA%\WiFiMeter Demo`，避免覆盖旧版数据；后端默认数据库位于 `%LOCALAPPDATA%\WiFiMeter\wifimeter.db`，主进程始终显式传入 `--db`，因此界面与后端用的是同一个文件。

完整备份包含记录、备注、额度和偏好；恢复后采集暂停，避免当前计数差立刻覆盖刚恢复的历史。CSV/JSON 流量导出不能代替完整备份。自启动与托盘开关会写入系统（Windows 用“启动”目录，Linux 用 `~/.config/autostart`），额度提醒转成系统通知，超额断开由后端核对网络身份后真实执行。

## 后端进程

`electron/backend.cjs` 按平台查找后端可执行文件：`WIFIMETER_BACKEND` 环境变量优先，其次是打包后的 `resources/wifimeter-backend(.exe)`，最后是开发目录 `build/app/`（Linux）或 `build/windows/app/`（Windows）。Windows 上不检查可执行位（该系统没有这个概念）。

后端退出或启动失败时不会让界面永久失联：下一次请求会自动重新拉起。数据库路径始终由主进程显式传给后端，两个进程不会各用一份数据。

## 测试打包程序

从仓库根目录、在 Linux 图形会话中执行：

```bash
WIFIMETER_EXECUTABLE="$PWD/dist/linux/linux-unpacked/wifimeter" npm run test:ui
```

在 Windows PowerShell 中：

```powershell
$env:WIFIMETER_EXECUTABLE = (Resolve-Path '.\dist\windows\win-unpacked\WiFiMeter Demo.exe').Path
npm run test:ui
```

截图和失败时的跟踪文件位于此目录的 `test-results/`。测试使用临时配置目录。
