#requires -Version 5.1

$script:AppIconCache = [Collections.Generic.Dictionary[string,object]]::new([StringComparer]::OrdinalIgnoreCase)
# Bound for the icon cache: clearing at the limit keeps icon handles and memory in check.
$script:AppIconCacheLimit = 256
$script:AppIconCellTemplate = $null

function ConvertTo-MeterAppIconFrom {
    param([Parameter(Mandatory = $true)][string]$Path)
    Add-Type -AssemblyName System.Drawing -ErrorAction Stop
    Add-Type -AssemblyName PresentationCore -ErrorAction Stop
    $drawingIcon = $null
    try {
        $drawingIcon = [System.Drawing.Icon]::ExtractAssociatedIcon($Path)
        if ($null -eq $drawingIcon) { return $null }
        # BitmapSizeOptions::FromWidth(18) is rejected by CreateBitmapSourceFromHIcon
        # (E_INVALIDARG); convert at the native 32x32 size and scale with a frozen
        # TransformedBitmap so the result is safe to use on the UI thread.
        $source = [System.Windows.Interop.Imaging]::CreateBitmapSourceFromHIcon($drawingIcon.Handle, [Windows.Int32Rect]::Empty, [Windows.Media.Imaging.BitmapSizeOptions]::FromEmptyOptions())
        $scale = 18.0 / 32.0
        $scaled = [Windows.Media.Imaging.TransformedBitmap]::new($source, [Windows.Media.ScaleTransform]::new($scale, $scale))
        $scaled.Freeze()
        return $scaled
    } finally { if ($null -ne $drawingIcon) { $drawingIcon.Dispose() } }
}

