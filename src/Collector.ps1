#requires -Version 5.1
[CmdletBinding()]
param([string]$DataDirectory)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
Import-Module (Join-Path $PSScriptRoot 'Control.psm1') -Force
if ([string]::IsNullOrWhiteSpace($DataDirectory)) { $DataDirectory = Get-MeterDataDirectory }
$directory = Initialize-MeterDataDirectory $DataDirectory
$lock = $null
try { $lock = [IO.File]::Open((Join-Path $directory 'collector.lock'), 'OpenOrCreate', 'ReadWrite', 'None') }
catch [IO.IOException] { exit 0 }
$self = Get-Process -Id $PID
$status = [pscustomobject]@{ Running = $true; Healthy = $true; ProcessId = $PID; ProcessStartTicks = $self.StartTime.ToUniversalTime().Ticks; LaunchId = [guid]::NewGuid().ToString('N'); UpdatedAt = ''; Message = '正在初始化'; Connections = @(); DownloadPerSecond = 0.0; UploadPerSecond = 0.0; Error = ''; SkippedIntervals = 0; Alerts = @() }
$self.Dispose()
$state = $null
$exitCode = 0
$script:storageWarning = ''
$needsSave = $true

function Write-CollectorLog([string]$Message) {
    $log = Join-Path $directory 'collector.log'
    try {
        if ([IO.File]::Exists($log) -and (Get-Item -LiteralPath $log).Length -gt 1048576) { [IO.File]::WriteAllText($log, '') }
        [IO.File]::AppendAllText($log, ([DateTimeOffset]::Now.ToString('o') + ' ' + $Message + [Environment]::NewLine), (New-Object Text.UTF8Encoding($true)))
    } catch { }
}

function Save-CollectorData {
    $warnings = @()
    Save-MeterState -State $state -DataDirectory $directory -WarningAction SilentlyContinue -WarningVariable warnings
    $script:storageWarning = ''
    if ($warnings.Count -gt 0) {
        $script:storageWarning = ($warnings | ForEach-Object { $_.ToString() }) -join '; '
        Write-CollectorLog $script:storageWarning
    }
}

function Test-CollectorStopRequested {
    if (-not [IO.File]::Exists($stopPath)) { return $false }
    try {
        $request = Read-MeterJson $stopPath
        return $request.LaunchId -ceq $status.LaunchId
    } catch {
        # A stale or incomplete request must not stop collection or shorten its sampling delay.
        return $false
    }
}

