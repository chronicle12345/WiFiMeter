#requires -Version 5.1
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
Add-Type -AssemblyName PresentationFramework, PresentationCore, WindowsBase
function Save-DialogSnapshot($Window, $Filename) {
    $Window.Dispatcher.Invoke([Action]{}, [Windows.Threading.DispatcherPriority]::ContextIdle)
    $Window.UpdateLayout()
    $surface = $Window.Content
    $bitmap = [Windows.Media.Imaging.RenderTargetBitmap]::new([int]$surface.ActualWidth, [int]$surface.ActualHeight, 96, 96, [Windows.Media.PixelFormats]::Pbgra32)
    $bitmap.Render($surface)
    $encoder = [Windows.Media.Imaging.PngBitmapEncoder]::new()
    $encoder.Frames.Add([Windows.Media.Imaging.BitmapFrame]::Create($bitmap))
    $folder = Join-Path (Split-Path $PSScriptRoot -Parent) 'artifacts'
    [void][IO.Directory]::CreateDirectory($folder)
    $stream = [IO.File]::Create((Join-Path $folder $Filename))
    try { $encoder.Save($stream) } finally { $stream.Dispose() }
}
. (Join-Path (Split-Path $PSScriptRoot -Parent) 'src/Dialogs.ps1')
function Assert-Detail($Value, $Message) { if (-not $Value) { throw $Message } }
$exe = Join-Path $env:SystemRoot 'System32/notepad.exe'
$script:AppIconCache['missing-id'] = $null
$icon = Get-MeterAppIcon -AppId 'missing-id' -Name $exe
Assert-Detail ($null -ne $icon -and $icon.IsFrozen) 'A cached miss must not hide a valid second candidate.'
$icon = Get-MeterAppIcon -AppId ('\??\' + $exe) -Name ''
Assert-Detail ($null -ne $icon) 'NT DOS paths must resolve to executable icons.'
$process = Get-Process -Id $PID
$icon = Get-MeterAppIcon -AppId $process.ProcessName -Name ''
Assert-Detail ($null -ne $icon) 'Running process names must resolve to executable icons.'
function Text-Meter($Key) { return $Key }; $grid = New-MeterUsageGrid
$cell = $grid.Columns[0].CellTemplate.LoadContent()
Assert-Detail ($cell.Children[0].Children[0].Text.Length -gt 0) 'Unresolved applications must have a visible fallback glyph.'
Write-Host 'PASS icon cache, NT paths, running processes and fallback'


$target = [Text.StringBuilder]::new(1024)
$null = Resolve-MeterAppIconPath '\Device\nonexistent\none.exe'
$drive = $exe.Substring(0, 2)
if ([WiFiMeter.DialogDevicePaths]::QueryDosDevice($drive, $target, $target.Capacity)) {
    $deviceIcon = Get-MeterAppIcon -AppId ($target.ToString() + $exe.Substring(2)) -Name ''
    Assert-Detail ($null -ne $deviceIcon -and $deviceIcon.IsFrozen) 'Device volume paths must resolve to local icons.'
}
$root = Split-Path $PSScriptRoot -Parent
$script:window = [Windows.Markup.XamlReader]::Parse([IO.File]::ReadAllText((Join-Path $root 'src/MainWindow.xaml')))
function Get-MeterNetworkPreference { return [pscustomobject]@{ Alias = ''; LimitGB = 0; WarnPercent = 80; DisconnectAtLimit = $false; Period = 'Month' } }
function Get-CurrentMeterRange { return @{ Period = 'Today' } }
function Get-MeterNetworkAliasMap { return @{} }
function Get-MeterWiredNameMap { return @{} }
function Resolve-MeterNetworkDisplayName { param($SSID) return $SSID }
function Test-MeterWiredIdentity { param($SSID) return $SSID.StartsWith('Ethernet:') }
$script:preferences = [pscustomobject]@{ RetentionDays = 30; Proxy = [pscustomobject]@{ Ports = @(7890); ProcessNames = @() }; TotalLimit = [pscustomobject]@{ LimitGB = 0; WarnPercent = 80; Period = 'Month'; DisconnectAtLimit = $false } }
$script:isReadOnly = $true
Import-Module (Join-Path $root 'src/Strings.psm1') -Force
$strings = Get-MeterStrings -Language en
foreach ($key in $strings.Keys) { $script:window.Resources[$key] = $strings[$key] }
# Allow standalone screenshots before the coordinator integrates these resources.
foreach ($entry in @(@('SearchApplications','Search applications'), @('AppUsageNoMatch','No application matches your search'), @('ProxyAutoDetectHint','Enter the proxy listening ports to automatically identify the listening processes.'), @('ProxyAdvanced','Advanced (optional)'), @('ProxyProcessesOptional','Additional process names (optional)'))) { $script:window.Resources[$entry[0]] = $entry[1] }
$script:window.Show()
try {
    $context = New-MeterNetworkDialog 'Test WiFi'
    $context.Window.Show()
    $context.Window.UpdateLayout()
    Assert-Detail ($context.Apps.Items.Count -eq 2 -and $context.Daily.Items.Count -eq 2) 'Preview should load both tables.'
    Assert-Detail ($context.Window.FindName('SSID').Visibility -eq 'Collapsed') 'Duplicate SSID subtitle should collapse.'
    $context.Tabs.SelectedIndex = 1
    Assert-Detail ($context.UsageFilters.Visibility -eq 'Visible' -and $context.Save.Visibility -eq 'Collapsed') 'Usage tabs should show shared filters and hide settings save.'
    foreach ($column in $context.Apps.Columns) { if ($strings.ContainsKey([string]$column.Header)) { $column.Header = $strings[[string]$column.Header] } }
    Save-DialogSnapshot $context.Window 'dialog-details.png'
    Assert-Detail ($context.Apps.Columns[0].ActualWidth -ge 220) 'Application names and icons must have visible column width.'
    $converted = @(ConvertTo-MeterAppRows @([pscustomobject]@{ Name = 'A'; AppId = $exe; RxBytes = 0; TxBytes = 0; TotalBytes = 0 }, [pscustomobject]@{ Name = 'B'; RxBytes = 0; TxBytes = 0; TotalBytes = 0 }))
    Assert-Detail ($converted[0].AppId -eq $exe -and $converted[1].AppId -eq '') 'Converted rows must preserve application paths and allow missing identifiers.'
    $context.AppSearch.Text = ' EDGE '
    Assert-Detail ($context.Apps.Items.Count -eq 1 -and $context.Daily.Items.Count -eq 1) 'Search should trim whitespace and match both tables ignoring case.'
    $context.AppSearch.Text = '[*]'
    Assert-Detail ($context.Apps.Items.Count -eq 0 -and $context.Daily.Items.Count -eq 0 -and $context.Status.Text -eq 'AppUsageNoMatch') 'Search must be literal and explain no matches.'
    $context.AppSearch.Text = ''
    $context.AppPeriod.SelectedIndex = 1
    Assert-Detail ($context.AppFrom.SelectedDate -eq $context.Start -and $context.AppTo.SelectedDate -eq $context.End) 'Disabled date controls must show the active range.'
    Assert-Detail ($context.Start -eq [datetime]::Today.AddDays(1 - [datetime]::Today.Day) -and $context.End -eq [datetime]::Today) 'Month should use inclusive current-month boundaries.'
    $context.AppPeriod.SelectedIndex = 2
    $context.AppFrom.SelectedDate = [datetime]::Today.AddDays(-2)
    $context.AppTo.SelectedDate = [datetime]::Today.AddDays(-1)
    $context.AppApply.RaiseEvent([Windows.RoutedEventArgs]::new([Windows.Controls.Button]::ClickEvent))
    Assert-Detail ($context.Apps.Items.Count -eq 0 -and $context.Daily.Items.Count -eq 0) 'Past custom dates should exclude today from both tables.'
    $version = $context.Version
    $context.AppFrom.SelectedDate = [datetime]::Today
    $context.AppApply.RaiseEvent([Windows.RoutedEventArgs]::new([Windows.Controls.Button]::ClickEvent))
    Assert-Detail ($context.Version -eq $version -and $context.Status.Text -eq 'ErrorDateOrder') 'Reversed dates should not start a query.'
    $context.AppTo.SelectedDate = $null
    $context.AppApply.RaiseEvent([Windows.RoutedEventArgs]::new([Windows.Controls.Button]::ClickEvent))
    Assert-Detail ($context.Version -eq $version -and $context.Status.Text -eq 'MissingDates') 'Missing dates should not start a query.'
    $context.AppPeriod.SelectedIndex = 0
    Assert-Detail ($context.Apps.Items.Count -eq 2 -and $context.Daily.Items.Count -eq 2) 'Today should restore both tables.'
    $context.AppSearch.Text = 'edge'
    Complete-MeterAppUsage -Context $context -Result ([pscustomobject]@{ Available = $true; Rows = @([pscustomobject]@{ Name = 'Other'; RxBytes = 0; TxBytes = 0; TotalBytes = 0 }); Days = @(); Message = '' })
    Assert-Detail ($context.Apps.Items.Count -eq 0) 'Query completion should retain current search.'
    # Use a real asynchronous pipeline to verify stale completion is discarded.
    $context.Worker = [PowerShell]::Create()
    [void]$context.Worker.AddScript("[pscustomobject]@{ Available = $true; Rows = @(); Days = @(); Message = 'stale' }")
    $context.Pending = $context.Worker.BeginInvoke()
    $context.ActiveVersion = $context.Version
    $context.Poll = [Windows.Threading.DispatcherTimer]::new()
    $context.Poll.Tag = $context
    $oldWorker = $context.Worker
    $context.AppSearch.Text = ''
    $context.AppPeriod.SelectedIndex = 1
    $context.AppPeriod.SelectedIndex = 0
    Assert-Detail ([object]::ReferenceEquals($oldWorker, $context.Worker)) 'Rapid date changes must not leak or replace a running worker.'
    Assert-Detail ($context.Apps.Items.Count -eq 0 -and $context.Daily.Items.Count -eq 0) 'Pending range must clear old table contents.'
    Assert-Detail ($context.Pending.AsyncWaitHandle.WaitOne(5000)) 'Test worker should finish.'
    Receive-MeterAppUsageRead $context
    Assert-Detail ($context.Apps.Items.Count -eq 2 -and $context.Daily.Items.Count -eq 2 -and $null -eq $context.Worker -and $null -eq $context.Pending -and $null -eq $context.Poll) 'Stale completion must trigger the latest range and release the old worker and timer.'
    $context.Worker = [PowerShell]::Create()
    [void]$context.Worker.AddScript('Start-Sleep -Seconds 10')
    $context.Pending = $context.Worker.BeginInvoke()
    $context.Poll = [Windows.Threading.DispatcherTimer]::new()
    $context.Poll.Tag = $context
    $context.Poll.Start()
    $context.Window.Close()
    Assert-Detail ($null -eq $context.Pending -and $null -eq $context.Poll) 'Closing during a query must release the pending operation and timer.'
    $version = $context.Version
    Start-MeterAppUsageRead $context
    Assert-Detail ($context.Closed -and $context.Version -eq $version -and $null -eq $context.Worker) 'Closed dialogs should not restart queries.'
    $settings = New-MeterSettingsDialog
    Assert-Detail ($settings.Processes.Parent.Parent -is [Windows.Controls.Expander] -and -not $settings.Processes.Parent.Parent.IsExpanded) 'Process names should be an optional collapsed advanced setting.'
    $settings.Window.Show()
    $settings.Window.UpdateLayout()
    $settings.Processes.Parent.Parent.BringIntoView()
    Save-DialogSnapshot $settings.Window 'dialog-settings.png'
    $settings.Save.RaiseEvent([Windows.RoutedEventArgs]::new([Windows.Controls.Button]::ClickEvent))
    Assert-Detail $settings.Saved 'Port-only settings must validate and save.'
    Write-Host 'PASS shared search, inclusive dates, validation, completion and optional proxy process names'
} finally { $script:window.Close() }