function Resolve-MeterAppIconPath {
    param([string]$Candidate)
    if ([string]::IsNullOrWhiteSpace($Candidate)) { return }
    $path = [Environment]::ExpandEnvironmentVariables($Candidate.Trim().Trim('"'))
    if ($path.StartsWith('\??\') -or $path.StartsWith('\\?\')) { $path = $path.Substring(4) }
    if ($path.StartsWith('\SystemRoot\', [StringComparison]::OrdinalIgnoreCase)) { $path = Join-Path $env:SystemRoot $path.Substring(12) }
    if ($path.StartsWith('\Device\', [StringComparison]::OrdinalIgnoreCase)) {
        if (-not ('WiFiMeter.DialogDevicePaths' -as [type])) {
            Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Runtime.InteropServices;
namespace WiFiMeter {
    public static class DialogDevicePaths {
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode)]
        public static extern uint QueryDosDevice(string name, StringBuilder target, int length);
    }
}
'@
        }
        foreach ($drive in [IO.DriveInfo]::GetDrives()) {
            $target = [Text.StringBuilder]::new(1024)
            if ([WiFiMeter.DialogDevicePaths]::QueryDosDevice($drive.Name.Substring(0, 2), $target, $target.Capacity) -eq 0) { continue }
            $prefix = $target.ToString() + '\'
            if ($path.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) { $path = $drive.Name + $path.Substring($prefix.Length); break }
        }
    }
    # Resolve local executables without shell lookup or remote path probes.
    if ($path -match '^[a-zA-Z]:\\' -and [IO.File]::Exists($path)) { return $path }
    if ($path -notmatch '[\\/:*?\[\]]') {
        foreach ($process in @(Get-Process -Name ([IO.Path]::GetFileNameWithoutExtension($path)) -ErrorAction SilentlyContinue)) {
            try { if ($process.Path -and [IO.File]::Exists($process.Path)) { return $process.Path } } catch { }
            finally { $process.Dispose() }
        }
    }
}

function Get-MeterAppIcon {
    [CmdletBinding()]
    param([AllowEmptyString()][string]$AppId, [AllowEmptyString()][string]$Name)
    if ($script:AppIconCache.Count -ge $script:AppIconCacheLimit) { $script:AppIconCache.Clear() }
    foreach ($candidate in @($AppId, $Name)) {
        if ([string]::IsNullOrWhiteSpace($candidate)) { continue }
        if ($script:AppIconCache.ContainsKey($candidate) -and $null -ne $script:AppIconCache[$candidate]) { return $script:AppIconCache[$candidate] }
        try {
            $path = Resolve-MeterAppIconPath -Candidate $candidate
            if ($path) {
                $icon = ConvertTo-MeterAppIconFrom -Path $path
                if ($null -ne $icon) { $script:AppIconCache[$candidate] = $icon; return $icon }
            }
        } catch { }
        # A process may start later, so misses must remain retryable.
    }
    return $null
}

function New-MeterDialog {
    param([string]$TitleKey, [int]$Width, [int]$Height, [string]$Content)
    $markup = '<Window xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation" xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml" Background="{DynamicResource PageBackground}" FontFamily="Segoe UI, Microsoft YaHei UI" FontSize="13" Foreground="{DynamicResource TextPrimary}" WindowStartupLocation="CenterOwner" ShowInTaskbar="False" ResizeMode="NoResize" UseLayoutRounding="True" SnapsToDevicePixels="True"><Border Background="{DynamicResource PageBackground}" Padding="24"><Grid>' + $Content + '</Grid></Border></Window>'
    $dialog = [Windows.Markup.XamlReader]::Parse($markup)
    $dialog.Title = Text-Meter $TitleKey
    $dialog.Width = $Width
    $dialog.Height = $Height
    $dialog.Owner = $script:window
    $dialog.Resources.MergedDictionaries.Add($script:window.Resources)
    $dialog.Language = $script:window.Language
    return $dialog
}

function New-MeterDateDialog {
    $dialog = New-MeterDialog -TitleKey CustomRange -Width 630 -Height 410 -Content @'
<Grid.RowDefinitions>
  <RowDefinition Height="Auto" />
  <RowDefinition Height="*" />
  <RowDefinition Height="Auto" />
  <RowDefinition Height="Auto" />
</Grid.RowDefinitions>
<TextBlock Text="{DynamicResource CustomRange}" FontSize="23" FontWeight="SemiBold" Margin="0,0,0,18" />
<UniformGrid Grid.Row="1" Columns="2">
  <StackPanel Margin="0,0,12,0">
    <TextBlock Text="{DynamicResource StartDate}" Foreground="{DynamicResource Muted}" Margin="0,0,0,8" />
    <Calendar x:Name="From" HorizontalAlignment="Left" />
  </StackPanel>
  <StackPanel Margin="12,0,0,0">
    <TextBlock Text="{DynamicResource EndDate}" Foreground="{DynamicResource Muted}" Margin="0,0,0,8" />
    <Calendar x:Name="To" HorizontalAlignment="Left" />
  </StackPanel>
</UniformGrid>
<TextBlock x:Name="Error" Grid.Row="2" Foreground="{DynamicResource DangerText}" Margin="0,0,0,10" TextWrapping="Wrap" />
<Grid Grid.Row="3">
  <TextBlock Text="{DynamicResource Inclusive}" Foreground="{DynamicResource Muted}" VerticalAlignment="Center" />
  <StackPanel Orientation="Horizontal" HorizontalAlignment="Right">
    <Button x:Name="Cancel" Content="{DynamicResource Cancel}" MinWidth="84" Margin="0,0,8,0" IsCancel="True" />
    <Button x:Name="Apply" Content="{DynamicResource Apply}" MinWidth="84" Style="{DynamicResource PrimaryButton}" IsDefault="True" />
  </StackPanel>
</Grid>
'@
    $context = @{ Window = $dialog; From = $dialog.FindName('From'); To = $dialog.FindName('To'); Apply = $dialog.FindName('Apply'); Error = $dialog.FindName('Error'); Result = @{ Accepted = $false; StartDate = $null; EndDate = $null } }
    $context.From.SelectedDate = $script:rangeStart
    $context.To.SelectedDate = $script:rangeEnd
    $context.From.DisplayDate = $script:rangeStart
    $context.To.DisplayDate = $script:rangeEnd
    $context.From.DisplayDateEnd = [DateTime]::Today
    $context.To.DisplayDateEnd = [DateTime]::Today
    $context.Apply.Tag = $context
    $context.Apply.Add_Click({
        param($sender, $eventArgs)
        $state = $sender.Tag
        if ($null -eq $state.From.SelectedDate -or $null -eq $state.To.SelectedDate) { $state.Error.Text = Text-Meter 'MissingDates'; return }
        if ($state.From.SelectedDate -gt $state.To.SelectedDate) { $state.Error.Text = Text-Meter 'ErrorDateOrder'; return }
        $state.Result.StartDate = ([datetime]$state.From.SelectedDate).Date
        $state.Result.EndDate = ([datetime]$state.To.SelectedDate).Date
        $state.Result.Accepted = $true
        $state.Window.Close()
    })
    $cancel = $dialog.FindName('Cancel')
    $cancel.Tag = $context
    $cancel.Add_Click({ param($sender, $eventArgs) $sender.Tag.Window.Close() })
    return $context
}

function Show-MeterDateDialog {
    $context = New-MeterDateDialog
    [void]$context.Window.ShowDialog()
    if ($context.Result.Accepted) {
        $script:rangeStart = $context.Result.StartDate
        $script:rangeEnd = $context.Result.EndDate
        $script:periodKey = 'Range'
        $PeriodRange.IsChecked = $true
        Refresh-MeterView
    } else {
        switch ($script:periodKey) {
            'Today' { $PeriodToday.IsChecked = $true }
            'Month' { $PeriodMonth.IsChecked = $true }
            'Range' { $PeriodRange.IsChecked = $true }
            default { $PeriodAll.IsChecked = $true }
        }
    }
}

function New-MeterSettingsDialog {
    $dialog = New-MeterDialog -TitleKey Settings -Width 560 -Height 660 -Content @'
<Grid.RowDefinitions>
  <RowDefinition Height="Auto" />
  <RowDefinition Height="*" />
  <RowDefinition Height="Auto" />
</Grid.RowDefinitions>
<TextBlock Text="{DynamicResource Settings}" FontSize="23" FontWeight="SemiBold" Margin="0,0,0,20" />
<ScrollViewer Grid.Row="1" VerticalScrollBarVisibility="Auto" HorizontalScrollBarVisibility="Disabled" Margin="0,0,8,0">
  <StackPanel>
    <TextBlock Text="{DynamicResource Retention}" FontWeight="SemiBold" FontSize="14" />
    <StackPanel Orientation="Horizontal" Margin="0,12,0,10">
      <TextBox x:Name="Days" Width="110" Padding="9,7" MaxLength="5" VerticalContentAlignment="Center" />
      <TextBlock Text="{DynamicResource Days}" Foreground="{DynamicResource Muted}" Margin="10,0,0,0" VerticalAlignment="Center" />
    </StackPanel>
    <TextBlock Text="{DynamicResource RetentionHint}" Foreground="{DynamicResource Muted}" FontSize="11" LineHeight="17" TextWrapping="Wrap" />
    <Border BorderBrush="{DynamicResource DividerSoft}" BorderThickness="0,1,0,0" Margin="0,16,0,0" />
    <TextBlock Text="{DynamicResource TotalQuota}" FontWeight="SemiBold" FontSize="14" Margin="0,16,0,0" />
    <UniformGrid Columns="3" Margin="0,12,0,0">
      <StackPanel Margin="0,0,16,0">
        <TextBlock Text="{DynamicResource QuotaGB}" Foreground="{DynamicResource Muted}" FontSize="11" />
        <TextBox x:Name="TotalLimit" Padding="9,7" MaxLength="20" Margin="0,8,0,0" VerticalContentAlignment="Center" />
      </StackPanel>
      <StackPanel Margin="0,0,16,0">
        <TextBlock Text="{DynamicResource QuotaPeriod}" Foreground="{DynamicResource Muted}" FontSize="11" />
        <ComboBox x:Name="TotalPeriod" Padding="8,6" Margin="0,8,0,0">
          <ComboBoxItem Tag="Day" Content="{DynamicResource PeriodDay}" />
          <ComboBoxItem Tag="Month" Content="{DynamicResource PeriodMonth}" />
          <ComboBoxItem Tag="All" Content="{DynamicResource PeriodAll}" />
        </ComboBox>
      </StackPanel>
      <StackPanel>
        <TextBlock Text="{DynamicResource WarnPercent}" Foreground="{DynamicResource Muted}" FontSize="11" />
        <TextBox x:Name="TotalWarn" Padding="9,7" MaxLength="6" Margin="0,8,0,0" VerticalContentAlignment="Center" />
      </StackPanel>
    </UniformGrid>
    <CheckBox x:Name="TotalDisconnect" Content="{DynamicResource TotalDisconnectAtLimit}" Margin="0,14,0,0" />
    <TextBlock Text="{DynamicResource TotalDisconnectHint}" Foreground="{DynamicResource Muted}" FontSize="11" LineHeight="17" TextWrapping="Wrap" Margin="22,7,0,0" />
    <TextBlock Text="{DynamicResource TotalQuotaHint}" Foreground="{DynamicResource Muted}" FontSize="11" LineHeight="17" TextWrapping="Wrap" Margin="0,10,0,0" />
    <Border BorderBrush="{DynamicResource DividerSoft}" BorderThickness="0,1,0,0" Margin="0,16,0,0" />
    <TextBlock Text="{DynamicResource ProxyPorts}" FontWeight="SemiBold" FontSize="14" Margin="0,16,0,0" />
    <TextBox x:Name="Ports" Padding="9,7" Margin="0,12,0,0" VerticalContentAlignment="Center" />
    <TextBlock Text="{DynamicResource ProxyAutoDetectHint}" Foreground="{DynamicResource Muted}" FontSize="11" TextWrapping="Wrap" Margin="0,10,0,0" />
    <Expander Header="{DynamicResource ProxyAdvanced}" Margin="0,14,0,0">
      <StackPanel Margin="0,10,0,0">
        <TextBlock Text="{DynamicResource ProxyProcessesOptional}" Foreground="{DynamicResource Muted}" />
        <TextBox x:Name="Processes" Padding="9,7" Margin="0,8,0,0" VerticalContentAlignment="Center" />
      </StackPanel>
    </Expander>
    <TextBlock x:Name="Error" Foreground="{DynamicResource DangerText}" TextWrapping="Wrap" Margin="0,14,0,0" />
  </StackPanel>
</ScrollViewer>
<StackPanel Grid.Row="2" Orientation="Horizontal" HorizontalAlignment="Right">
  <Button x:Name="Cancel" Content="{DynamicResource Cancel}" MinWidth="84" Margin="0,0,8,0" IsCancel="True" />
  <Button x:Name="Save" Content="{DynamicResource Save}" MinWidth="84" Style="{DynamicResource PrimaryButton}" IsDefault="True" />
</StackPanel>
'@
    $context = @{ Window = $dialog; Days = $dialog.FindName('Days'); Ports = $dialog.FindName('Ports'); Processes = $dialog.FindName('Processes'); TotalLimit = $dialog.FindName('TotalLimit'); TotalPeriod = $dialog.FindName('TotalPeriod'); TotalWarn = $dialog.FindName('TotalWarn'); TotalDisconnect = $dialog.FindName('TotalDisconnect'); Error = $dialog.FindName('Error'); Save = $dialog.FindName('Save'); Saved = $false }
    $context.Days.Text = [string]$script:preferences.RetentionDays
    $context.Ports.Text = (@($script:preferences.Proxy.Ports) -join ', ')
    $context.Processes.Text = (@($script:preferences.Proxy.ProcessNames) -join ', ')
    $context.TotalLimit.Text = [string]$script:preferences.TotalLimit.LimitGB
    $context.TotalWarn.Text = [string]$script:preferences.TotalLimit.WarnPercent
    $context.TotalDisconnect.IsChecked = $script:preferences.TotalLimit.DisconnectAtLimit
    foreach ($item in $context.TotalPeriod.Items) { if ($item.Tag -ceq $script:preferences.TotalLimit.Period) { $context.TotalPeriod.SelectedItem = $item } }
    $context.Save.Tag = $context
    $context.Save.Add_Click({
        param($sender, $eventArgs)
        $state = $sender.Tag
        [int]$days = 0
        if (-not [int]::TryParse($state.Days.Text, [ref]$days) -or $days -lt 0 -or $days -gt 36500) { $state.Error.Text = Text-Meter 'RetentionInvalid'; return }
        [double]$totalLimit = 0; [double]$totalWarn = 0
        if (-not [double]::TryParse($state.TotalLimit.Text, [ref]$totalLimit) -or [double]::IsNaN($totalLimit) -or $totalLimit -lt 0 -or $totalLimit -gt 9e9 -or ($totalLimit -gt 0 -and $totalLimit -lt 1e-9) -or
            -not [double]::TryParse($state.TotalWarn.Text, [ref]$totalWarn) -or [double]::IsNaN($totalWarn) -or $totalWarn -lt 1 -or $totalWarn -gt 100 -or
            $null -eq $state.TotalPeriod.SelectedItem) { $state.Error.Text = Text-Meter 'QuotaInvalid'; return }
        $ports = [System.Collections.Generic.List[int]]::new()
        foreach ($token in @($state.Ports.Text -split '[,\s;，；]+' | Where-Object { $_ })) {
            [int]$port = 0
            if (-not [int]::TryParse($token, [ref]$port) -or $port -lt 1 -or $port -gt 65535) { $state.Error.Text = Text-Meter 'ProxyPortsInvalid'; return }
            if (-not $ports.Contains($port)) { $ports.Add($port) }
        }
        if ($ports.Count -gt 64) { $state.Error.Text = Text-Meter 'ProxyPortsInvalid'; return }
        $names = [System.Collections.Generic.List[string]]::new()
        foreach ($token in @($state.Processes.Text -split '[,;，；]+' | Where-Object { $_ })) {
            $name = $token.Trim()
            if (-not $name) { continue }
            if ($name.Length -gt 64 -or $name -match '[\x00-\x1f\x7f]') { $state.Error.Text = Text-Meter 'ProxyNamesInvalid'; return }
            $duplicate = $false
            foreach ($existing in $names) { if ($existing -ieq $name) { $duplicate = $true; break } }
            if (-not $duplicate) { $names.Add($name) }
        }
        if ($names.Count -gt 32) { $state.Error.Text = Text-Meter 'ProxyNamesInvalid'; return }
        try {
            if (-not $script:isReadOnly) {
                $script:preferences = Save-MeterPreferences -DataDirectory $script:directory -Preferences ([pscustomobject]@{
                    RetentionDays = $days
                    Proxy = [pscustomobject]@{ Ports = $ports.ToArray(); ProcessNames = $names.ToArray() }
                    TotalLimit = [pscustomobject]@{ LimitGB = $totalLimit; Period = [string]$state.TotalPeriod.SelectedItem.Tag; WarnPercent = $totalWarn; DisconnectAtLimit = [bool]$state.TotalDisconnect.IsChecked }
                })
            }
            $state.Saved = $true
            $state.Window.Close()
        } catch { $state.Error.Text = Format-MeterError $_.Exception.Message 'Settings' }
    })
    $dialog.FindName('Cancel').Tag = $context
    $dialog.FindName('Cancel').Add_Click({ param($sender, $eventArgs) $sender.Tag.Window.Close() })
    return $context
}

function New-MeterUsageGrid {
    param([bool]$IncludeDate = $false)
    $table = [Windows.Controls.DataGrid]::new()
    $table.AutoGenerateColumns = $false
    $table.IsReadOnly = $true
    $table.CanUserAddRows = $false
    $table.EnableRowVirtualization = $true
    $table.EnableColumnVirtualization = $true
    $table.HeadersVisibility = 'Column'
    $table.GridLinesVisibility = 'None'
    $table.BorderThickness = 0
    $table.Background = [Windows.Media.Brushes]::White
    if ($null -eq $script:AppIconCellTemplate) {
        # Icon + name share the Application column; a placeholder glyph shows
        # through whenever the row's Icon is empty.
        $script:AppIconCellTemplate = [Windows.Markup.XamlReader]::Parse(@'
<DataTemplate xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation">
  <StackPanel Orientation="Horizontal" VerticalAlignment="Center">
    <Grid Width="20" Height="20" VerticalAlignment="Center">
      <TextBlock FontFamily="Segoe MDL2 Assets" Text="&#xE8A5;" FontSize="13" Foreground="{DynamicResource Faint}" HorizontalAlignment="Center" VerticalAlignment="Center" />
      <Image Source="{Binding Icon}" Width="18" Height="18" RenderOptions.BitmapScalingMode="HighQuality" HorizontalAlignment="Center" VerticalAlignment="Center" />
    </Grid>
    <TextBlock Text="{Binding Name}" VerticalAlignment="Center" Margin="8,0,0,0" TextTrimming="CharacterEllipsis" />
  </StackPanel>
</DataTemplate>
'@)
    }
    $fields = @()
    if ($IncludeDate) { $fields += ,@('Date', 'Date', 112) }
    $fields += ,@('Name', 'Application', '*')
    $fields += ,@('DownloadGB', 'DownloadGB', 135)
    $fields += ,@('UploadGB', 'UploadGB', 125)
    $fields += ,@('TotalGB', 'TotalGB', 120)
    foreach ($field in $fields) {
        if ($field[0] -ceq 'Name') {
            $column = [Windows.Controls.DataGridTemplateColumn]::new()
            $column.Header = Text-Meter $field[1]
            $column.CellTemplate = $script:AppIconCellTemplate
            $column.MinWidth = 220
            $column.Width = [Windows.Controls.DataGridLengthConverter]::new().ConvertFromString([string]$field[2])
        } else {
            $column = [Windows.Controls.DataGridTextColumn]::new()
            $column.Header = Text-Meter $field[1]
            $column.Binding = [Windows.Data.Binding]::new($field[0])
            if ($field[0] -like '*GB') { $column.Binding.StringFormat = 'N3' }
            $column.Width = [Windows.Controls.DataGridLengthConverter]::new().ConvertFromString([string]$field[2])
        }
        $table.Columns.Add($column)
    }
    return $table
}

function ConvertTo-MeterAppRows {
    param([object[]]$Rows)
    return @(foreach ($row in $Rows) {
        [pscustomobject]@{
            Name = $row.Name
            AppId = $(if ($row.PSObject.Properties['AppId']) { [string]$row.AppId } else { '' })
            Date = $(if ($row.PSObject.Properties['Date']) { $row.Date } else { '' })
            DownloadGB = [double]$row.RxBytes / 1e9
            UploadGB = [double]$row.TxBytes / 1e9
            TotalGB = [double]$row.TotalBytes / 1e9
            Icon = $(if ($row.PSObject.Properties['Icon']) { $row.Icon } else { $null })
        }
    })
}

function Get-MeterAppUsageMessageKey {
    param($Result)
    $messageKey = 'AppUsageUnavailable'
    if ($Result.Available) { $messageKey = if (@($Result.Rows).Count -gt 0) { 'AppUsageSource' } else { 'AppUsageEmpty' } }
    if ($Result.PSObject.Properties['MessageCode']) {
        switch ($Result.MessageCode) {
            'AccessDenied' { $messageKey = 'AppUsageAccessDenied' }
            'Timeout' { $messageKey = 'AppUsageTimeout' }
            'NoData' { $messageKey = 'AppUsageEmpty' }
            'ProfileUnavailable' { $messageKey = 'AppUsageProfile' }
            'Partial' { $messageKey = 'AppUsagePartial' }
            'OutsideAvailableRange' { $messageKey = 'AppUsageOutside' }
            'WiredNetwork' { $messageKey = 'AppUsageWired' }
        }
    }
    return $messageKey
}

function Get-MeterAppMonthlyRows {
    param([object[]]$Rows)
    $groups = [Collections.Generic.Dictionary[string,object]]::new([StringComparer]::Ordinal)
    foreach ($row in $Rows) {
        $month = ([datetime]::ParseExact([string]$row.Date, 'yyyy-MM-dd', [Globalization.CultureInfo]::InvariantCulture)).ToString('yyyy-MM')
        $appId = if ($row.PSObject.Properties['AppId']) { [string]$row.AppId } else { '' }
        $identity = if ($appId) { 'id:' + $appId } else { 'name:' + $row.Name }
        $key = $month + "`n" + $identity
        if (-not $groups.ContainsKey($key)) {
            $groups[$key] = [pscustomobject]@{
                Date = $month; AppId = $appId; Name = $row.Name
                RxBytes = [long]0; TxBytes = [long]0; TotalBytes = [long]0
                Icon = $(if ($row.PSObject.Properties['Icon']) { $row.Icon } else { $null })
            }
        }
        $target = $groups[$key]
        foreach ($field in @('RxBytes', 'TxBytes', 'TotalBytes')) {
            $target.$field = [long][Math]::Min([decimal][long]::MaxValue, ([decimal]$target.$field + [decimal]$row.$field))
        }
    }
    return @($groups.Values | Sort-Object Date, @{ Expression = 'TotalBytes'; Descending = $true }, AppId)
}

function Update-MeterAppExportState {
    param($Context)
    if (-not $Context.ContainsKey('AppExport')) { return }
    $table = if ($Context.Tabs.SelectedIndex -eq 1) { $Context.Apps } else { $Context.Daily }
    $datesApplied = $Context.AppPeriod.SelectedItem.Tag -ne 'Range' -or (
        $null -ne $Context.AppFrom.SelectedDate -and $null -ne $Context.AppTo.SelectedDate -and
        $Context.AppFrom.SelectedDate -eq $Context.Start -and $Context.AppTo.SelectedDate -eq $Context.End)
    $Context.AppExport.IsEnabled = $Context.Tabs.SelectedIndex -gt 0 -and $null -ne $Context.Result -and $Context.Result.Available -and $table.Items.Count -gt 0 -and $datesApplied
}

function Export-MeterAppUsageCsv {
    param($Context, [Parameter(Mandatory)][string]$Path)
    Update-MeterAppExportState $Context
    if (-not $Context.AppExport.IsEnabled) { throw 'No current application usage is available for export.' }
    $table = if ($Context.Tabs.SelectedIndex -eq 1) { $Context.Apps } else { $Context.Daily }
    $fields = @('Name', 'AppId', 'DownloadGB', 'UploadGB', 'TotalGB')
    if ($Context.Tabs.SelectedIndex -eq 2) { $fields = @('Date') + $fields }
    # Export the collection view so filtering, grouping and user sorting match the table.
    $table.Items | Select-Object -Property $fields | Export-Csv -LiteralPath $Path -NoTypeInformation -Encoding UTF8 -ErrorAction Stop
}

function Update-MeterAppUsageFilter {
    param($Context)
    if (-not $Context.ContainsKey('Result') -or $null -eq $Context.Result) { return }
    $query = if ($Context.ContainsKey('AppSearch')) { $Context.AppSearch.Text.Trim() } else { '' }
    foreach ($pair in @(@('Apps', 'Rows'), @('Daily', 'Days'))) {
        $source = @($Context.Result.($pair[1]))
        if ($pair[0] -eq 'Daily' -and $Context.ContainsKey('AppGrouping') -and $Context.AppGrouping.SelectedItem.Tag -eq 'Month') { $source = @(Get-MeterAppMonthlyRows -Rows $source) }
        $rows = @($source | Where-Object { -not $query -or ([string]$_.Name).IndexOf($query, [StringComparison]::OrdinalIgnoreCase) -ge 0 })
        $Context[$pair[0]].ItemsSource = @(ConvertTo-MeterAppRows -Rows $rows)
    }
    $messageKey = Get-MeterAppUsageMessageKey -Result $Context.Result
    $Context.Status.Text = if ($messageKey -eq 'AppUsageSource') { '' } else { Text-Meter $messageKey }
    if ($query -and $Context.Apps.Items.Count -eq 0 -and $Context.Daily.Items.Count -eq 0 -and $Context.Result.Available) { $Context.Status.Text = Text-Meter 'AppUsageNoMatch' }
    $Context.Status.ToolTip = $Context.Result.Message
    $Context.Apps.ToolTip = Text-Meter $messageKey
    $Context.Daily.ToolTip = $Context.Apps.ToolTip
    if ($Context.ContainsKey('AppGrouping')) { $Context.Daily.Columns[0].Header = if ($Context.AppGrouping.SelectedItem.Tag -eq 'Month') { Text-Meter 'AppUsageMonth' } else { Text-Meter 'Date' } }
    Update-MeterAppExportState $Context
}

function Complete-MeterAppUsage {
    param($Context, $Result)
    $Context.Result = $Result
    Update-MeterAppUsageFilter -Context $Context
}

function Set-MeterAppUsageRange {
    param($Context)
    $period = [string]$Context.AppPeriod.SelectedItem.Tag
    $custom = $period -eq 'Range'
    $Context.AppFrom.IsEnabled = $custom
    $Context.AppTo.IsEnabled = $custom
    Update-MeterAppExportState $Context
    if ($custom) {
        if ($null -eq $Context.AppFrom.SelectedDate -or $null -eq $Context.AppTo.SelectedDate) { $Context.Status.Text = Text-Meter 'MissingDates'; return }
        $start = ([datetime]$Context.AppFrom.SelectedDate).Date
        $end = ([datetime]$Context.AppTo.SelectedDate).Date
        if ($start -gt $end) { $Context.Status.Text = Text-Meter 'ErrorDateOrder'; return }
    } else {
        $end = [datetime]::Today
        $start = switch ($period) { 'Today' { $end }; 'Month' { $end.AddDays(1 - $end.Day) }; default { [datetime]::new(2000, 1, 1) } }
    }
    $Context.AppFrom.SelectedDate = $start
    $Context.AppTo.SelectedDate = $end
    $Context.Start = $start
    $Context.End = $end
    Start-MeterAppUsageRead -Context $Context
}

function Start-MeterAppUsageRead {
    param($Context)
    if ($Context.ContainsKey('Closed') -and $Context.Closed) { return }
    if (-not $Context.ContainsKey('Closed')) { $Context.Closed = $false }
    if (-not $Context.ContainsKey('Version')) { $Context.Version = 0 }
    $Context.Version++
    $Context.Result = $null
    $Context.Apps.ItemsSource = @()
    $Context.Daily.ItemsSource = @()
    Update-MeterAppExportState $Context
    $Context.Status.ToolTip = $null
    $Context.Status.Text = Text-Meter 'AppUsageLoading'
    # Coalesce range changes and discard stale results before starting the latest query.
    if ($Context.ContainsKey('Worker') -and $null -ne $Context.Worker) { return }
    # Wired identities have no Wi-Fi profile; Windows keeps no app usage for them.
    if (Test-MeterWiredIdentity $Context.SSID) {
        Complete-MeterAppUsage -Context $Context -Result ([pscustomobject]@{ Available = $false; MessageCode = 'WiredNetwork'; Rows = @(); Days = @(); Message = (Text-Meter 'AppUsageWired') })
        return
    }
    if ($script:isReadOnly) {
        $sample = @(
            [pscustomobject]@{ Name = 'Microsoft Edge'; AppId = 'msedge'; RxBytes = 1850000000; TxBytes = 85000000; TotalBytes = 1935000000; Date = [DateTime]::Today.ToString('yyyy-MM-dd') },
            [pscustomobject]@{ Name = 'Windows Update'; AppId = 'system'; RxBytes = 610000000; TxBytes = 5000000; TotalBytes = 615000000; Date = [DateTime]::Today.ToString('yyyy-MM-dd') }
        )
        $sample = @($sample | Where-Object { [datetime]$_.Date -ge $Context.Start -and [datetime]$_.Date -le $Context.End })
        foreach ($row in $sample) { $row | Add-Member -NotePropertyName Icon -NotePropertyValue (Get-MeterAppIcon -AppId ([string]$row.AppId) -Name ([string]$row.Name)) -Force }
        Complete-MeterAppUsage -Context $Context -Result ([pscustomobject]@{ Available = $true; Rows = $sample; Days = $sample; Message = Text-Meter 'PreviewDetail' })
        return
    }
    $Context.Status.Text = Text-Meter 'AppUsageLoading'
    $Context.Worker = [PowerShell]::Create()
    # The worker imports AppMonitor so proxy-attributed bytes can be redistributed
    # by observed client connections, and Dialogs for icon extraction, before the
    # result reaches the dialog; the UI thread never extracts icons in bulk.
    [void]$Context.Worker.AddScript('param($module, $monitorModule, $dialogModule, $proxyRowName, $ssid, $start, $end, $directory) Import-Module $module -Force -ErrorAction Stop; Import-Module $monitorModule -Force -ErrorAction Stop; Import-Module $dialogModule -Force -ErrorAction Stop; $result = Get-MeterAppUsage -SSID $ssid -StartDate $start -EndDate $end -DataDirectory $directory -ErrorAction Stop; $result = Repair-MeterProxyAttribution -Result $result -DataDirectory $directory -UnattributedName $proxyRowName; foreach ($row in @($result.Rows) + @($result.Days)) { $row | Add-Member -NotePropertyName Icon -NotePropertyValue (Get-MeterAppIcon -AppId ([string]$row.AppId) -Name ([string]$row.Name)) -Force }; return $result').AddArgument((Join-Path $PSScriptRoot 'AppUsage.psm1')).AddArgument((Join-Path $PSScriptRoot 'AppMonitor.psm1')).AddArgument((Join-Path $PSScriptRoot 'Dialogs.ps1')).AddArgument((Text-Meter 'ProxyUnattributedRow')).AddArgument($Context.SSID).AddArgument($Context.Start).AddArgument($Context.End).AddArgument($script:directory)
    $Context.ActiveVersion = $Context.Version
    try { $Context.Pending = $Context.Worker.BeginInvoke() }
    catch { $Context.Worker.Dispose(); $Context.Worker = $null; $Context.Status.Text = Text-Meter 'AppUsageUnavailable'; $Context.Status.ToolTip = $_.Exception.Message; return }
    $Context.Poll = [Windows.Threading.DispatcherTimer]::new()
    $Context.Poll.Interval = [TimeSpan]::FromMilliseconds(200)
    $Context.Poll.Tag = $Context
    $Context.Poll.Add_Tick({ param($sender, $eventArgs) Receive-MeterAppUsageRead -Context $sender.Tag })
    $Context.Poll.Start()
}

function Receive-MeterAppUsageRead {
    param($Context)
    $state = $Context
        if ($null -eq $state -or $state.Closed -or $null -eq $state.Pending -or -not $state.Pending.IsCompleted) { return }
        $state.Poll.Stop()
        try {
            $results = @($state.Worker.EndInvoke($state.Pending))
            if ($state.Worker.HadErrors -or $results.Count -eq 0) { throw 'Application usage query failed.' }
            if ($state.ActiveVersion -eq $state.Version) { Complete-MeterAppUsage -Context $state -Result $results[-1] }
        } catch { if ($state.ActiveVersion -eq $state.Version) { $state.Status.Text = Text-Meter 'AppUsageUnavailable'; $state.Status.ToolTip = $_.Exception.Message } }
        finally { $state.Worker.Dispose(); $state.Worker = $null; $state.Pending = $null; $state.Poll.Tag = $null; $state.Poll = $null }
        if (-not $state.Closed -and $state.ActiveVersion -ne $state.Version) { Start-MeterAppUsageRead -Context $state }
}

function New-MeterNetworkDialog {
    param([Parameter(Mandatory)][string]$SSID)
    $dialog = New-MeterDialog -TitleKey NetworkDetails -Width 900 -Height 715 -Content @'
<Grid.RowDefinitions>
  <RowDefinition Height="Auto" />
  <RowDefinition Height="Auto" />
  <RowDefinition Height="*" />
  <RowDefinition Height="Auto" />
</Grid.RowDefinitions>
<TextBlock x:Name="Name" FontSize="23" FontWeight="SemiBold" TextTrimming="CharacterEllipsis" />
<TextBlock x:Name="SSID" Grid.Row="1" Foreground="{DynamicResource Muted}" Margin="0,6,0,20" TextTrimming="CharacterEllipsis" />
<Grid Grid.Row="2">
<Grid.RowDefinitions><RowDefinition Height="Auto" /><RowDefinition Height="Auto" /><RowDefinition Height="*" /></Grid.RowDefinitions>
<StackPanel Grid.Row="1" x:Name="UsageFilters" Margin="0,16,0,0">
  <TextBlock Text="{DynamicResource SearchApplications}" Foreground="{DynamicResource Muted}" Margin="0,0,0,6" />
  <TextBox x:Name="AppSearch" Padding="10,7" AutomationProperties.Name="{DynamicResource SearchApplications}" />
  <WrapPanel Margin="0,10,0,0">
    <ComboBox x:Name="AppPeriod" Width="150" Margin="0,0,12,0" AutomationProperties.Name="{DynamicResource CustomRange}">
      <ComboBoxItem Tag="Today" Content="{DynamicResource Today}" />
      <ComboBoxItem Tag="Month" Content="{DynamicResource Month}" />
      <ComboBoxItem Tag="Range" Content="{DynamicResource CustomRange}" />
      <ComboBoxItem Tag="All" Content="{DynamicResource AllTime}" />
    </ComboBox>
    <TextBlock Text="{DynamicResource StartDate}" VerticalAlignment="Center" Margin="0,0,8,0" />
    <DatePicker x:Name="AppFrom" Width="145" AutomationProperties.Name="{DynamicResource StartDate}" />
    <TextBlock Text="{DynamicResource EndDate}" VerticalAlignment="Center" Margin="12,0,8,0" />
    <DatePicker x:Name="AppTo" Width="145" AutomationProperties.Name="{DynamicResource EndDate}" />
    <Button x:Name="AppApply" Content="{DynamicResource Apply}" Margin="12,0,0,0" MinWidth="70" />
  </WrapPanel>
  <StackPanel x:Name="AppGroupingHost" Orientation="Horizontal" Margin="0,10,0,0" Visibility="Collapsed">
    <TextBlock Text="{DynamicResource AppUsageGrouping}" VerticalAlignment="Center" Margin="0,0,12,0" />
    <ComboBox x:Name="AppGrouping" Width="210" SelectedIndex="0" AutomationProperties.Name="{DynamicResource AppUsageGrouping}">
      <ComboBoxItem Tag="Day" Content="{DynamicResource AppUsageByDate}" />
      <ComboBoxItem Tag="Month" Content="{DynamicResource AppUsageByMonth}" />
    </ComboBox>
  </StackPanel>
</StackPanel>
<TabControl Grid.Row="0" x:Name="Tabs" Background="Transparent" BorderThickness="0">
  <TabControl.Template><ControlTemplate TargetType="TabControl"><StackPanel IsItemsHost="True" Orientation="Horizontal" KeyboardNavigation.TabNavigation="Once" KeyboardNavigation.DirectionalNavigation="Cycle" /></ControlTemplate></TabControl.Template>
  <TabItem Header="{DynamicResource NetworkSettings}" Padding="14,8">
    <StackPanel Margin="4,22,4,0">
      <TextBlock Text="{DynamicResource Alias}" FontWeight="SemiBold" />
      <TextBox x:Name="Alias" MaxLength="80" Padding="10,8" Margin="0,8,0,18" />
      <UniformGrid Columns="3">
        <StackPanel Margin="0,0,16,0">
          <TextBlock Text="{DynamicResource QuotaGB}" FontWeight="SemiBold" />
          <TextBox x:Name="Limit" Padding="10,8" MaxLength="20" Margin="0,8,0,0" />
        </StackPanel>
        <StackPanel Margin="0,0,16,0">
          <TextBlock Text="{DynamicResource QuotaPeriod}" FontWeight="SemiBold" />
          <ComboBox x:Name="Period" Padding="8,6" Margin="0,8,0,0">
            <ComboBoxItem Tag="Day" Content="{DynamicResource PeriodDay}" />
            <ComboBoxItem Tag="Month" Content="{DynamicResource PeriodMonth}" />
            <ComboBoxItem Tag="All" Content="{DynamicResource PeriodAll}" />
          </ComboBox>
        </StackPanel>
        <StackPanel>
          <TextBlock Text="{DynamicResource WarnPercent}" FontWeight="SemiBold" />
          <TextBox x:Name="Warn" Padding="10,8" MaxLength="6" Margin="0,8,0,0" />
        </StackPanel>
      </UniformGrid>
      <TextBlock Text="{DynamicResource QuotaHint}" Foreground="{DynamicResource Muted}" Margin="0,12,0,18" TextWrapping="Wrap" />
      <CheckBox x:Name="Disconnect" Content="{DynamicResource DisconnectAtLimit}" />
      <TextBlock Text="{DynamicResource DisconnectHint}" Foreground="{DynamicResource Muted}" Margin="22,7,0,0" TextWrapping="Wrap" />
      <TextBlock x:Name="Error" Foreground="{DynamicResource DangerText}" Margin="0,14,0,0" TextWrapping="Wrap" />
    </StackPanel>
  </TabItem>
  <TabItem Header="{DynamicResource Applications}" Padding="14,8"><Grid x:Name="AppsHost" Margin="0,16,0,0" /></TabItem>
  <TabItem Header="{DynamicResource AppUsageHistory}" Padding="14,8"><Grid x:Name="DailyHost" Margin="0,16,0,0" /></TabItem>
</TabControl>
<ContentPresenter Grid.Row="2" Content="{Binding SelectedContent, ElementName=Tabs}" />
</Grid>
<Grid Grid.Row="3" Margin="0,18,0,0">
  <Grid.ColumnDefinitions><ColumnDefinition Width="*" /><ColumnDefinition Width="Auto" /></Grid.ColumnDefinitions>
  <TextBlock x:Name="Status" TextWrapping="Wrap" Foreground="{DynamicResource Muted}" FontSize="11" VerticalAlignment="Center" Margin="0,0,15,0" />
  <StackPanel Grid.Column="1" Orientation="Horizontal">
    <Button x:Name="AppExport" Content="{DynamicResource Export}" MinWidth="100" Margin="0,0,8,0" Visibility="Collapsed" IsEnabled="False" />
    <Button x:Name="Close" Content="{DynamicResource Close}" MinWidth="84" Margin="0,0,8,0" IsCancel="True" />
    <Button x:Name="Save" Content="{DynamicResource Save}" MinWidth="84" Style="{DynamicResource PrimaryButton}" />
  </StackPanel>
</Grid>
'@
    $network = Get-MeterNetworkPreference -Preferences $script:preferences -SSID $SSID
    $range = Get-CurrentMeterRange
    $start = switch ($range.Period) { 'Today' { [DateTime]::Today }; 'Month' { [DateTime]::Today.AddDays(1 - [DateTime]::Today.Day) }; 'Range' { $range.StartDate }; default { [DateTime]::new(2000, 1, 1) } }
    $end = if ($range.Period -eq 'Range') { $range.EndDate } else { [DateTime]::Today }
    $context = @{ Window = $dialog; SSID = $SSID; Start = $start; End = $end; Worker = $null; Pending = $null; Poll = $null; Saved = $false; Closed = $false; Version = 0; Result = $null }
    foreach ($name in @('Alias', 'Limit', 'Period', 'Warn', 'Disconnect', 'Error', 'Save', 'Status', 'AppSearch', 'AppPeriod', 'AppFrom', 'AppTo', 'AppApply', 'AppGrouping', 'AppGroupingHost', 'AppExport', 'UsageFilters', 'Tabs')) { $context[$name] = $dialog.FindName($name) }
    # Wired identities show the connection name (or alias); the raw identity stays below.
    $display = Resolve-MeterNetworkDisplayName -SSID $SSID -Aliases (Get-MeterNetworkAliasMap) -WiredNames (Get-MeterWiredNameMap)
    $dialog.FindName('Name').Text = $display
    $dialog.FindName('SSID').Text = $SSID
    if ([string]::IsNullOrWhiteSpace($display) -or $display -eq $SSID) { $dialog.FindName('SSID').Visibility = 'Collapsed'; $dialog.FindName('Name').Margin = '0,0,0,16' }
    $context.Alias.Text = $network.Alias
    $context.Limit.Text = [string]$network.LimitGB
    $context.Warn.Text = [string]$network.WarnPercent
    $context.Disconnect.IsChecked = $network.DisconnectAtLimit
    foreach ($item in $context.Period.Items) { if ($item.Tag -eq $network.Period) { $context.Period.SelectedItem = $item } }
    $context.Apps = New-MeterUsageGrid
    $context.Daily = New-MeterUsageGrid -IncludeDate $true
    [void]$dialog.FindName('AppsHost').Children.Add($context.Apps)
    [void]$dialog.FindName('DailyHost').Children.Add($context.Daily)
    $context.AppFrom.SelectedDate = $start
    $context.AppTo.SelectedDate = $end
    $context.AppFrom.DisplayDateEnd = [datetime]::Today
    $context.AppTo.DisplayDateEnd = [datetime]::Today
    foreach ($item in $context.AppPeriod.Items) { if ($item.Tag -eq $range.Period) { $context.AppPeriod.SelectedItem = $item } }
    if ($null -eq $context.AppPeriod.SelectedItem) { $context.AppPeriod.SelectedIndex = 3 }
    $context.AppFrom.IsEnabled = $context.AppPeriod.SelectedItem.Tag -eq 'Range'
    $context.AppTo.IsEnabled = $context.AppFrom.IsEnabled
    $context.AppSearch.Tag = $context
    $context.AppSearch.Add_TextChanged({ param($sender, $eventArgs) Update-MeterAppUsageFilter -Context $sender.Tag })
    $context.AppPeriod.Tag = $context
    $context.AppPeriod.Add_SelectionChanged({ param($sender, $eventArgs) Set-MeterAppUsageRange -Context $sender.Tag })
    $context.AppApply.Tag = $context
    $context.AppApply.Add_Click({ param($sender, $eventArgs) Set-MeterAppUsageRange -Context $sender.Tag })
    $context.AppGrouping.Tag = $context
    $context.AppGrouping.Add_SelectionChanged({ param($sender, $eventArgs) Update-MeterAppUsageFilter $sender.Tag })
    foreach ($picker in @($context.AppFrom, $context.AppTo)) {
        $picker.Tag = $context
        $picker.Add_SelectedDateChanged({ param($sender, $eventArgs) Update-MeterAppExportState $sender.Tag })
    }
    $context.AppExport.Tag = $context
    $context.AppExport.Add_Click({
        param($sender, $eventArgs)
        $state = $sender.Tag
        $saveDialog = [Microsoft.Win32.SaveFileDialog]::new()
        $saveDialog.Title = Text-Meter 'ExportTitle'
        $saveDialog.Filter = Text-Meter 'CsvFilter'
        $saveDialog.DefaultExt = '.csv'
        $saveDialog.AddExtension = $true
        $mode = if ($state.Tabs.SelectedIndex -eq 1) { 'apps' } else { [string]$state.AppGrouping.SelectedItem.Tag }
        $saveDialog.FileName = 'app-usage-' + $state.Start.ToString('yyyyMMdd') + '-' + $state.End.ToString('yyyyMMdd') + '-' + $mode.ToLowerInvariant() + '.csv'
        if ($saveDialog.ShowDialog($state.Window)) {
            try {
                Export-MeterAppUsageCsv -Context $state -Path $saveDialog.FileName
                [void][Windows.MessageBox]::Show($state.Window, ((Text-Meter 'ExportedTo') + [Environment]::NewLine + $saveDialog.FileName), (Text-Meter 'ExportComplete'), 'OK', 'Information')
            } catch { $state.Status.Text = Text-Meter 'AppUsageExportFailed'; $state.Status.ToolTip = $_.Exception.Message }
        }
    })
    $context.UsageFilters.Visibility = 'Collapsed'
    $context.Tabs.Tag = $context
    $context.Tabs.Add_SelectionChanged({
        param($sender, $eventArgs)
        if ($eventArgs.OriginalSource -ne $sender) { return }
        $sender.Tag.UsageFilters.Visibility = if ($sender.SelectedIndex -eq 0) { 'Collapsed' } else { 'Visible' }
        $sender.Tag.AppGroupingHost.Visibility = if ($sender.SelectedIndex -eq 2) { 'Visible' } else { 'Collapsed' }
        $sender.Tag.AppExport.Visibility = if ($sender.SelectedIndex -eq 0) { 'Collapsed' } else { 'Visible' }
        Update-MeterAppExportState $sender.Tag
        $sender.Tag.Save.Visibility = if ($sender.SelectedIndex -eq 0) { 'Visible' } else { 'Collapsed' }
    })
    $context.Save.Tag = $context
    $context.Save.Add_Click({
        param($sender, $eventArgs)
        $state = $sender.Tag
        [double]$limit = 0; [double]$warn = 0
        if (-not [double]::TryParse($state.Limit.Text, [ref]$limit) -or [double]::IsNaN($limit) -or $limit -lt 0 -or $limit -gt 9e9 -or ($limit -gt 0 -and $limit -lt 1e-9) -or -not [double]::TryParse($state.Warn.Text, [ref]$warn) -or [double]::IsNaN($warn) -or $warn -lt 1 -or $warn -gt 100) {
            $state.Error.Text = Text-Meter 'QuotaInvalid'; return
        }
        if ($state.Alias.Text.Length -gt 80 -or $state.Alias.Text -match '[\x00-\x1f\x7f]') {
            $state.Error.Text = Text-Meter 'AliasInvalid'; return
        }
        try {
            $network = [pscustomobject]@{ SSID = $state.SSID; Alias = $state.Alias.Text.Trim(); LimitGB = $limit; Period = [string]$state.Period.SelectedItem.Tag; WarnPercent = $warn; DisconnectAtLimit = [bool]$state.Disconnect.IsChecked }
            if (-not $script:isReadOnly) { $script:preferences = Set-MeterNetworkPreference -DataDirectory $script:directory -Network $network }
            $state.Saved = $true
            $script:renderKey = ''
            Refresh-MeterView
            $state.Error.Foreground = $state.Window.Resources['SuccessText']
            $state.Error.Text = Text-Meter 'Saved'
        } catch { $state.Error.Foreground = $state.Window.Resources['DangerText']; $state.Error.Text = Format-MeterError $_.Exception.Message 'Settings' }
    })
    $dialog.Tag = $context
    $dialog.Add_Loaded({ param($sender, $eventArgs) Start-MeterAppUsageRead -Context $sender.Tag })
    $dialog.Add_Closed({
        param($sender, $eventArgs)
        $state = $sender.Tag
        $state.Closed = $true
        if ($null -ne $state.Poll) { $state.Poll.Stop(); $state.Poll.Tag = $null; $state.Poll = $null }
        if ($null -ne $state.Worker) {
            # The WinRT query has a bounded timeout; cancellation interrupts its wait.
            try { $state.Worker.Stop() } finally { $state.Worker.Dispose(); $state.Worker = $null; $state.Pending = $null }
        }
    })
    $dialog.FindName('Close').Tag = $context
    $dialog.FindName('Close').Add_Click({ param($sender, $eventArgs) $sender.Tag.Window.Close() })
    return $context
}

function Show-MeterCloseDialog {
    $dialog = New-MeterDialog -TitleKey CloseTitle -Width 555 -Height 240 -Content @'
<Grid.RowDefinitions><RowDefinition Height="Auto" /><RowDefinition Height="*" /><RowDefinition Height="Auto" /></Grid.RowDefinitions>
<TextBlock Text="{DynamicResource CloseTitle}" FontSize="22" FontWeight="SemiBold" />
<TextBlock Grid.Row="1" Text="{DynamicResource CloseHint}" Foreground="{DynamicResource Muted}" TextWrapping="Wrap" Margin="0,14,0,20" />
<StackPanel Grid.Row="2" Orientation="Horizontal" HorizontalAlignment="Right">
  <Button x:Name="Cancel" Content="{DynamicResource Cancel}" Margin="0,0,8,0" IsCancel="True" />
  <Button x:Name="Exit" Content="{DynamicResource Exit}" Margin="0,0,8,0" />
  <Button x:Name="Tray" Content="{DynamicResource MinimizeTray}" Style="{DynamicResource PrimaryButton}" />
</StackPanel>
'@
    $state = @{ Window = $dialog; Choice = 'Cancel' }
    foreach ($name in @('Cancel', 'Exit', 'Tray')) {
        $button = $dialog.FindName($name)
        $button.Tag = @{ State = $state; Choice = $name }
        $button.Add_Click({ param($sender, $eventArgs) $sender.Tag.State.Choice = $sender.Tag.Choice; $sender.Tag.State.Window.Close() })
    }
    [void]$dialog.ShowDialog()
    return $state.Choice
}
