#requires -Version 5.1
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
Import-Module (Join-Path $root 'src\Control.psm1') -Force
Import-Module (Join-Path $root 'src\Core.psm1') -Force
Import-Module (Join-Path $root 'src\Preferences.psm1') -Force
$artifactDirectory = Join-Path $root 'artifacts'
$directory = Join-Path $artifactDirectory ('integration 中文 ' + [guid]::NewGuid().ToString('N'))
$passed = $false
try {
    $null = Initialize-MeterDataDirectory $directory
    $first = Start-Process -FilePath (Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe') -ArgumentList ('-NoProfile -ExecutionPolicy Bypass -File "{0}" -DataDirectory "{1}"' -f (Join-Path $root 'src\Collector.ps1'), $directory) -WindowStyle Hidden -PassThru
    $lockDeadline = [DateTime]::UtcNow.AddSeconds(8)
    while (-not (Test-Path (Join-Path $directory 'collector.lock')) -and [DateTime]::UtcNow -lt $lockDeadline) { Start-Sleep -Milliseconds 10 }
    $status = Start-MeterCollector $directory
    if (-not $status.Running) { throw 'FAIL: collector did not start.' }
    if ($status.ProcessId -ne $first.Id) { throw 'FAIL: direct login startup race returned wrong collector.' }
    $workerId = $status.ProcessId
    $again = Start-MeterCollector $directory
    if ($again.ProcessId -ne $workerId) { throw 'FAIL: repeated start created another process.' }
    $duplicate = Start-Process -FilePath (Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe') -ArgumentList ('-NoProfile -ExecutionPolicy Bypass -File "{0}" -DataDirectory "{1}"' -f (Join-Path $root 'src\Collector.ps1'), $directory) -WindowStyle Hidden -PassThru
    if (-not $duplicate.WaitForExit(5000)) { throw 'FAIL: duplicate worker did not exit.' }
    if ($duplicate.ExitCode -ne 0) { throw 'FAIL: duplicate worker failed unexpectedly.' }
    # A leftover request from another launch must neither stop this worker nor bypass its sampling delay.
    Write-MeterJson -Path (Join-Path $directory 'stop.request') -Value @{ LaunchId = 'different-launch' }
    $lastSampleTime = [DateTimeOffset]::Parse((Get-MeterStatus $directory).UpdatedAt)
    $malformedAt = [DateTime]::UtcNow.AddSeconds(6)
    $malformedWritten = $false
    # Poll rapidly while the collector replaces status files, exercising real reader/writer concurrency.
    $end = [DateTime]::UtcNow.AddSeconds(12)
    while ([DateTime]::UtcNow -lt $end) {
        $live = Get-MeterStatus $directory
        if (-not $live.Running -or -not $live.Healthy) { throw ('FAIL: live worker lost status. ' + $live.Message + ' ' + $live.Error) }
        $sampleTime = [DateTimeOffset]::Parse($live.UpdatedAt)
        if ($sampleTime -ne $lastSampleTime) {
            if (($sampleTime - $lastSampleTime).TotalSeconds -lt 4.5) { throw 'FAIL: an unrelated stop request bypassed the sample interval.' }
            $lastSampleTime = $sampleTime
        }
        if (-not $malformedWritten -and [DateTime]::UtcNow -ge $malformedAt) {
            [IO.File]::WriteAllText((Join-Path $directory 'stop.request'), '{invalid')
            $malformedWritten = $true
        }
        $null = Read-MeterState $directory
        Start-Sleep -Milliseconds 30
    }
    $stopped = Stop-MeterCollector $directory
    if ($stopped.Running) { throw 'FAIL: collector did not stop.' }
    $remainingWorker = Get-Process -Id $workerId -ErrorAction SilentlyContinue
    if ($null -ne $remainingWorker) {
        try { if (-not $remainingWorker.HasExited) { throw 'FAIL: stop returned before process exit.' } }
        finally { $remainingWorker.Dispose() }
    }
    if ($stopped.Error) { throw ('FAIL: collector error: ' + $stopped.Error) }
    $state = Read-MeterState $directory
    if (-not (Test-Path (Join-Path $directory 'usage.csv')) -or -not (Test-Path (Join-Path $directory 'state.json'))) { throw 'FAIL: data was not saved.' }
    $sumBefore = 0L
    foreach ($row in @(Get-MeterRows $state)) { $sumBefore += $row.TotalBytes }
    $restarted = Start-MeterCollector $directory
    if ($restarted.ProcessId -eq $workerId) { throw 'FAIL: restart retained old process.' }
    $null = Stop-MeterCollector $directory
    $restored = Read-MeterState $directory
    $sumAfter = 0L
    foreach ($row in @(Get-MeterRows $restored)) { $sumAfter += $row.TotalBytes }
    if ($sumAfter -lt $sumBefore) { throw 'FAIL: totals lost after restart.' }
    # Use an artificial SSID and leave disconnect disabled; never change the real Wi-Fi connection.
    $policyState = New-MeterState
    $policySession = New-MeterSession
    $yesterday = [DateTimeOffset]::Now.AddDays(-1)
    $baseline = [pscustomobject]@{ AdapterId = 'quota-fixture'; SSID = 'Quota fixture'; RxBytes = 0L; TxBytes = 0L }
    $null = Add-MeterSamples $policyState $policySession @($baseline) $yesterday
    $baseline.RxBytes = 1000000000L
    $null = Add-MeterSamples $policyState $policySession @($baseline) $yesterday.AddSeconds(5)
    Save-MeterState -State $policyState -DataDirectory $directory
    $null = Set-MeterNetworkPreference -DataDirectory $directory -Network ([pscustomobject]@{ SSID = 'Quota fixture'; Alias = 'Test quota'; Period = 'All'; LimitGB = 1; WarnPercent = 80; DisconnectAtLimit = $false })
    $null = Set-MeterRetention -DataDirectory $directory -Days 1
    $policyRun = Start-MeterCollector $directory
    if (@($policyRun.Alerts).Count -ne 1 -or $policyRun.Alerts[0].Type -ne 'Limit') { throw 'FAIL: collector did not publish the configured quota notification.' }
    $null = Stop-MeterCollector $directory
    foreach ($filename in @('state.json', 'state.json.bak')) {
        $pruned = Read-MeterJson (Join-Path $directory $filename)
        $fixture = @($pruned.Networks | Where-Object { $_.SSID -ceq 'Quota fixture' })[0]
        if ($fixture.Days.Count -ne 0 -or $fixture.RxBytes -ne 0) { throw ('FAIL: expired records remained in ' + $filename) }
        if ($pruned.QuotaLedger.Networks[0].UsedBytes -ne 1000000000) { throw 'FAIL: pruning reset the active quota.' }
    }
    $policyRestart = Start-MeterCollector $directory
    if (@($policyRestart.Alerts).Count -ne 0) { throw 'FAIL: restarting repeated an acknowledged quota notification.' }
    $null = Stop-MeterCollector $directory
    $passed = $true
    Write-Output ('PASS: startup race, duplicate lock, stale stop requests, cadence, concurrent reads, graceful stop, retention in both saves, quota notifications and restart; network_count=' + $state.Networks.Count)
} finally {
    try { $null = Stop-MeterCollector $directory } catch { Write-Warning $_.Exception.Message }
    if ($passed -and (Test-Path $directory) -and [IO.Path]::GetFullPath($directory).StartsWith([IO.Path]::GetFullPath($artifactDirectory).TrimEnd('\') + '\', [StringComparison]::OrdinalIgnoreCase)) {
        Remove-Item -LiteralPath $directory -Recurse -Force
    }
}
