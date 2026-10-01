#requires -Version 5.1
function Set-MeterPage([ValidateSet('Overview', 'Applications')][string]$Page) {
    $OverviewPage.Visibility = if ($Page -eq 'Overview') { 'Visible' } else { 'Collapsed' }
    $ApplicationsPage.Visibility = if ($Page -eq 'Applications') { 'Visible' } else { 'Collapsed' }
    $OverviewNav.Background = $window.Resources[$(if ($Page -eq 'Overview') { 'AccentSoft' } else { 'SidebarBackground' })]
    $ApplicationsNav.Background = $window.Resources[$(if ($Page -eq 'Applications') { 'AccentSoft' } else { 'SidebarBackground' })]
    $OverviewNav.Foreground = $window.Resources[$(if ($Page -eq 'Overview') { 'AccentDeep' } else { 'TextSecondary' })]
    $ApplicationsNav.Foreground = $window.Resources[$(if ($Page -eq 'Applications') { 'AccentDeep' } else { 'TextSecondary' })]
    $OverviewNav.FontWeight = if ($Page -eq 'Overview') { 'SemiBold' } else { 'Normal' }
    $ApplicationsNav.FontWeight = if ($Page -eq 'Applications') { 'SemiBold' } else { 'Normal' }

}
function Initialize-MeterAppControls {
    $panel = [Windows.Markup.XamlReader]::Parse(@'
<StackPanel xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation" xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml">
  <TextBlock Text="{DynamicResource AppNetworkControl}" FontSize="17" FontWeight="SemiBold" Margin="0,0,0,12" />
  <Grid><Grid.ColumnDefinitions><ColumnDefinition Width="*"/><ColumnDefinition Width="Auto"/></Grid.ColumnDefinitions>
    <TextBox x:Name="ProgramPath" IsReadOnly="True" ToolTip="{Binding Text, RelativeSource={RelativeSource Self}}" Margin="0,0,10,0" />
    <Button x:Name="BrowseProgram" Grid.Column="1" Content="{DynamicResource ChooseProgram}" />
  </Grid>
  <TextBlock Text="{DynamicResource AppControlSelectHint}" Foreground="{DynamicResource TextSecondary}" TextWrapping="Wrap" Margin="0,8,0,16" />
  <WrapPanel>
    <Button x:Name="BlockProgram" Content="{DynamicResource BlockProgram}" Margin="0,0,10,8" />
    <Button x:Name="UnblockProgram" Content="{DynamicResource UnblockProgram}" Margin="0,0,10,8" />
    <Button x:Name="ReadProgramState" Content="{DynamicResource Refresh}" Margin="0,0,0,8" />
  </WrapPanel>
  <TextBlock Text="{DynamicResource UploadLimit}" Margin="0,8,0,8" FontWeight="SemiBold" />
  <WrapPanel>
    <TextBox x:Name="UploadLimitValue" Width="110" Text="1024" Margin="0,0,8,8" />
    <TextBlock Text="KB/s" VerticalAlignment="Center" Margin="0,0,16,8" />
    <Button x:Name="ThrottleProgram" Content="{DynamicResource ApplyUploadLimit}" Margin="0,0,10,8" />
    <Button x:Name="UnthrottleProgram" Content="{DynamicResource RemoveUploadLimit}" Margin="0,0,0,8" />
  </WrapPanel>
  <TextBlock Text="{DynamicResource AppControlLimits}" Foreground="{DynamicResource TextSecondary}" TextWrapping="Wrap" Margin="0,8,0,12" />
  <TextBlock x:Name="ProgramState" TextWrapping="Wrap" Foreground="{DynamicResource TextPrimary}" />
</StackPanel>
'@)
    $AppControlHost.Content = $panel
    $script:appControl = @{ Worker = $null; Pending = $null; Poll = $null; Path = ''; Busy = $false }
    foreach ($name in @('ProgramPath','BrowseProgram','BlockProgram','UnblockProgram','ReadProgramState','UploadLimitValue','ThrottleProgram','UnthrottleProgram','ProgramState')) { $script:appControl[$name] = $panel.FindName($name) }
    $script:appControl.BrowseProgram.Add_Click({
        $picker = [Microsoft.Win32.OpenFileDialog]::new()
        $picker.Filter = 'Programs (*.exe)|*.exe'
        if ($picker.ShowDialog($window)) { Select-MeterControlledProgram -Path $picker.FileName }
    })
    $script:appControl.BlockProgram.Add_Click({ Start-MeterAppControlAction 'Block' })
    $script:appControl.UnblockProgram.Add_Click({ Start-MeterAppControlAction 'Unblock' })
    $script:appControl.ReadProgramState.Add_Click({ Start-MeterAppControlAction 'Read' })
    $script:appControl.ThrottleProgram.Add_Click({ Start-MeterAppControlAction 'Throttle' })
    $script:appControl.UnthrottleProgram.Add_Click({ Start-MeterAppControlAction 'Unthrottle' })
    Set-MeterAppControlButtons
}
function Set-MeterAppControlButtons {
    $state = $script:appControl
    foreach ($name in @('BlockProgram','UnblockProgram','ThrottleProgram','UnthrottleProgram')) { $state[$name].IsEnabled = -not $state.Busy -and -not $script:isReadOnly -and -not [string]::IsNullOrEmpty($state.Path) }
    $state.ReadProgramState.IsEnabled = -not $state.Busy -and -not [string]::IsNullOrEmpty($state.Path)
    $state.BrowseProgram.IsEnabled = -not $state.Busy
    $state.UploadLimitValue.IsEnabled = -not $state.Busy
    $LiveAppsList.IsEnabled = -not $state.Busy
}
function Select-MeterControlledProgram([string]$Path) {
    if ($script:appControl.Busy) { return }
    $script:appControl.Path = $Path
    $script:appControl.ProgramPath.Text = $Path
    $script:appControl.ProgramState.Text = Text-Meter 'AppControlSelectHint'
    Set-MeterAppControlButtons
    if ($Path) { Start-MeterAppControlAction 'Read' }
}
function Start-MeterAppControlAction([ValidateSet('Read','Block','Unblock','Throttle','Unthrottle')][string]$Action) {
    $state = $script:appControl
    if ($state.Busy -or -not $state.Path) { return }
    if ($script:isReadOnly) { $state.ProgramState.Text = Text-Meter 'AppControlPreview'; return }
    [int]$limit = 0
    if ($Action -eq 'Throttle' -and (-not [int]::TryParse($state.UploadLimitValue.Text, [ref]$limit) -or $limit -lt 1 -or $limit -gt 1000000)) { $state.ProgramState.Text = Text-Meter 'UploadLimitInvalid'; return }
    $state.Busy = $true
    $script:mutating = $true
    Set-MeterAppControlButtons
    $state.ProgramState.Text = Text-Meter 'AppControlWorking'
    $state.Worker = [PowerShell]::Create()
    [void]$state.Worker.AddScript('param($module,$path,$action,$limit) Import-Module $module -Force -ErrorAction Stop; if ($action -eq "Read") { Get-MeterAppNetworkState -Path $path } else { $operation = Invoke-MeterAppNetworkAction -Path $path -Action $action -UploadKbps ([long]$limit * 8); while ($operation.Status -eq "Running") { $operation = Receive-MeterAppNetworkAction -Operation $operation -WaitMilliseconds 500 }; $operation }').AddArgument((Join-Path $PSScriptRoot 'AppNetworkControl.psm1')).AddArgument($state.Path).AddArgument($Action).AddArgument($limit)
    try { $state.Pending = $state.Worker.BeginInvoke() }
    catch { $state.Worker.Dispose(); $state.Worker = $null; $state.Busy = $false; $script:mutating = $false; Set-MeterAppControlButtons; $state.ProgramState.Text = $_.Exception.Message; return }
    $state.Poll = [Windows.Threading.DispatcherTimer]::new()
    $state.Poll.Interval = [TimeSpan]::FromMilliseconds(200)
    $state.Poll.Add_Tick({
        $state = $script:appControl
        if (-not $state.Pending.IsCompleted) { return }
        $state.Poll.Stop()
        try {
            $result = @($state.Worker.EndInvoke($state.Pending))
            if ($state.Worker.HadErrors) { throw ($state.Worker.Streams.Error | Out-String) }
            if ($result.Count -eq 0) { throw (Text-Meter 'AppControlNoResult') }
            $state.ProgramState.Text = Format-MeterAppNetworkState $result[-1]
        } catch { $state.ProgramState.Text = $_.Exception.Message }
        finally { $state.Worker.Dispose(); $state.Worker = $null; $state.Pending = $null; $state.Poll = $null; $state.Busy = $false; $script:mutating = $false; Set-MeterAppControlButtons }
    })
    $state.Poll.Start()
}
function Format-MeterAppNetworkState($State) {
    $lines = [Collections.Generic.List[string]]::new()
    if ($State.PSObject.Properties['Status']) {
        $lines.Add((Text-Meter ('AppAction' + $State.Status)))
        if ($State.Error) { $lines.Add([string]$State.Error) }
        if ($null -eq $State.State) { return ($lines -join [Environment]::NewLine) }
        $State = $State.State
    }
    if ($State.FirewallError) { $lines.Add((Text-Meter 'AppFirewallReadError') + ': ' + $State.FirewallError) }
    elseif ($State.Blocked) { $lines.Add((Text-Meter 'AppBlockConfigured')) }
    elseif ($State.FirewallRuleCount -gt 0) { $lines.Add((Text-Meter 'AppBlockPartial')) }
    else { $lines.Add((Text-Meter 'AppBlockAbsent')) }
    if ($State.QosError) { $lines.Add((Text-Meter 'AppQosReadError') + ': ' + $State.QosError) }
    elseif ($State.Throttled) { $lines.Add((Text-Meter 'UploadLimit') + ': ' + ([double]$State.UploadKbps / 8).ToString('0.###') + ' KB/s') }
    else { $lines.Add((Text-Meter 'AppThrottleAbsent')) }
    return ($lines -join [Environment]::NewLine)
}
