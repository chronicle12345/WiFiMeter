# 项目架构

共享的 Electron 桌面应用位于 `apps/desktop/`，同一套页面和宿主代码面向 Windows/Linux。真实网络采集与业务存储由本机 C++ 后端负责，两个平台层都已实现。

## 当前数据流

```text
renderer/app.js → data/backend-client.js → preload → Electron 主进程 → wifimeter-backend（子进程，按行 JSON）
       └──────────────────────────────────→ data/model.js（校验与计算）
页面 → preload → Electron 主进程 → 系统文件对话框
                                 → 开机启动、托盘、系统通知
```

`client.js` 是页面创建数据对象的唯一入口：有桌面桥时用 `backend-client.js`，没有时（例如浏览器里跑单元测试）退回 `mock.js`。数据定义与计算放在 `model.js`。

主进程用 `electron/backend.cjs` 拉起后端并按 id 配对请求与响应，事件（`live`、`usage`、`alert`）单独推送；后端的失败以 `{ ok: false, error }` 形式回给页面，而不是抛异常，因为跨进程只保留错误消息、会丢掉页面用来决定文案的错误码。历史、额度和网络设置以 C++ 后端为准。

## C++ 后端

`backend/platform/network_platform.h` 定义平台无关的采集、身份识别与断开控制接口，两个实现：

| 实现 | 计数来源 | 身份来源 | 断开方式 |
| --- | --- | --- | --- |
| `backend/platform/linux/` | `/proc/net/dev` | `nmcli`（只解析与语言环境无关的部分） | `nmcli dev disconnect` + 复核 |
| `backend/platform/win32/` | IP Helper `GetIfTable2` | WLAN API `WlanQueryInterface` | `WlanDisconnect` + 轮询复核 |

接口只报告事实与类型化失败，不生成界面文案；读取计数前后各确认一次身份，期间切换网络则丢弃样本；断开先判定、再执行、最后复核，只在关联到期望网络时才动手。

Windows 的实现分成两层，这是它可测试的关键：

```text
platform/win32/      只做系统调用与字段搬运（WlanOpenHandle、GetIfTable2、WlanDisconnect）
platform/windows/    采样与断开的判断逻辑，通过 SystemApi 依赖注入，不调用任何 Win32 API
```

因此“采样期间换网要丢弃样本”“断开异步生效要轮询到超时”“未关联不算失败”等判断在 Linux
开发机上就能验证；`platform/win32/` 只剩机械代码。身份字段（UTF-16 → UTF-8、代理对、非法字节）
与计数器转换同样在 `platform/windows/` 里，不依赖 Windows 类型。

`core/` 实现与平台无关的业务规则：字节格式转换、本地日历键、网络键映射、用量累计与额度。用量累计的重点是决定“基线何时失效”——计数回落、身份变化、网卡从完整报告中消失都丢弃基线并上报类型化事件，避免把无法归属的流量记到错误的网络。

`storage/` 用 SQLite 落盘：采集每几秒写一次，只做增量累加而不是重写整份历史；每日用量、小时明细、网络与额度账本、偏好设置各一张表，另有一张 `coverage_gaps` 记录“没有采集到数据的区间”，让界面能兑现“缺失记录不会伪装成零流量”。Linux 用系统 `libsqlite3`，Windows（含交叉编译）用 `backend/third_party/sqlite` 的合并源码。

`ipc/` 是协议与事件循环：请求 `{id, method, params}`、响应 `{id, ok, result|error}`、事件 `{event, ...}`。输入输出循环按平台选择——POSIX 用 `poll` 同时等待标准输入与采样定时器，Windows 用 `WaitForSingleObject` 等待管道句柄——协议与业务逻辑完全共用。

## 职责边界

| 模块 | 职责 |
| --- | --- |
| 页面 | 展示、输入、筛选、交互状态 |
| Electron | 窗口、桌面能力、文件对话框、后端进程管理 |
| C++ 后端 | 真实采集、累计、额度判断、业务存储 |
| 平台适配 | 隔离 Windows/Linux 系统 API |
| contracts | 描述前后端需要共享的数据与协议约定 |
| packaging | 按系统组装安装包 |

只有实际出现平台差异时才在宿主或后端中增加平台适配代码。

## 构建与旧版隔离

根目录 npm 命令转发到桌面应用，锁文件与依赖保留在应用目录。

- **Linux**：`npm run dist:linux` 先构建后端，再由 electron-builder 组装 `dist/linux/linux-unpacked/`，最后由 `packaging/linux/build-deb.mjs` 生成 deb。
- **Windows（本机）**：`npm run dist:windows` 用本机 CMake 构建后端，再由 electron-builder 调用 NSIS，输出到 `dist/windows/`。
- **Windows（在 Linux 上交叉编译）**：同一个入口改用 `packaging/windows/build-backend.mjs`（Zig 工具链）与便携版 Wine；工具链与缓存都在 `.cross-build/` 下，不提交。

C++ 中间产物位于根目录 `build/`（Linux 在 `build/`，Windows 在 `build/windows/`），安装包随包分发对应的 `wifimeter-backend` 可执行文件。Windows 使用独立的应用标识与数据目录，不读取 Linux 的运行组件路径。

两个平台的产品名统一为 `WiFiMeter`：Windows 沿用应用标识 `io.wifimeter.demo`
与数据目录 `%APPDATA%\WiFiMeter Demo`；Linux 使用 `WiFiMeter` 与标准的 XDG 目录。
身份定义集中在 `apps/desktop/electron/product.cjs` 并有单元测试；显示名称更新时保留
Windows 的原有应用标识与数据路径，使升级后仍能读取已有记录。

数据目录之外，应用不写入任何用户可见的位置；`.github/workflows/` 下只有两条工作流：
`desktop.yml`（Linux 上的后端测试与 Windows 交叉编译）与 `windows-app.yml`（Windows 本机
构建、测试与打包）。
