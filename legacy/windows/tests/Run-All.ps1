#requires -Version 5.1
[CmdletBinding()]
param([switch]$SkipDesktopTests)
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
$powershellPath = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'

$errorsFound = @()
$source = foreach ($directory in @('src', 'tests', 'tools')) {
    Get-ChildItem -LiteralPath (Join-Path $root $directory) -File -Recurse | Where-Object { $_.Extension -in @('.ps1', '.psm1') }
}
foreach ($file in $source) {
    $tokens = $null; $parseErrors = $null
    [void][System.Management.Automation.Language.Parser]::ParseFile($file.FullName, [ref]$tokens, [ref]$parseErrors)
    $errorsFound += $parseErrors
    $bytes = [IO.File]::ReadAllBytes($file.FullName)
    if ($bytes.Length -lt 3 -or $bytes[0] -ne 239 -or $bytes[1] -ne 187 -or $bytes[2] -ne 191) { throw ('FAIL: missing UTF-8 BOM: ' + $file.Name) }
}
if ($errorsFound.Count -gt 0) { $errorsFound | Format-List | Out-Host; throw 'FAIL: PowerShell parser errors.' }
Write-Output ('PASS: syntax and UTF-8 BOM for ' + $source.Count + ' PowerShell files.')

# The interface and host suites create real windows and render them through WPF.
# An agent without an interactive desktop blocks in those calls instead of failing,
# so they are skipped unless a desktop is available and they were not excluded.
# Every suite prints a RUN line before it starts. A suite that never finishes is
# identified by the last RUN line, which is what makes a blocked run diagnosable.
$desktopAvailable = [Environment]::UserInteractive
$suites = @(
    [pscustomobject]@{ Name = 'Core.Tests.ps1'; Extra = @(); Desktop = $false },
    [pscustomobject]@{ Name = 'Preferences.Tests.ps1'; Extra = @(); Desktop = $false },
    [pscustomobject]@{ Name = 'QuotaRuntime.Tests.ps1'; Extra = @(); Desktop = $false },
    [pscustomobject]@{ Name = 'AppUsage.Tests.ps1'; Extra = @(); Desktop = $false },
    [pscustomobject]@{ Name = 'Control.Tests.ps1'; Extra = @(); Desktop = $false },
    [pscustomobject]@{ Name = 'Sampler.Tests.ps1'; Extra = @('-Live'); Desktop = $false },
    [pscustomobject]@{ Name = 'Integration.Tests.ps1'; Extra = @(); Desktop = $false },
    [pscustomobject]@{ Name = 'UI.Tests.ps1'; Extra = @(); Desktop = $true },
    [pscustomobject]@{ Name = 'Host.Tests.ps1'; Extra = @('-IncludePreview'); Desktop = $true },
    [pscustomobject]@{ Name = 'Installer.Tests.ps1'; Extra = @(); Desktop = $false }
)

$skipped = @()
$total = [Diagnostics.Stopwatch]::StartNew()
foreach ($suite in $suites) {
    if ($suite.Desktop -and ($SkipDesktopTests -or -not $desktopAvailable)) {
        $skipped += $suite.Name
        Write-Output ('SKIP: ' + $suite.Name + ' needs an interactive desktop session. Run it on a signed-in workstation.')
        continue
    }
    $arguments = @('-NoLogo', '-NoProfile', '-STA', '-ExecutionPolicy', 'Bypass', '-File', (Join-Path $PSScriptRoot $suite.Name)) + $suite.Extra
    Write-Output ('RUN: ' + $suite.Name)
    $started = [DateTime]::UtcNow
    & $powershellPath @arguments
    if ($LASTEXITCODE -ne 0) { throw ('FAIL: ' + $suite.Name + ' exited with code ' + $LASTEXITCODE + '.') }
    Write-Output ('PASS: ' + $suite.Name + ' completed in ' + [math]::Round(([DateTime]::UtcNow - $started).TotalSeconds, 1) + 's.')
}
$total.Stop()
if ($skipped.Count -gt 0) { Write-Output ('SKIP summary: ' + ($skipped -join ', ')) }
Write-Output ('PASS: all test suites completed in ' + [math]::Round($total.Elapsed.TotalSeconds, 1) + 's.')
