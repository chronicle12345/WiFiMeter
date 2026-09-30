#requires -Version 5.1
[CmdletBinding()]
param(
    [string]$DataDirectory,
    [switch]$NoStart,
    [switch]$StartMinimized,
    [switch]$Preview,
    [string]$SnapshotPath,
    [ValidateRange(0, 1000)][int]$PreviewNetworkCount = 12,
    [ValidateSet('en', 'zh-CN')][string]$Language
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName PresentationFramework, PresentationCore, WindowsBase, System.Windows.Forms, System.Drawing
try {
    Import-Module (Join-Path $PSScriptRoot 'Core.psm1') -Force
    Import-Module (Join-Path $PSScriptRoot 'Control.psm1') -Force
    Import-Module (Join-Path $PSScriptRoot 'Strings.psm1') -Force
    Import-Module (Join-Path $PSScriptRoot 'Preferences.psm1') -Force
    . (Join-Path $PSScriptRoot 'Dialogs.ps1')
    if ([string]::IsNullOrWhiteSpace($DataDirectory)) { $DataDirectory = Get-MeterDataDirectory }
    $script:directory = [IO.Path]::GetFullPath($DataDirectory)
    $script:settingsPath = Join-Path $script:directory 'settings.json'
    $script:isReadOnly = [bool]($Preview -or $SnapshotPath)
    $script:preferences = Read-MeterPreferences -DataDirectory $script:directory
    $script:uiLanguage = if ($Language) { $Language } elseif ($Preview) { 'en' } else { $script:preferences.Language }
    $script:strings = Get-MeterStrings -Language $script:uiLanguage
    function Text-Meter([string]$Key) { $script:strings[$Key] }
    if ([Threading.Thread]::CurrentThread.ApartmentState -ne 'STA') { throw (Text-Meter 'StaError') }
    $script:mutating = $false
    $script:updatingSettings = $false
    $script:changingDates = $false
    $script:loadError = ''
    $script:cachedState = $null
    $script:dataStamp = ''
    $script:renderKey = ''
    $script:readWarnings = @()
    $script:periodKey = 'All'
    $script:displayRows = @()
    $script:previewState = $null
    $script:lastLoggedError = ''
    $script:rangeStart = [DateTime]::Today.AddDays(1 - [DateTime]::Today.Day)
    $script:rangeEnd = [DateTime]::Today
    $script:trayIcon = $null
    $script:allowClose = $false
    $script:closeDialogOpen = $false
    $script:seenAlerts = [Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
    $script:lastViewRefresh = [DateTime]::MinValue
    $script:liveAppsStatus = $null
    $script:liveMode = 'Connections'
    $script:liveAppsKey = ''
    $script:liveUsageQuery = @{ Worker = $null; Pending = $null; Poll = $null; Ssid = ''; Rows = @(); MessageKey = '' }
    $script:wiredNameCache = @{ Time = [datetime]::MinValue; Map = $null }

    function Format-MeterError([string]$Message, [string]$Context = 'Action') {
        if (-not $script:isReadOnly -and $script:lastLoggedError -cne $Message) {
            try {
                [void][IO.Directory]::CreateDirectory($script:directory)
                $logPath = Join-Path $script:directory 'ui.log'
                if ([IO.File]::Exists($logPath) -and ([IO.FileInfo]$logPath).Length -gt 262144) {
                    $previousLog = $logPath + '.1'
                    if ([IO.File]::Exists($previousLog)) { [IO.File]::Delete($previousLog) }
                    [IO.File]::Move($logPath, $previousLog)
                }
                $entry = [DateTimeOffset]::Now.ToString('o') + ' [' + $Context + '] ' + $Message + [Environment]::NewLine
                [IO.File]::AppendAllText($logPath, $entry, [Text.UTF8Encoding]::new($true))
                $script:lastLoggedError = $Message
            } catch { }
        }
        return Get-MeterErrorText -Message $Message -Language $script:uiLanguage -Context $Context
    }

    if ($Preview) {
        $script:previewState = New-MeterState
        $names = @('家里的 Wi-Fi', '工作室 · Studio', 'iPhone 热点', '书房 5 GHz', '咖啡馆 Guest', '图书馆 Wi-Fi', '旅行路由器', '办公室 2F', '会议室', '周末小屋', '朋友家 Wi-Fi', '机场 Free Wi-Fi')
        $stamp = [DateTimeOffset]::Now.ToString('o')
        $script:previewState.Networks = @(for ($i = 0; $i -lt $PreviewNetworkCount; $i++) {
            [long]$rx = [Math]::Round(71340000000 / [Math]::Pow($i + 1, 1.37))
            [long]$tx = [Math]::Round($rx * (0.085 + ($i % 3) * 0.07))
            [long]$rxToday = [Math]::Floor($rx * 0.3); [long]$txToday = [Math]::Floor($tx * 0.3)
            $name = if ($i -lt $names.Count) { $names[$i] } else { '演示 Wi-Fi ' + ($i + 1) }
            [pscustomobject]@{ SSID = $name; RxBytes = $rx; TxBytes = $tx; FirstSeen = $stamp; LastSeen = $stamp; Days = @(
                [pscustomobject]@{ Date = [DateTime]::Today.AddDays(-1).ToString('yyyy-MM-dd'); RxBytes = [long]($rx - $rxToday); TxBytes = [long]($tx - $txToday) },
                [pscustomobject]@{ Date = [DateTime]::Today.ToString('yyyy-MM-dd'); RxBytes = $rxToday; TxBytes = $txToday }
            ) }
        })
    }
    $reader = [Xml.XmlReader]::Create((Join-Path $PSScriptRoot 'MainWindow.xaml'))
    try { $script:window = [Windows.Markup.XamlReader]::Load($reader) } finally { $reader.Close() }
    $names = @('ChartList', 'TrafficTable', 'EmptyState', 'ToggleButton', 'AutoStart', 'StartupDetail', 'StartupSettingsButton', 'StatusBadge', 'StatusPill', 'StatusDetail', 'ConnectionName', 'DownloadSpeed', 'UploadSpeed', 'TotalValue', 'DownloadValue', 'UploadValue', 'NetworkCount', 'RangeCaption', 'HeaderSubtitle', 'ExportButton', 'FolderButton', 'RefreshButton', 'StopAndExitButton', 'SettingsButton', 'PeriodAll', 'PeriodToday', 'PeriodMonth', 'PeriodRange', 'ChartView', 'TableView', 'LanguageEnglish', 'LanguageChinese', 'LiveConnections', 'LiveUsage', 'LiveAppsHint', 'LiveAppsList')
    foreach ($name in $names) { Set-Variable -Scope Script -Name $name -Value $window.FindName($name) }
    function Update-MeterLocalizedControls {
        foreach ($key in $script:strings.Keys) { $window.Resources[$key] = $script:strings[$key] }
        # DataGrid columns do not inherit resources from the visual tree.
        $columnKeys = @('NetworkName', 'DownloadGB', 'UploadGB', 'TotalGB')
        for ($i = 0; $i -lt $columnKeys.Count; $i++) {
            $TrafficTable.Columns[$i].Header = Text-Meter $columnKeys[$i]
        }
        $window.Language = [Windows.Markup.XmlLanguage]::GetLanguage($(if ($script:uiLanguage -eq 'en') { 'en-US' } else { 'zh-CN' }))
        $culture = [Globalization.CultureInfo]::GetCultureInfo($window.Language.IetfLanguageTag)
        [Threading.Thread]::CurrentThread.CurrentCulture = $culture
        [Threading.Thread]::CurrentThread.CurrentUICulture = $culture
        if ($null -ne $script:trayIcon) {
            $script:trayIcon.ContextMenuStrip.Items[0].Text = Text-Meter 'OpenWindow'
            $script:trayIcon.ContextMenuStrip.Items[1].Text = Text-Meter 'Exit'
        }
    }
    Update-MeterLocalizedControls
    $LanguageEnglish.IsChecked = $script:uiLanguage -eq 'en'
    $LanguageChinese.IsChecked = $script:uiLanguage -eq 'zh-CN'
    $workArea = [Windows.SystemParameters]::WorkArea
    $window.Width = [Math]::Min(1240, $workArea.Width)
    $window.Height = [Math]::Min(760, $workArea.Height)
    if ($Preview) {
        $HeaderSubtitle.Text = Text-Meter 'PreviewSubtitle'
        $ToggleButton.IsEnabled = $false; $AutoStart.IsEnabled = $false
        $ExportButton.IsEnabled = $false; $FolderButton.IsEnabled = $false
        $StartupDetail.Text = Text-Meter 'PreviewStartup'
    }

    function Format-MeterGigabytes([double]$Bytes) { ($Bytes / 1e9).ToString('N3') + ' GB' }

    function Get-MeterNetworkAliasMap {
        $aliases = [Collections.Generic.Dictionary[string,string]]::new([StringComparer]::Ordinal)
        foreach ($network in $script:preferences.Networks) { $aliases[$network.SSID] = [string]$network.Alias }
        return $aliases
    }

    function ConvertTo-MeterWiredNameMap {
        param([AllowNull()]$Interfaces)
        # Wired adapters are sampled under the reserved "Ethernet:<GUID>" identity;
        # this maps each identity to the adapter's Windows connection name for display.
        $map = [Collections.Generic.Dictionary[string,string]]::new([StringComparer]::Ordinal)
        try {
            foreach ($interface in @($Interfaces)) {
                try {
                    if ($interface.NetworkInterfaceType -ne [System.Net.NetworkInformation.NetworkInterfaceType]::Ethernet) { continue }
                    $name = [string]$interface.Name
                    if ([string]::IsNullOrWhiteSpace($name)) { continue }
                    $map['Ethernet:' + ([guid]$interface.Id).ToString('D')] = $name
                } catch { }
            }
        } catch { }
        return $map
    }

    function Get-MeterWiredNameMap {
        param([AllowNull()]$Interfaces = $null)
        # Tests inject fake interface objects; live calls share a short-lived cache.
        if ($null -ne $Interfaces) { return (ConvertTo-MeterWiredNameMap -Interfaces $Interfaces) }
        if ($null -ne $script:wiredNameCache.Map -and ([datetime]::UtcNow - $script:wiredNameCache.Time) -lt [TimeSpan]::FromSeconds(10)) {
            return $script:wiredNameCache.Map
        }
        try { $adapters = [System.Net.NetworkInformation.NetworkInterface]::GetAllNetworkInterfaces() } catch { $adapters = @() }
        $map = ConvertTo-MeterWiredNameMap -Interfaces $adapters
        $script:wiredNameCache.Time = [datetime]::UtcNow
        $script:wiredNameCache.Map = $map
        return $map
    }

    function Resolve-MeterNetworkDisplayName {
        param([Parameter(Mandatory)][AllowEmptyString()][string]$SSID, [AllowNull()]$Aliases, [AllowNull()]$WiredNames)
        # Wired identities show the user's alias or the adapter's connection name.
        # The raw identity stays visible in the details dialog and in exports.
        $isWired = Test-MeterWiredIdentity $SSID
        if ($null -ne $Aliases -and $Aliases.ContainsKey($SSID) -and -not [string]::IsNullOrWhiteSpace($Aliases[$SSID])) { return [string]$Aliases[$SSID] }
        if ($isWired -and $null -ne $WiredNames -and $WiredNames.ContainsKey($SSID)) { return [string]$WiredNames[$SSID] }
        return $SSID
    }

    function Get-MeterCsvNetworkNames {
        param($State, $Aliases, $WiredNames)
        # Export mappings may only replace wired identities; Wi-Fi SSIDs stay verbatim.
        $names = [Collections.Generic.Dictionary[string,string]]::new([StringComparer]::Ordinal)
        if ($null -eq $State -or $null -eq $State.PSObject.Properties['Networks']) { return $names }
        foreach ($network in @($State.Networks)) {
            if ($null -eq $network -or -not $network.PSObject.Properties['SSID'] -or -not (Test-MeterWiredIdentity ([string]$network.SSID))) { continue }
            $display = Resolve-MeterNetworkDisplayName -SSID ([string]$network.SSID) -Aliases $Aliases -WiredNames $WiredNames
            if ($display -cne [string]$network.SSID) { $names[[string]$network.SSID] = $display }
        }
        return $names
    }

    function Get-MeterStatusApps($Status) {
        # status.Apps is a best-effort collector addition; tolerate older status files.
        $apps = [Collections.Generic.List[object]]::new()
        if ($null -ne $Status -and $null -ne $Status.PSObject.Properties['Apps'] -and $null -ne $Status.Apps) {
            foreach ($app in @($Status.Apps)) {
                if ($null -eq $app -or -not $app.PSObject.Properties['Name']) { continue }
                $name = [string]$app.Name
                if ([string]::IsNullOrWhiteSpace($name)) { continue }
                $connections = [long]0
                if ($app.PSObject.Properties['Connections']) { try { $connections = [long]$app.Connections } catch { $connections = [long]0 } }
                $apps.Add([pscustomobject]@{ Name = $name; Connections = $connections })
            }
        }
        return @($apps | Sort-Object -Property @{ Expression = 'Connections'; Descending = $true }, Name | Select-Object -First 12)
    }

    function Get-MeterCurrentConnectionSsid {
        param($Status, $WiredNames)
        # The collector lists Wi-Fi SSIDs first and wired connection names after;
        # skip names that belong to wired adapters so usage queries get an SSID.
        if ($null -eq $Status -or $null -eq $Status.PSObject.Properties['Connections']) { return '' }
        $wired = [Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
        if ($null -ne $WiredNames) { foreach ($name in $WiredNames.Values) { [void]$wired.Add([string]$name) } }
        foreach ($connection in @($Status.Connections)) {
            $name = [string]$connection
            if ([string]::IsNullOrWhiteSpace($name) -or $wired.Contains($name)) { continue }
            return $name
        }
        return ''
    }

    function Start-MeterLiveUsageWorker {
        param([Parameter(Mandatory)][string]$Ssid)
        $script:liveUsageQuery.Worker = [PowerShell]::Create()
        # Same worker pattern as the network dialog: the WinRT query and proxy
        # repair run outside the UI thread and the poll forwards the result.
        [void]$script:liveUsageQuery.Worker.AddScript('param($module, $monitorModule, $proxyRowName, $ssid, $start, $end, $directory) Import-Module $module -Force -ErrorAction Stop; Import-Module $monitorModule -Force -ErrorAction Stop; $result = Get-MeterAppUsage -SSID $ssid -StartDate $start -EndDate $end -DataDirectory $directory -ErrorAction Stop; return (Repair-MeterProxyAttribution -Result $result -DataDirectory $directory -UnattributedName $proxyRowName)').AddArgument((Join-Path $PSScriptRoot 'AppUsage.psm1')).AddArgument((Join-Path $PSScriptRoot 'AppMonitor.psm1')).AddArgument((Text-Meter 'ProxyUnattributedRow')).AddArgument($Ssid).AddArgument([DateTime]::Today).AddArgument([DateTime]::Today).AddArgument($script:directory)
        $script:liveUsageQuery.Pending = $script:liveUsageQuery.Worker.BeginInvoke()
        $script:liveUsageQuery.Poll = [Windows.Threading.DispatcherTimer]::new()
        $script:liveUsageQuery.Poll.Interval = [TimeSpan]::FromMilliseconds(200)
        $script:liveUsageQuery.Poll.Add_Tick({
            $state = $script:liveUsageQuery
            if ($null -eq $state.Pending -or -not $state.Pending.IsCompleted) { return }
            $state.Poll.Stop()
            try {
                $results = @($state.Worker.EndInvoke($state.Pending))
                if ($state.Worker.HadErrors -or $results.Count -eq 0) { throw 'Application usage query failed.' }
                $result = $results[-1]
                $script:liveUsageQuery.Rows = @(ConvertTo-MeterAppRows -Rows @($result.Rows))
                $script:liveUsageQuery.MessageKey = Get-MeterAppUsageMessageKey -Result $result
            } catch {
                $script:liveUsageQuery.Rows = @()
                $script:liveUsageQuery.MessageKey = 'AppUsageUnavailable'
            } finally {
                $state.Worker.Dispose(); $state.Worker = $null; $state.Pending = $null; $state.Poll = $null
            }
            Update-MeterLiveAppsPanel
        })
        $script:liveUsageQuery.Poll.Start()
    }

    function Enter-MeterLiveUsageMode {
        # Today's usage is queried on demand for the current network, not on the 2s tick.
        if ($script:isReadOnly) {
            $script:liveUsageQuery.Rows = @(
                [pscustomobject]@{ Name = 'Microsoft Edge'; DownloadGB = 1.850; UploadGB = 0.085; TotalGB = 1.935 }
                [pscustomobject]@{ Name = 'Windows Update'; DownloadGB = 0.610; UploadGB = 0.005; TotalGB = 0.615 }
            )
            $script:liveUsageQuery.MessageKey = 'AppUsageSource'
            return
        }
        $status = $script:liveAppsStatus
        $connections = @()
        if ($null -ne $status -and $null -ne $status.PSObject.Properties['Connections']) { $connections = @($status.Connections) }
        if ($connections.Count -eq 0) { $script:liveUsageQuery.Rows = @(); $script:liveUsageQuery.MessageKey = 'NoConnection'; return }
        $ssid = Get-MeterCurrentConnectionSsid -Status $status -WiredNames (Get-MeterWiredNameMap)
        if (-not $ssid) { $script:liveUsageQuery.Rows = @(); $script:liveUsageQuery.MessageKey = 'AppUsageWired'; return }
        if ($null -ne $script:liveUsageQuery.Worker) { return }
        if ($script:liveUsageQuery.Ssid -ceq $ssid -and $script:liveUsageQuery.MessageKey) { return }
        $script:liveUsageQuery.Ssid = $ssid
        $script:liveUsageQuery.Rows = @()
        $script:liveUsageQuery.MessageKey = 'AppUsageLoading'
        Start-MeterLiveUsageWorker -Ssid $ssid
    }

    function Update-MeterLiveAppsPanel {
        $items = [Collections.Generic.List[object]]::new()
        $hint = ''
        $hintVisible = $false
        if ($script:liveMode -ceq 'Usage') {
            $hintVisible = $true
            $hint = Text-Meter $(if ($script:liveUsageQuery.MessageKey) { $script:liveUsageQuery.MessageKey } else { 'AppUsageLoading' })
            foreach ($row in @($script:liveUsageQuery.Rows)) {
                $gb = '{0:N3}' -f [double]$row.TotalGB
                $detail = (Text-Meter 'LiveAppUsageChip') -f [string]$row.Name, $gb
                $items.Add([pscustomobject]@{ Name = [string]$row.Name; Value = ($gb + ' GB'); Detail = $detail })
            }
        } else {
            foreach ($app in @(Get-MeterStatusApps $script:liveAppsStatus)) {
                $detail = (Text-Meter 'LiveAppChip') -f $app.Name, $app.Connections
                $items.Add([pscustomobject]@{ Name = $app.Name; Value = [string]$app.Connections; Detail = $detail })
            }
            if ($items.Count -eq 0) { $hintVisible = $true; $hint = Text-Meter 'LiveAppsEmpty' }
        }
        # Rebind only when the visible data or language changed; the panel updates every 2s.
        $parts = @(foreach ($item in $items) { $item.Name + '=' + $item.Value })
        $key = $script:uiLanguage + '|' + $script:liveMode + '|' + ($parts -join ';')
        if ($key -ceq $script:liveAppsKey) { return }
        $script:liveAppsKey = $key
        $LiveAppsList.ItemsSource = $items
        $LiveAppsHint.Text = $hint
        $LiveAppsHint.Visibility = if ($hintVisible -or $items.Count -eq 0) { 'Visible' } else { 'Collapsed' }
    }

    function Get-CurrentMeterRange {
        @{ Period = $script:periodKey; StartDate = $script:rangeStart; EndDate = $script:rangeEnd }
    }

    function Export-CurrentMeterRange([string]$Path) {
        if ([IO.Path]::GetExtension($Path) -ine '.csv' -or [IO.Path]::GetFileName($Path) -in @('usage.csv', 'daily.csv')) { throw (Text-Meter 'InvalidExport') }
        $range = Get-CurrentMeterRange
        $state = if ($Preview) { $script:previewState } else { Read-MeterState -DataDirectory $script:directory }
        # Export wired rows under their connection names; Wi-Fi SSIDs stay verbatim.
        $names = Get-MeterCsvNetworkNames -State $state -Aliases (Get-MeterNetworkAliasMap) -WiredNames (Get-MeterWiredNameMap)
        Export-MeterRangeCsv -State $state -Path $Path -NetworkNames $names @range
    }

    function Refresh-MeterView {
        try {
            $stamp = if ($Preview) { 'preview' } else {
                $primary = Get-Item -LiteralPath (Join-Path $script:directory 'state.json') -ErrorAction SilentlyContinue
                $backup = Get-Item -LiteralPath (Join-Path $script:directory 'state.json.bak') -ErrorAction SilentlyContinue
                $(if ($null -ne $primary) { $primary.LastWriteTimeUtc.Ticks.ToString() + ':' + $primary.Length } else { 'missing' }) + '|' + $(if ($null -ne $backup) { $backup.LastWriteTimeUtc.Ticks.ToString() + ':' + $backup.Length } else { 'missing' })
            }
            if ($null -eq $script:cachedState -or $script:dataStamp -ne $stamp) {
                $script:readWarnings = @()
                $script:cachedState = if ($Preview) { $script:previewState } else { Read-MeterState -DataDirectory $script:directory -WarningAction SilentlyContinue -WarningVariable script:readWarnings }
                $script:dataStamp = $stamp
            }
            $range = Get-CurrentMeterRange
            $key = $stamp + '|' + $range.Period + '|' + $range.StartDate.Ticks + '|' + $range.EndDate.Ticks + '|' + [DateTime]::Today.Ticks
            if ($script:renderKey -ne $key) {
                $rows = @(Get-MeterRows -State $script:cachedState @range)
                [double]$download = 0; [double]$upload = 0
                [double]$maximum = 1
                if ($rows.Count -gt 0) { $maximum = [Math]::Max(1, [double]$rows[0].TotalBytes) }
                $items = [Collections.Generic.List[object]]::new()
                $rank = 0
                $aliases = Get-MeterNetworkAliasMap
                $wiredNames = Get-MeterWiredNameMap
                foreach ($row in $rows) {
                    $rank++; $download += $row.RxBytes; $upload += $row.TxBytes
                    $rxShare = 100.0 * [double]$row.RxBytes / $maximum
                    $txShare = 100.0 * [double]$row.TxBytes / $maximum
                    $items.Add([pscustomobject]@{
                        SSID = $row.SSID; Rank = $rank; RxBytes = $row.RxBytes; TxBytes = $row.TxBytes; TotalBytes = $row.TotalBytes
                        DisplayName = (Resolve-MeterNetworkDisplayName -SSID $row.SSID -Aliases $aliases -WiredNames $wiredNames)
                        DownloadGB = [double]$row.RxBytes / 1e9; UploadGB = [double]$row.TxBytes / 1e9; TotalGB = [double]$row.TotalBytes / 1e9
                        TotalText = Format-MeterGigabytes $row.TotalBytes
                        DetailText = ('↓ ' + (Format-MeterGigabytes $row.RxBytes) + '     ↑ ' + (Format-MeterGigabytes $row.TxBytes))
                        RxWidth = [Windows.GridLength]::new($rxShare, [Windows.GridUnitType]::Star)
                        TxWidth = [Windows.GridLength]::new($txShare, [Windows.GridUnitType]::Star)
                        EmptyWidth = [Windows.GridLength]::new([Math]::Max(0, 100.0 - $rxShare - $txShare), [Windows.GridUnitType]::Star)
                    })
                }
                $script:displayRows = $items.ToArray()
                $chartList.ItemsSource = $script:displayRows
                $trafficTable.ItemsSource = $script:displayRows
                $TotalValue.Text = Format-MeterGigabytes ($download + $upload)
                $DownloadValue.Text = Format-MeterGigabytes $download
                $UploadValue.Text = Format-MeterGigabytes $upload
                $NetworkCount.Text = (Text-Meter 'NetworkCount') -f $rows.Count
                $EmptyState.Visibility = if ($rows.Count -eq 0) { 'Visible' } else { 'Collapsed' }
                $caption = switch ($range.Period) { 'Today' { Text-Meter 'Today' }; 'Month' { Text-Meter 'Month' }; 'Range' { (Text-Meter 'RangeCaption') -f $range.StartDate.ToString('yyyy-MM-dd'), $range.EndDate.ToString('yyyy-MM-dd') }; default { Text-Meter 'AllTime' } }
                $RangeCaption.Text = $caption + (Text-Meter 'Sorted')
                $script:renderKey = $key
            }
            Refresh-MeterStatus
            $script:loadError = ''
        } catch {
            $script:loadError = $_.Exception.Message
            $StatusBadge.Text = Text-Meter 'ReadFailed'; $StatusPill.Background = $window.Resources['DangerSoft']; $StatusBadge.Foreground = $window.Resources['DangerText']
            $StatusDetail.Text = Format-MeterError $script:loadError 'Read'
            $StatusDetail.ToolTip = $StatusDetail.Text + [Environment]::NewLine + (Text-Meter 'TechnicalDetails') + ': ' + $script:loadError
        }
    }

    function Refresh-MeterStatus {
        if ($Preview) {
            $StatusBadge.Text = Text-Meter 'Preview'; $StatusPill.Background = $window.Resources['PreviewSoft']; $StatusBadge.Foreground = $window.Resources['PreviewText']
            $ConnectionName.Text = '家里的 Wi-Fi'; $DownloadSpeed.Text = '2.84 MB/s'; $UploadSpeed.Text = '0.16 MB/s'
            $HeaderSubtitle.Text = Text-Meter 'PreviewSubtitle'
            $StartupDetail.Text = Text-Meter 'PreviewStartup'
            $StatusDetail.Text = Text-Meter 'PreviewDetail'
            $script:liveAppsStatus = [pscustomobject]@{
                Running = $true
                Apps = @(
                    [pscustomobject]@{ Name = 'Microsoft Edge'; Connections = [long]14 }
                    [pscustomobject]@{ Name = 'Windows Terminal'; Connections = [long]5 }
                    [pscustomobject]@{ Name = 'Spotify'; Connections = [long]3 }
                )
            }
            Update-MeterLiveAppsPanel
            return
        }
        $status = Get-MeterStatus -DataDirectory $script:directory
        Show-MeterQuotaAlerts -Status $status
        $ToggleButton.Content = if ($status.Running) { Text-Meter 'Stop' } else { Text-Meter 'Start' }
        $StatusBadge.Text = if ($status.Running -and $status.Healthy) { Text-Meter 'Tracking' } elseif ($status.Running) { Text-Meter 'WaitingSample' } else { Text-Meter 'Stopped' }
        $StatusPill.Background = if ($status.Running) { $window.Resources['SuccessSoft'] } else { $window.Resources['NeutralSoft'] }
        $StatusBadge.Foreground = if ($status.Running) { $window.Resources['SuccessText'] } else { $window.Resources['Muted'] }
        $ConnectionName.Text = if ($status.Running -and @($status.Connections).Count -gt 0) { $status.Connections -join ' / ' } else { Text-Meter 'NoConnection' }
        $ConnectionName.ToolTip = $ConnectionName.Text
        $DownloadSpeed.Text = $(if ($status.Running) { $status.DownloadPerSecond / 1e6 } else { 0 }).ToString('N2') + ' MB/s'
        $UploadSpeed.Text = $(if ($status.Running) { $status.UploadPerSecond / 1e6 } else { 0 }).ToString('N2') + ' MB/s'
        $detail = $StatusBadge.Text
        if ($status.Error) { $detail += ' · ' + (Format-MeterError $status.Error 'Sampling') }
        if ($script:readWarnings.Count -gt 0) { $detail += Text-Meter 'BackupUsed' }
        $detail += ' · ' + (Text-Meter 'BackgroundHint') + (Text-Meter 'UsageNote')
        $StatusDetail.Text = $detail; $StatusDetail.ToolTip = $detail
        if ($status.Error) { $StatusDetail.ToolTip += [Environment]::NewLine + (Text-Meter 'TechnicalDetails') + ': ' + $status.Error }
        $startup = Get-MeterAutoStartInfo
        $script:updatingSettings = $true
        try { $AutoStart.IsChecked = [bool]$startup.Registered } finally { $script:updatingSettings = $false }
        $StartupDetail.Text = if ($startup.DisabledByWindows) { Text-Meter 'StartupDisabled' } elseif ($startup.Enabled) { Text-Meter 'StartupEnabled' } else { Text-Meter 'StartupOff' }
        $StartupSettingsButton.Visibility = if ($startup.DisabledByWindows) { 'Visible' } else { 'Collapsed' }
        $script:liveAppsStatus = $status
        Update-MeterLiveAppsPanel
    }

    function Invoke-MeterAction([scriptblock]$Action, [switch]$PassThru) {
        if ($script:mutating -or $script:isReadOnly) { return }
        $script:mutating = $true
        $ToggleButton.IsEnabled = $false; $AutoStart.IsEnabled = $false; $StopAndExitButton.IsEnabled = $false
        $window.Cursor = [Windows.Input.Cursors]::Wait
        $StatusDetail.Text = Text-Meter 'Working'
        # Render before a collector start or stop waits for its acknowledgement.
        $window.Dispatcher.Invoke([Action]{}, [Windows.Threading.DispatcherPriority]::Render)
        $succeeded = $false
        try { & $Action | Out-Null; $succeeded = $true }
        catch { [void][Windows.MessageBox]::Show($window, (Format-MeterError $_.Exception.Message), 'WiFiMeter', 'OK', 'Warning') }
        finally {
            $window.Cursor = $null; $ToggleButton.IsEnabled = $true; $AutoStart.IsEnabled = $true; $StopAndExitButton.IsEnabled = $true
            $script:mutating = $false
            Refresh-MeterView
        }
        if ($PassThru) { return $succeeded }
    }

    $ToggleButton.Add_Click({ Invoke-MeterAction { if ((Get-MeterStatus -DataDirectory $script:directory).Running) { Stop-MeterCollector -DataDirectory $script:directory } else { Start-MeterCollector -DataDirectory $script:directory } } })
    $ExportButton.Add_Click({ Invoke-MeterAction {
        $range = Get-CurrentMeterRange
        $suffix = if ($range.Period -eq 'Range') { $range.StartDate.ToString('yyyyMMdd') + '-' + $range.EndDate.ToString('yyyyMMdd') } else { $range.Period.ToLowerInvariant() }
        $dialog = New-Object Microsoft.Win32.SaveFileDialog
        $dialog.Title = Text-Meter 'ExportTitle'; $dialog.Filter = Text-Meter 'CsvFilter'; $dialog.DefaultExt = '.csv'; $dialog.AddExtension = $true
        $dialog.FileName = 'wifi-usage-' + $suffix + '.csv'
        if ([IO.Directory]::Exists($script:directory)) { $dialog.InitialDirectory = $script:directory }
        if ($dialog.ShowDialog($window)) { Export-CurrentMeterRange -Path $dialog.FileName; [void][Windows.MessageBox]::Show($window, ((Text-Meter 'ExportedTo') + [Environment]::NewLine + $dialog.FileName), (Text-Meter 'ExportComplete'), 'OK', 'Information') }
    } })
    $FolderButton.Add_Click({ Invoke-MeterAction { [void][IO.Directory]::CreateDirectory($script:directory); Start-Process -FilePath 'explorer.exe' -ArgumentList ('"' + $script:directory + '"') } })
    $StartupSettingsButton.Add_Click({ if (-not $Preview) { Start-Process 'ms-settings:startupapps' } })
    $RefreshButton.Add_Click({ $script:cachedState = $null; $script:renderKey = ''; Refresh-MeterView })
    foreach ($radio in @($PeriodAll, $PeriodToday, $PeriodMonth)) {
        $radio.Add_Checked({ param($sender, $eventArgs) $script:periodKey = [string]$sender.Tag; Refresh-MeterView })
    }
    $PeriodRange.Add_Click({ Show-MeterDateDialog })
    $SettingsButton.Add_Click({ $dialog = New-MeterSettingsDialog; [void]$dialog.Window.ShowDialog() })
    function Open-MeterSelectedNetwork {
        param($Sender, $Source)
        $container = [Windows.Controls.ItemsControl]::ContainerFromElement($Sender, $Source)
        if ($null -eq $container -or $null -eq $container.DataContext -or -not $container.DataContext.PSObject.Properties['SSID']) { return }
        $dialog = New-MeterNetworkDialog -SSID $container.DataContext.SSID
        [void]$dialog.Window.ShowDialog()
    }
    $ChartList.Add_MouseLeftButtonUp({ param($sender, $eventArgs) Open-MeterSelectedNetwork -Sender $sender -Source $eventArgs.OriginalSource })
    $TrafficTable.Add_MouseLeftButtonUp({ param($sender, $eventArgs) Open-MeterSelectedNetwork -Sender $sender -Source $eventArgs.OriginalSource })
    foreach ($list in @($ChartList, $TrafficTable)) {
        $list.Add_KeyDown({ param($sender, $eventArgs)
            if ($eventArgs.Key -eq 'Enter' -and $null -ne $sender.SelectedItem) {
                $dialog = New-MeterNetworkDialog -SSID $sender.SelectedItem.SSID
                [void]$dialog.Window.ShowDialog()
                $eventArgs.Handled = $true
            }
        })
    }
    function Set-MeterUiLanguage([ValidateSet('en', 'zh-CN')][string]$Value) {
        $script:uiLanguage = $Value
        $script:strings = Get-MeterStrings -Language $Value
        Update-MeterLocalizedControls
        $script:renderKey = ''
        Refresh-MeterView
        if (-not $script:isReadOnly) {
            try { $script:preferences = Set-MeterLanguagePreference -DataDirectory $script:directory -Language $Value }
            catch { $StatusDetail.Text = Format-MeterError $_.Exception.Message 'Settings' }
        }
    }
    $LanguageEnglish.Add_Checked({ Set-MeterUiLanguage 'en' })
    $LanguageChinese.Add_Checked({ Set-MeterUiLanguage 'zh-CN' })
    $ChartView.Add_Checked({ $ChartList.Visibility = 'Visible'; $TrafficTable.Visibility = 'Collapsed' })
    $TableView.Add_Checked({ $ChartList.Visibility = 'Collapsed'; $TrafficTable.Visibility = 'Visible' })
    $LiveConnections.Add_Checked({ $script:liveMode = 'Connections'; Update-MeterLiveAppsPanel })
    $LiveUsage.Add_Checked({ $script:liveMode = 'Usage'; Enter-MeterLiveUsageMode; Update-MeterLiveAppsPanel })
    $AutoStart.Add_Click({
        if ($script:updatingSettings -or $script:mutating -or $Preview) { return }
        Invoke-MeterAction { Set-MeterAutoStart -Enabled ([bool]$AutoStart.IsChecked) }
    })
    function Show-MeterWindow {
        $window.Show()
        $window.WindowState = 'Normal'
        $window.ShowInTaskbar = $true
        [void]$window.Activate()
        Refresh-MeterView
    }
    function Hide-MeterWindow {
        $window.ShowInTaskbar = $false
        $window.Hide()
    }
    function Exit-MeterApplication {
        if ($script:mutating) { return }
        if ($script:isReadOnly) { $script:allowClose = $true; $window.Close(); return }
        $stopped = Invoke-MeterAction -Action { Stop-MeterCollector -DataDirectory $script:directory } -PassThru
        if (-not $stopped) { return }
        if (-not (Get-MeterStatus -DataDirectory $script:directory).Running) {
            $script:allowClose = $true
            $window.Close()
        }
    }
    function Show-MeterQuotaAlerts {
        param($Status)
        if ($null -eq $script:trayIcon -or -not $Status.PSObject.Properties['Alerts']) { return }
        foreach ($alert in @($Status.Alerts)) {
            if (-not $alert.Id -or -not $script:seenAlerts.Add([string]$alert.Id)) { continue }
            $name = if ($alert.Alias) { $alert.Alias } else { $alert.SSID }
            # Total-scope alerts carry their own wording; older persisted notices have no Scope.
            $isTotal = $null -ne $alert.PSObject.Properties['Scope'] -and $alert.Scope -ceq 'Total'
            $key = switch ($alert.Type) {
                'Disconnected' { 'QuotaDisconnected' }
                'DisconnectFailed' { 'QuotaDisconnectFailed' }
                'Limit' { if ($isTotal) { 'TotalQuotaReached' } else { 'QuotaReached' } }
                default { if ($isTotal) { 'TotalQuotaWarning' } else { 'QuotaWarning' } }
            }
            $script:trayIcon.ShowBalloonTip(8000, 'WiFiMeter', ((Text-Meter $key) -f $name, [Math]::Round([double]$alert.Percent)), [Windows.Forms.ToolTipIcon]::Warning)
        }
    }
    function Initialize-MeterTray {
        if ($script:isReadOnly) { return }
        $script:trayIcon = [Windows.Forms.NotifyIcon]::new()
        $script:trayIcon.Text = 'WiFiMeter'
        $executable = Join-Path (Split-Path $PSScriptRoot -Parent) 'WiFiMeter.exe'
        $script:trayIcon.Icon = if ([IO.File]::Exists($executable)) { [Drawing.Icon]::ExtractAssociatedIcon($executable) } else { [Drawing.SystemIcons]::Application.Clone() }
        $script:trayIcon.ContextMenuStrip = [Windows.Forms.ContextMenuStrip]::new()
        $open = $script:trayIcon.ContextMenuStrip.Items.Add((Text-Meter 'OpenWindow'))
        $quit = $script:trayIcon.ContextMenuStrip.Items.Add((Text-Meter 'Exit'))
        $open.Add_Click({ Show-MeterWindow })
        $quit.Add_Click({ Exit-MeterApplication })
        $script:trayIcon.Add_MouseClick({ param($sender, $eventArgs) if ($eventArgs.Button -eq [Windows.Forms.MouseButtons]::Left) { Show-MeterWindow } })
        $script:trayIcon.Visible = $true
    }
    $StopAndExitButton.Add_Click({ Exit-MeterApplication })
    $script:timer = New-Object Windows.Threading.DispatcherTimer
    $timer.Interval = [TimeSpan]::FromMilliseconds(300)
    $timer.Add_Tick({
        $activation = Get-Variable -Name WiFiMeterActivationEvent -ErrorAction SilentlyContinue
        if ($null -ne $activation -and $null -ne $activation.Value -and $activation.Value.WaitOne(0)) { Show-MeterWindow }
        $exitEvent = Get-Variable -Name WiFiMeterExitEvent -ErrorAction SilentlyContinue
        if (-not $script:mutating -and $null -ne $exitEvent -and $null -ne $exitEvent.Value -and $exitEvent.Value.WaitOne(0)) { Exit-MeterApplication; return }
        if (-not $script:mutating -and ([DateTime]::UtcNow - $script:lastViewRefresh).TotalSeconds -ge 2) {
            $script:lastViewRefresh = [DateTime]::UtcNow
            if ($window.IsVisible) { Refresh-MeterView } elseif (-not $script:isReadOnly) { Show-MeterQuotaAlerts -Status (Get-MeterStatus -DataDirectory $script:directory) }
        }
    })
    $window.Add_Loaded({
        Initialize-MeterTray
        if ($StartMinimized -and -not $script:isReadOnly) { Hide-MeterWindow; $window.Opacity = 1 }
        if (-not $NoStart -and -not $script:isReadOnly) { Invoke-MeterAction { Start-MeterCollector -DataDirectory $script:directory } }
        Refresh-MeterView
        $timer.Start()
        if ($SnapshotPath) {
            [void]$window.Dispatcher.BeginInvoke([Action]{
                try {
                    if ($script:loadError) { throw $script:loadError }
                    $window.UpdateLayout()
                    $surface = $window.Content
                    $bitmap = [Windows.Media.Imaging.RenderTargetBitmap]::new([int]$surface.ActualWidth, [int]$surface.ActualHeight, 96, 96, [Windows.Media.PixelFormats]::Pbgra32)
                    $bitmap.Render($surface)
                    $encoder = New-Object Windows.Media.Imaging.PngBitmapEncoder
                    $encoder.Frames.Add([Windows.Media.Imaging.BitmapFrame]::Create($bitmap))
                    $stream = [IO.File]::Create([IO.Path]::GetFullPath($SnapshotPath))
                    try { $encoder.Save($stream) } finally { $stream.Dispose() }
                } catch { $script:loadError = $_.Exception.Message }
                finally { $window.Close() }
            }, [Windows.Threading.DispatcherPriority]::ContextIdle)
        }
    })
    $window.Add_StateChanged({ if ($window.WindowState -eq 'Minimized' -and -not $script:isReadOnly) { Hide-MeterWindow } })
    $window.Add_Closing({
        param($sender, $eventArgs)
        if ($script:allowClose -or $script:isReadOnly) { return }
        $eventArgs.Cancel = $true
        if ($script:closeDialogOpen -or $script:mutating) { return }
        $script:closeDialogOpen = $true
        try { $choice = Show-MeterCloseDialog } finally { $script:closeDialogOpen = $false }
        if ($choice -eq 'Tray') { Hide-MeterWindow }
        elseif ($choice -eq 'Exit') { [void]$window.Dispatcher.BeginInvoke([Action]{ Exit-MeterApplication }) }
    })
    $script:frame = [Windows.Threading.DispatcherFrame]::new()
    $window.Add_Closed({
        $timer.Stop()
        if ($null -ne $script:liveUsageQuery.Poll) { $script:liveUsageQuery.Poll.Stop() }
        if ($null -ne $script:liveUsageQuery.Worker) {
            # The WinRT query has a bounded timeout; cancellation interrupts its wait.
            $script:liveUsageQuery.Worker.Stop()
            $script:liveUsageQuery.Worker.Dispose()
        }
        $script:liveUsageQuery.Poll = $null; $script:liveUsageQuery.Pending = $null; $script:liveUsageQuery.Worker = $null
        if ($null -ne $script:trayIcon) {
            $script:trayIcon.Visible = $false
            $script:trayIcon.Icon.Dispose()
            $script:trayIcon.ContextMenuStrip.Dispose()
            $script:trayIcon.Dispose()
            $script:trayIcon = $null
        }
        $script:frame.Continue = $false
    })
    if ($StartMinimized -and -not $script:isReadOnly) {
        $window.ShowInTaskbar = $false
        $window.Opacity = 0
    }
    $window.Show()
    [Windows.Threading.Dispatcher]::PushFrame($script:frame)
    if ($SnapshotPath -and $script:loadError) { throw $script:loadError }
} catch {
    if ($SnapshotPath) { throw }
    [void][Windows.MessageBox]::Show($_.Exception.Message, 'WiFiMeter', 'OK', 'Error')
    exit 1
}
