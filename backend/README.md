# C++ 本机后端

此目录是 Windows/Linux 共用的 C++ 后端：两个平台的网络采集、身份识别与断开控制，
与平台无关的业务规则（用量累计、网络键、额度），基于 SQLite 的本地存储，
以及供 Electron 主进程使用的 JSON 协议与 `wifimeter-backend` 可执行程序。

## 当前结构

```text
platform/network_platform.h   平台无关接口与数据类型
platform/network_platform.cpp 频段分类等与平台无关的实现
platform/linux/               Linux 实现（proc/net/dev + nmcli）
platform/windows/             Windows 实现的判断逻辑（不调用 Win32 API）
platform/win32/               Windows 系统调用（WLAN API + IP Helper）
core/                         业务规则：字节格式、本地日历、网络键、用量累计、额度
storage/                      SQLite 结构与仓储：用量记录、网络与额度、偏好设置、覆盖空档
ipc/                          协议、服务逻辑与按平台的输入输出循环
third_party/sqlite/           SQLite 合并源码（Windows 构建使用）
app/                          可执行程序入口（main.cpp / main_windows.cpp）
tests/                        单元测试与真实系统只读冒烟测试
```

`platform/linux/` 的模块划分：

| 文件 | 职责 |
| --- | --- |
| `proc_net_dev.*` | 解析 `/proc/net/dev`，读取每张网卡的累计收发字节 |
| `sysfs_net.*` | 枚举 `/sys/class/net` 下的无线网卡及 `operstate` |
| `nmcli.*` | 子进程调用、terse 输出解析、连接身份查询 |
| `wifi_control.*` | 断开的判定与执行 |
| `linux_network_platform.*` | 组合上述能力，实现 `platform/network_platform.h` |
| `text_file.*` | 文本文件读取与行尾处理 |

`platform/windows/` 与 `platform/win32/` 的分工，是 Windows 侧可测试的关键：

| 文件 | 职责 |
| --- | --- |
| `platform/windows/text_convert.*` | UTF-16 与 UTF-8 的严格转换（代理对、非法序列） |
| `platform/windows/interface_counters.*` | 由 IP Helper 的行转换出累计计数 |
| `platform/windows/wlan.*` | 由 WLAN 状态转换出身份、信号与“是否关联” |
| `platform/windows/system_api.*` | 系统查询接口与采样编排依赖的数据结构 |
| `platform/windows/windows_network_platform.*` | 采样与断开的编排（依赖注入，可在任何平台测试） |
| `platform/win32/wlanapi_query.*` | 真正的系统调用：打开 WLAN 会话、枚举、查询、断开、读计数 |

`platform/windows/` 里的文件不包含任何 Win32 头文件，因此它们的单元测试在 Linux 上原生运行；
`platform/win32/` 里的代码只做字段搬运与错误码分类，逻辑都在被测试覆盖的那一侧。

## 业务规则（core/）

| 文件 | 职责 |
| --- | --- |
| `byte_count.*` | 字节计数与快照约定的十进制字符串（`^(0\|[1-9]\d{0,19})$`）互转 |
| `local_time.*` | 时间点到本地日期／小时／月份键 |
| `network_key.*` | 平台身份到稳定网络键的映射 |
| `usage_accumulator.*` | 累计计数换算为归属某个网络的增量 |
| `quota.*` | 额度周期键、账本滚动与额度状态 |

### 用量累计

平台给出的是网卡的累计计数，记录需要的是增量，因此要保存上一次的基线。难点全在“基线何时失效”：

- **首次见面**只建立基线、不产生增量：进程启动前的流量无从归属。
- **计数回落**（网卡重载、驱动重置）说明这段流量无法估算，丢弃基线并上报 `counterReset`，
  而不是把回落当成一次巨大的负增量或溢出。
- **身份变化**（键或网络名任一不同，含同一份配置匹配到不同 SSID）同样丢弃基线并上报
  `reattributed`：切换瞬间的流量无法判断属于哪个网络。
- **网卡从采样中消失**时按报告是否完整分两种处理：报告完整说明它确实不再关联，
  未关联期间的流量不可归属，直接丢弃基线；报告不完整（例如 `nmcli` 失败）说明情况未知，
  保留基线，超过 `baselineTtl` 仍无消息才丢弃，避免把很久之后的差值算到旧网络上。
