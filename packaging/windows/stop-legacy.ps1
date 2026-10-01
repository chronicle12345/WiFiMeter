#requires -Version 5.1
param(
    [string]$DataDirectory = (Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'WiFiMeter\data'),
    [string]$InstallDirectory,
    [ValidateRange(1, 60)][int]$TimeoutSeconds = 15
)
$ErrorActionPreference = 'Stop'

function Test-LegacyStopped([string]$Directory) {
    $lockPath = Join-Path $Directory 'collector.lock'
    if (-not [IO.File]::Exists($lockPath)) { return $true }
    try {
        $probe = [IO.File]::Open($lockPath, 'Open', 'ReadWrite', 'None')
        $probe.Dispose()
        return $true
    } catch [IO.IOException] { return $false }
}

function Test-LegacyIdentity($Status, $ExpectedProcess) {
    if ($null -eq $Status -or $Status.LaunchId -notmatch '^[a-fA-F0-9]{32}$') { return $false }
    if ($null -eq $ExpectedProcess) { return $true }
    # CIM timestamps have microsecond precision; the collector records 100 ns ticks.
    [long]$ticks = 0
    return ($Status.ProcessId -eq $ExpectedProcess.ProcessId -and
        [long]::TryParse([string]$Status.ProcessStartTicks, [ref]$ticks) -and
        $ExpectedProcess.CreationDate -is [DateTime] -and
        [Math]::Abs([decimal]$ticks - [decimal]$ExpectedProcess.CreationDate.ToUniversalTime().Ticks) -lt 10)
}

function Stop-LegacyCollector([string]$Directory, [int]$TimeoutSeconds, $ExpectedProcess = $null) {
    $directory = [IO.Path]::GetFullPath($Directory)
    if (Test-LegacyStopped $directory) {
        if ($null -ne $ExpectedProcess) { throw 'Close WiFiMeter before updating: the running process has no active collector lock.' }
        return
    }
    $statusPath = Join-Path $directory 'status.json'
    $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
    $status = $null
    do {
        try { $status = [IO.File]::ReadAllText($statusPath) | ConvertFrom-Json } catch { $status = $null }
        if ((Test-LegacyIdentity $status $ExpectedProcess) -and ($null -eq $ExpectedProcess -or $status.Running -eq $true)) { break }
        if ($null -eq $ExpectedProcess -and (Test-LegacyStopped $directory)) { return }
        Start-Sleep -Milliseconds 100
    } while ([DateTime]::UtcNow -lt $deadline)
    if (-not (Test-LegacyIdentity $status $ExpectedProcess) -or ($null -ne $ExpectedProcess -and $status.Running -ne $true)) {
        throw 'Close the previous WiFiMeter collector before updating: its launch identity could not be confirmed.'
    }
    $launchId = [string]$status.LaunchId
    $request = Join-Path $directory 'stop.request'
    $temporary = $request + '.' + [guid]::NewGuid().ToString('N') + '.tmp'
    try {
        [IO.File]::WriteAllText($temporary, (@{ LaunchId = $launchId } | ConvertTo-Json -Compress), [Text.UTF8Encoding]::new($true))
        if ([IO.File]::Exists($request)) { [IO.File]::Replace($temporary, $request, [System.Management.Automation.Language.NullString]::Value) }
        else { [IO.File]::Move($temporary, $request) }
    } finally { if ([IO.File]::Exists($temporary)) { [IO.File]::Delete($temporary) } }
    while ([DateTime]::UtcNow -lt $deadline) {
        if (Test-LegacyStopped $directory) {
            if ($null -ne $ExpectedProcess) {
                $final = [IO.File]::ReadAllText($statusPath) | ConvertFrom-Json
                if (-not (Test-LegacyIdentity $final $ExpectedProcess) -or $final.LaunchId -cne $launchId -or
                    $final.Running -ne $false -or -not [string]::IsNullOrEmpty([string]$final.Error)) {
                    throw 'Close WiFiMeter and check its storage error before updating: a successful save was not confirmed.'
                }
            }
            return
        }
        Start-Sleep -Milliseconds 100
    }
    throw 'The previous collector has not finished saving. Close it and retry the update.'
}

function Get-WiFiMeterProcesses {
    Get-CimInstance -ClassName Win32_Process -Filter "Name = 'WiFiMeter.exe'" -ErrorAction Stop
}

