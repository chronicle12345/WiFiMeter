#requires -Version 5.1

function Get-MeterDownloadSupport {
    $architecture = if ($env:PROCESSOR_ARCHITEW6432) { $env:PROCESSOR_ARCHITEW6432 } else { $env:PROCESSOR_ARCHITECTURE }
    if ($architecture -eq 'ARM64') { return [pscustomobject]@{ Supported = $false; Error = 'Windows ARM64 暂不支持 WinDivert 下载限速。'; Code = 'DownloadArchitectureUnsupported'; Dll = $null } }
    $folder = if ([Environment]::Is64BitProcess) { 'x64' } else { 'x86' }
    $dll = Join-Path $PSScriptRoot "WinDivert\$folder\WinDivert.dll"
    $driver = Join-Path $PSScriptRoot "WinDivert\$folder\WinDivert64.sys"
    if (-not [Environment]::Is64BitOperatingSystem) { $driver = Join-Path $PSScriptRoot "WinDivert\$folder\WinDivert32.sys" }
    if (-not (Test-Path -LiteralPath $dll -PathType Leaf) -or -not (Test-Path -LiteralPath $driver -PathType Leaf)) {
        return [pscustomobject]@{ Supported = $false; Error = '缺少 WinDivert DLL 或签名驱动，无法启用下载限速。'; Code = 'DownloadDependencyMissing'; Dll = $null }
    }
    return [pscustomobject]@{ Supported = $true; Error = $null; Code = $null; Dll = $dll }
}

function Initialize-MeterDownloadControl {
    if (-not ('WiFiMeter.DownloadControl.Server' -as [type])) {
        Add-Type -Path (Join-Path $PSScriptRoot 'DownloadLimiter.cs') -ErrorAction Stop
    }
}

function Get-MeterDownloadPipeName {
    param([string]$OwnerSid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value)
    return 'WiFiMeter.DownloadControl.v1-' + $OwnerSid
}

function Get-MeterDownloadState {
    param([string]$Path)
    $support = Get-MeterDownloadSupport
    $state = [pscustomobject]@{ Supported = $support.Supported; Throttled = $false; Kbps = $null; Error = $support.Error; ErrorCode = $support.Code }
    if (-not $support.Supported) { return $state }
    try {
        Initialize-MeterDownloadControl
        $response = [WiFiMeter.DownloadControl.Server]::Request((Get-MeterDownloadPipeName), 'READ', $Path, 0, 500)
        if ($null -ne $response) {
            if ($response -notmatch '^OK\|([0-9]+)$') { throw '下载限速后台返回了无效的状态。' }
            $rate = [long]$Matches[1]
            $state.Throttled = $rate -gt 0
            if ($state.Throttled) { $state.Kbps = $rate }
        }
    } catch { $state.Throttled = $null; $state.Error = $_.Exception.Message; $state.ErrorCode = 'DownloadQueryFailed' }
    return $state
}

function Invoke-MeterDownloadMutation {
    param([string]$Path, [long]$DownloadKbps, [int]$OwnerPid, [string]$OwnerSid)
    $support = Get-MeterDownloadSupport
    if (-not $support.Supported) {
        if ($DownloadKbps -eq 0) { return }
        throw $support.Error
    }
    Initialize-MeterDownloadControl
    $pipeName = Get-MeterDownloadPipeName -OwnerSid $OwnerSid
    $response = [WiFiMeter.DownloadControl.Server]::Request($pipeName, 'SET', $Path, $DownloadKbps, 1000)
    if ($null -ne $response) {
        if ($response -ne "OK|$DownloadKbps") { throw '下载限速配置回读失败。' }
        return
    }
    if ($DownloadKbps -eq 0) { return }
    if ($OwnerPid -le 0) { throw '下载限速需要有效的 WiFiMeter 主进程。' }
    # RunAs helper is already elevated. Data stays inside base64 JSON and fixed code.
    $payload = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes((@{
        Source = (Join-Path $PSScriptRoot 'DownloadLimiter.cs'); Pipe = $pipeName; Dll = $support.Dll
        Path = $Path; Rate = $DownloadKbps; Owner = $OwnerPid; OwnerSid = $OwnerSid
    } | ConvertTo-Json -Compress)))
    $script = @(
        '$ErrorActionPreference = ''Stop'''
        'try {'
        '    $data = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String(''__PAYLOAD__'')) | ConvertFrom-Json'
        '    Add-Type -Path $data.Source -ErrorAction Stop'
        '    [WiFiMeter.DownloadControl.Server]::Run($data.Pipe, $data.Dll, $data.Path, [long]$data.Rate, [int]$data.Owner, $data.OwnerSid)'
        '    exit 0'
        '} catch { exit 1 }'
    ) -join "`n"
    $encoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($script.Replace('__PAYLOAD__', $payload)))
    $exe = Join-Path ([Environment]::GetFolderPath('Windows')) 'System32\WindowsPowerShell\v1.0\powershell.exe'
    $daemon = Start-Process -FilePath $exe -ArgumentList @('-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', $encoded) -WindowStyle Hidden -PassThru -ErrorAction Stop
    try {
        $clock = [Diagnostics.Stopwatch]::StartNew()
        while ($clock.ElapsedMilliseconds -lt 20000) {
            $response = [WiFiMeter.DownloadControl.Server]::Request($pipeName, 'SET', $Path, $DownloadKbps, 500)
            if ($response -eq "OK|$DownloadKbps") { return }
            if ($daemon.HasExited) { throw 'WinDivert 下载限速后台启动失败，请检查管理员权限及系统是否允许签名驱动运行。' }
        }
        throw '等待下载限速后台启动超时，请查询实际状态。'
    } finally { $daemon.Dispose() }
}