- 零增量也会上报，上层据此推进“最后采样时间”；时钟回拨时区间长度按 0 处理。

### 网络键

快照要求 `network.id` 匹配 `^[-a-zA-Z0-9_]+$`，而 SSID 可以含空格、中文与冒号，不能直接当键。
取键优先用连接配置 UUID：跨重启稳定、天然符合字符集，也不受 SSID 改名影响；
拿不到配置 UUID 时才退回 `ssid_` 加 SSID 的 FNV-1a 散列。代价是用户删除并重建 Wi-Fi 配置后
历史会分成两条记录，上层可以按 `ssid` 归并显示。

### 额度

额度按日或月为周期，周期键取本地日期或月份。账本只记录当前周期的累计用量，跨周期时归零再累加，
而不是回头重算历史记录——重算会让记录裁剪（retention）反过来影响额度。`capGb` 按十进制 GB 换算。

## 存储（storage/）

| 文件 | 职责 |
| --- | --- |
| `database.*` | SQLite 连接、语句、事务、结构迁移与在线备份 |
| `usage_repository.*` | 每日用量、小时明细、覆盖空档 |
| `network_repository.*` | 网络条目与额度账本 |
| `settings_repository.*` | 单行偏好设置 |
| `store.*` | 门面：打开数据库，把累计器输出在**一个事务里**落库 |

### 为什么是 SQLite

不是因为数据量大（保留 90 天、几十个网络也只有几万行），而是因为**写入模式**：采集器每几秒就要落一次盘。
示例实现每次采样都把整份历史序列化成 JSON 重写，代价随历史线性增长；这里只做增量累加
（`ON CONFLICT ... DO UPDATE SET rx_bytes = rx_bytes + excluded.rx_bytes`），并由 WAL 与事务保证
掉电时已提交的记录仍然完整。查询也由 SQL 承担：区间查询、按网络过滤、保留期裁剪都是一条语句。

字节数在库里存 64 位有符号整数，而接口层用无符号 64 位：单条记录的用量不可能接近 2^63（约 9.2 EB），
超出即视为数据异常并被拒绝写入，而不是截断或回绕。

### 表结构（v1）

- `daily_usage(network_key, day, rx_bytes, tx_bytes)`：按本地日期归档的用量。
- `hourly_usage(network_key, day, hour, rx_bytes, tx_bytes)`：小时明细，界面“今日”图表用它。
- `networks(key, ssid, alias, cap_gb, warn_percent, quota_period, notify, auto_disconnect, first_seen_at, last_seen_at)`：
  采集只刷新 `ssid` 与 `last_seen_at`，用户设置的备注与额度不会被采集覆盖。
- `quota_ledgers(network_key, period_key, used_bytes)`：当前周期的额度账本。
- `settings(id=1, ...)`：偏好设置，固定只有一行；非法取值在读写时回退到默认。
- `coverage_gaps(network_key, reason, started_at, ended_at, span_seconds)`：**没有采集到数据的区间**。
  界面承诺“缺失记录不会伪装成零流量”，因此暂停、离线、计数器重置、身份变化、网卡断开都会在这里留痕。

结构版本记在 `PRAGMA user_version`；打开时自动迁移，遇到比程序更新的版本会拒绝打开而不是猜着读。

## 接口设计

`platform/network_platform.h` 只有三个方法：`wirelessLinks()`、`sampleWifi()`、`disconnectIfAssociated()`。
几条贯穿始终的约定：

- **平台层不写界面文案**。失败用 `FailureKind` 分类表达（依赖缺失、超时、命令失败、输出无法解析、
  信息矛盾、缺少计数），`detail` 只放原始系统诊断信息供写日志；提示语句由上层决定。
- **未知值用 `std::optional`**，不用 `-1`、空字符串之类的哨兵值。信号强度、频率、SSID 都可能未知。
- **区分“没有网卡”和“网卡未连接”**。`wirelessLinks()` 会返回未关联的网卡，其 `identity.ssid` 为空值；
  由此上层可以还原快照里的 `disconnected` 与 `offline` 等状态。
- **身份分两层**。`profileUuid` 是连接配置的 UUID，跨重启稳定，可直接用作快照 `network.id`
  （满足 `^[-a-zA-Z0-9_]+$`）；`ssid` 是用户认得的网络名，用于展示与备注匹配。平台层不做这个映射。
