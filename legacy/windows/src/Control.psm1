#requires -Version 5.1
Set-StrictMode -Version Latest
Import-Module (Join-Path $PSScriptRoot 'Storage.psm1') -Scope Local
$script:SourceDirectory = $PSScriptRoot
$script:MeterRoot = Split-Path $PSScriptRoot -Parent

function Get-MeterDataDirectory {
    return Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'WiFiMeter\data'
}

function Initialize-MeterDataDirectory {
    param([string]$DataDirectory = (Get-MeterDataDirectory))
    $fullPath = [IO.Path]::GetFullPath($DataDirectory)
    [void][IO.Directory]::CreateDirectory($fullPath)
    return $fullPath
}

function Get-MeterIdentity {
    param([string]$Path = $script:MeterRoot)
    $sha = [Security.Cryptography.SHA256]::Create()
    try { return ([BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes([IO.Path]::GetFullPath($Path).ToUpperInvariant())))).Replace('-', '').Substring(0, 20) }
    finally { $sha.Dispose() }
}

function Write-MeterJson {
    param([Parameter(Mandatory)][string]$Path, [Parameter(Mandatory)]$Value)
    $temporary = $Path + '.' + [guid]::NewGuid().ToString('N') + '.tmp'
    try {
        [IO.File]::WriteAllText($temporary, ($Value | ConvertTo-Json -Depth 12), (New-Object Text.UTF8Encoding($true)))
        if ([IO.File]::Exists($Path)) { Invoke-MeterFileReplace -Source $temporary -Destination $Path }
        else { [IO.File]::Move($temporary, $Path) }
    } finally { if ([IO.File]::Exists($temporary)) { [IO.File]::Delete($temporary) } }
}

function Get-MeterStatus {
    param([string]$DataDirectory = (Get-MeterDataDirectory))
    $result = [pscustomobject]@{ Running = $false; Healthy = $false; Message = '统计尚未启动'; ProcessId = 0; ProcessStartTicks = 0; LaunchId = ''; UpdatedAt = ''; Connections = @(); DownloadPerSecond = 0.0; UploadPerSecond = 0.0; Error = ''; SkippedIntervals = 0; Alerts = @() }
    $path = Join-Path $DataDirectory 'status.json'
    $lockPath = Join-Path $DataDirectory 'collector.lock'
    if (-not [IO.File]::Exists($path) -and -not [IO.File]::Exists($lockPath)) { return $result }
    try {
        # Replacement can briefly report missing/access-denied on some Windows file systems.
        # Retry only the read; a valid stopped snapshot is returned immediately.
        for ($attempt = 0; ; $attempt++) {
            try { $saved = Read-MeterJson $path; break }
            catch { if ($attempt -ge 2) { throw }; Start-Sleep -Milliseconds 20 }
        }
        foreach ($property in $result.PSObject.Properties.Name) {
            if ($null -ne $saved.PSObject.Properties[$property]) { $result.$property = $saved.$property }
        }
        if ($result.Running) {
            $process = Get-Process -Id $result.ProcessId -ErrorAction SilentlyContinue
            $valid = $null -ne $process -and $process.ProcessName -in @('WiFiMeter', 'powershell') -and $process.StartTime.ToUniversalTime().Ticks -eq [long]$result.ProcessStartTicks
            if ($null -ne $process) { $process.Dispose() }
            if (-not $valid) { $result.Running = $false; $result.Healthy = $false; $result.Message = '后台统计已停止' }
            else {
                $result.Healthy = ([DateTimeOffset]::UtcNow - [DateTimeOffset]::Parse($result.UpdatedAt)).TotalSeconds -lt 20
                if (-not $result.Healthy) { $result.Message = '后台进程仍在运行，等待采样更新' }
            }
        }
    } catch { $result.Running = $false; $result.Healthy = $false; $result.Message = '暂时无法读取运行状态：' + $_.Exception.Message }
    return $result
}

function Read-MeterJson {
    param([Parameter(Mandatory)][string]$Path)
    $stream = [IO.File]::Open($Path, 'Open', 'Read', ([IO.FileShare]::ReadWrite -bor [IO.FileShare]::Delete))
    $reader = $null
    try {
        $reader = New-Object IO.StreamReader($stream, [Text.Encoding]::UTF8, $true)
        return ($reader.ReadToEnd() | ConvertFrom-Json -ErrorAction Stop)
    } finally { if ($null -ne $reader) { $reader.Dispose() } else { $stream.Dispose() } }
}

