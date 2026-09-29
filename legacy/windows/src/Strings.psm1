#requires -Version 5.1
Set-StrictMode -Version Latest
Import-Module (Join-Path $PSScriptRoot 'Storage.psm1') -Scope Local

function Get-MeterStrings {
    param([ValidateSet('en', 'zh-CN')][string]$Language = 'en')
    $entries = @(
        @('WindowTitle', 'WiFiMeter · Wi-Fi usage', 'WiFiMeter · Wi-Fi 流量统计'),
        @('Tagline', 'Usage by Wi-Fi network', '按 Wi-Fi 查看流量'),
        @('Workspace', 'WORKSPACE', '工作空间'),
        @('Overview', 'Overview', '流量概览'),
        @('OpenData', 'Open data folder', '打开数据文件夹'),
        @('OpenDataAccessible', 'Open local usage data folder', '打开本机统计数据文件夹'),
        @('CurrentConnection', 'CURRENT CONNECTION', '当前连接'),
        @('WaitingConnection', 'Waiting for Wi-Fi', '等待连接'),
        @('DownloadSpeed', '↓ Download', '↓ 下载速度'),
        @('UploadSpeed', '↑ Upload', '↑ 上传速度'),
        @('AutoStart', 'Start with Windows', '开机自启动'),
        @('AutoStartHint', 'Track in the background after sign-in', '登录 Windows 后在后台统计'),
        @('StartupSettings', 'Windows startup settings', '打开 Windows 启动设置'),
        @('StopExit', 'Stop and quit', '停止统计并退出'),
        @('LocalOnly', 'Stored only on this device', '数据仅保存在本机'),
        @('WaitingStart', 'Ready to start', '等待启动'),
        @('Subtitle', 'Usage by Wi-Fi network', 'Wi-Fi 用量统计'),
        @('Start', 'Start tracking', '启动统计'),
        @('Stop', 'Stop tracking', '停止统计'),
        @('ToggleAccessible', 'Start or stop Wi-Fi usage tracking', '启动或停止流量统计'),
        @('TotalUsage', 'TOTAL USAGE', '总流量'),
        @('DownloadUsage', '↓  DOWNLOADED', '↓  下载流量'),
        @('UploadUsage', '↑  UPLOADED', '↑  上传流量'),
        @('AllTime', 'All time', '全部累计'),
        @('Today', 'Today', '今天'),
        @('Month', 'This month', '本月'),
        @('CustomRange', 'Custom dates', '自选日期'),
        @('Export', 'Export CSV', '导出 CSV'),
        @('ExportAccessible', 'Export the selected date range to CSV', '导出当前日期范围为 CSV'),
        @('From', 'From', '从'),
        @('To', 'to', '至'),
        @('StartDate', 'Start date', '开始日期'),
        @('EndDate', 'End date', '结束日期'),
        @('Inclusive', 'Both dates included', '包含起止当天'),
        @('NetworkUsage', 'Wi-Fi usage', 'Wi-Fi 使用情况'),
        @('NoNetworks', '0 networks', '0 个网络'),
        @('Download', 'Download', '下载'),
        @('Upload', 'Upload', '上传'),
        @('Chart', 'Chart', '图表'),
        @('Details', 'Details', '明细'),
        @('ChartAccessible', 'All Wi-Fi usage charts, scroll to see more', '所有 Wi-Fi 流量图表，支持滚动'),
        @('TableAccessible', 'All Wi-Fi usage details in GB', '所有 Wi-Fi 流量明细，单位 GB'),
        @('NetworkName', 'Wi-Fi network', 'Wi-Fi 名称'),
        @('DownloadGB', 'Download / GB', '下载 / GB'),
        @('UploadGB', 'Upload / GB', '上传 / GB'),
        @('TotalGB', 'Total / GB', '总计 / GB'),
        @('EmptyTitle', 'No usage recorded yet', '还没有流量记录'),
        @('EmptyDetail', 'Start tracking and connect to Wi-Fi to see your usage here', '启动统计并连接 Wi-Fi 后，数据会显示在这里'),
        @('DefaultCaption', 'All time · Sorted by total usage', '全部累计 · 按总流量排序'),
        @('Units', '1 GB = 1 billion bytes', '1 GB = 10 亿字节'),
        @('BackgroundHint', 'Minimize to the tray to keep tracking', '最小化到托盘后继续统计'),
        @('Refresh', 'Refresh', '刷新'),
        @('Language', 'LANGUAGE', '界面语言'),
        @('PreviewSubtitle', 'Demo data · Explore usage across every network', '演示数据 · 预览全部网络的流量统计'),
        @('PreviewStartup', 'Preview keeps startup settings unchanged', '演示模式，不修改启动设置'),
        @('Preview', 'Demo', '演示模式'),
        @('PreviewDetail', 'Demo data · Scroll to explore all networks · No usage data is saved', '演示数据，不写入本机统计 · 每个网络都可以滚动查看'),
        @('Tracking', 'Tracking', '正在统计'),
        @('WaitingSample', 'Waiting for sample', '等待采样'),
        @('Stopped', 'Stopped', '已停止'),
        @('NoConnection', 'No Wi-Fi connection', '暂无 Wi-Fi 连接'),
        @('NetworkCount', '{0} networks', '{0} 个网络'),
        @('Sorted', ' · Sorted by total usage', ' · 按总流量排序'),
        @('RangeCaption', '{0} to {1}', '{0} 至 {1}'),
        @('ReadFailed', 'Could not load data', '读取失败'),
        @('ReadFailedDetail', 'Could not load data: ', '读取失败：'),
        @('BackupUsed', ' · Recovered from the backup', ' · 已从备份读取数据'),
        @('UsageNote', ' · Includes local traffic; networks with the same name are combined', ' · 包含局域网流量，同名 Wi-Fi 合并'),
        @('StartupEnabled', 'Enabled after Windows sign-in', '已启用，登录 Windows 后在后台统计'),
        @('StartupOff', 'Off · Start tracking manually', '未启用，需手动启动统计'),
        @('StartupDisabled', 'Disabled in Windows startup settings', '已被 Windows 启动设置禁用'),
        @('Working', 'Working, please wait…', '正在处理，请稍候…'),
        @('MissingDates', 'Select both a start date and an end date.', '请填写完整的开始日期和结束日期。'),
        @('InvalidExport', 'Choose a new .csv filename. Raw usage files cannot be overwritten.', '请另存为新的 .csv 文件，不能覆盖统计原始数据文件。'),
        @('ExportTitle', 'Export usage for the selected dates', '导出当前日期范围的流量统计'),
        @('CsvFilter', 'CSV spreadsheet (*.csv)|*.csv', 'CSV 表格 (*.csv)|*.csv'),
        @('ExportComplete', 'Export complete', '导出完成'),
        @('ExportedTo', 'Saved to:', '已导出至：'),
        @('InvalidDate', 'Invalid date. Choose a date from the calendar.', '日期格式无效，请使用日历选择日期。'),
        @('StartupError', 'WiFiMeter could not start', 'WiFiMeter 启动失败'),
        @('StaError', 'Start the application with WiFiMeter.exe (STA is required).', '界面需要在 STA 模式下运行，请使用 WiFiMeter.exe 启动。'),
        @('SettingsError', 'Could not save settings. Check that the data folder is writable.', '无法保存设置，请检查数据文件夹是否允许写入。'),
        @('Settings', 'Settings', '设置'),
        @('Save', 'Save', '保存'),
        @('Saved', 'Saved', '已保存'),
        @('Apply', 'Apply', '应用'),
        @('Cancel', 'Cancel', '取消'),
        @('Close', 'Close', '关闭'),
        @('Exit', 'Exit', '退出'),
        @('OpenWindow', 'Open WiFiMeter', '打开 WiFiMeter'),
        @('MinimizeTray', 'Minimize to tray', '最小化到托盘'),
        @('CloseTitle', 'Close WiFiMeter', '关闭 WiFiMeter'),
        @('CloseHint', 'Keep tracking in the notification area, or exit and stop tracking.', '可以最小化到托盘继续统计，也可以退出并停止统计。'),
        @('Retention', 'Keep usage records for', '统计记录保存时间'),
        @('Days', 'days', '天'),
        @('RetentionHint', '0 keeps records indefinitely. A positive number includes today. Older daily records are removed automatically and the totals are recalculated.', '0 表示永久保存。设置天数包含今天，较早的每日记录会自动删除，累计流量随之重新计算。'),
        @('RetentionInvalid', 'Enter a whole number from 0 to 36500.', '请输入 0 到 36500 之间的整数。'),
        @('NetworkDetails', 'Network details', '网络详情'),
        @('NetworkSettings', 'Network settings', '网络设置'),
        @('Alias', 'Display name', '备注名称'),
        @('AliasInvalid', 'Use up to 80 characters without control characters for the display name.', '备注名称最多 80 个字符，不能包含控制字符。'),
        @('QuotaGB', 'Traffic limit / GB', '流量限额 / GB'),
        @('QuotaPeriod', 'Limit period', '限额周期'),
        @('WarnPercent', 'Warn at / %', '提醒阈值 / %'),
        @('PeriodDay', 'Daily', '每天'),
        @('PeriodMonth', 'Monthly', '每月'),
        @('PeriodAll', 'All time', '累计'),
        @('QuotaHint', '0 disables the limit. A new limit starts from existing download and upload records; deleting old records does not reset it.', '限额设为 0 时不限制。新建限额从现有下载和上传记录开始计算，清理旧记录不会重置限额用量。'),
        @('QuotaInvalid', 'Enter a limit from 0 to 9000000000 GB and a warning threshold from 1 to 100%.', '限额应为 0 到 9000000000 GB，提醒阈值应为 1% 到 100%。'),
        @('DisconnectAtLimit', 'Disconnect this Wi-Fi when the limit is reached', '达到限额后断开此 Wi-Fi'),
        @('DisconnectHint', 'Off by default. When enabled, WiFiMeter disconnects the matching Wi-Fi adapter after a sample reaches the limit. Small overages are possible.', '默认关闭。启用后，采样流量达到限额时会断开对应 Wi-Fi 网卡，实际流量可能略微超过限额。'),
        @('QuotaWarning', '{0} has used {1}% of its traffic limit.', '{0} 已使用限额的 {1}%。'),
        @('QuotaReached', '{0} has reached its traffic limit ({1}%).', '{0} 已达到流量限额（{1}%）。'),
        @('QuotaDisconnected', '{0} was disconnected after reaching its traffic limit ({1}%).', '{0} 已达到流量限额（{1}%），已断开连接。'),
        @('QuotaDisconnectFailed', '{0} has reached its limit ({1}%), but Windows could not disconnect it. Check the Wi-Fi connection.', '{0} 已达到限额（{1}%），但 Windows 未能断开连接，请检查 Wi-Fi 连接。'),
        @('Applications', 'Applications', '应用流量'),
        @('Application', 'Application', '应用'),
        @('ByDay', 'By day', '每日明细'),
        @('Date', 'Date', '日期'),
        @('AppUsageLoading', 'Loading application usage from Windows…', '正在读取 Windows 应用流量记录…'),
        @('AppUsageSource', 'Windows application usage can be delayed and may differ from the Wi-Fi totals.', 'Windows 应用流量记录可能延迟，与 Wi-Fi 总流量可能存在差异。'),
        @('AppUsageEmpty', 'Windows has no application records for this Wi-Fi and date range yet.', 'Windows 暂无此 Wi-Fi 在所选日期内的应用流量记录。'),
        @('AppUsageUnavailable', 'Windows application usage is unavailable for this Wi-Fi.', '暂时无法读取此 Wi-Fi 的 Windows 应用流量记录。'),
        @('AppUsageAccessDenied', 'Windows did not allow access to application usage for this Wi-Fi.', 'Windows 不允许读取此 Wi-Fi 的应用流量记录。'),
        @('AppUsageTimeout', 'Windows did not finish the request in time. Try a shorter date range.', 'Windows 查询超时，请尝试缩短日期范围。'),
        @('AppUsageProfile', 'Connect to this Wi-Fi once while WiFiMeter is running so its Windows profile can be identified.', '请在 WiFiMeter 运行时连接一次此 Wi-Fi，以便识别对应的 Windows 网络配置。'),
        @('AppUsagePartial', 'Only part of this range is available. Windows keeps up to 60 days of application history; your retention setting also applies.', '仅能查询所选范围内的部分记录。Windows 最多保留近 60 天的应用历史，同时受本软件的保存天数设置限制。'),
        @('AppUsageOutside', 'This range is outside the retained dates or the Windows 60-day application history.', '此日期范围超出了保留记录的范围或 Windows 近 60 天的应用历史范围。'),
        @('ErrorBusy', 'Another start or stop operation is in progress. Try again shortly.', '另一个启动或停止操作尚未完成，请稍后重试。'),
        @('ErrorStart', 'Tracking could not start. Open the data folder and check collector.log.', '后台统计启动失败，请打开数据文件夹查看 collector.log。'),
        @('ErrorStartTimeout', 'Tracking did not respond in time. Refresh the window and check collector.log in the data folder.', '后台启动超时，请刷新窗口，并打开数据文件夹查看 collector.log。'),
        @('ErrorStop', 'Tracking is still saving or shutting down. Wait a moment, then try again.', '后台统计仍在保存数据或退出，请稍后重试。'),
        @('ErrorStopStatus', 'The collector is still running, but its status could not be read. Try stopping it again shortly.', '后台进程仍在运行，但暂时无法读取状态，请稍后重试停止。'),
        @('ErrorStartupExe', 'Open the app with WiFiMeter.exe before changing the startup setting.', '请通过 WiFiMeter.exe 打开应用，再设置自启动。'),
        @('ErrorStartupPath', 'The application path is too long for Windows startup. Move the app to a shorter path.', '程序路径过长，无法注册 Windows 启动项，请将程序移到较短的目录。'),
        @('ErrorStartupDisabled', 'Windows has disabled this startup entry. Enable WiFiMeter in Task Manager or Windows startup settings.', 'Windows 已禁用此启动项，请在任务管理器或 Windows 启动设置中启用 WiFiMeter。'),
        @('ErrorDateOrder', 'The start date must be on or before the end date.', '开始日期不能晚于结束日期。'),
        @('ErrorData', 'Saved usage data could not be read. Keep the data files and check ui.log or collector.log in the data folder.', '无法读取统计数据，请保留原始文件，并查看数据文件夹中的 ui.log 或 collector.log。'),
        @('ErrorExport', 'Usage was saved, but CSV export failed. Close applications using the CSV files, then try again.', '统计数据已保存，但 CSV 导出失败。请关闭正在使用 CSV 文件的程序后重试。'),
        @('ErrorSamplePartial', 'Some Wi-Fi adapters could not be sampled. Available adapters are still being tracked.', '部分 Wi-Fi 网卡无法采样，其他网卡仍在统计。'),
        @('ErrorSample', 'Wi-Fi connection or traffic data is unavailable. Check the connection and try again shortly.', '暂时无法读取 Wi-Fi 连接或流量信息，请检查网络连接后重试。'),
        @('ErrorRecovered', 'Usage data was recovered from its backup.', '已从备份读取统计数据。'),
        @('ErrorAction', 'The operation could not finish. Check access to the data folder and see ui.log for details.', '操作未能完成，请检查数据文件夹的访问权限，并查看 ui.log 中的详细信息。'),
        @('ErrorRead', 'Usage data could not be loaded. Open the data folder and check ui.log for details.', '无法加载统计数据，请打开数据文件夹查看 ui.log 中的详细信息。'),
        @('TechnicalDetails', 'Technical details', '技术详情')
    )
    $index = if ($Language -eq 'zh-CN') { 2 } else { 1 }
    $strings = @{}
    foreach ($entry in $entries) { $strings[$entry[0]] = $entry[$index] }
    return $strings
}

