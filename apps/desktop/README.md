# WiFiMeter 共享桌面应用

此目录包含 Windows/Linux 共用的 Electron 宿主和页面。当前只使用示例数据，Linux deb 和 Windows 本机 NSIS 打包入口已提供；真实采集尚未实现。

从仓库根目录运行：

```bash
npm ci --prefix apps/desktop
npm start
npm test
npm run dist:linux
```

也可进入此目录执行 `npm start`、`npm test` 和 `npm run dist:linux`。Linux 产物位于仓库根目录 `dist/linux/`；Windows 本机执行 `npm run dist:windows`，产物位于 `dist/windows/`。详见 [Windows 构建说明](../../packaging/windows/README.md)。

## 模块

- `electron/`：窗口、受限 preload 接口、桌面文件读写。
- `renderer/app.js`、`index.html`、`styles.css`：页面与交互。
- `renderer/data/model.js`：快照校验、日期、单位和用量计算。
- `renderer/data/mock.js`：示例生成、本地保存、设置修改与模拟采样。
- `renderer/data/client.js`：页面创建数据对象的统一入口，目前返回同步示例实现。
- `assets/`：应用图标。
- `tests/`：数据与文件操作单元测试、Electron 界面测试。

桌面桥通过只读的 `appName` 提供当前平台产品名，文件操作公开 `saveFile({ filename, body })` 和 `openBackup()`。取消返回 `canceled: true`，失败返回 `error`；没有后端通信方法。

## 数据兼容

Linux 保留应用名称、应用标识、包名 `wifimeter-linux`、存储键 `wifimeter-linux-demo-v1` 和备份标记 `wifimeter-ui-demo`，不会因目录改名重置已有设置。历史名称是兼容标识，不限制共享代码支持的平台。

Windows 使用名称 `WiFiMeter Demo`、应用标识 `io.wifimeter.demo` 和独立数据目录 `%APPDATA%\WiFiMeter Demo`，避免覆盖旧版数据。

记录使用 Electron 用户数据目录中的本地存储。完整备份包含记录、备注、额度和偏好；恢复后暂停模拟统计。CSV/JSON 流量导出不能代替完整备份。自启动与托盘选项仅保存偏好，关闭窗口即退出；超额断开只改变模拟状态。

## 测试打包程序

从仓库根目录、在 Linux 图形会话中执行：

```bash
WIFIMETER_EXECUTABLE="$PWD/dist/linux/linux-unpacked/wifimeter" npm run test:ui
```

截图和失败时的跟踪文件位于此目录的 `test-results/`。测试使用临时配置目录。