- **展示名称来自厂商与产品**。`adapterAlias` 取 `GENERAL.VENDOR` 与 `GENERAL.PRODUCT`
  （如 `AICSemi AIC8800DC`），取不到时才退回内核接口名。

## 采集语义

采样正确性的关键是“这次计数属于哪个网络”：

- 只采样已关联的网卡，未关联的网卡不产生样本，也**不算失败**（`complete()` 仍为真）。
- 读取计数前后各做一次身份识别；两次 SSID 不同则丢弃该样本并上报 `inconsistent`，
  避免把切换网络期间的流量记到错误的网络。
- 单张网卡失败不影响其他网卡的样本，失败逐条上报而不是互相覆盖。
- 计数来自内核 `/proc/net/dev`，与 NetworkManager 是否存在无关，因此身份识别失败时
  不会把计数器本身误判为零。
- 内核链路已断开而连接管理器仍报告已激活时，视为身份不可靠，本轮跳过该网卡并上报 `inconsistent`。

## 断开控制

断开是会改变用户网络状态的操作，因此分成三步：

1. **判定**（`decideDisconnect`，纯函数）：只有当前关联的正是期望网络时才允许断开，否则返回
   `notAssociated` 或 `ssidMismatch`，不执行任何命令。
2. **执行**（`requestDisconnect`）：调用 `nmcli dev disconnect`，失败按 `unavailable` 或 `commandFailed` 分类。
3. **复核**：重新读取状态，若仍关联在期望网络上则返回 `stillAssociated`，而不是报告成功。

判定与执行之间仍存在极短的时间窗口（用户在此期间切换网络），复核会把它暴露出来而不是掩盖。

## 语言环境

`nmcli` 的状态文字与是否列会随语言环境变化（`connected`/`已连接`、`yes`/`否`），
而连接名与 SSID 是原样输出的 UTF-8 用户数据。实测 `LC_ALL=C` 会把用户数据里的非 ASCII 字符
换成 `?`（`有线连接 1` 变成 `???? 1`），因此本实现保留调用方的语言环境，
只解析与语言环境无关的部分：ASCII 字段名、状态码数字、以及 SSID 原文匹配。

## 构建与测试

编译产物进入仓库根目录 `build/`（Windows 为 `build/windows/`），不提交生成文件。

```bash
npm run test:backend     # 本机（Linux）构建并跑 ctest
npm run test:windows     # 交叉编译 Windows 目标并在 Wine 下运行全部测试
npm run build:backend:windows
```

`test:backend` 等价于：

```bash
cmake -S backend -B build
cmake --build build
ctest --test-dir build --output-on-failure
```

测试包含三层：

- **平台无关**：业务规则、存储、协议、以及 Windows 的转换与采样编排（用假系统数据）；
  这些用例在任何平台上都构建并运行，包括在 Linux 上验证 Windows 目标的编码、时区与位宽问题；
- **Linux 平台**：用真实 `nmcli` 与 `/proc/net/dev` 输出作为样本，配以临时目录构造的假 sysfs 与假 `nmcli`；
- **真实系统只读冒烟**：读取当前机器的网卡状态与计数，不断开任何连接。
  真实断开只在身份守卫通过时才可能发生，因此自动测试只断言“拒绝断开”的分支。

Windows 系统调用（WLAN API、IP Helper）无法在 Linux 上执行，只能交叉编译验证它们能通过编译，
行为验证放在 Windows 实机（见 `packaging/windows/README.md` 的验收清单）。

## 尚未完成

- 应用级流量统计（界面“应用分布”）：需要按进程归属 socket 流量，成本高，暂缓。
- 备份与恢复目前只有数据库级备份（`Store::backupTo`），界面需要的“完整备份 / 流量导出”文件格式待定。
- Linux 每轮采样会启动多个 `nmcli` 子进程（身份识别前后各一次，每张已关联网卡再由扫描结果取信号与频段）；
  后续可改为订阅 NetworkManager 的 D-Bus 信号以减少开销。
- Linux 真实断开需要 polkit 授权；尚未在已关联的网卡上验证过真实断开与复核。
- Windows 的频段报告为未知：Win32 不通过 WLAN API 暴露当前信道，需要额外的
  原生 Wi-Fi 调用（`wlan_intf_opcode_channel_number` 在部分驱动上才可用）才有数据。
- Windows 侧尚未在真实无线网卡上验证过断开与自动重连的复核行为。