try {
    Import-Module (Join-Path $PSScriptRoot 'Core.psm1') -Force
    Import-Module (Join-Path $PSScriptRoot 'Sampler.psm1') -Force
    Import-Module (Join-Path $PSScriptRoot 'Preferences.psm1') -Force
    Import-Module (Join-Path $PSScriptRoot 'QuotaRuntime.psm1') -Force
    Import-Module (Join-Path $PSScriptRoot 'AppUsage.psm1') -Force
    $recoveryWarnings = @()
    $state = Read-MeterState -DataDirectory $directory -WarningAction SilentlyContinue -WarningVariable recoveryWarnings
    $ledger = Read-MeterQuotaLedger -State $state
    $state | Add-Member -NotePropertyName QuotaLedger -NotePropertyValue $ledger -Force
    $preferences = Read-MeterPreferences -DataDirectory $directory
    $preferenceStamp = ''
    $lastProfiles = [DateTimeOffset]::MinValue
    $lastDisconnect = [Collections.Generic.Dictionary[string,DateTimeOffset]]::new([StringComparer]::Ordinal)
    if ($recoveryWarnings.Count -gt 0) { $status.Error = ($recoveryWarnings | ForEach-Object { $_.ToString() }) -join '; '; Write-CollectorLog $status.Error }
    $session = New-MeterSession
    $stopPath = Join-Path $directory 'stop.request'
    # The collector lock is held and no running status has been published yet.
    # Remove a previous launch's stop request before accepting requests for this launch.
    if ([IO.File]::Exists($stopPath)) { [IO.File]::Delete($stopPath) }
    $lastSave = [DateTimeOffset]::MinValue
    $previousTime = $null
    $previousDate = ''
    while ($true) {
        $now = [DateTimeOffset]::Now
        $policyError = ''
        $settings = Get-Item -LiteralPath (Join-Path $directory 'settings.json') -ErrorAction SilentlyContinue
        $changedPreferences = $false
        if ($null -ne $settings) {
            $stamp = $settings.LastWriteTimeUtc.Ticks.ToString() + ':' + $settings.Length
            if ($stamp -ne $preferenceStamp) {
                try {
                    $preferences = Read-MeterPreferences -DataDirectory $directory
                    $preferenceStamp = $stamp
                    $changedPreferences = $true
                } catch { $policyError = $_.Exception.Message }
            }
        }
        $before = [Collections.Generic.Dictionary[string,object]]::new([StringComparer]::Ordinal)
        foreach ($network in $state.Networks) { $before[$network.SSID] = @([long]$network.RxBytes, [long]$network.TxBytes) }
        $sample = Get-WifiSamples
        $delta = Add-MeterSamples -State $state -Session $session -Samples @($sample.Samples) -Timestamp $now
        $networkDeltas = @(foreach ($network in $state.Networks) {
            $old = if ($before.ContainsKey($network.SSID)) { $before[$network.SSID] } else { @(0L, 0L) }
            [pscustomobject]@{ SSID = $network.SSID; RxBytes = [long]$network.RxBytes - $old[0]; TxBytes = [long]$network.TxBytes - $old[1] }
        })
        $quotaActions = @(Update-MeterQuotaLedger -Ledger $ledger -State $state -Preferences $preferences -Deltas $networkDeltas -Timestamp $now)
        foreach ($action in $quotaActions) {
            if ($null -ne $action.Notice) {
                $status.Alerts = @(@($status.Alerts) + @($action.Notice) | Select-Object -Last 20)
                $needsSave = $true
            }
            if ($action.Disconnect -and (-not $lastDisconnect.ContainsKey($action.SSID) -or ($now - $lastDisconnect[$action.SSID]).TotalSeconds -ge 10)) {
                # Recheck the current SSID inside the native call before disconnecting this adapter.
                foreach ($connection in $sample.Samples) {
                    if ($connection.SSID -cne $action.SSID) { continue }
                    try { $null = Disconnect-MeterWifi -AdapterId $connection.AdapterId -SSID $action.SSID }
                    catch { $policyError = $_.Exception.Message; Write-CollectorLog $policyError }
                    $lastDisconnect[$action.SSID] = $now
                }
            }
        }
        if ($changedPreferences -or $previousDate -ne $now.ToString('yyyy-MM-dd')) {
            $removed = Remove-MeterExpiredRecords -State $state -RetentionDays $preferences.RetentionDays -Timestamp $now
            $needsSave = $true
            if ($preferences.RetentionDays -gt 0) {
                # Rotate twice so both primary and recovery copy obey the retention setting.
                Save-CollectorData
                Save-CollectorData
            }
        }
        if (($now - $lastProfiles).TotalSeconds -ge 60) {
            try { Update-MeterAppUsageProfiles -DataDirectory $directory | Out-Null }
            catch { Write-CollectorLog ('Application profile discovery: ' + $_.Exception.Message) }
            $lastProfiles = $now
        }
        if ($delta.DownloadBytes -gt 0 -or $delta.UploadBytes -gt 0 -or $delta.Reason -match 'Baseline|NetworkChanged' -or ($sample.Samples.Count -gt 0 -and $now.ToString('yyyy-MM-dd') -ne $previousDate)) { $needsSave = $true }
        $seconds = if ($null -ne $previousTime) { ($now - $previousTime).TotalSeconds } else { 0 }
        $status.DownloadPerSecond = if ($seconds -gt 0) { [double]$delta.DownloadBytes / $seconds } else { 0 }
        $status.UploadPerSecond = if ($seconds -gt 0) { [double]$delta.UploadBytes / $seconds } else { 0 }
        $status.SkippedIntervals += $delta.SkippedIntervals
        $status.Message = if ($sample.Samples.Count -gt 0 -and -not $sample.HasError) { '正在统计' } else { $sample.Message }
        $status.Connections = @($sample.Samples | ForEach-Object { $_.SSID } | Select-Object -Unique)
        $status.UpdatedAt = [DateTimeOffset]::UtcNow.ToString('o')
        if (($needsSave -or $script:storageWarning) -and ($now - $lastSave).TotalSeconds -ge 10) { Save-CollectorData; $lastSave = $now; $needsSave = $false }
        $status.Error = @($(if ($sample.HasError) { $sample.Message }), $script:storageWarning, $policyError) | Where-Object { $_ }
        $status.Error = $status.Error -join '; '
        Write-MeterJson -Path (Join-Path $directory 'status.json') -Value $status
        $previousTime = $now
        $previousDate = $now.ToString('yyyy-MM-dd')
        if (Test-CollectorStopRequested) { break }
        $nextSample = [Diagnostics.Stopwatch]::StartNew()
        try {
            while ($nextSample.ElapsedMilliseconds -lt 5000) {
                if (Test-CollectorStopRequested) { break }
                Start-Sleep -Milliseconds 200
            }
        } finally { $nextSample.Stop() }
    }
} catch {
    $status.Error = $_.Exception.Message
    $status.Message = '统计遇到错误，请查看错误提示'
    $exitCode = 1
    Write-CollectorLog ($_ | Out-String)
} finally {
    if ($null -ne $state -and ($needsSave -or $script:storageWarning)) {
        try { Save-CollectorData } catch { $status.Error = $_.Exception.Message; $exitCode = 1; Write-CollectorLog $_.Exception.Message }
    }
    $status.Running = $false
    $status.Healthy = $false
    $status.DownloadPerSecond = 0
    $status.UploadPerSecond = 0
    if ($exitCode -eq 0) { $status.Message = '统计已停止，数据已保存' }
    $status.UpdatedAt = [DateTimeOffset]::UtcNow.ToString('o')
    try { Write-MeterJson -Path (Join-Path $directory 'status.json') -Value $status } catch { Write-CollectorLog $_.Exception.Message }
    if ($null -ne $lock) { $lock.Dispose() }
}
exit $exitCode
