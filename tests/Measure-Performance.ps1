#requires -Version 5.1
[CmdletBinding()]
param([ValidateRange(10, 60)][int]$Seconds = 20)
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
$runtimeControl = Join-Path $root 'dist\WiFiMeter\src\Control.psm1'
if (-not [IO.File]::Exists($runtimeControl)) { $runtimeControl = Join-Path $root 'src\Control.psm1' }
Import-Module $runtimeControl -Force
Import-Module (Join-Path $root 'src\Sampler.psm1') -Force
$artifactDirectory = Join-Path $root 'artifacts'
$directory = Join-Path $artifactDirectory ('performance-' + [guid]::NewGuid().ToString('N'))
$stopped = $false
try {
    $status = Start-MeterCollector $directory
    $worker = Get-Process -Id $status.ProcessId
    $cpuBefore = $worker.TotalProcessorTime.TotalSeconds
    $timer = [Diagnostics.Stopwatch]::StartNew()
    Start-Sleep -Seconds $Seconds
    $timer.Stop()
    $worker.Refresh()
    $cpuPercent = ($worker.TotalProcessorTime.TotalSeconds - $cpuBefore) / $timer.Elapsed.TotalSeconds * 100
    $workingSet = $worker.WorkingSet64 / 1MB
    $privateBytes = $worker.PrivateMemorySize64 / 1MB
    $null = Stop-MeterCollector $directory
    $stopped = $true
    $null = Get-WifiSamples
    $sampleTimer = [Diagnostics.Stopwatch]::StartNew()
    for ($i = 0; $i -lt 10; $i++) { $null = Get-WifiSamples }
    $sampleTimer.Stop()
    [pscustomobject]@{
        DurationSeconds = [math]::Round($timer.Elapsed.TotalSeconds, 2)
        CpuPercentOfOneCore = [math]::Round($cpuPercent, 3)
        WorkingSetMiB = [math]::Round($workingSet, 2)
        PrivateMemoryMiB = [math]::Round($privateBytes, 2)
        MeanSampleMilliseconds = [math]::Round($sampleTimer.Elapsed.TotalMilliseconds / 10, 2)
    } | ConvertTo-Json
} finally {
    if (-not $stopped) { try { $null = Stop-MeterCollector $directory; $stopped = $true } catch { Write-Warning $_.Exception.Message } }
    if ($stopped -and (Test-Path $directory) -and [IO.Path]::GetFullPath($directory).StartsWith([IO.Path]::GetFullPath($artifactDirectory).TrimEnd('\') + '\', [StringComparison]::OrdinalIgnoreCase)) { Remove-Item -LiteralPath $directory -Recurse -Force }
}