function Start-MeterCollector {
    param([string]$DataDirectory = (Get-MeterDataDirectory))
    $directory = Initialize-MeterDataDirectory $DataDirectory
    $mutex = New-Object Threading.Mutex($false, ('Local\WiFiMeterControl_' + (Get-MeterIdentity $directory)))
    $owned = $false
    $child = $null
    try {
        try { $owned = $mutex.WaitOne(12000) } catch [Threading.AbandonedMutexException] { $owned = $true }
        if (-not $owned) { throw '另一个启动或停止操作尚未完成，请稍后重试。' }
        $current = Get-MeterStatus $directory
        if ($current.Running) { return $current }
        $executable = Join-Path $script:MeterRoot 'WiFiMeter.exe'
        if ([IO.File]::Exists($executable)) {
            $arguments = '--background --data-directory "{0}"' -f $directory.TrimEnd('\')
        } else {
            # Direct source execution is reserved for development and automated tests.
            $executable = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
            $scriptPath = Join-Path $script:SourceDirectory 'Collector.ps1'
            $arguments = '-NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "{0}" -DataDirectory "{1}"' -f $scriptPath, $directory.TrimEnd('\')
        }
        $child = Start-Process -FilePath $executable -ArgumentList $arguments -WindowStyle Hidden -PassThru
        $deadline = [DateTime]::UtcNow.AddSeconds(10)
        do {
            Start-Sleep -Milliseconds 150
            $current = Get-MeterStatus $directory
            if ($current.Running -and $current.ProcessId -eq $child.Id) { return $current }
            if ($child.HasExited) {
                # Another launcher may have acquired the file lock first.
                if ($current.Running) { return $current }
                if ($child.ExitCode -ne 0) {
                    if ($current.Error -and $current.ProcessId -eq $child.Id) { throw $current.Error }
                    throw '后台进程未能启动，请查看 data\collector.log。'
                }
                # A competing collector can own the lock before its first status write.
                # Keep waiting for that process rather than reporting a false failure.
            }
        } while ([DateTime]::UtcNow -lt $deadline)
        throw '后台启动超时，请稍后刷新窗口并查看 data\collector.log。'
    } finally { if ($null -ne $child) { $child.Dispose() }; if ($owned) { $mutex.ReleaseMutex() }; $mutex.Dispose() }
}

function Stop-MeterCollector {
    param([string]$DataDirectory = (Get-MeterDataDirectory))
    $mutex = New-Object Threading.Mutex($false, ('Local\WiFiMeterControl_' + (Get-MeterIdentity $DataDirectory)))
    $owned = $false
    $targetProcess = $null
    try {
        try { $owned = $mutex.WaitOne(12000) } catch [Threading.AbandonedMutexException] { $owned = $true }
        if (-not $owned) { throw '另一个启动或停止操作尚未完成，请稍后重试。' }
        $current = Get-MeterStatus $DataDirectory
        if (-not $current.Running) {
            # Never report a completed stop solely because status could not be read.
            # The collector owns this exclusive lock for its complete lifetime.
            $lockPath = Join-Path $DataDirectory 'collector.lock'
            if ([IO.File]::Exists($lockPath)) {
                $probe = $null
                try { $probe = [IO.File]::Open($lockPath, 'Open', 'ReadWrite', 'None') }
                catch [IO.FileNotFoundException] { }
                catch [IO.IOException] { throw '后台进程仍在运行，但暂时无法读取状态。请稍后重试停止。' }
                finally { if ($null -ne $probe) { $probe.Dispose() } }
            }
            return $current
        }
        $targetProcess = Get-Process -Id $current.ProcessId -ErrorAction SilentlyContinue
        Write-MeterJson -Path (Join-Path $DataDirectory 'stop.request') -Value @{ LaunchId = [string]$current.LaunchId }
        $deadline = [DateTime]::UtcNow.AddSeconds(10)
        do {
            Start-Sleep -Milliseconds 150
            $current = Get-MeterStatus $DataDirectory
            if (-not $current.Running) {
                # A final status write precedes lock disposal. Wait for process exit
                # before reporting a completed stop or allowing immediate restart.
                if ($null -ne $targetProcess -and -not $targetProcess.HasExited) {
                    $remaining = [int][math]::Max(0, ($deadline - [DateTime]::UtcNow).TotalMilliseconds)
                    if (-not $targetProcess.WaitForExit($remaining)) { throw '数据已保存，后台进程尚未完全退出，请稍后重试。' }
                }
                return $current
            }
        } while ([DateTime]::UtcNow -lt $deadline)
        throw '后台尚未完成保存，请稍后再试。'
    } finally { if ($null -ne $targetProcess) { $targetProcess.Dispose() }; if ($owned) { $mutex.ReleaseMutex() }; $mutex.Dispose() }
}

function Get-MeterAutoStartInfo {
    [CmdletBinding()]
    param(
        [string]$RunSubKey = 'Software\Microsoft\Windows\CurrentVersion\Run',
        [string]$ApprovalSubKey = 'Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run'
    )
    $run = $null
    $approval = $null
    $command = ''
    $disabled = $false
    try {
        $run = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey($RunSubKey)
        if ($null -ne $run) { $command = [string]$run.GetValue('WiFiMeter', '') }
        $approval = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey($ApprovalSubKey)
        if ($null -ne $approval) {
            $record = $approval.GetValue('WiFiMeter', $null)
            # Read known Windows disabled states only; never modify its approval data.
            if ($record -is [byte[]] -and $record.Length -ge 1) { $disabled = $record[0] -in @(3, 7) }
        }
    } finally {
        if ($null -ne $run) { $run.Dispose() }
        if ($null -ne $approval) { $approval.Dispose() }
    }
    $registered = -not [string]::IsNullOrEmpty($command)
    $message = if ($registered -and $disabled) { '已被 Windows 禁用，请在任务管理器的启动应用中启用 WiFiMeter' } elseif ($registered) { '登录后自动统计，可在任务管理器的启动应用中管理 WiFiMeter' } else { '已关闭登录自启动' }
    [pscustomobject]@{ Registered = $registered; Enabled = ($registered -and -not $disabled); DisabledByWindows = $disabled; Message = $message; Command = $command }
}

function Get-MeterAutoStart {
    [CmdletBinding()]
    param(
        [string]$RunSubKey = 'Software\Microsoft\Windows\CurrentVersion\Run',
        [string]$ApprovalSubKey = 'Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run'
    )
    return (Get-MeterAutoStartInfo -RunSubKey $RunSubKey -ApprovalSubKey $ApprovalSubKey).Enabled
}

function Set-MeterAutoStart {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][bool]$Enabled,
        [string]$ExecutablePath = (Join-Path $script:MeterRoot 'WiFiMeter.exe'),
        [string]$RunSubKey = 'Software\Microsoft\Windows\CurrentVersion\Run',
        [string]$ApprovalSubKey = 'Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run'
    )
    $run = $null
    try {
        if ($Enabled) {
            $exe = [IO.Path]::GetFullPath($ExecutablePath)
            if (-not [IO.File]::Exists($exe) -or [IO.Path]::GetFileName($exe) -ine 'WiFiMeter.exe') { throw '请从安装后的 WiFiMeter.exe 打开应用，再设置自启动。' }
            $command = '"' + $exe + '" --tray'
            if ($command.Length -gt 260) { throw '程序路径过长，无法注册 Windows 启动项。请将程序放到较短的目录。' }
            $run = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey($RunSubKey)
            $run.SetValue('WiFiMeter', $command, [Microsoft.Win32.RegistryValueKind]::String)
        } else {
            $run = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey($RunSubKey, $true)
            if ($null -ne $run) { $run.DeleteValue('WiFiMeter', $false) }
        }
    } finally { if ($null -ne $run) { $run.Dispose() } }
    if ($Enabled -and (Get-MeterAutoStartInfo -RunSubKey $RunSubKey -ApprovalSubKey $ApprovalSubKey).DisabledByWindows) { throw 'Windows 已禁用此启动项。请在任务管理器的启动应用中启用 WiFiMeter。' }
}

Export-ModuleMember -Function Get-MeterDataDirectory, Initialize-MeterDataDirectory, Get-MeterIdentity, Write-MeterJson, Read-MeterJson, Get-MeterStatus, Start-MeterCollector, Stop-MeterCollector, Get-MeterAutoStart, Get-MeterAutoStartInfo, Set-MeterAutoStart
