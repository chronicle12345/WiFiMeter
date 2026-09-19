#requires -Version 5.1
param([switch]$IncludePreview)
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
$exe = Join-Path $root 'dist\WiFiMeter\WiFiMeter.exe'
if (-not [IO.File]::Exists($exe)) { throw 'FAIL: the native WiFiMeter.exe has not been built.' }
Import-Module (Join-Path $root 'dist\WiFiMeter\src\Control.psm1') -Force
Add-Type @'
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class MeterWindowTest {
    private delegate bool WindowCallback(IntPtr window, IntPtr parameter);
    [DllImport("user32.dll")] private static extern bool EnumWindows(WindowCallback callback, IntPtr parameter);
    [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr window, out uint process);
    [DllImport("user32.dll")] private static extern bool IsWindowVisible(IntPtr window);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern int GetClassName(IntPtr window, StringBuilder text, int count);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern int GetWindowText(IntPtr window, StringBuilder text, int count);
    public static bool HasVisibleDashboard(int processId) {
        bool found = false;
        EnumWindows(delegate(IntPtr window, IntPtr unused) {
            uint owner; GetWindowThreadProcessId(window, out owner);
            if (owner != processId || !IsWindowVisible(window)) return true;
            StringBuilder title = new StringBuilder(256), type = new StringBuilder(256);
            GetWindowText(window, title, title.Capacity); GetClassName(window, type, type.Capacity);
            // Input methods can create visible helper windows inside the host process.
            if (title.ToString().StartsWith("WiFiMeter", StringComparison.Ordinal) && type.ToString().StartsWith("HwndWrapper", StringComparison.Ordinal)) found = true;
            return !found;
        }, IntPtr.Zero);
        return found;
    }
}
'@
$bytes = [IO.File]::ReadAllBytes($exe)
$pe = [BitConverter]::ToInt32($bytes, 0x3c)
if ([BitConverter]::ToUInt16($bytes, $pe + 24 + 68) -ne 2) { throw 'FAIL: host must use the Windows GUI subsystem.' }
if ([Diagnostics.FileVersionInfo]::GetVersionInfo($exe).ProductName -ne 'WiFiMeter') { throw 'FAIL: missing native application identity.' }
$artifactDirectory = Join-Path $root 'artifacts'
$temp = Join-Path $artifactDirectory ('host 中文 spaces-' + [guid]::NewGuid().ToString('N'))
[void][IO.Directory]::CreateDirectory($temp)
$collector = $null
$tray = $null
try {
    $collector = Start-Process -FilePath $exe -ArgumentList ('--background --data-directory "{0}"' -f $temp) -WindowStyle Hidden -PassThru
    $statusPath = Join-Path $temp 'status.json'
    $deadline = [DateTime]::UtcNow.AddSeconds(20)
    $status = $null
    do {
        Start-Sleep -Milliseconds 200
        if ([IO.File]::Exists($statusPath)) {
            try { $status = Read-MeterJson -Path $statusPath } catch { }
        }
        if ($null -ne $status -and $status.Running) { break }
        if ($collector.HasExited) { throw ('FAIL: background host exited early with code ' + $collector.ExitCode) }
    } while ([DateTime]::UtcNow -lt $deadline)
    if ($null -eq $status -or -not $status.Running) { throw 'FAIL: native background host did not publish running status.' }
    if ($status.ProcessId -ne $collector.Id -or (Get-Process -Id $status.ProcessId).ProcessName -ne 'WiFiMeter') { throw 'FAIL: collector is not hosted by the native executable.' }
    $stop = Start-Process -FilePath $exe -ArgumentList ('--stop --data-directory "{0}"' -f $temp) -WindowStyle Hidden -PassThru
    if (-not $stop.WaitForExit(20000) -or $stop.ExitCode -ne 0) { throw 'FAIL: graceful stop command failed.' }
    if (-not $collector.WaitForExit(10000) -or $collector.ExitCode -ne 0) { throw 'FAIL: collector did not exit successfully after saving.' }
    $saved = Read-MeterJson -Path $statusPath
    if ($saved.Running) { throw 'FAIL: collector final status still says running.' }
    $saved.Running = $true
    $saved.ProcessId = 2147483646
    $saved | ConvertTo-Json -Depth 12 | Set-Content -LiteralPath $statusPath -Encoding UTF8
    $staleStop = Start-Process -FilePath $exe -ArgumentList ('--stop --data-directory "{0}"' -f $temp) -WindowStyle Hidden -PassThru
    if (-not $staleStop.WaitForExit(20000) -or $staleStop.ExitCode -ne 0) { throw 'FAIL: stopping an already-exited collector must succeed.' }
    $tray = Start-Process -FilePath $exe -ArgumentList ('--tray --data-directory "{0}"' -f $temp) -WindowStyle Hidden -PassThru
    $deadline = [DateTime]::UtcNow.AddSeconds(25)
    do {
        Start-Sleep -Milliseconds 200
        $live = Get-MeterStatus $temp
        if ($tray.HasExited) { throw 'FAIL: tray host exited during startup.' }
    } while (-not $live.Running -and [DateTime]::UtcNow -lt $deadline)
    if (-not $live.Running -or $live.ProcessId -eq $tray.Id) { throw 'FAIL: tray startup must start its separate collector.' }
    $tray.Refresh()
    if ([MeterWindowTest]::HasVisibleDashboard($tray.Id)) { throw 'FAIL: tray startup showed a window.' }
    $duplicate = Start-Process -FilePath $exe -ArgumentList ('--data-directory "{0}"' -f $temp) -WindowStyle Hidden -PassThru
    if (-not $duplicate.WaitForExit(15000) -or $duplicate.ExitCode -ne 0) { throw 'FAIL: second launch did not hand off to the existing window.' }
    $deadline = [DateTime]::UtcNow.AddSeconds(10)
    do { Start-Sleep -Milliseconds 100 } while (-not [MeterWindowTest]::HasVisibleDashboard($tray.Id) -and [DateTime]::UtcNow -lt $deadline)
    if (-not [MeterWindowTest]::HasVisibleDashboard($tray.Id)) { throw 'FAIL: second launch did not restore the tray window.' }
    $stop = Start-Process -FilePath $exe -ArgumentList ('--stop --data-directory "{0}"' -f $temp) -WindowStyle Hidden -PassThru
    if (-not $stop.WaitForExit(25000) -or $stop.ExitCode -ne 0) { throw 'FAIL: stop did not close the tray application.' }
    if (-not $tray.WaitForExit(5000) -or $tray.ExitCode -ne 0 -or (Get-MeterStatus $temp).Running) { throw 'FAIL: tray exit left a window or collector running.' }
    if ($IncludePreview) {
        foreach ($language in @('en', 'zh-CN')) {
            $snapshot = Join-Path $temp ('preview 中文 ' + $language + '.png')
            $preview = Start-Process -FilePath $exe -ArgumentList ('--preview --snapshot "{0}" --no-start --language {2} --data-directory "{1}"' -f $snapshot, $temp, $language) -WindowStyle Hidden -PassThru
            if (-not $preview.WaitForExit(30000) -or $preview.ExitCode -ne 0 -or -not [IO.File]::Exists($snapshot)) { throw ('FAIL: native WPF preview did not create its snapshot: ' + $language) }
        }
    }
    Write-Output 'PASS: GUI PE identity, native collector, Unicode paths, tray startup, single window activation, graceful save/stop and exit codes.'
} finally {
    if (($null -ne $collector -and -not $collector.HasExited) -or ($null -ne $tray -and -not $tray.HasExited)) {
        $stop = Start-Process -FilePath $exe -ArgumentList ('--stop --data-directory "{0}"' -f $temp) -WindowStyle Hidden -PassThru
        [void]$stop.WaitForExit(20000)
    }
    if (($null -eq $collector -or $collector.HasExited) -and ($null -eq $tray -or $tray.HasExited) -and [IO.Directory]::Exists($temp)) {
        $full = [IO.Path]::GetFullPath($temp)
        if ($full.StartsWith([IO.Path]::GetFullPath($artifactDirectory).TrimEnd('\') + '\', [StringComparison]::OrdinalIgnoreCase)) { Remove-Item -LiteralPath $full -Recurse -Force }
    }
}
