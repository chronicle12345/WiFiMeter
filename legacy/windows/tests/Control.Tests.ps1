#requires -Version 5.1
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
Import-Module (Join-Path $root 'src\Control.psm1') -Force
$artifactDirectory = Join-Path $root 'artifacts'
$temp = Join-Path $artifactDirectory ('control-' + [guid]::NewGuid().ToString('N'))
$registryRoot = 'Software\WiFiMeter\ControlTests\' + [guid]::NewGuid().ToString('N')
$registryOptions = @{ RunSubKey = $registryRoot + '\Run'; ApprovalSubKey = $registryRoot + '\Approved' }
try {
    $dir = Initialize-MeterDataDirectory $temp
    Write-MeterJson -Path (Join-Path $dir 'status.json') -Value @{ Running = $true; ProcessId = 2147483646; ProcessStartTicks = 0; Message = 'stale' }
    if ((Get-MeterStatus $dir).Running) { throw 'FAIL: stale process status considered running.' }
    $collectorLock = [IO.File]::Open((Join-Path $dir 'collector.lock'), 'OpenOrCreate', 'ReadWrite', 'None')
    try {
        [IO.File]::WriteAllText((Join-Path $dir 'status.json'), '{invalid')
        $stopRefused = $false
        try { $null = Stop-MeterCollector $dir } catch { $stopRefused = $true }
        if (-not $stopRefused) { throw 'FAIL: unreadable status with an active collector lock was reported as stopped.' }
    } finally { $collectorLock.Dispose() }
    Write-MeterJson -Path (Join-Path $dir 'roundtrip.json') -Value @{ Message = '中文路径与空格'; Count = 12 }
    $actual = Get-Content (Join-Path $dir 'roundtrip.json') -Raw -Encoding UTF8 | ConvertFrom-Json
    if ($actual.Count -ne 12 -or $actual.Message -cne '中文路径与空格') { throw 'FAIL: JSON did not round trip.' }
    Write-MeterJson -Path (Join-Path $dir 'roundtrip.json') -Value @{ Count = 20 }
    if ((Get-Content (Join-Path $dir 'roundtrip.json') -Raw | ConvertFrom-Json).Count -ne 20) { throw 'FAIL: replacement failed.' }
    $expectedData = Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'WiFiMeter\data'
    if ((Get-MeterDataDirectory) -ine $expectedData) { throw 'FAIL: data location is not separate from installation.' }
    $fakeExecutable = Join-Path $temp 'WiFiMeter.exe'
    [IO.File]::WriteAllBytes($fakeExecutable, [byte[]]@(77, 90))
    Set-MeterAutoStart -Enabled $true -ExecutablePath $fakeExecutable @registryOptions
    if (-not (Get-MeterAutoStart @registryOptions)) { throw 'FAIL: startup registration failed.' }
    $key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey($registryOptions.RunSubKey)
    try { $command = $key.GetValue('WiFiMeter') } finally { $key.Dispose() }
    if ($command -cne ('"' + $fakeExecutable + '" --tray')) { throw 'FAIL: startup does not target the GUI executable.' }
    $approval = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey($registryOptions.ApprovalSubKey)
    try { $approval.SetValue('WiFiMeter', [byte[]]@(3,0,0,0,0,0,0,0,0,0,0,0), [Microsoft.Win32.RegistryValueKind]::Binary) } finally { $approval.Dispose() }
    $info = Get-MeterAutoStartInfo @registryOptions
    if (-not $info.Registered -or -not $info.DisabledByWindows -or $info.Enabled) { throw 'FAIL: Windows-disabled startup not reflected.' }
    $blocked = $false
    try { Set-MeterAutoStart -Enabled $true -ExecutablePath $fakeExecutable @registryOptions } catch { $blocked = $true }
    if (-not $blocked) { throw 'FAIL: enabling should respect Windows-disabled startup.' }
    Set-MeterAutoStart -Enabled $false @registryOptions
    if ((Get-MeterAutoStartInfo @registryOptions).Registered) { throw 'FAIL: startup disable failed.' }
    $approval = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey($registryOptions.ApprovalSubKey)
    try { if ($approval.GetValue('WiFiMeter')[0] -ne 3) { throw 'FAIL: Windows approval record modified.' } } finally { $approval.Dispose() }
    Write-Output 'PASS: atomic JSON, stale PID, unreadable active status, separate user data, GUI startup command, Windows disable detection, enable/disable isolation.'
} finally {
    [Microsoft.Win32.Registry]::CurrentUser.DeleteSubKeyTree($registryRoot, $false)
    if ((Test-Path $temp) -and ([IO.Path]::GetFullPath($temp).StartsWith([IO.Path]::GetFullPath($artifactDirectory).TrimEnd('\') + '\', [StringComparison]::OrdinalIgnoreCase))) {
        Remove-Item -LiteralPath $temp -Recurse -Force
    }
}
