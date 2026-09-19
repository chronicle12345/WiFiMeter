#requires -Version 5.1
param([string]$SnapshotPath)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
if ([Threading.Thread]::CurrentThread.ApartmentState -ne 'STA') { throw 'Run UI tests in Windows PowerShell with -STA.' }
$root = Split-Path $PSScriptRoot -Parent
$temporary = Join-Path $env:TEMP ('WiFiMeter-UI-' + [guid]::NewGuid().ToString('N'))
[void][IO.Directory]::CreateDirectory($temporary)
if (-not $SnapshotPath) { $SnapshotPath = Join-Path $temporary 'preview.png' }
$uiTestSnapshotPath = $SnapshotPath
$unusedData = Join-Path $temporary 'must-not-create'
Add-Type -AssemblyName PresentationFramework, PresentationCore, WindowsBase
function Assert-Ui($Value, [string]$Message) { if (-not $Value) { throw $Message } }
function Find-UiScrollViewer($Element) {
    if ($Element -is [Windows.Controls.ScrollViewer]) { return $Element }
    for ($i = 0; $i -lt [Windows.Media.VisualTreeHelper]::GetChildrenCount($Element); $i++) {
        $found = Find-UiScrollViewer ([Windows.Media.VisualTreeHelper]::GetChild($Element, $i))
        if ($null -ne $found) { return $found }
    }
    return $null
}
function Test-LiveMeterWindow {
    $script:window.UpdateLayout()
    $surface = $script:window.Content
    $bitmap = [Windows.Media.Imaging.RenderTargetBitmap]::new([int]$surface.ActualWidth, [int]$surface.ActualHeight, 96, 96, [Windows.Media.PixelFormats]::Pbgra32)
    $bitmap.Render($surface)
    $pixel = New-Object byte[] 4
    $bitmap.CopyPixels([Windows.Int32Rect]::new(210, 0, 1, 1), $pixel, 4, 0)
    Assert-Ui ($pixel[3] -eq 255) 'Snapshot background must be opaque.'
    $encoder = New-Object Windows.Media.Imaging.PngBitmapEncoder
    $encoder.Frames.Add([Windows.Media.Imaging.BitmapFrame]::Create($bitmap))
    $stream = [IO.File]::Create([IO.Path]::GetFullPath($uiTestSnapshotPath))
    try { $encoder.Save($stream) } finally { $stream.Dispose() }
    Assert-Ui ([IO.File]::Exists($uiTestSnapshotPath)) 'Preview must render a PNG.'
    Assert-Ui ($script:uiLanguage -ceq 'en') 'Fresh installation must default to English.'
    Assert-Ui ($script:PeriodAll.Content -ceq 'All time') 'Default English must reach static controls.'
    Assert-Ui ($script:StatusBadge.Text -ceq 'Demo') 'Default English must reach dynamic status.'
    Assert-Ui ($script:trafficTable.Columns[0].Header -ceq 'Wi-Fi network') 'Table headers must have visible English labels.'
    Assert-Ui (-not [IO.Directory]::Exists($unusedData)) 'Preview must not write a data directory.'
    $script:WiFiMeterExitEvent = [Threading.EventWaitHandle]::new($false, [Threading.EventResetMode]::AutoReset)
    $script:mutating = $true
    $busyFrame = [Windows.Threading.DispatcherFrame]::new()
    $busyTimer = [Windows.Threading.DispatcherTimer]::new()
    $busyTimer.Interval = [TimeSpan]::FromMilliseconds(700)
    $busyTimer.Tag = $busyFrame
    $busyTimer.Add_Tick({ param($sender, $eventArgs) $sender.Stop(); $sender.Tag.Continue = $false })
    try {
        [void]$script:WiFiMeterExitEvent.Set()
        $busyTimer.Start()
        [Windows.Threading.Dispatcher]::PushFrame($busyFrame)
        Assert-Ui ($script:WiFiMeterExitEvent.WaitOne(0)) 'A stop request must remain pending while a modal action is busy.'
    } finally {
        $busyTimer.Stop()
        $script:mutating = $false
        $script:WiFiMeterExitEvent.Dispose()
        $script:WiFiMeterExitEvent = $null
    }
    Assert-Ui ($script:chartList.Items.Count -eq 12) 'All 12 Wi-Fi networks must appear in the chart.'
    Assert-Ui ($script:trafficTable.Items.Count -eq 12) 'All 12 Wi-Fi networks must appear in the table.'
    $scroll = Find-UiScrollViewer $script:chartList
    Assert-Ui ($null -ne $scroll -and $scroll.ScrollableHeight -gt 0) 'Chart must provide scrolling for all networks.'
    Assert-Ui ([Windows.Controls.VirtualizingPanel]::GetIsVirtualizing($script:chartList)) 'Chart must virtualize its network rows.'
    $script:chartList.ScrollIntoView($script:chartList.Items[11])
    $script:window.UpdateLayout()
    $script:chartList.Dispatcher.Invoke([Action]{}, [Windows.Threading.DispatcherPriority]::ContextIdle)
    $script:chartList.UpdateLayout()
    Assert-Ui ($scroll.VerticalOffset -gt 0) 'The last network must be reachable by scrolling.'
    Write-Host 'PASS all networks are available in virtualized, scrollable chart and table'

    Assert-Ui ($null -eq $script:window.FindName('DateControls')) 'Date selection must appear in its dialog, not a separate main-window row.'
    $dateDialog = New-MeterDateDialog
    $dateDialog.From.SelectedDate = [DateTime]::Today
    $dateDialog.To.SelectedDate = [DateTime]::Today
    $dateDialog.Apply.RaiseEvent([Windows.RoutedEventArgs]::new([Windows.Controls.Button]::ClickEvent))
    Assert-Ui ($dateDialog.Result.Accepted -and $dateDialog.Result.StartDate -eq [DateTime]::Today) 'Date dialog must accept an inclusive single-day range.'
    $dateDialog = New-MeterDateDialog
    $dateDialog.From.SelectedDate = [DateTime]::Today
    $dateDialog.To.SelectedDate = [DateTime]::Today.AddDays(-1)
    $dateDialog.Apply.RaiseEvent([Windows.RoutedEventArgs]::new([Windows.Controls.Button]::ClickEvent))
    Assert-Ui (-not $dateDialog.Result.Accepted -and $dateDialog.Error.Text) 'Reversed dates must keep the dialog open with a validation message.'
    $dateDialog.Window.Close()
    Assert-Ui ($null -eq $script:trayIcon) 'Preview must not create a notification-area icon.'
    Write-Host 'PASS custom dates validate before applying and preview has no tray side effects'

    $networkDialog = New-MeterNetworkDialog -SSID $script:displayRows[0].SSID
    $networkDialog.Window.Show()
    $networkDialog.Window.UpdateLayout()
    Assert-Ui ($networkDialog.Period.SelectedItem.Tag -eq 'Month') 'Network quota must default to a monthly period.'
    Assert-Ui (-not $networkDialog.Disconnect.IsChecked) 'Automatic disconnect must be off by default.'
    Assert-Ui ($networkDialog.Apps.Items.Count -eq 2 -and $networkDialog.Daily.Items.Count -eq 2) 'Application and daily views must display returned usage rows.'
    Assert-Ui ($networkDialog.Apps.Columns[0].Header -ceq 'Application') 'Application table headers must be localized.'
    Complete-MeterAppUsage -Context $networkDialog -Result ([pscustomobject]@{ Available = $true; MessageCode = 'Partial'; Rows = @(); Days = @(); Message = 'Partial history.' })
    Assert-Ui ($networkDialog.Status.Text -match '60 days') 'Partial application history must clearly explain its date limits.'
    $networkDialog.Window.Close()
    Assert-Ui (-not [IO.Directory]::Exists($unusedData)) 'Network preview must not write settings or application records.'

    $originalDirectory = $script:directory
    $originalPreferences = $script:preferences
    $isolatedPreferences = Join-Path $temporary 'dialog-settings'
    try {
        $script:directory = $isolatedPreferences
        $script:isReadOnly = $false
        $networkDialog = New-MeterNetworkDialog -SSID $script:displayRows[0].SSID
        $networkDialog.Alias.Text = 'Home'
        $networkDialog.Limit.Text = '100'
        $networkDialog.Warn.Text = '85'
        $networkDialog.Save.RaiseEvent([Windows.RoutedEventArgs]::new([Windows.Controls.Button]::ClickEvent))
        Assert-Ui $networkDialog.Saved 'Valid network settings must save successfully.'
        $saved = Read-MeterPreferences -DataDirectory $isolatedPreferences
        $network = Get-MeterNetworkPreference -Preferences $saved -SSID $networkDialog.SSID
        Assert-Ui ($network.Alias -ceq 'Home' -and $network.LimitGB -eq 100 -and $network.WarnPercent -eq 85) 'Alias and quota settings must persist together.'
        Assert-Ui ($script:displayRows[0].DisplayName -ceq 'Home') 'Saving an alias must update the main network list.'
        Assert-Ui ($script:displayRows[0].SSID -ceq $networkDialog.SSID) 'An alias must preserve the original SSID identity.'
        $networkDialog.Window.Close()
        $settingsDialog = New-MeterSettingsDialog
        $settingsDialog.Days.Text = '-1'
        $settingsDialog.Save.RaiseEvent([Windows.RoutedEventArgs]::new([Windows.Controls.Button]::ClickEvent))
        Assert-Ui (-not $settingsDialog.Saved -and $settingsDialog.Error.Text) 'Invalid retention must not be saved.'
        $settingsDialog.Days.Text = '30'
        $settingsDialog.Save.RaiseEvent([Windows.RoutedEventArgs]::new([Windows.Controls.Button]::ClickEvent))
        $saved = Read-MeterPreferences -DataDirectory $isolatedPreferences
        Assert-Ui ($settingsDialog.Saved -and $saved.RetentionDays -eq 30) 'Valid retention must persist.'
        Assert-Ui ($saved.Networks[0].Alias -ceq 'Home') 'Retention changes must preserve network settings.'
    } finally {
        $script:directory = $originalDirectory
        $script:preferences = $originalPreferences
        $script:isReadOnly = $true
        $script:renderKey = ''
        Refresh-MeterView
    }
    Write-Host 'PASS network details, alias and quota persistence, retention validation and application history states'

    $allTotal = ($script:displayRows | Measure-Object -Property TotalBytes -Sum).Sum
    $script:periodKey = 'Range'
    $script:rangeStart = [DateTime]::Today
    $script:rangeEnd = [DateTime]::Today
    Refresh-MeterView
    $rangeTotal = ($script:displayRows | Measure-Object -Property TotalBytes -Sum).Sum
    Assert-Ui ($rangeTotal -gt 0 -and $rangeTotal -lt $allTotal) 'Changing to an inclusive one-day range must update totals.'
    Assert-Ui ([object]::ReferenceEquals($script:chartList.ItemsSource, $script:trafficTable.ItemsSource)) 'Chart and table must share the current range.'
    $exportPath = Join-Path $temporary 'selected-range.csv'
    Export-CurrentMeterRange -Path $exportPath
    $csv = @(Import-Csv -LiteralPath $exportPath -Encoding UTF8)
    Assert-Ui ($csv.Count -eq 12) 'The current range export must include every network.'
    $exportTotal = ($csv | ForEach-Object { [decimal]$_.'总计_GB' } | Measure-Object -Sum).Sum
    Assert-Ui ([Math]::Abs($exportTotal - $rangeTotal / 1e9) -lt 0.000001) 'Export must use the same inclusive range as the chart and table.'
    Write-Host 'PASS date filter, chart, table, totals and export use the same range'

    foreach ($filename in @('state.json', 'usage.csv', 'daily.csv', 'program.ps1')) {
        $rejected = $false
        try { Export-CurrentMeterRange -Path (Join-Path $temporary $filename) } catch { $rejected = $true }
        Assert-Ui $rejected ('Unsafe export filename must be rejected: ' + $filename)
    }
    Write-Host 'PASS export rejects raw data filenames and non-CSV paths'

    $script:LanguageChinese.IsChecked = $true
    Assert-Ui ($script:PeriodAll.Content -ceq '全部累计') 'Switching to Chinese must update static labels.'
    Assert-Ui ($script:StatusBadge.Text -ceq '演示模式') 'Switching to Chinese must update dynamic labels.'
    Assert-Ui ($script:trafficTable.Columns[0].Header -ceq 'Wi-Fi 名称') 'Switching to Chinese must update table headers.'
    Assert-Ui (-not [IO.Directory]::Exists($unusedData)) 'Preview language changes must not write preferences.'
    $preferences = Join-Path $temporary 'settings.json'
    Save-MeterLanguage -Path $preferences -Language 'zh-CN'
    Assert-Ui ((Read-MeterLanguage -Path $preferences) -ceq 'zh-CN') 'Chinese preference must persist across launches.'
    Save-MeterLanguage -Path $preferences -Language 'en'
    Assert-Ui ((Read-MeterLanguage -Path $preferences) -ceq 'en') 'English preference must persist across launches.'
    $script:LanguageEnglish.IsChecked = $true
    Assert-Ui ($script:trafficTable.Columns[1].Header -ceq 'Download / GB') 'Switching back to English must update table headers.'
    $startupError = Get-MeterErrorText -Message 'Windows 已禁用此启动项。请在任务管理器的启动应用中启用 WiFiMeter。' -Language en
    Assert-Ui ($startupError -match 'Task Manager' -and $startupError -notmatch '[\u4e00-\u9fff]') 'Startup errors must give an English action in the English UI.'
    Assert-Ui ((Get-MeterErrorText -Message '无法读取数据' -Language en -Context Read) -notmatch '[\u4e00-\u9fff]') 'Unknown read errors must have an English summary.'
    Write-Host 'PASS English default, live Chinese switching and persisted language preference'

    $script:previewState = New-MeterState
    $script:cachedState = $null
    $script:renderKey = ''
    Refresh-MeterView
    Assert-Ui ($script:chartList.Items.Count -eq 0 -and $script:trafficTable.Items.Count -eq 0) 'Empty state must clear both views.'
    Assert-Ui ($script:emptyState.Visibility -eq 'Visible') 'Empty state must be explicit.'
    Assert-Ui ([string]::IsNullOrEmpty($script:loadError)) 'Empty state must not be a loading error.'
    Write-Host 'PASS empty state renders without errors'
}
try {
    $script:uiTestFailure = $null
    $script:uiTestCompleted = $false
    # Exercise scrolling while the real window still owns its visual tree.
    [void][Windows.Threading.Dispatcher]::CurrentDispatcher.BeginInvoke([Action]{
        try {
            Test-LiveMeterWindow
            $script:uiTestCompleted = $true
        } catch { $script:uiTestFailure = $_ }
        finally { $script:window.Close() }
    }, [Windows.Threading.DispatcherPriority]::ApplicationIdle)
    . (Join-Path $root 'src/App.ps1') -Preview -NoStart -DataDirectory $unusedData -PreviewNetworkCount 12
    if ($null -ne $script:uiTestFailure) { throw $script:uiTestFailure }
    Assert-Ui $script:uiTestCompleted 'Live UI checks must complete before the window closes.'

    $persistedData = Join-Path $temporary 'preferences'
    Save-MeterLanguage -Path (Join-Path $persistedData 'settings.json') -Language 'zh-CN'
    . (Join-Path $root 'src/App.ps1') -NoStart -DataDirectory $persistedData -SnapshotPath (Join-Path $temporary 'persisted-language.png')
    Assert-Ui ($script:uiLanguage -ceq 'zh-CN') 'A new launch must load the saved Chinese preference.'
    Assert-Ui ($script:PeriodAll.Content -ceq '全部累计') 'Saved language must reach the new window.'
    Write-Host 'PASS saved language is restored on a new application launch'
} finally {
    if ([IO.Directory]::Exists($temporary)) {
        $resolved = [IO.Path]::GetFullPath($temporary)
        if (-not $resolved.StartsWith([IO.Path]::GetFullPath($env:TEMP), [StringComparison]::OrdinalIgnoreCase)) { throw 'Unsafe test cleanup path.' }
        Remove-Item -LiteralPath $resolved -Recurse -Force
    }
}
