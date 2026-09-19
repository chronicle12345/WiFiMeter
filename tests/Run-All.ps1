#requires -Version 5.1
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
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
foreach ($test in @('Core.Tests.ps1', 'Preferences.Tests.ps1', 'QuotaRuntime.Tests.ps1', 'AppUsage.Tests.ps1', 'Control.Tests.ps1', 'Sampler.Tests.ps1', 'Integration.Tests.ps1', 'UI.Tests.ps1', 'Host.Tests.ps1', 'Installer.Tests.ps1')) {
    $arguments = @('-NoLogo', '-NoProfile', '-STA', '-ExecutionPolicy', 'Bypass', '-File', (Join-Path $PSScriptRoot $test))
    if ($test -eq 'Sampler.Tests.ps1') { $arguments += '-Live' }
    if ($test -eq 'Host.Tests.ps1') { $arguments += '-IncludePreview' }
    & (Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe') @arguments
    if ($LASTEXITCODE -ne 0) { throw ('FAIL: ' + $test) }
}
Write-Output 'PASS: all test suites completed.'
