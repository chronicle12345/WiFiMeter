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

    Assert-Ui ($script:OverviewPage.Visibility -eq 'Visible' -and $script:ApplicationsPage.Visibility -eq 'Collapsed') 'The overview must be the default page.'
    $script:ApplicationsNav.RaiseEvent([Windows.RoutedEventArgs]::new([Windows.Controls.Button]::ClickEvent))
    $script:window.UpdateLayout()
    Assert-Ui ($script:OverviewPage.Visibility -eq 'Collapsed' -and $script:ApplicationsPage.Visibility -eq 'Visible') 'Sidebar navigation must open the independent applications page.'
    Assert-Ui ($script:LiveAppsList -is [Windows.Controls.DataGrid]) 'Live applications must render as a table.'
    Assert-Ui ($script:AppControls.Visibility -eq 'Collapsed') 'Network controls must remain hidden until an application is selected.'
    Assert-Ui ([object]::ReferenceEquals($script:RefreshButton.Parent, $script:ExportButton.Parent)) 'Refresh and export must share the toolbar.'
    Assert-Ui ($script:LiveAppsList.Items[0].Download -match '/s' -and $script:LiveAppsList.Items[0].Upload -match '/s') 'Live application rows must show download and upload rates.'
    $script:LiveAppsList.SelectedIndex = 0
    Assert-Ui ($script:AppControls.Visibility -eq 'Visible') 'Selecting an application must reveal its controls.'
    $script:liveAppsKey = ''
    Update-MeterLiveAppsPanel
    Assert-Ui ($null -ne $script:LiveAppsList.SelectedItem -and $script:LiveAppsList.SelectedItem.Name -eq 'Microsoft Edge') 'Refreshing rows must preserve application selection.'
    $script:LiveAppSearch.Text = 'terminal'
    Assert-Ui ($script:LiveAppsList.Items.Count -eq 1 -and $script:LiveAppsList.Items[0].Name -eq 'Windows Terminal') 'Application search must filter the application page.'
    $script:LiveAppSearch.Text = ''
    Select-MeterControlledProgram -Path (Join-Path $env:SystemRoot 'System32/notepad.exe')
    Assert-Ui (-not $script:appControl.BlockProgram.IsEnabled -and -not $script:appControl.ThrottleProgram.IsEnabled) 'Preview must not permit privileged network mutations.'
    Assert-Ui ($script:appControl.ProgramPath.Text -like '*notepad.exe') 'Application control must show the exact executable target.'
    $script:OverviewNav.RaiseEvent([Windows.RoutedEventArgs]::new([Windows.Controls.Button]::ClickEvent))
    Assert-Ui ($script:OverviewPage.Visibility -eq 'Visible' -and $script:ApplicationsPage.Visibility -eq 'Collapsed') 'Sidebar navigation must restore the overview.'
    Write-Host 'PASS sidebar applications page, application search and preview network-control isolation'

    Assert-Ui ($script:liveConnections.IsChecked) 'Live connections must be the default panel mode.'
    Assert-Ui ($script:liveAppsList.Items.Count -ge 1) 'Preview must show live per-program connection chips.'
    $chipValues = @($script:liveAppsList.Items | ForEach-Object { [string]$_.Value })
    Assert-Ui (-not (($chipValues -join ' ') -match 'MB/s|GB')) 'Live connection chips must not show byte rates or volumes.'
    Assert-Ui ($script:liveAppsList.Items[0].Name -ceq 'Microsoft Edge') 'Live chips must be sorted by connection count.'
    $tolerant = @(Get-MeterStatusApps ([pscustomobject]@{ Apps = @([pscustomobject]@{ Name = 'ok'; Connections = '7' }, [pscustomobject]@{ }, [pscustomobject]@{ Name = ' ' }, 'junk') }))
    Assert-Ui ($tolerant.Count -eq 1 -and [long]$tolerant[0].Connections -eq 7) 'Live app parsing must tolerate incomplete status rows.'
    $script:LiveUsage.IsChecked = $true
    Assert-Ui ($script:liveAppsList.Items.Count -ge 1) 'Usage mode must show today usage chips in preview.'
    Assert-Ui ($script:LiveUsage.ToolTip -eq (Text-Meter 'AppUsageSource')) 'Usage mode must expose delayed-data guidance in its tooltip.'
    Assert-Ui ($script:liveAppsHint.Visibility -eq 'Collapsed') 'Successful usage must not repeat guidance below the panel.'
    $usageChip = [string]$script:liveAppsList.Items[0].Detail
    Assert-Ui ($usageChip -match 'GB') 'Usage chips must be labelled as today usage in GB.'
    $script:LiveConnections.IsChecked = $true
    Assert-Ui ($script:liveAppsList.Items[0].Name -ceq 'Microsoft Edge') 'Switching back must restore connection chips.'
    Write-Host 'PASS the live apps table renders rates, selections and delayed usage'
    # Regressions: numeric ordering, refresh preservation, and mode reset.
    $savedStatus = $script:liveAppsStatus
    $script:liveAppsStatus = [pscustomobject]@{ Apps = @(
        [pscustomobject]@{ Name = 'Fast'; Connections = 14; DownloadPerSecond = 2000000; UploadPerSecond = 900 }
        [pscustomobject]@{ Name = 'Slow'; Connections = 9; DownloadPerSecond = 900; UploadPerSecond = 2000000 }
        [pscustomobject]@{ Name = 'Unknown'; Connections = 0; DownloadPerSecond = $null; UploadPerSecond = $null }
    ) }
    Update-MeterLiveAppsPanel
    foreach ($case in @(@(1, 'Fast'), @(2, 'Slow'), @(3, 'Fast'))) {
        $column = $script:LiveAppsList.Columns[$case[0]]
        $view = [Windows.Data.CollectionViewSource]::GetDefaultView($script:LiveAppsList.ItemsSource)
        $view.SortDescriptions.Clear()
        $property = if ($column.SortMemberPath) { $column.SortMemberPath } else { $column.Binding.Path.Path }
        $view.SortDescriptions.Add([ComponentModel.SortDescription]::new($property, 'Descending'))
        $column.SortDirection = 'Descending'
        Assert-Ui ($script:LiveAppsList.Items[0].Name -eq $case[1]) 'Application columns must sort by numeric magnitude, not display text.'
        $script:liveAppsKey = ''
        Update-MeterLiveAppsPanel
        Assert-Ui ($script:LiveAppsList.Items[0].Name -eq $case[1] -and $script:LiveAppsList.Items.SortDescriptions.Count -eq 1 -and $column.SortDirection -eq 'Descending') 'Refresh must preserve the active numeric sort and header direction.'
        $column.SortDirection = $null
    }
    $unknown = @($script:LiveAppsList.Items | Where-Object Name -eq 'Unknown')[0]
    Assert-Ui ($null -eq $unknown.DownloadValue -and $null -eq $unknown.UploadValue -and $unknown.Download -eq '—') 'Unknown rates must remain null and display a dash.'
    $script:LiveUsage.IsChecked = $true
    Assert-Ui ($script:LiveAppsList.Items.SortDescriptions.Count -eq 0 -and @($script:LiveAppsList.Columns | Where-Object { $null -ne $_.SortDirection }).Count -eq 0) 'Changing modes must clear sorting and header arrows.'
    Assert-Ui ($script:LiveAppsList.Items[0].DownloadValue -eq 1.85 -and $script:LiveAppsList.Items[0].UploadValue -eq 0.085 -and $script:LiveAppsList.Items[0].SortValue -eq 1.935) 'Usage sorting must use numeric usage values.'
    $script:LiveConnections.IsChecked = $true
    $script:liveAppsStatus = [pscustomobject]@{ Apps = @(
        [pscustomobject]@{ Name = 'SameName'; AppId = ''; ProcessId = 101; Connections = 1 }
        [pscustomobject]@{ Name = 'SameName'; AppId = ''; ProcessId = 202; Connections = 1 }
    ) }
    Update-MeterLiveAppsPanel
    $script:LiveAppsList.SelectedItem = @($script:LiveAppsList.Items | Where-Object { $_.SelectionId -eq 'pid:202' -or $_.AppId -eq 'C:\Other\a.exe' })[0]
    $script:liveAppsKey = ''
    Update-MeterLiveAppsPanel
    Assert-Ui ($script:LiveAppsList.SelectedItem.SelectionId -eq 'pid:202') 'Refreshing unknown-path processes with the same name must preserve the selected PID.'
    $script:liveAppsStatus.Apps[1].ProcessId = 303
    Update-MeterLiveAppsPanel
    Assert-Ui ($null -eq $script:LiveAppsList.SelectedItem) 'A different PID with identical display values must not inherit the old selection.'
    $script:liveAppsStatus = [pscustomobject]@{ Apps = @(
        [pscustomobject]@{ Name = 'SameName'; AppId = 'C:\Apps\a.exe'; ProcessId = 101; Connections = 1 }
        [pscustomobject]@{ Name = 'SameName'; AppId = 'C:\Other\a.exe'; ProcessId = 202; Connections = 1 }
    ) }
    Update-MeterLiveAppsPanel
    $script:LiveAppsList.SelectedItem = @($script:LiveAppsList.Items | Where-Object { $_.SelectionId -eq 'pid:202' -or $_.AppId -eq 'C:\Other\a.exe' })[0]
    $script:liveAppsStatus.Apps[1].ProcessId = 303
    $script:liveAppsKey = ''
    Update-MeterLiveAppsPanel
    Assert-Ui ($null -ne $script:LiveAppsList.SelectedItem -and $script:LiveAppsList.SelectedItem.AppId -eq 'C:\Other\a.exe') 'Known-path selection must follow AppId even when its member PID changes.'
    $script:liveAppsStatus = $savedStatus
    Update-MeterLiveAppsPanel
    $script:LiveConnections.IsChecked = $true

    $script:appControl.CloseProgramControls.RaiseEvent([Windows.RoutedEventArgs]::new([Windows.Controls.Button]::ClickEvent))
    $script:ApplicationsNav.RaiseEvent([Windows.RoutedEventArgs]::new([Windows.Controls.Button]::ClickEvent))
    $script:LiveAppSearch.Text = 'no matching application'
    $script:window.UpdateLayout()
    $choose = $script:window.FindName('ChooseProgramButton')
    Assert-Ui ($null -ne $choose -and $choose.IsVisible -and $choose.IsEnabled) 'An empty application list must retain a visible choose-program entry point.'
    $originalPicker = (Get-Item Function:Request-MeterProgramPath).ScriptBlock
    try {
        function script:Request-MeterProgramPath { return $null }
        $choose.RaiseEvent([Windows.RoutedEventArgs]::new([Windows.Controls.Button]::ClickEvent))
        Assert-Ui ($script:AppControls.Visibility -eq 'Collapsed') 'Cancelling the picker must not open controls.'
        function script:Request-MeterProgramPath { return (Join-Path $env:SystemRoot 'System32/notepad.exe') }
        $choose.RaiseEvent([Windows.RoutedEventArgs]::new([Windows.Controls.Button]::ClickEvent))
        Assert-Ui ($script:AppControls.Visibility -eq 'Visible' -and $script:appControl.ProgramPath.Text -like '*notepad.exe') 'Choosing a file from an empty list must open controls for that executable.'
    } finally { Set-Item Function:script:Request-MeterProgramPath $originalPicker }
    $script:LiveAppSearch.Text = ''
    $script:OverviewNav.RaiseEvent([Windows.RoutedEventArgs]::new([Windows.Controls.Button]::ClickEvent))
    Write-Host 'PASS numeric application sorting, refresh preservation, mode reset and independent program picker'

    $accent = $script:window.Resources['Accent']
    Assert-Ui ($accent -is [Windows.Media.SolidColorBrush] -and $accent.Color.ToString() -ceq '#FF5A63E8') 'The accent token must keep its hue.'
    $pageBackground = $script:window.Resources['PageBackground']
    Assert-Ui ($pageBackground -is [Windows.Media.SolidColorBrush] -and $pageBackground.Color.ToString() -ceq '#FFF5F7FB') 'The page background token must keep the light base.'
    Assert-Ui ($script:window.Background -ceq $pageBackground) 'The window must be painted with the named page background token.'
    $cardStyle = $script:window.Resources['Card']
    $cardRadius = @($cardStyle.Setters | Where-Object { $_ -is [Windows.Setter] -and $_.Property -ceq [Windows.Controls.Border]::CornerRadiusProperty } | Select-Object -First 1).Value
    Assert-Ui ($cardRadius -eq 12) 'Cards must keep the 12px corner radius.'
    $rowStyle = $script:window.Resources[[Windows.Controls.DataGridRow]]
    Assert-Ui (@($rowStyle.Triggers | Where-Object { $_ -is [Windows.Trigger] -and $_.Property -ceq [Windows.Controls.DataGridRow]::IsMouseOverProperty }).Count -gt 0) 'Table rows must have a hover state.'
    $buttonTemplate = @($script:window.Resources[[Windows.Controls.Button]].Setters | Where-Object { $_ -is [Windows.Setter] -and $_.Property -ceq [Windows.Controls.Control]::TemplateProperty } | Select-Object -First 1).Value
    Assert-Ui (@($buttonTemplate.Triggers | Where-Object { $_ -is [Windows.Trigger] -and $_.Property -ceq [Windows.Controls.Control]::IsKeyboardFocusedProperty }).Count -gt 0) 'Buttons must show a keyboard focus indicator.'
    Write-Host 'PASS the design tokens keep the palette, radii and interaction states consistent'

    $script:NetworkSearch.Text = 'studio'
    Assert-Ui ($script:chartList.Items.Count -eq 1 -and $script:trafficTable.Items.Count -eq 1) 'Searching must filter chart and table together, ignoring case.'
    Assert-Ui ($script:displayRows[0].SSID -ceq '工作室 · Studio') 'The filtered row must keep its original SSID identity.'
    $script:NetworkSearch.Text = 'zzz-no-network'
    Assert-Ui ($script:chartList.Items.Count -eq 0 -and $script:emptyState.Visibility -eq 'Visible') 'No search match must show the empty state.'
    Assert-Ui ($script:EmptyTitle.Text -match 'matches your search') 'No match must use the search-specific empty message.'
    $script:NetworkSearch.Text = ''
    Assert-Ui ($script:chartList.Items.Count -eq 12 -and $script:emptyState.Visibility -ceq 'Collapsed') 'Clearing the search must restore every network.'
    Assert-Ui ($script:EmptyTitle.Text -match 'No usage recorded yet') 'Clearing the search must restore the original empty message.'
    Write-Host 'PASS the search filters chart and table with a distinct no-match state'

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

    $wiredContext = @{ SSID = 'Ethernet:00000000-0000-0000-0000-000000000000'; Status = [Windows.Controls.TextBlock]::new() }
    $wiredContext.Apps = New-MeterUsageGrid
    $wiredContext.Daily = New-MeterUsageGrid -IncludeDate $true
    Start-MeterAppUsageRead -Context $wiredContext
    Assert-Ui ($wiredContext.Apps.Items.Count -eq 0 -and $wiredContext.Daily.Items.Count -eq 0) 'Wired identities must not show demo application rows.'
    Assert-Ui ($wiredContext.Status.Text -match 'wired Ethernet') 'Wired identities must explain that Windows keeps no application usage for them.'

    $fakeAdapters = @(
        [pscustomobject]@{ Id = '{C8F2E5A0-1111-2222-3333-444455556666}'; Name = 'Ethernet 2'; NetworkInterfaceType = [System.Net.NetworkInformation.NetworkInterfaceType]::Ethernet },
        [pscustomobject]@{ Id = 'not-a-guid'; Name = 'Broken'; NetworkInterfaceType = [System.Net.NetworkInformation.NetworkInterfaceType]::Ethernet },
        [pscustomobject]@{ Id = '{C8F2E5A0-1111-2222-3333-444455556666}'; Name = 'Wi-Fi adapter'; NetworkInterfaceType = [System.Net.NetworkInformation.NetworkInterfaceType]::Wireless80211 }
    )
    $map = Get-MeterWiredNameMap -Interfaces $fakeAdapters
    Assert-Ui ($map['Ethernet:c8f2e5a0-1111-2222-3333-444455556666'] -ceq 'Ethernet 2') 'Wired identities must map to the adapter connection name.'
    Assert-Ui ($map.Count -eq 1) 'Only Ethernet adapters with valid identities may enter the wired name map.'
    $aliases = [Collections.Generic.Dictionary[string,string]]::new([StringComparer]::Ordinal)
    $aliases['Ethernet:c8f2e5a0-1111-2222-3333-444455556666'] = 'Desk uplink'
    Assert-Ui ((Resolve-MeterNetworkDisplayName -SSID 'Ethernet:c8f2e5a0-1111-2222-3333-444455556666' -Aliases $aliases -WiredNames $map) -ceq 'Desk uplink') 'Aliases must win over adapter connection names.'
    Assert-Ui ((Resolve-MeterNetworkDisplayName -SSID 'Ethernet:c8f2e5a0-1111-2222-3333-444455556666' -Aliases (Get-MeterNetworkAliasMap) -WiredNames $map) -ceq 'Ethernet 2') 'Wired rows must resolve to the adapter name when no alias exists.'
    Assert-Ui ((Resolve-MeterNetworkDisplayName -SSID 'Ethernet:00000000-0000-0000-0000-000000000000' -Aliases (Get-MeterNetworkAliasMap) -WiredNames $map) -ceq 'Ethernet:00000000-0000-0000-0000-000000000000') 'Unknown wired identities must keep their raw key.'
    Assert-Ui ((Resolve-MeterNetworkDisplayName -SSID 'Home Wi-Fi' -Aliases $aliases -WiredNames $map) -ceq 'Home Wi-Fi') 'Wi-Fi SSIDs without aliases must stay unchanged.'
    Write-Host 'PASS wired identities resolve to connection names and wired app usage explains its limits'

    $appsGrid = New-MeterUsageGrid
    Assert-Ui ($appsGrid.Columns[0] -is [Windows.Controls.DataGridTemplateColumn] -and $appsGrid.Columns[0].Header -ceq 'Application') 'Application cells must combine the icon and name in one localized column.'
    $dailyGrid = New-MeterUsageGrid -IncludeDate $true
    Assert-Ui ($dailyGrid.Columns[0].Header -ceq 'Date' -and $dailyGrid.Columns[1] -is [Windows.Controls.DataGridTemplateColumn]) 'Daily tables must keep their date column before the icon column.'
    $notepadIcon = Get-MeterAppIcon -AppId (Join-Path $env:SystemRoot 'System32\notepad.exe') -Name ''
    Assert-Ui ($null -ne $notepadIcon -and $notepadIcon.IsFrozen) 'Identifiable executables must yield a frozen, UI-thread-safe icon.'
    Assert-Ui ([object]::ReferenceEquals($notepadIcon, (Get-MeterAppIcon -AppId (Join-Path $env:SystemRoot 'System32\notepad.exe') -Name ''))) 'Icon lookups must be cached per identifier.'
    Assert-Ui ($null -eq (Get-MeterAppIcon -AppId 'WiFiMeter_missing_72e513' -Name 'WiFiMeter_missing_72e513')) 'Unresolvable identifiers must fall back to the placeholder glyph.'
    for ($i = 0; $i -lt 300; $i++) { $null = Get-MeterAppIcon -AppId ('C:\nonexistent\' + $i + '.exe') -Name '' }
    Assert-Ui ($script:AppIconCache.Count -le 256) 'The icon cache must stay bounded.'
    Write-Host 'PASS application tables render icons from a bounded, worker-filled cache'

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
        $settingsDialog = New-MeterSettingsDialog
        $settingsDialog.Ports.Text = '7890, 7891 0'
        $settingsDialog.Save.RaiseEvent([Windows.RoutedEventArgs]::new([Windows.Controls.Button]::ClickEvent))
        Assert-Ui (-not $settingsDialog.Saved -and $settingsDialog.Error.Text) 'Out-of-range proxy ports must not be saved.'
        $settingsDialog = New-MeterSettingsDialog
        $settingsDialog.Days.Text = '30'
        $settingsDialog.Ports.Text = '7890, 7891'
        $settingsDialog.Processes.Text = 'mihomo, Clash'
        $settingsDialog.TotalLimit.Text = '50'
        $settingsDialog.TotalWarn.Text = '85'
        $settingsDialog.TotalDisconnect.IsChecked = $true
        foreach ($item in $settingsDialog.TotalPeriod.Items) { if ([string]$item.Tag -ceq 'Day') { $settingsDialog.TotalPeriod.SelectedItem = $item } }
        $settingsDialog.Save.RaiseEvent([Windows.RoutedEventArgs]::new([Windows.Controls.Button]::ClickEvent))
        Assert-Ui $settingsDialog.Saved 'Proxy and total quota settings must save successfully.'
        $saved = Read-MeterPreferences -DataDirectory $isolatedPreferences
        Assert-Ui ((@($saved.Proxy.Ports) -join ',') -ceq '7890,7891') 'Proxy ports must persist through the settings dialog.'
        Assert-Ui ((@($saved.Proxy.ProcessNames) -join ',') -ceq 'mihomo,Clash') 'Proxy process names must persist through the settings dialog.'
        Assert-Ui ($saved.TotalLimit.LimitGB -eq 50 -and [string]$saved.TotalLimit.Period -ceq 'Day' -and $saved.TotalLimit.WarnPercent -eq 85 -and $saved.TotalLimit.DisconnectAtLimit) 'Total Wi-Fi quota settings must persist together.'
        Assert-Ui ($saved.RetentionDays -eq 30) 'Saving proxy and total quota settings must preserve retention.'
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

    $script:TrendView.IsChecked = $true
    $script:window.UpdateLayout()
    Assert-Ui ($script:TrendHost.Visibility -ceq 'Visible' -and $script:chartList.Visibility -ceq 'Collapsed' -and $script:trafficTable.Visibility -ceq 'Collapsed') 'Selecting the trend view must show only the trend canvas.'
    Assert-Ui ($script:TrendPlaceholder.Visibility -ceq 'Visible') 'A single-day range must degrade to the trend placeholder.'
    $script:periodKey = 'All'
    Refresh-MeterView
    $script:window.UpdateLayout()
    $script:chartList.Dispatcher.Invoke([Action]{}, [Windows.Threading.DispatcherPriority]::ContextIdle)
    Assert-Ui ($script:TrendPlaceholder.Visibility -ceq 'Collapsed') 'The all-time range must render the trend.'
    Assert-Ui ($script:TrendCanvas.Children.Count -ge 6) 'The trend must draw grid lines, axis labels and both series.'
    Assert-Ui ($script:TrendXStart.Text -match '\d{4}-\d{2}-\d{2}' -and $script:TrendXEnd.Text -match '\d{4}-\d{2}-\d{2}') 'The trend must label its date span.'
    $script:ChartView.IsChecked = $true
    $script:window.UpdateLayout()
    Assert-Ui ($script:chartList.Visibility -ceq 'Visible' -and $script:TrendHost.Visibility -ceq 'Collapsed') 'Switching back must restore the chart view.'
    $script:NetworkSearch.Text = 'missing-network-for-trend-test'
    $script:TrendView.IsChecked = $true
    $script:window.UpdateLayout()
    Update-MeterTrend
    Assert-Ui ($script:NetworkSearchBox.Visibility -eq 'Collapsed' -and $script:NetworkSearchRow.Height.Value -eq 0) 'Trend must hide the network search and reclaim its row.'
    Assert-Ui ($script:displayRows.Count -gt 0 -and $script:EmptyState.Visibility -eq 'Collapsed') 'A hidden search must not filter trend totals or display an empty overlay.'
    $hits = @($script:TrendCanvas.Children | Where-Object { $_ -is [Windows.Controls.Border] -and $_.Tag -eq 'TrendDay' })
    Assert-Ui ($hits.Count -eq $script:trendData.Days.Count) 'Every plotted date must have a hover target.'
    $firstDay = $script:trendData.Days[0]
    Assert-Ui ($hits[0].ToolTip.Content.Contains($firstDay.Date) -and $hits[0].ToolTip.Content.Contains(('{0:N0}' -f $firstDay.RxBytes)) -and $hits[0].ToolTip.Content.Contains(('{0:N0}' -f $firstDay.TxBytes))) 'Hover must expose the actual date and both precise byte values.'
    $script:ChartView.IsChecked = $true
    Assert-Ui ($script:NetworkSearchBox.Visibility -eq 'Visible' -and $script:displayRows.Count -eq 0) 'Returning to chart must restore the visible search and its filter.'
    $script:NetworkSearch.Text = ''
    Write-Host 'PASS the trend view degrades on short ranges and draws both daily series'

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