function Get-MeterErrorText {
    param(
        [Parameter(Mandatory)][string]$Message,
        [ValidateSet('en', 'zh-CN')][string]$Language = 'en',
        [ValidateSet('Action', 'Read', 'Settings', 'Sampling')][string]$Context = 'Action'
    )
    $strings = Get-MeterStrings -Language $Language
    if ($strings.Values -ccontains $Message) { return $Message }
    $key = switch -Regex ($Message) {
        '另一个启动或停止操作' { 'ErrorBusy'; break }
        '后台启动超时' { 'ErrorStartTimeout'; break }
        '后台进程未能启动' { 'ErrorStart'; break }
        '后台进程仍在运行，但暂时无法读取状态' { 'ErrorStopStatus'; break }
        '后台尚未完成保存|后台进程尚未完全退出' { 'ErrorStop'; break }
        '请从安装后的 WiFiMeter.exe' { 'ErrorStartupExe'; break }
        '程序路径过长' { 'ErrorStartupPath'; break }
        'Windows 已禁用此启动项' { 'ErrorStartupDisabled'; break }
        '开始日期不能晚于结束日期' { 'ErrorDateOrder'; break }
        '自选日期范围需要同时提供' { 'MissingDates'; break }
        '导出失败' { 'ErrorExport'; break }
        '部分 Wi-Fi 接口采样失败' { 'ErrorSamplePartial'; break }
        '无法读取 Wi-Fi 连接或流量信息' { 'ErrorSample'; break }
        '已使用备份恢复' { 'ErrorRecovered'; break }
        '数据文件|主数据|备份|网络列表格式|每日流量|网络名称无效|累计流量|流量字节数' { 'ErrorData'; break }
        default {
            switch ($Context) {
                'Read' { 'ErrorRead' }
                'Settings' { 'SettingsError' }
                'Sampling' { 'ErrorSample' }
                default { 'ErrorAction' }
            }
        }
    }
    return $strings[$key]
}

