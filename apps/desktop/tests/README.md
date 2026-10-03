# 测试分层

- `*.test.js`：页面数据、视图、桌面桥契约与构建资源的 Node 单元测试。
- `*.spec.js`：Playwright 浏览器回归。`support/renderer-harness.mjs` 使用真实 C++ 后端、独立 SQLite 数据和生产 `renderer/host/bridge.js`；系统文件选择与窗口事件由夹具提供。
- `e2e/smoke-linux.mjs`：真实 WebKitGTK 窗口、系统能力及随包资源。
- `e2e/smoke-windows.mjs`：真实 WebView2、浮窗、原生图标、双语弹窗、更新恢复、自启动隔离和单实例。
- `e2e/smoke-package-windows.mjs`：真实发布包，清除后端路径覆盖后检查随包采集器。
- `../src-tauri/tests/` 与 Rust 内联测试：生产宿主的协议、迁移、原子文件操作、偏好、更新交接及平台规则。

原生窗口行为不由浏览器夹具模拟。原 Electron 原生测试由上述 Rust 与 Tauri e2e 测试接替，浏览器测试保留页面布局、焦点、自动保存、历史筛选、导出、备份恢复和事件更新回归。

```sh
npm run build:backend
npm --prefix apps/desktop exec -- playwright install chromium
npm run test:unit
npm run test:ui
```

两端宿主构建与端到端测试命令见 [桌面说明](../README.md)。测试失败时不得把缺少后端、浏览器或系统运行库当作通过。
