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
    $names = @('ChartList', 'TrafficTable', 'EmptyState', 'ToggleButton', 'AutoStart', 'StartupDetail', 'StartupSettingsButton', 'StatusBadge', 'StatusPill', 'StatusDetail', 'ConnectionName', 'DownloadSpeed', 'UploadSpeed', 'TotalValue', 'DownloadValue', 'UploadValue', 'NetworkCount', 'RangeCaption', 'HeaderSubtitle', 'ExportButton', 'FolderButton', 'RefreshButton', 'StopAndExitButton', 'SettingsButton', 'PeriodAll', 'PeriodToday', 'PeriodMonth', 'PeriodRange', 'ChartView', 'TableView', 'LanguageEnglish', 'LanguageChinese')
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

    function Get-CurrentMeterRange {
        @{ Period = $script:periodKey; StartDate = $script:rangeStart; EndDate = $script:rangeEnd }
    }

    function Export-CurrentMeterRange([string]$Path) {
        if ([IO.Path]::GetExtension($Path) -ine '.csv' -or [IO.Path]::GetFileName($Path) -in @('usage.csv', 'daily.csv')) { throw (Text-Meter 'InvalidExport') }
        $range = Get-CurrentMeterRange
        $state = if ($Preview) { $script:previewState } else { Read-MeterState -DataDirectory $script:directory }
        Export-MeterRangeCsv -State $state -Path $Path @range
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
                $aliases = [Collections.Generic.Dictionary[string,string]]::new([StringComparer]::Ordinal)
                foreach ($network in $script:preferences.Networks) { $aliases[$network.SSID] = $network.Alias }
                foreach ($row in $rows) {
                    $rank++; $download += $row.RxBytes; $upload += $row.TxBytes
                    $rxShare = 100.0 * [double]$row.RxBytes / $maximum
                    $txShare = 100.0 * [double]$row.TxBytes / $maximum
                    $items.Add([pscustomobject]@{
                        SSID = $row.SSID; Rank = $rank; RxBytes = $row.RxBytes; TxBytes = $row.TxBytes; TotalBytes = $row.TotalBytes
                        DisplayName = $(if ($aliases.ContainsKey($row.SSID) -and $aliases[$row.SSID]) { $aliases[$row.SSID] } else { $row.SSID })
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
            $StatusBadge.Text = Text-Meter 'ReadFailed'; $StatusPill.Background = '#FDEEEF'; $StatusBadge.Foreground = '#C45664'
            $StatusDetail.Text = Format-MeterError $script:loadError 'Read'
            $StatusDetail.ToolTip = $StatusDetail.Text + [Environment]::NewLine + (Text-Meter 'TechnicalDetails') + ': ' + $script:loadError
        }
    }

    function Refresh-MeterStatus {
        if ($Preview) {
            $StatusBadge.Text = Text-Meter 'Preview'; $StatusPill.Background = '#EEEDFE'; $StatusBadge.Foreground = '#6567BC'
            $ConnectionName.Text = '家里的 Wi-Fi'; $DownloadSpeed.Text = '2.84 MB/s'; $UploadSpeed.Text = '0.16 MB/s'
            $HeaderSubtitle.Text = Text-Meter 'PreviewSubtitle'
            $StartupDetail.Text = Text-Meter 'PreviewStartup'
            $StatusDetail.Text = Text-Meter 'PreviewDetail'
            return
        }
        $status = Get-MeterStatus -DataDirectory $script:directory
        Show-MeterQuotaAlerts -Status $status
        $ToggleButton.Content = if ($status.Running) { Text-Meter 'Stop' } else { Text-Meter 'Start' }
        $StatusBadge.Text = if ($status.Running -and $status.Healthy) { Text-Meter 'Tracking' } elseif ($status.Running) { Text-Meter 'WaitingSample' } else { Text-Meter 'Stopped' }
        $StatusPill.Background = if ($status.Running) { '#E9F6F0' } else { '#EAEDF4' }
        $StatusBadge.Foreground = if ($status.Running) { '#26996E' } else { '#7C879D' }
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
            $key = switch ($alert.Type) { 'Disconnected' { 'QuotaDisconnected' }; 'DisconnectFailed' { 'QuotaDisconnectFailed' }; 'Limit' { 'QuotaReached' }; default { 'QuotaWarning' } }
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
