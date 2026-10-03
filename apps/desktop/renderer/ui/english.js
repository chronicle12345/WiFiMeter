// 文案键沿用中文原文。只翻译源码里的静态文本，不扫描或改写用户数据。
export const english = Object.fromEntries(`
采集详情|Collection details
正在下载安装包…|Downloading installer…
正在校验安装包…|Verifying installer…
正在保存数据并准备安装…|Saving data and preparing installation…
正在启动安装程序…|Starting installer…
后续安装进度将在安装程序中显示。|Further installation progress is shown in the installer.
更新失败。|Update failed.
本地 TCP|Local TCP
本地代理连接 · 实时速度不计入 Wi-Fi 总量|Local proxy connections · Live rates are separate from Wi-Fi totals
关闭应用详情|Close application details
返回网络详情|Back to network details
应用详情|Application details
请等待自动保存完成，或重试保存失败的更改。|Wait for automatic saving to finish, or retry the failed changes.
状态与帮助|Status and help
小窗形状|Mini window shape
小窗配色|Mini window palette
条形|Bar
方形|Square
圆形|Circle
靛蓝|Indigo
贴边吸附|Snap to screen edges
贴边自动隐藏|Auto-hide at screen edge
保存失败，请重试。|Could not save. Please retry.
正在保存…|Saving…
等待保存…|Waiting to save…
已自动保存|Saved automatically
缩短保留期将删除范围外的历史记录，建议先备份。|Shortening retention deletes older history. Back up first.
总额度达到上限时将断开全部 Wi-Fi。|All Wi-Fi connections will disconnect when the total quota is reached.

检测到的代理客户端|Detected proxy clients
连接数|Connections
连接已检测到，流量数值需启用应用采集。|Connections detected. Enable application collection to measure usage.
提醒阈值须为 1 到 100，多个值用逗号分隔。|Thresholds must be between 1 and 100, separated by commas.
缺失区间：|Missing intervals:
自动（推荐）|Automatic (recommended)
应用流量|Application usage
应用断网|Application network control
实时采集|Live collection
当前没有应用进程数据。|No application processes are available.
缺少程序路径，请选择程序。|Select a program to supply its executable path.
试试其他日期或网络。|Try another date range or network.
启用应用采集后开始记录。|Enable application collection to start recording.
请切换到应用汇总或历史后导出。|Switch to summary or history to export.

主题|Theme
跟随系统|System
浅色|Light
深色|Dark
面包屑导航|Breadcrumbs
旧版数据导入完成，重叠日期保留现有记录。|Import completed. Existing records were kept for overlapping dates.
已略过|Skipped
 个重叠日期。| overlapping dates.
无法读取 Wi-Fi 信息|Unable to read Wi-Fi information
无法确认连接信息|Unable to confirm connection information
常规|General
显示|Display
流量额度|Traffic quota
代理|Proxy
数据与迁移|Data and migration
关于更新|About and updates
设置分类|Settings categories
桌面小窗|Desktop mini window
关闭窗口时|When closing the window
每次询问|Ask every time
最小化到托盘|Minimize to tray
退出应用|Exit application

选择含 state.json 或 state.json.bak 的文件夹。|Choose the folder containing state.json or state.json.bak.

语言与旧数据|Language and previous data
先选择语言，或导入以前的流量记录。|Choose your language or import your previous usage records.
选择后立即保存并切换。|Saved and applied immediately.
先退出旧版采集器，再选择包含 state.json 或 state.json.bak 的文件夹；不要选择单个文件。|Exit the old collector, then select the folder containing state.json or state.json.bak, not an individual file.
旧版默认目录：|Previous default folder:
原文件会保留。导入前自动备份；发现与现有记录重叠时会停止，不会覆盖。|Original files are kept and a backup is created before import. Overlapping records stop the import instead of overwriting data.

尚未检查更新。|Updates have not been checked yet.
已取消更新。|Update cancelled.
恢复采集|Resume collection
已恢复原采集状态。|Previous collection state restored.
已打开官方发布页。|The official release page has been opened.
正在退出并启动安装程序…|Exiting and starting the installer…
软件更新|Software updates
仅查询 GitHub 正式版本，不上传网络记录。安装前会再次确认。|Checks official GitHub releases only. Network records are not uploaded. Installation requires confirmation.
启动时检查更新|Check for updates on startup
当前版本：|Current version:
最新版本：|Latest version:
当前已是最新版本。|You are up to date.
发现新版本。|An update is available.
更新检查失败。|Update check failed.
正在检查更新…|Checking for updates…
检查更新|Check for updates
更新说明|Release notes
下载并安装|Download and install
打开版本下载页|Open release downloads
发现新版本，请在设置中查看更新。|An update is available. Open Settings to review it.

刷新|Refresh
 已达到额度上限。| has reached its quota.
请先保存或取消当前更改。|Save or cancel the current changes first.
代理流量估算|Proxy traffic estimates
代理端口|Proxy ports
代理进程名（可选）|Proxy process names (optional)
使用逗号分隔，留空清除配置。|Separate entries with commas. Leave blank to clear the configuration.
保存代理配置|Save proxy configuration
代理配置已保存。|Proxy configuration saved.
代理端口须为 1 到 65535 的整数。|Proxy ports must be integers from 1 to 65535.
最多设置 64 个端口、32 个进程名；进程名最长 64 个字符且不能包含控制字符。|Use up to 64 ports and 32 process names. Each name must be at most 64 characters without control characters.
后端尚未提供代理估算接口。|The backend does not provide proxy estimates yet.
当前平台不支持代理流量估算，原生应用采集不受影响。|Proxy traffic estimates are unsupported on this platform. Native application collection is unaffected.
代理估算与原生采集独立；仅替换匹配网络和日期的代理记录，保留客户端直接流量。|Proxy estimates are separate from native collection. They replace proxy records only for matching networks and dates; direct client traffic is retained.
应用数据来源|Application data source
原生记录|Native records
包含代理估算|Include proxy estimates
估算 · 未归属|Estimated / Unattributed
估算|Estimated
来源|Source
代理配置更新未返回状态。|The proxy configuration update did not return a state.
有线网络|Ethernet
有线网卡|Ethernet adapter
原始身份|Original identity
有线网络不支持无线断开操作。|Wireless disconnect is not available for Ethernet.
选择要查看的网卡|Choose a network adapter
今日|Today
近 7 天|Last 7 days
本月|This month
所选期间|Selected period
全部历史|All history
全部已保留历史|All retained history
未识别网络|Unknown network
暂无小时明细|No hourly records
所选时段暂无流量记录|No usage records in this period
上传与下载流量（| upload and download traffic (
单位|Unit
；深蓝色代表下载，浅蓝色代表上传。缺失日期不表示零用量。可聚焦每根柱查看数据。|; dark blue is download, light blue is upload. Missing dates do not mean zero usage. Focus a bar to inspect its values.
无记录|No records
下载|Download
，上传|, upload
暂无流量记录|No usage records
连接 Wi-Fi 后，采集器会从新的基线开始记录。|Connect to Wi-Fi to start collecting from a new baseline.
全部网络|All networks
统计时间范围|Usage period
按网络筛选|Filter by network
自定义|Custom
流量总览|Usage overview
查看用量、连接状态与网络额度。|View usage, connection status and network quotas.
我的网络|My networks
历史记录|Usage history
按时间回看用量，保留清晰的流量记录。|Review recorded usage over time.
偏好设置|Preferences
让统计方式，适合你的使用习惯。|Choose how usage is collected and displayed.
总览|Overview
网络|Networks
历史|History
设置|Settings
每|Every
秒采样 · SQLite 落盘| seconds · saved to SQLite
统计已暂停|Collection paused
正在采集|Collecting
采集器未就绪|Collector not ready
历史记录仍可查看|Saved history remains available
按网络独立累计|Usage tracked per network
恢复统计|Resume collection
暂停统计|Pause collection
记录保存在本机数据库|Records are stored on this device
工作台 /|Workspace /
统计口径与帮助|Usage definitions and help
采集状态|Collection status
导出数据|Export data
无法连接采集后端，请检查状态|Cannot connect to the backend. Check collection status.
更新于|Updated
等待本机采集器|Waiting for the collector
正在连接本机采集后端。|Connecting to the local backend.
查看状态|View status
无法读取 Wi-Fi 名称|Cannot read the Wi-Fi name
网络身份权限不足 · 未识别流量不会记到上一个 Wi-Fi|Network identity permission required. Unknown traffic is not assigned to the previous Wi-Fi.
处理方式|Troubleshoot
采集器暂未响应|Collector is not responding
下方为已保存的记录，不代表当前实时状态。|Saved records below may not reflect the current connection.
检查状态|Check status
尚未连接 Wi-Fi|Not connected to Wi-Fi
历史记录仍可查看；重新连接后从新的基线开始统计。|History remains available. Reconnecting starts a new baseline.
查看连接|View connections
已连接|Connected
信号|Signal
当前下载|Download now
当前上传|Upload now
张网卡|adapters
查看当前网络详情|View current network details
总用量|Total usage
下载流量|Downloaded
上传流量|Uploaded
个网络 · 本机累计记录|networks · recorded locally
暂无记录，不代表零流量|No records does not mean zero usage
占总用量|Share of total:
等待采样记录|Waiting for usage records
流量趋势|Usage trend
上传|Upload
单位：|Unit:
按小时|Hourly
按月|Monthly
按日|Daily
今日尚未结束|Today is still in progress
网络额度|Network quota
尚无网络|No networks yet
连接并开始记录后，可设置流量额度。|Connect and collect usage to set a quota.
固定周期| quota period
设置该网络额度|Edit network quota
网络额度使用比例|Network quota used
剩余额度|Remaining quota
尚未设置流量额度|No quota configured
已用|Used
不限制用量|Unlimited usage
达到|Notify at
% 时提醒|% used
流量提醒未开启|Quota notifications are off
可单独为每个 Wi-Fi 设置|Configure a quota for each Wi-Fi
，不自动断网|; automatic disconnect is off
没有匹配的网络|No matching networks
暂无网络记录|No network records
试试其他 SSID 或网络备注。|Try another SSID or network alias.
首次连接后会在这里出现，不需要手动添加。|Networks appear automatically after the first connection.
网络名称|Network name
额度进度|Quota usage
/ 独立周期|/ quota period
操作|Actions
查看|View
详情|details
未设置额度|No quota
用量已达| usage reached
查看额度|View quota
，剩余|, remaining
，已超过所设额度|, quota exceeded
网络用量|Network usage
· 按 SSID 分类记录|· grouped by SSID
管理网络|Manage networks
搜索网络备注或 SSID|Search aliases or SSIDs
搜索网络|Search networks
共|Total:
个网络|networks
网络排序|Network sorting
按用量排序|Sort by usage
按名称排序|Sort by name
已连接优先|Connected first
有记录的日期：|Days with records:
天|days
日均用量|Daily average
仅按有记录的日期计算|Based only on days with records
单日最高用量|Highest daily usage
每日明细|Daily details
本机采集 · 日期按本地时间归档|Local collection · dates use local time
导出所选记录|Export selected records
暂无记录|No records
日期|Date
记录说明|Record status
天 · 每页 10 条|days · 10 per page
当日未结束|Day in progress
已保存记录|Saved
上一页|Previous
下一页|Next
所选时段没有记录|No records in this period
更换日期或网络试试；缺失记录不会被当作零流量。|Try another date or network. Missing records are not treated as zero usage.
启动与采集|Startup and collection
系统级开关会随系统设置生效|Changes are applied through system settings
显示与提醒|Display and notifications
数据与存储|Data and storage
更改后点击保存，防止误操作。|Save to apply your changes.
保存设置|Save settings
安静运行，清楚记录|Local collection, clear records
网络记录与提醒规则保存在本机，不需要账号。|Network records and notification rules stay on this device. No account is needed.
按 Wi-Fi 归属流量，不将未知区间强行计入某个网络。|Traffic is assigned to known Wi-Fi networks. Unknown intervals remain unassigned.
历史总量与应用统计独立展示，避免相加造成重复。|Network and application totals are shown separately to avoid double counting.
超额默认只提醒。自动断网须在网络详情里明确开启。|Quota limits notify by default. Enable automatic disconnect explicitly in network settings.
历史、额度与偏好都保存在本机数据库。开机启动与托盘属于系统级设置。|History, quotas and preferences are stored locally. Startup and tray behavior use system integration.
开机自启|Start at login
写入系统的自启动目录，登录后自动开始采集。|Start collecting automatically when you sign in.
关闭窗口时最小化到托盘|Minimize to tray on close
开启后关闭窗口只隐藏窗口，采集继续进行。|Closing the window hides it while collection continues.
采样间隔|Sampling interval
后端按此间隔读取网卡计数器。|How often the backend reads adapter counters.
秒|seconds
流量单位进制|Usage unit system
用量自动选择单位；十进制按 1000、二进制按 1024 换算。|Units scale automatically. Decimal uses 1000; binary uses 1024.
十进制 · KB / MB / GB|Decimal · KB / MB / GB
二进制 · KiB / MiB / GiB|Binary · KiB / MiB / GiB
实时速度单位|Live speed unit
MB/s 是字节速率；Mbps 是比特速率。|MB/s measures bytes per second; Mbps measures bits per second.
允许额度提醒|Allow quota notifications
各网络分别设置提醒阈值；默认不自动断网。|Set thresholds per network. Automatic disconnect is off by default.
历史保留时长|History retention
缩短保留期前会再次确认；建议先导出备份。|Shorter retention requires confirmation. Export a backup first.
数据存储位置|Data location
数据库文件所在文件夹；切换会复制当前数据库并保留原文件。|Folder that holds the database file. Switching copies the current database and keeps the original file.
读取中…|Loading…
当前使用默认位置。|Using the default location.
本次运行暂时使用默认位置；保存的自定义位置会在下次启动时继续尝试。|Using the default location for this run. The saved custom location is tried again on the next start.
更改位置|Change location
正在切换…|Switching…
恢复默认位置|Use default location
数据位置已更新。|Data location updated.
数据位置已切换，当前数据库已复制到新位置。|Data location changed. The current database was copied to the new location.
数据位置已切换，新位置会新建空白数据库。|Data location changed. A new empty database will be created there.
当前已经是这个数据位置。|This is already the current data location.
已恢复默认位置，不再使用自定义位置。|Back to the default location. The custom location is no longer used.
未能切换数据位置。|The data location could not be changed.
原数据库仍保留在：|The original database remains at:
目标文件夹原有的数据库已归档为：|The database that was already in the target folder was archived as:
当前数据库：|Current database:
最近 30 天|Last 30 days
最近 90 天|Last 90 days
最近 365 天|Last 365 days
长期保留|Keep indefinitely
导入旧版数据|Import legacy data
选择旧版数据目录；导入结果与备份位置将在下方显示。|Choose a legacy data directory. Results and the backup location appear below.
数据备份|Data backup
完整备份包含网络备注、额度及记录，不含 Wi-Fi 密码。|Backups include aliases, quotas and usage records, but no Wi-Fi passwords.
备份|Back up
恢复|Restore
清空历史记录|Clear usage history
只清除用量记录，保留网络备注与偏好设置。|Remove usage records while keeping aliases and preferences.
清空记录|Clear records
取消更改|Discard changes
放弃未保存的更改？|Discard unsaved changes?
当前设置尚未保存。离开后会恢复上一次保存的偏好。|These changes are not saved. Leaving restores the saved preferences.
放弃并离开|Discard and leave
本机采样|Local samples
用量趋势|Usage trend
最近记录|Recent records
无线网卡|Wireless adapter
频段 / 信号|Band / signal
连接开始|Connected since
统计状态|Collection state
已暂停|Paused
采样中|Sampling
所选时间内没有该网络的记录。|No records for this network in the selected period.
导出此网络记录|Export this network
应用记录|Application records
尚未采集|Not collected yet
网卡用量明细与历史记录来自真实采集；应用分布将在接入原生采集器后填充。|Network details are recorded locally. Application usage requires a native application collector.
应用级流量尚未采集|No application usage collected yet
按进程归属流量需要额外的系统能力，当前构建没有可用的应用采集器。|Per-process traffic requires system support. This build has no available application collector.
已统计应用总用量|Recorded application usage
占比按当前网络和时段的已统计应用流量计算。应用统计与网卡统计口径可能不同，两者分别展示。|Shares use recorded application traffic in the selected network and period. Application and adapter totals may differ and are displayed separately.
搜索应用|Search applications
应用排序|Application sorting
历史分组|History grouping
按总量|By total
按下载|By download
按上传|By upload
应用汇总|Application summary
应用采集未启用|Application collection is disabled
应用采集正在启动|Starting application collection
应用采集中|Collecting application usage
应用采集已暂停|Application collection paused
应用采集需要系统授权|Application collection requires permission
应用采集暂不可用|Application collection unavailable
应用采集有缺失|Application collection has gaps
停止应用采集|Stop application collection
启用应用采集|Enable application collection
开启应用采集需要额外的系统权限，请完成系统授权后重试。|Grant the required system permission, then retry application collection.
重试应用采集|Retry application collection
所选时段有|Gaps in this period:
段应用采集缺失；已记录的流量仍可查看。| application collection gaps. Saved records remain available.
已配置|Configured
未配置|Not configured
未知|Unknown
应用网络控制|Application network control
当前平台暂不支持应用防火墙与上传限速。|Application firewall and upload throttling are not supported on this platform.
规则状态表示本地配置；本地代理可能绕过阻断。限速只作用于所选程序的上传。|Rule status reflects local configuration. Local proxies may bypass blocking. Throttling applies only to uploads by the selected program.
选择程序|Choose program
完整路径|Full path
防火墙规则|Firewall rules
上传限速|Upload limit
上传限速 KB/s|Upload limit (KB/s)
设置上传限速|Set upload limit
查询状态|Read status
阻止联网|Block network access
解除阻止|Remove block
取消上传限速|Remove upload limit
正在等待系统操作完成…|Waiting for the system operation…
检查旧版数据|Check legacy data
导入旧版目录|Import legacy directory
月份|Month
应用|Application
导出当前表格|Export this table
所选时段没有应用记录|No application records in this period
更换日期或应用名称后重试。|Try another date or application name.
已导出|Exported
条记录。|records.
试试其他日期或网络。应用采集开始前的流量无法补算。|Try another date or network. Traffic before application collection started cannot be reconstructed.
启用后将从新的基线开始记录应用用量。|Enabling collection starts recording application usage from a new baseline.
没有匹配的应用|No matching applications
试试其他应用名称。|Try another application name.
个应用 · 显示|applications · showing
个|items
· 上传|· upload
最近采样进程|Recently sampled processes
收起列表|Collapse list
显示全部应用|Show all applications
显示本次采集的进程与速率，历史用量已按应用归并。|Processes and rates from the latest sample. Historical usage is grouped by application.
下载速度|Download speed
上传速度|Upload speed
当前没有该应用的进程数据。|No current process data for this application.
关闭|Close
网络备注|Network alias
给这个 Wi-Fi 起一个容易辨认的名字|Choose a recognizable name for this Wi-Fi
仅用于显示；原始 SSID 为|Display only. Original SSID:
流量额度|Usage quota
不限制|Unlimited
固定十进制 GB；留空或 0 表示不设额度。|Decimal GB. Leave blank or enter 0 for no quota.
额度周期|Quota period
按本地日期重置，不随页面筛选变化。|Resets by local date, independently of the history filter.
用量接近额度时提醒|Notify when usage approaches the quota
此网络的提醒还受全局提醒开关控制。|This network also follows the global notification preference.
提醒阈值|Notification threshold
达到额度后自动断开|Disconnect automatically at the quota
达到额度后由后端核对网络身份并断开当前连接。|The backend verifies network identity before disconnecting at the quota.
达到额度后，后端会先确认当前连接的正是这个网络，再执行断开并复核结果。|The backend checks the connected network before disconnecting, then verifies the result.
保存网络设置|Save network settings
每自然月|Calendar month
每天|Daily
接近额度时提醒|Notify near quota
已用额度的|Quota used:
关闭网络详情|Close network details
复制 SSID|Copy SSID
网络详情分类|Network detail tabs
数据来自本机采集 · 网络身份不受备注更改影响|Collected locally · aliases do not change network identity
用量明细|Usage details
应用分布|Applications
网络设置|Network settings
关闭对话框|Close dialog
输入清空确认|Type CLEAR to confirm
该操作无法撤销。建议先导出备份。|This cannot be undone. Export a backup first.
取消|Cancel
导出流量记录|Export usage records
导出当前筛选范围内的本机记录。包含原始字节数，便于后续核对。|Export local records for the selected period, including exact byte counts.
网络范围|Network selection
开始日期|Start date
结束日期|End date
文件格式|File format
导出记录|Export records
CSV · 可用表格软件打开|CSV · open in a spreadsheet
JSON · 精确字节数|JSON · exact byte counts
正在读取当前网络与速率|Reading the current network and rates
未连接 Wi-Fi|No Wi-Fi connection
有无线网卡但没有关联网络|A wireless adapter is present but not connected
权限不足|Permission required
无法确定网络身份，未见过的流量不会记到上一个网络|Unknown network identity. Traffic is not assigned to the previous network.
采集器不可用|Collector unavailable
读不到网卡信息，下方记录可能已过期|Adapter information unavailable; displayed records may be outdated
正在启动|Starting
正在连接本机采集后端|Connecting to the local backend
未知状态|Unknown state
· 信号|· signal
当前没有已关联的无线网卡|No connected wireless adapters
数据由本机后端进程读取网卡计数器后写入本机数据库，不经过网络。|The local backend reads adapter counters and stores them locally. Nothing is sent over the network.
采集器：|Collector:
备注、额度、导出与备份都写入本机数据库；开机启动、托盘与真实断网属于系统级设置。|Aliases, quotas and records are stored locally. Startup, tray behavior and disconnect operations use system integration.
运行中|Running
不可用|Unavailable
有|There are
段区间没有采集到数据，已单独记录，不会显示成 0。| collection gaps. They are recorded separately, not shown as zero usage.
完成|Done
统计口径与使用说明|Usage definitions and help
总量 = 下载 + 上传|Total = download + upload
首页和网络明细展示采集器记录的网卡流量；用量自动选择单位，设置中可切换十进制或二进制。|Overview and network details show recorded adapter traffic. Units scale automatically; choose decimal or binary in Preferences.
历史与实时分开|History and live data are separate
日期筛选仅影响历史用量。连接卡片显示当前选中网卡的实时状态，额度使用独立日 / 月周期。|Date filters affect history only. The connection card shows the selected adapter live; quotas follow their own periods.
缺失记录不会伪装成零流量|Missing records are not zero usage
断网、暂停、计数器重置与身份不明期间的覆盖情况，由后端记录并说明。|The backend records gaps caused by disconnection, pauses, counter resets or unknown network identity.
应用用量独立统计|Application usage is tracked separately
应用分布按当前网络与时段展示已采集的应用记录。启用应用采集后从新的基线开始，暂停和停止不会删除历史；是否可采集以及缺失区间会在页面说明。|Applications shows recorded usage for the selected network and period. Enabling collection starts a new baseline. Pausing or stopping keeps history; availability and collection gaps are shown separately.
数据来源|Data source
页面读取本机后端进程的采集结果，数据存放在本机 SQLite 数据库，不上传任何内容。|This page reads the local backend. Records stay in a local SQLite database; nothing is uploaded.
知道了|Got it
无法确定网络身份|Cannot identify the network
采集器读不到当前连接的网络名。无法归属的流量不会被记到上一次连接的网络。|The collector cannot read the connected network name. Unassigned traffic is not added to the previous network.
常见原因是 NetworkManager 未运行或当前用户无权查询连接信息。恢复后采集会从新的基线继续，中间区间会记为覆盖空档。|Check that NetworkManager is running and your user can query connections. Collection resumes from a new baseline; the interruption is recorded as a gap.
可以用|Use
确认 NetworkManager 是否正常。|to check NetworkManager.
查看采集状态|View collection status
请选择有效日期，结束日期不能早于开始日期或晚于今天。|Choose valid dates. The end must be on or after the start and no later than today.
所选范围没有可导出的流量记录。|There are no usage records to export in this period.
下载字节|Download bytes
上传字节|Upload bytes
总计字节|Total bytes
下载_|Download_
上传_|Upload_
总计_|Total_
本机采集|Local collection
已导出完整数据备份。|Full backup exported.
这个文件不是有效的备份文件。|This is not a valid backup file.
请选择备份功能生成的完整文件。|Choose a full file created by the backup feature.
恢复这份备份？|Restore this backup?
包含|Contains
个网络和|networks and
条每日记录。当前数据将被替换。|daily records. Current data will be replaced.
确认恢复|Confirm restore
已恢复备份，采集已暂停。|Backup restored. Collection is paused.
清空全部用量记录？|Clear all usage records?
此操作删除每日与小时记录、覆盖说明，并重置当前额度计数；保留网络备注与提醒设置。不能撤销。|This removes daily and hourly records and gap details, and resets quota counters. Aliases and notification settings are kept. This cannot be undone.
记录已清空，采集已暂停。|Records cleared. Collection is paused.
偏好已保存，但写入开机启动项失败，请检查用户目录权限。|Preferences saved, but startup registration failed. Check your user directory permissions.
已保存偏好。|Preferences saved.
应用新的保留时长？|Apply the new retention period?
将删除|Delete
之前的|records before
条每日记录及相应明细。建议先备份；这不会改变当前额度策略。|daily records and their details. Back up first. Quota policies will not change.
确认保存|Confirm save
额度须为 0 或 0.000000001 到 9000000000 GB。|Quota must be 0 or between 0.000000001 and 9000000000 GB.
请先设置大于 0 的额度，或关闭该网络的提醒与自动断网。|Set a quota above zero, or turn off notifications and automatic disconnect.
已保存网络设置。|Network settings saved.
启用自动断开规则？|Enable automatic disconnect?
达到所设额度后，应用会断开当前连接的网络：|At the quota, the app will disconnect the current network:
。断开只在确认连的正是这个网络时执行。|. Disconnect only runs after verifying the connected network.
确认启用|Confirm enable
额度提醒：|Quota notification:
已达到额度上限，已断开|Quota reached. Disconnected
已达到额度上限，但未能断开|Quota reached, but could not disconnect
请检查系统状态|Check system status
已恢复统计，从新的基线继续。|Collection resumed from a new baseline.
已暂停统计。暂停期间不会补记到任何网络。|Collection paused. Paused traffic will not be assigned to any network.
选择日期范围|Choose a date range
开始和结束日期均包含在统计范围内，将从数据库查询所选日期。|Both dates are included. Records are queried from the database for this period.
应用筛选|Apply filter
放弃未保存的网络设置？|Discard unsaved network settings?
网络备注与额度的更改尚未保存。|Alias and quota changes have not been saved.
放弃更改|Discard changes
已复制原始 SSID。|Original SSID copied.
复制网络名称|Copy network name
浏览器不允许直接写入剪贴板。可以选中下方名称复制。|Clipboard access is unavailable. Select and copy the name below.
切换标签页将放弃当前表单中的更改。|Switching tabs will discard changes in this form.
已恢复上次保存的设置。|Saved settings restored.
选择要查看的无线网卡|Choose a wireless adapter
实时速度按网卡显示；历史用量按网络聚合，不重复累加。|Live rates are per adapter. Historical usage is grouped by network without double counting.
操作失败，请重试。|Operation failed. Please try again.
请确认开始、结束日期有效，且结束日期不晚于今天。|Choose valid dates with an end date no later than today.
有尚未保存的更改。|You have unsaved changes.
清空|CLEAR
此时段没有记录|No records in this period
当前没有已连接的 Wi-Fi，连接后会从新的基线开始统计。|No Wi-Fi is connected. Collection starts from a new baseline after connecting.
无法连接采集后端：|Cannot connect to the backend:
月|month
日|day
不支持的数据版本。|Unsupported data version.
数据结构不正确或记录数量超出限制。|Invalid data structure or too many records.
网络标识或名称不合法。|Invalid network identity or name.
额度或提醒阈值不合法。|Invalid quota or notification threshold.
额度周期不合法。|Invalid quota period.
额度计数不合法。|Invalid quota counter.
流量记录不合法。|Invalid usage record.
包含重复的每日网络记录。|Duplicate daily network records.
明细记录过多。|Too many detail records.
小时记录不合法。|Invalid hourly record.
小时记录重复。|Duplicate hourly records.
应用记录不合法。|Invalid application record.
设置值不合法。|Invalid preference value.
开关值不合法。|Invalid switch value.
采集器状态不合法。|Invalid collector state.
连接信息不合法。|Invalid connection information.
网卡状态不合法。|Invalid adapter state.
更新时间不合法。|Invalid update timestamp.
缺失区间数量不合法。|Invalid gap count.
上传速率须为 0.125 到 125000000 KB/s，且为 0.125 的整数倍。|Upload rate must be 0.125 to 125000000 KB/s, in steps of 0.125.
操作已取消。|Operation canceled.
操作未完成。|Operation did not complete.
此目录已导入，无需重复导入。|This directory has already been imported.
当前统计已继续，旧版数据尚未导入。|Collection has resumed. Legacy data has not been imported.
旧版数据已导入。|Legacy data imported.
仅归档的应用缓存：|Application cache entries archived only:
条，未加入应用用量统计。| entries; not included in application usage statistics.
导入注意事项：|Import warnings:
备份目录：|Backup directory:
发现旧版数据，可选择目录导入。|Legacy data found. Choose a directory to import.
未自动发现旧版数据，可手动选择目录。|No legacy data detected automatically. Choose a directory manually.
界面语言|Interface language
中英文切换，保存后生效。|Choose a language and save to apply.
无线网络流量管理|Wi-Fi usage manager
工作台|Workspace
主导航|Main navigation
累计|All time
累计不重置|All time, no reset
总 Wi-Fi 额度|Total Wi-Fi quota
只累计 Wi-Fi 上传与下载，不包含有线网络。|Includes Wi-Fi upload and download only. Ethernet is excluded.
总额度使用比例|Total Wi-Fi quota used
总额度设置|Total quota settings
保存总额度|Save total quota
提醒阈值（%）|Notification threshold (%)
启用总额度提醒|Enable total quota notifications
总额度达到上限时断开全部 Wi-Fi|Disconnect all Wi-Fi at the total quota
总额度已保存。|Total quota saved.
后端尚未提供总额度接口。|The backend does not provide total quota settings yet.
总额度设置无效。|Invalid total quota settings.
后端不可用，无法读取本机流量。|Backend unavailable. Cannot read local usage.
后端没有响应。|The backend did not respond.
后端返回失败。|The backend returned an error.
导出查询未返回流量记录。|The export query did not return usage records.
总额度更新未返回状态。|The quota update did not return a state.
`.trim().split('\n').map(line => { const index=line.indexOf('|');return [line.slice(0,index),line.slice(index+1)]; }));
