#requires -Version 5.1
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$OutputDirectory
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$repository = (Resolve-Path (Join-Path $PSScriptRoot '../../..')).Path
$commit = '2e924647957cc631e33ae099fefb56391e86afc4'
$name = 'WiFiMeter-1.1.1-PowerShell-windows-Portable.zip'
$actual = & git -C $repository rev-parse 'refs/tags/v1.1.1^{commit}'
if ($LASTEXITCODE -ne 0 -or $actual -ne $commit) { throw 'v1.1.1 does not match the pinned commit.' }
$output = [IO.Path]::GetFullPath($OutputDirectory)
[void][IO.Directory]::CreateDirectory($output)
# A unique export prevents current checkout files or previous builds entering the package.
$work = Join-Path $output ('source-' + [guid]::NewGuid().ToString('N'))
[void][IO.Directory]::CreateDirectory($work)
$archive = Join-Path $work 'source.zip'
& git -C $repository archive --format=zip "--output=$archive" $commit
if ($LASTEXITCODE -ne 0) { throw 'Cannot export the pinned commit.' }
$source = Join-Path $work 'original'
Expand-Archive -LiteralPath $archive -DestinationPath $source
$powershell = Join-Path $env:SystemRoot 'System32/WindowsPowerShell/v1.0/powershell.exe'
& $powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $source 'tools/Build.ps1')
if ($LASTEXITCODE -ne 0) { throw 'Original PowerShell build failed.' }
$runtime = Join-Path $source 'dist/WiFiMeter'
$version = [Diagnostics.FileVersionInfo]::GetVersionInfo((Join-Path $runtime 'WiFiMeter.exe')).FileVersion
if ($version -ne '1.1.1.0') { throw "Original internal version changed: $version" }
# Check every copied runtime source/document against the exported commit, byte for byte.
foreach ($folder in @('src', 'docs')) {
    Get-ChildItem -LiteralPath (Join-Path $runtime $folder) -File -Recurse | ForEach-Object {
        $relative = $_.FullName.Substring($runtime.Length + 1)
        $original = Join-Path $source $relative
        if ((Get-FileHash -LiteralPath $_.FullName).Hash -ne (Get-FileHash -LiteralPath $original).Hash) {
            throw "Original content changed: $relative"
        }
    }
}
if ((Get-FileHash -LiteralPath (Join-Path $runtime 'WiFiMeter.exe.config')).Hash -ne
    (Get-FileHash -LiteralPath (Join-Path $source 'src/WiFiMeter.exe.config')).Hash) { throw 'Runtime config changed.' }
$portable = Join-Path $source 'dist/WiFiMeter-Portable.zip'
# Verify the archive contains exactly the original build output, including executable and icon.
$expanded = Join-Path $work 'expanded'
Expand-Archive -LiteralPath $portable -DestinationPath $expanded
$runtimeFiles = @(Get-ChildItem -LiteralPath $runtime -File -Recurse)
$zipFiles = @(Get-ChildItem -LiteralPath $expanded -File -Recurse)
if ($runtimeFiles.Count -ne $zipFiles.Count) { throw 'Portable file count mismatch.' }
foreach ($file in $runtimeFiles) {
    $relative = $file.FullName.Substring($runtime.Length + 1)
    $zipped = Join-Path $expanded ('WiFiMeter/' + $relative)
    if ((Get-FileHash -LiteralPath $file.FullName).Hash -ne (Get-FileHash -LiteralPath $zipped).Hash) {
        throw "Portable content mismatch: $relative"
    }
}
$destination = Join-Path $output $name
Copy-Item -LiteralPath $portable -Destination $destination -Force
$manifest = [ordered]@{
    tag = 'v1.1.1'; commit = $commit; version = '1.1.1'; runtime = 'PowerShell'; name = $name
    size = (Get-Item -LiteralPath $destination).Length
    sha256 = (Get-FileHash -LiteralPath $destination -Algorithm SHA256).Hash.ToLowerInvariant()
}
$manifest | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $output 'manifest.json') -Encoding UTF8
if ($env:GITHUB_OUTPUT) { "source=$source" | Out-File -LiteralPath $env:GITHUB_OUTPUT -Append -Encoding utf8 }
Write-Output ($manifest | ConvertTo-Json)
