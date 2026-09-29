# 项目架构

共享的 Electron 桌面应用位于 `apps/desktop/`，同一套页面和宿主代码面向 Windows/Linux。真实网络采集与业务存储将由本机 C++ 后端负责。

## 当前数据流

```text
renderer/app.js → data/client.js → data/mock.js
       └────────────────────────→ data/model.js（校验与计算）
页面 → preload → Electron 主进程 → 系统文件对话框
```

`client.js` 的 `createDataClient(storage, clock)` 返回现有同步数据对象，保留 `snapshot`、`storageFailed`、设置修改、保存、恢复、暂停和模拟刷新等调用方式。页面不直接创建 `DemoStore`。数据定义与计算放在 `model.js`，示例实现放在 `mock.js`。

当前没有 C++ 可执行程序或请求/响应协议。后续接入时，由 Electron 主进程管理后端进程、通信和退出；preload 暴露必要能力，页面的数据适配层处理异步请求与快照更新。历史、额度和网络设置届时以 C++ 后端为准。

## 职责边界

| 模块 | 职责 |
| --- | --- |
| 页面 | 展示、输入、筛选、交互状态 |
| Electron | 窗口、桌面能力、文件对话框、未来的后端进程管理 |
| C++ 后端 | 真实采集、累计、额度判断、业务存储 |
| 平台适配 | 隔离 Windows/Linux 系统 API |
| contracts | 描述前后端需要共享的数据与协议约定 |
| packaging | 按系统组装安装包 |

只有实际出现平台差异时才在宿主或后端中增加平台适配代码。当前不创建空组件、空 CMake 工程或未实现的通信类。

## 构建与旧版隔离

根目录 npm 命令转发到桌面应用，锁文件与依赖保留在应用目录。Linux 先由 electron-builder 组装 `dist/linux/linux-unpacked/`，再由 `packaging/linux/build-deb.mjs` 生成 deb。Windows 本机构建由 `packaging/windows/build.cjs` 调用 NSIS，输出到 `dist/windows/`，使用独立的 Demo 产品身份。平台配置分别位于 `packaging/linux/` 和 `packaging/windows/`，Windows 不读取 Linux 的运行组件路径。未来 C++ 中间产物使用根目录 `build/`，不提交生成文件。

原 Windows 项目整体位于 `legacy/windows/`，保留自身的 `src/`、`tools/`、`tests/`、`docs/` 及相对路径。旧脚本的输出仍在归档目录内的 `dist/` 和 `artifacts/`。根目录 `.github/workflows/` 中现有工作流只负责该旧版；原分支、PR 和标签触发规则保持不变。