function Read-MeterLanguage {
    param([Parameter(Mandatory)][string]$Path)
    if ([IO.File]::Exists($Path)) {
        try {
            $settings = [IO.File]::ReadAllText($Path, [Text.Encoding]::UTF8) | ConvertFrom-Json
            if ($settings.Language -in @('en', 'zh-CN')) { return [string]$settings.Language }
        } catch { }
    }
    return 'en'
}

function Save-MeterLanguage {
    param([Parameter(Mandatory)][string]$Path, [ValidateSet('en', 'zh-CN')][string]$Language)
    [void][IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName([IO.Path]::GetFullPath($Path)))
    $settings = @{}
    if ([IO.File]::Exists($Path)) {
        try {
            $existing = [IO.File]::ReadAllText($Path, [Text.Encoding]::UTF8) | ConvertFrom-Json
            foreach ($property in $existing.PSObject.Properties) { $settings[$property.Name] = $property.Value }
        } catch { }
    }
    $settings.Language = $Language
    $temporary = $Path + '.' + [guid]::NewGuid().ToString('N') + '.tmp'
    try {
        [IO.File]::WriteAllText($temporary, ($settings | ConvertTo-Json), [Text.UTF8Encoding]::new($true))
        if ([IO.File]::Exists($Path)) { Invoke-MeterFileReplace -Source $temporary -Destination $Path }
        else { [IO.File]::Move($temporary, $Path) }
    } finally { if ([IO.File]::Exists($temporary)) { [IO.File]::Delete($temporary) } }
}

Export-ModuleMember -Function Get-MeterStrings, Get-MeterErrorText, Read-MeterLanguage, Save-MeterLanguage