function Get-InstallProcesses([string]$InstallDirectory) {
    $executable = [IO.Path]::GetFullPath((Join-Path $InstallDirectory 'WiFiMeter.exe'))
    try { $processes = @(Get-WiFiMeterProcesses) }
    catch { throw 'Cannot inspect running WiFiMeter processes. Close WiFiMeter (including elevated instances) and retry the update.' }
    foreach ($process in $processes) {
        if ([string]::IsNullOrWhiteSpace($process.ExecutablePath)) {
            throw 'Cannot read a WiFiMeter process path. Close WiFiMeter (including elevated instances) and retry the update.'
        }
        if ([string]::Equals([IO.Path]::GetFullPath($process.ExecutablePath), $executable, [StringComparison]::OrdinalIgnoreCase)) {
            $process
        }
    }
}

function Get-LegacyDataDirectory([string]$CommandLine, [string]$ExecutablePath) {
    if ([string]::IsNullOrWhiteSpace($CommandLine)) { throw 'Close WiFiMeter before updating: its command line cannot be read.' }
    if (-not ('WiFiMeter.UpgradeArguments' -as [type])) {
        Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
namespace WiFiMeter {
    public static class UpgradeArguments {
        [DllImport("shell32.dll", SetLastError=true, CharSet=CharSet.Unicode)]
        private static extern IntPtr CommandLineToArgvW(string commandLine, out int count);
        [DllImport("kernel32.dll")]
        private static extern IntPtr LocalFree(IntPtr memory);
        public static string[] Parse(string commandLine) {
            int count;
            IntPtr memory = CommandLineToArgvW(commandLine, out count);
            if (memory == IntPtr.Zero) throw new System.ComponentModel.Win32Exception();
            try {
                var result = new string[count];
                for (int i=0; i<count; i++) result[i] = Marshal.PtrToStringUni(Marshal.ReadIntPtr(memory, i * IntPtr.Size));
                return result;
            } finally { LocalFree(memory); }
        }
    }
}
"@
    }
    $arguments = [WiFiMeter.UpgradeArguments]::Parse($CommandLine)
    $directory = $null
    $background = $false
    if ($arguments.Count -ne 4 -or -not [string]::Equals($arguments[0], $ExecutablePath, [StringComparison]::OrdinalIgnoreCase)) {
        throw 'Close WiFiMeter before updating: this instance is not a confirmed legacy background collector.'
    }
    for ($i = 1; $i -lt $arguments.Count; $i++) {
        switch -CaseSensitive ($arguments[$i]) {
            '--background' { if ($background) { throw 'Close WiFiMeter: duplicate background argument.' }; $background = $true }
            '--data-directory' {
                if ($null -ne $directory -or $i + 1 -ge $arguments.Count) { throw 'Close WiFiMeter: invalid data-directory argument.' }
                $directory = $arguments[++$i]
            }
            default { throw 'Close WiFiMeter before updating: unrecognized process arguments.' }
        }
    }
    # Drive-relative and current-drive paths cannot identify another process's data directory.
    if (-not $background -or $directory -notmatch '^(?:[a-zA-Z]:\\|\\\\[^\\]+\\[^\\]+(?:\\|$))') {
        throw 'Close WiFiMeter before updating: an absolute legacy data directory is required.'
    }
    return [IO.Path]::GetFullPath($directory)
}

function Invoke-InstallGuard([string]$InstallDirectory, [int]$TimeoutSeconds = 15) {
    $directory = [IO.Path]::GetFullPath($InstallDirectory)
    $processes = @(Get-InstallProcesses $directory)
    # Validate every candidate before requesting any collector to stop.
    $collectors = @(foreach ($process in $processes) {
        $data = Get-LegacyDataDirectory -CommandLine $process.CommandLine -ExecutablePath $process.ExecutablePath
        [pscustomobject]@{ Process = $process; Directory = $data }
    })
    foreach ($collector in $collectors) {
        Stop-LegacyCollector -Directory $collector.Directory -TimeoutSeconds $TimeoutSeconds -ExpectedProcess $collector.Process
    }
    # Lock release precedes process exit. Check again, including any newly started instance.
    $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
    do {
        if (@(Get-InstallProcesses $directory).Count -eq 0) { return }
        Start-Sleep -Milliseconds 100
    } while ([DateTime]::UtcNow -lt $deadline)
    throw 'WiFiMeter is still running. Close every instance in the selected installation directory and retry the update.'
}

if ($MyInvocation.InvocationName -ne '.') {
    try {
        if ($InstallDirectory) { Invoke-InstallGuard -InstallDirectory $InstallDirectory -TimeoutSeconds $TimeoutSeconds }
        else { Stop-LegacyCollector -Directory $DataDirectory -TimeoutSeconds $TimeoutSeconds }
        exit 0
    } catch {
        [Console]::Error.WriteLine($_.Exception.Message)
        exit 1
    }
}
