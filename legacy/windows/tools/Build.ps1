#requires -Version 5.1
param([switch]$HostOnly)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
$dist = Join-Path $root 'dist'
$runtime = Join-Path $dist 'WiFiMeter'
[void][IO.Directory]::CreateDirectory((Join-Path $runtime 'src'))
[void][IO.Directory]::CreateDirectory((Join-Path $runtime 'assets'))
$compiler = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
if (-not [IO.File]::Exists($compiler)) { $compiler = Join-Path $env:WINDIR 'Microsoft.NET\Framework\v4.0.30319\csc.exe' }
if (-not [IO.File]::Exists($compiler)) { throw '找不到 Windows .NET Framework C# 编译器。' }
$automation = Join-Path $env:WINDIR 'Microsoft.NET\assembly\GAC_MSIL\System.Management.Automation\v4.0_3.0.0.0__31bf3856ad364e35\System.Management.Automation.dll'
if (-not [IO.File]::Exists($automation)) { throw '找不到 Windows PowerShell 5.1 自动化程序集。' }
$icon = Join-Path $runtime 'assets\WiFiMeter.ico'
& (Join-Path $PSScriptRoot 'Create-Icon.ps1') -Path $icon
$manifest = Join-Path $root 'src\app.manifest'
$exe = Join-Path $runtime 'WiFiMeter.exe'
& $compiler /nologo /target:winexe /platform:anycpu /optimize+ /utf8output "/out:$exe" "/win32icon:$icon" "/win32manifest:$manifest" "/reference:$automation" /reference:System.Windows.Forms.dll (Join-Path $root 'src\Host.cs')
if ($LASTEXITCODE -ne 0) { throw 'WiFiMeter.exe 编译失败。' }
Copy-Item -LiteralPath (Join-Path $root 'src\WiFiMeter.exe.config') -Destination (Join-Path $runtime 'WiFiMeter.exe.config') -Force
$runtimeNames = @('App.ps1', 'Dialogs.ps1', 'Collector.ps1', 'Control.psm1', 'Core.psm1', 'Sampler.psm1', 'Strings.psm1', 'MainWindow.xaml', 'Preferences.psm1', 'QuotaRuntime.psm1', 'NetworkControl.cs', 'AppUsage.psm1', 'Storage.psm1')
foreach ($name in $runtimeNames) {
    $source = Join-Path $root ('src\' + $name)
    if ([IO.File]::Exists($source)) { Copy-Item -LiteralPath $source -Destination (Join-Path $runtime ('src\' + $name)) -Force }
    else { throw ('Missing runtime file: ' + $source) }
}
# Keep the runtime package limited to the explicitly listed files, including after an older build.
$docs = @(
    'docs\USAGE.md', 'docs\USAGE.zh-CN.md'
)
$allowed = @('WiFiMeter.exe', 'WiFiMeter.exe.config', 'assets\WiFiMeter.ico') + $docs + @($runtimeNames | ForEach-Object { 'src\' + $_ })
$runtimeFull = [IO.Path]::GetFullPath($runtime).TrimEnd('\')
Get-ChildItem -LiteralPath $runtimeFull -File -Recurse | ForEach-Object {
    $relative = $_.FullName.Substring($runtimeFull.Length + 1)
    if ($allowed -notcontains $relative) { Remove-Item -LiteralPath $_.FullName -Force }
}
Get-ChildItem -LiteralPath $runtimeFull -Directory -Recurse | Sort-Object { $_.FullName.Length } -Descending | ForEach-Object {
    if ($_.FullName.StartsWith($runtimeFull + '\', [StringComparison]::OrdinalIgnoreCase) -and
        @(Get-ChildItem -LiteralPath $_.FullName -Force).Count -eq 0) { Remove-Item -LiteralPath $_.FullName -Force }
}
foreach ($doc in $docs) {
    $docSource = Join-Path $root $doc
    if ([IO.File]::Exists($docSource)) {
        $docTarget = Join-Path $runtime $doc
        [void][IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($docTarget))
        Copy-Item -LiteralPath $docSource -Destination $docTarget -Force
    }
}
if ($HostOnly) { Write-Output $exe; return }
Add-Type -AssemblyName System.IO.Compression.FileSystem
$portable = Join-Path $dist 'WiFiMeter-Portable.zip'
$stage = Join-Path $dist ('build-' + [guid]::NewGuid().ToString('N'))
[void][IO.Directory]::CreateDirectory($stage)
try {
    $payload = Join-Path $stage 'runtime.zip'
    [IO.Compression.ZipFile]::CreateFromDirectory($runtime, $payload, [IO.Compression.CompressionLevel]::Optimal, $false)
    $setup = Join-Path $dist 'WiFiMeter-Setup.exe'
    & $compiler /nologo /target:winexe /platform:anycpu /optimize+ /utf8output "/out:$setup" "/win32icon:$icon" "/win32manifest:$manifest" /reference:System.Windows.Forms.dll /reference:System.Drawing.dll /reference:System.IO.Compression.dll /reference:System.IO.Compression.FileSystem.dll "/resource:$payload,WiFiMeter.Runtime.zip" (Join-Path $root 'installer\Setup.cs')
    if ($LASTEXITCODE -ne 0) { throw '安装程序编译失败。' }
    $portableTemporary = Join-Path $stage 'portable.zip'
    [IO.Compression.ZipFile]::CreateFromDirectory($runtime, $portableTemporary, [IO.Compression.CompressionLevel]::Optimal, $true)
    if ([IO.File]::Exists($portable)) { [IO.File]::Replace($portableTemporary, $portable, [System.Management.Automation.Language.NullString]::Value) }
    else { [IO.File]::Move($portableTemporary, $portable) }
    Write-Output $exe
    Write-Output $setup
    Write-Output $portable
} finally {
    $full = [IO.Path]::GetFullPath($stage)
    if ($full.StartsWith([IO.Path]::GetFullPath($dist).TrimEnd('\') + '\', [StringComparison]::OrdinalIgnoreCase) -and [IO.Path]::GetFileName($full).StartsWith('build-')) { Remove-Item -LiteralPath $full -Recurse -Force }
}
