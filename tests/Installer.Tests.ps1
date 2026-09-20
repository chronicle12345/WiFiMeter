#requires -Version 5.1
[CmdletBinding()]
param([switch]$KeepArtifacts)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$workspace = [IO.Path]::GetFullPath((Split-Path $PSScriptRoot -Parent))
$setupPath = Join-Path $workspace 'dist\WiFiMeter-Setup.exe'
Import-Module (Join-Path $workspace 'src\Control.psm1') -Force
$artifactDirectory = Join-Path $workspace 'artifacts'
$resultDirectory = Join-Path $artifactDirectory 'test-results'
$runId = [DateTime]::UtcNow.ToString('yyyyMMdd-HHmmss') + '-' + [guid]::NewGuid().ToString('N').Substring(0, 8)
$testRoot = [IO.Path]::GetFullPath((Join-Path $artifactDirectory ('installer 中文 空格 ' + $runId)))
$installDirectory = Join-Path $testRoot 'Programs\WiFiMeter'
$dataDirectory = Join-Path $testRoot 'Data'
$appPath = Join-Path $installDirectory 'WiFiMeter.exe'
$uninstallPath = Join-Path $installDirectory 'Uninstall.exe'
$script:assertionCount = 0
$script:activeCollector = $null
$passed = $false
$script:logPath = Join-Path $resultDirectory ('installer-' + $runId + '.log')
[void][IO.Directory]::CreateDirectory($resultDirectory)
[IO.File]::WriteAllText($script:logPath, '', (New-Object Text.UTF8Encoding($true)))

function Write-TestLog([string]$Message) {
    $line = [DateTime]::UtcNow.ToString('o') + ' ' + $Message
    [IO.File]::AppendAllText($script:logPath, $line + [Environment]::NewLine, [Text.Encoding]::UTF8)
    Write-Host $line
}

function Assert-Test([bool]$Condition, [string]$Message) {
    if (-not $Condition) { throw ('FAIL: ' + $Message) }
    $script:assertionCount++
    Write-TestLog ('PASS: ' + $Message)
}

function Assert-SafeTestRoot {
    $fullRoot = [IO.Path]::GetFullPath($testRoot)
    $allowedPrefix = [IO.Path]::GetFullPath($artifactDirectory).TrimEnd('\') + '\'
    if (-not $fullRoot.StartsWith($allowedPrefix, [StringComparison]::OrdinalIgnoreCase)) {
        throw ('Refusing cleanup outside artifacts: ' + $fullRoot)
    }
    # A junction must never redirect fixture creation or cleanup outside the workspace.
    $candidate = $fullRoot
    while ($candidate.Length -ge $workspace.Length) {
        if (Test-Path -LiteralPath $candidate) {
            $item = Get-Item -LiteralPath $candidate -Force
            if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
                throw ('Refusing a test path containing a reparse point: ' + $candidate)
            }
        }
        $parent = [IO.Path]::GetDirectoryName($candidate)
        if ([string]::IsNullOrEmpty($parent) -or $parent -eq $candidate) { break }
        $candidate = $parent
    }
}

function Assert-GuiExecutable([string]$Path) {
    Assert-Test ([IO.File]::Exists($Path)) ('Executable exists: ' + $Path)
    $bytes = [IO.File]::ReadAllBytes($Path)
    Assert-Test ($bytes.Length -ge 64 -and $bytes[0] -eq 0x4d -and $bytes[1] -eq 0x5a) ('DOS header: ' + [IO.Path]::GetFileName($Path))
    $peOffset = [BitConverter]::ToInt32($bytes, 0x3c)
    Assert-Test ($peOffset -ge 64 -and $peOffset + 94 -le $bytes.Length) ('PE header bounds: ' + [IO.Path]::GetFileName($Path))
    Assert-Test ([BitConverter]::ToUInt32($bytes, $peOffset) -eq 0x4550) ('PE signature: ' + [IO.Path]::GetFileName($Path))
    $magic = [BitConverter]::ToUInt16($bytes, $peOffset + 24)
    Assert-Test ($magic -eq 0x10b -or $magic -eq 0x20b) ('PE optional header: ' + [IO.Path]::GetFileName($Path))
    Assert-Test ([BitConverter]::ToUInt16($bytes, $peOffset + 92) -eq 2) ('Windows GUI subsystem: ' + [IO.Path]::GetFileName($Path))
}

function Start-TestExecutable([string]$Path, [string]$Arguments) {
    $info = New-Object Diagnostics.ProcessStartInfo
    $info.FileName = $Path
    $info.Arguments = $Arguments
    $info.UseShellExecute = $false
    $info.CreateNoWindow = $true
    $info.WindowStyle = [Diagnostics.ProcessWindowStyle]::Hidden
    $info.WorkingDirectory = $testRoot
    $process = New-Object Diagnostics.Process
    $process.StartInfo = $info
    if (-not $process.Start()) { throw ('FAIL: Could not start ' + $Path) }
    Write-TestLog ('Started PID ' + $process.Id + ': ' + $Path + ' ' + $Arguments)
    return $process
}

function Invoke-TestExecutable([string]$Path, [string]$Arguments, [string]$Operation) {
    $process = Start-TestExecutable $Path $Arguments
    try {
        Assert-Test ($process.WaitForExit(90000)) ($Operation + ' completes within 90 seconds')
        $exitCode = $process.ExitCode
        Assert-Test ($exitCode -eq 0) ($Operation + ' exit code is 0; actual=' + $exitCode)
    } finally { $process.Dispose() }
}

function Get-DirectoryFingerprint([string]$Path, [bool]$CollectorRunning = $false) {
    if (-not (Test-Path -LiteralPath $Path)) { return '<absent>' }
    $rows = @('ROOT')
    foreach ($item in @(Get-ChildItem -LiteralPath $Path -Recurse -Force | Sort-Object FullName)) {
        # A user's existing collector continues to write during this isolated installer test.
        # Compare stable settings and unrelated files, and verify that process separately.
        if ($CollectorRunning -and -not $item.PSIsContainer -and
            ($item.Name -in @('state.json', 'state.json.bak', 'status.json', 'usage.csv', 'daily.csv', 'collector.lock', 'stop.request', 'app-usage.json', 'app-usage-profiles.json') -or
             $item.Name -like '*.tmp' -or $item.Name -match '^(collector|ui|host)\.log(\.1)?$')) { continue }
        $relative = $item.FullName.Substring($Path.TrimEnd('\').Length)
        if ($item.PSIsContainer) { $rows += ('D|' + $relative) }
        else { $rows += ('F|' + $relative + '|' + $item.Length + '|' + (Get-FileHash -LiteralPath $item.FullName -Algorithm SHA256).Hash) }
    }
    return ($rows -join "`n")
}

function Assert-DefaultDataUnchanged([string]$Phase) {
    foreach ($snapshot in $defaultSnapshots) {
        Assert-Test ((Get-DirectoryFingerprint $snapshot.Path $snapshot.CollectorRunning) -ceq $snapshot.Fingerprint) ($Phase + ' leaves default settings and unrelated files unchanged: ' + $snapshot.Path)
        if ($snapshot.CollectorRunning) {
            $current = Get-MeterStatus -DataDirectory $snapshot.Path
            Assert-Test ($current.Running -and $current.ProcessId -eq $snapshot.ProcessId -and $current.LaunchId -ceq $snapshot.LaunchId) ($Phase + ' leaves the existing user collector running')
        }
    }
}

function Assert-Shortcut([string]$Path) {
    Assert-Test ([IO.File]::Exists($Path)) ('Shortcut exists: ' + $Path)
    $shell = New-Object -ComObject WScript.Shell
    $shortcut = $null
    try {
        $shortcut = $shell.CreateShortcut($Path)
        $target = [IO.Path]::GetFullPath($shortcut.TargetPath)
        Assert-Test ($target.Equals($appPath, [StringComparison]::OrdinalIgnoreCase)) ('Shortcut targets installed WiFiMeter.exe: ' + $Path)
    } finally {
        if ($null -ne $shortcut) { [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($shortcut) }
        [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($shell)
    }
}

function New-UnrelatedShortcut([string]$Path) {
    $shell = New-Object -ComObject WScript.Shell
    $shortcut = $null
    try {
        $shortcut = $shell.CreateShortcut($Path)
        $shortcut.TargetPath = Join-Path $env:SystemRoot 'System32\notepad.exe'
        $shortcut.Description = 'Installer test: unrelated shortcut must survive'
        $shortcut.Save()
    } finally {
        if ($null -ne $shortcut) { [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($shortcut) }
        [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($shell)
    }
}

function Start-TestCollector {
    Import-Module (Join-Path $installDirectory 'src\Control.psm1') -Force
    # Installer lifecycle must not depend on a desktop. Tray and window behaviour is
    # covered by Host.Tests.ps1, which runs on a signed-in machine.
    Write-TestLog 'Step: start the test collector'
    $worker = Start-TestExecutable $appPath ('--background --data-directory "' + $dataDirectory + '"')
    $script:activeCollector = [pscustomobject]@{ Worker = $worker }
    $deadline = [DateTime]::UtcNow.AddSeconds(20)
    do {
        Start-Sleep -Milliseconds 100
        if ($worker.HasExited) { throw ('FAIL: Background collector exited during startup with code ' + $worker.ExitCode) }
        $status = Get-MeterStatus -DataDirectory $dataDirectory
    } while (-not $status.Running -and [DateTime]::UtcNow -lt $deadline)
    if (-not $status.Running) {
        # A hosted agent must explain this failure from the uploaded log alone.
        Write-TestLog ('Diagnostic: collector alive=' + (-not $worker.HasExited) + '; message=' + $status.Message + '; error=' + $status.Error)
        $collectorLog = Join-Path $dataDirectory 'collector.log'
        if ([IO.File]::Exists($collectorLog)) { Write-TestLog ('Diagnostic: collector.log tail: ' + ((Get-Content -LiteralPath $collectorLog -Tail 5) -join ' | ')) }
        else { Write-TestLog 'Diagnostic: collector.log was never created' }
    }
    Assert-Test ([bool]$status.Running) 'Background startup starts the test collector'
    Assert-Test ([int]$status.ProcessId -eq $worker.Id) 'Background collector is hosted by the installed executable'
    # Open the process handle before upgrade/uninstall so its exit code remains available.
    [void]$worker.Handle
    Write-TestLog ('Collector PID ' + $worker.Id + ', data=' + $dataDirectory)
}

function Assert-TestCollectorStopped([string]$Operation) {
    $collector = $script:activeCollector
    Assert-Test ($null -ne $collector) ($Operation + ' was exercised with a running collector')
    Assert-Test ($collector.Worker.WaitForExit(20000)) ($Operation + ' waits for the original collector to exit')
    Assert-Test ($collector.Worker.ExitCode -eq 0) ($Operation + ' stops the collector with exit code 0')
    Assert-Test (-not (Get-MeterStatus -DataDirectory $dataDirectory).Running) ($Operation + ' records a stopped collector')
    $collector.Worker.Dispose()
    $script:activeCollector = $null
}

try {
    Write-TestLog ('Installer test root: ' + $testRoot)
    Assert-Test ([IO.File]::Exists($setupPath)) 'dist\WiFiMeter-Setup.exe exists; run tools\Build.ps1 first'
    Assert-SafeTestRoot
    Assert-Test (-not (Test-Path -LiteralPath $testRoot)) 'Test root is new and includes Unicode characters and spaces'
    [void][IO.Directory]::CreateDirectory($testRoot)
    Assert-GuiExecutable $setupPath
    $sha = [Security.Cryptography.SHA256]::Create()
    try {
        $identity = ([BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($testRoot.ToUpperInvariant())))).Replace('-', '').Substring(0, 20)
    } finally { $sha.Dispose() }
    $registryPath = 'HKCU:\Software\WiFiMeter\InstallerTests\' + $identity
    Assert-Test (-not (Test-Path -LiteralPath $registryPath)) 'Isolated installer registry key is initially absent'
    $defaultSnapshots = @(
        foreach ($path in @((Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'WiFiMeter\data'), (Join-Path $workspace 'data'))) {
            $existing = Get-MeterStatus -DataDirectory $path
            [pscustomobject]@{ Path = $path; CollectorRunning = [bool]$existing.Running; ProcessId = $existing.ProcessId; LaunchId = $existing.LaunchId; Fingerprint = Get-DirectoryFingerprint $path ([bool]$existing.Running) }
        }
    )
    $installArguments = '--test-root "' + $testRoot + '" --silent'
    $conflictShortcut = Join-Path $testRoot 'Shortcuts\Desktop\WiFiMeter.lnk'
    [void][IO.Directory]::CreateDirectory((Split-Path $conflictShortcut -Parent))
    Write-TestLog 'Step: prepare a conflicting shortcut'
    New-UnrelatedShortcut $conflictShortcut
    $conflictHash = (Get-FileHash -LiteralPath $conflictShortcut -Algorithm SHA256).Hash
    Write-TestLog 'Step: install over a conflicting shortcut'
    $conflictingInstall = Start-TestExecutable $setupPath $installArguments
    try {
        Assert-Test ($conflictingInstall.WaitForExit(30000)) 'Conflicting shortcut check completes promptly'
        Assert-Test ($conflictingInstall.ExitCode -ne 0) 'Installation rejects a same-name shortcut owned by another application'
    } finally { $conflictingInstall.Dispose() }
    Assert-Test ((Get-FileHash -LiteralPath $conflictShortcut -Algorithm SHA256).Hash -eq $conflictHash) 'Rejected installation preserves the conflicting shortcut'
    Assert-Test (-not [IO.File]::Exists($appPath)) 'Shortcut conflict is detected before writing application files'
    Assert-Test (-not (Test-Path -LiteralPath $registryPath)) 'Rejected installation does not create uninstall registration'
    Write-TestLog 'Step: remove the conflicting shortcut'
    Remove-Item -LiteralPath $conflictShortcut -Force
    Write-TestLog 'Step: install into a clean test root'
    Invoke-TestExecutable $setupPath $installArguments 'Installation'
    Assert-GuiExecutable $appPath
    Assert-GuiExecutable $uninstallPath
    foreach ($file in @('src\Control.psm1', 'src\Collector.ps1', 'src\Core.psm1', 'src\Sampler.psm1', 'src\Strings.psm1', 'src\Dialogs.ps1', 'src\Preferences.psm1', 'src\QuotaRuntime.psm1', 'src\NetworkControl.cs', 'src\AppUsage.psm1', 'docs\USAGE.md', 'docs\USAGE.zh-CN.md')) {
        Assert-Test ([IO.File]::Exists((Join-Path $installDirectory $file))) ('Installed runtime file: ' + $file)
    }
    $ownedFiles = @(Get-ChildItem -LiteralPath $installDirectory -Recurse -Force -File | ForEach-Object { $_.FullName })
    $ownedShortcuts = @((Join-Path $testRoot 'Shortcuts\Desktop\WiFiMeter.lnk'), (Join-Path $testRoot 'Shortcuts\StartMenu\WiFiMeter.lnk'))
    foreach ($shortcutPath in $ownedShortcuts) { Assert-Shortcut $shortcutPath }
    Assert-Test (Test-Path -LiteralPath $registryPath) 'Installation creates its isolated uninstall registration'
    Assert-Test (-not (Test-Path -LiteralPath ($registryPath + '\Run'))) 'A fresh installation does not enable startup'
    $registration = Get-ItemProperty -LiteralPath $registryPath
    Assert-Test ([string]$registration.DisplayName -match 'WiFiMeter') 'Uninstall registry DisplayName identifies WiFiMeter'
    $uninstallCommand = [string]$registration.UninstallString
    Assert-Test ($uninstallCommand.StartsWith(('"' + $uninstallPath + '"'), [StringComparison]::OrdinalIgnoreCase)) 'UninstallString quotes the installed native uninstaller path'
    Assert-Test ($uninstallCommand.Contains('--uninstall') -and $uninstallCommand.Contains('--test-root') -and $uninstallCommand.Contains($testRoot)) 'UninstallString retains uninstall action and isolated test root'
    Assert-DefaultDataUnchanged 'Installation'

    [void][IO.Directory]::CreateDirectory($dataDirectory)
    $dataSentinel = Join-Path $dataDirectory '用户数据 保留.txt'
    $unknownDirectory = Join-Path $installDirectory '用户资料'
    [void][IO.Directory]::CreateDirectory($unknownDirectory)
    $unknownFile = Join-Path $unknownDirectory 'keep custom file.txt'
    $sentinelText = 'Preserve exact user content: 中文 ' + $runId
    [IO.File]::WriteAllText($dataSentinel, $sentinelText, [Text.Encoding]::UTF8)
    [IO.File]::WriteAllText($unknownFile, $sentinelText, [Text.Encoding]::UTF8)
    $unrelatedShortcuts = @(
        foreach ($shortcutPath in $ownedShortcuts) {
            $otherPath = Join-Path (Split-Path $shortcutPath -Parent) 'Other Application.lnk'
            New-UnrelatedShortcut $otherPath
            [pscustomobject]@{ Path = $otherPath; Hash = (Get-FileHash -LiteralPath $otherPath -Algorithm SHA256).Hash }
        }
    )
    $fixtureRun = $registryPath + '\Run'
    $fixtureApproval = $registryPath + '\StartupApproved'
    $null = New-Item -Path $fixtureRun -Force
    $null = New-Item -Path $fixtureApproval -Force
    $null = New-ItemProperty -LiteralPath $fixtureRun -Name WiFiMeter -Value ('"' + $appPath + '" --background') -PropertyType String
    $null = New-ItemProperty -LiteralPath $fixtureApproval -Name WiFiMeter -Value ([byte[]]@(3, 0, 0, 0)) -PropertyType Binary
    Start-TestCollector
    Write-TestLog 'Step: upgrade with the collector running'
    Invoke-TestExecutable $setupPath $installArguments 'Upgrade'
    Assert-TestCollectorStopped 'Upgrade'
    Assert-Test ((Get-ItemPropertyValue -LiteralPath $fixtureRun -Name WiFiMeter) -ceq ('"' + $appPath + '" --tray')) 'Upgrade migrates an existing owned startup command to tray mode'
    Assert-Test ((Get-ItemPropertyValue -LiteralPath $fixtureApproval -Name WiFiMeter)[0] -eq 3) 'Upgrade preserves the Windows startup disable state'
    Assert-Test ([IO.File]::ReadAllText($dataSentinel) -ceq $sentinelText) 'Upgrade preserves user data exactly'
    Assert-Test ([IO.File]::ReadAllText($unknownFile) -ceq $sentinelText) 'Upgrade preserves unknown files in the installation directory'
    foreach ($file in $ownedFiles) { Assert-Test ([IO.File]::Exists($file)) ('Upgrade retains installed file: ' + $file.Substring($installDirectory.Length + 1)) }
    foreach ($shortcutPath in $ownedShortcuts) { Assert-Shortcut $shortcutPath }
    Assert-Test (Test-Path -LiteralPath $registryPath) 'Upgrade retains uninstall registration'
    Assert-DefaultDataUnchanged 'Upgrade'
    # These stand-ins live under the isolated uninstall key, unlike the real Windows keys.
    Remove-Item -LiteralPath $fixtureRun -Force
    Remove-Item -LiteralPath $fixtureApproval -Force

    Start-TestCollector
    Write-TestLog 'Step: uninstall with the collector running'
    Invoke-TestExecutable $uninstallPath ('--uninstall --test-root "' + $testRoot + '" --silent') 'Uninstallation'
    Assert-TestCollectorStopped 'Uninstallation'
    # The copied uninstaller helper may finish deleting the original after its parent exits.
    $deadline = [DateTime]::UtcNow.AddSeconds(10)
    do {
        $remainingFiles = @($ownedFiles | Where-Object { [IO.File]::Exists($_) })
        if ($remainingFiles.Count -eq 0) { break }
        Start-Sleep -Milliseconds 100
    } while ([DateTime]::UtcNow -lt $deadline)
    Assert-Test ($remainingFiles.Count -eq 0) ('Uninstallation removes every installed file within 10 seconds; remaining=' + ($remainingFiles -join ', '))
    Assert-Test (-not (Test-Path -LiteralPath $registryPath)) 'Uninstallation removes its isolated registry key'
    foreach ($shortcutPath in $ownedShortcuts) { Assert-Test (-not [IO.File]::Exists($shortcutPath)) ('Uninstallation removes owned shortcut: ' + $shortcutPath) }
    foreach ($shortcut in $unrelatedShortcuts) {
        Assert-Test ([IO.File]::Exists($shortcut.Path)) ('Uninstallation preserves unrelated shortcut: ' + $shortcut.Path)
        Assert-Test ((Get-FileHash -LiteralPath $shortcut.Path -Algorithm SHA256).Hash -eq $shortcut.Hash) 'Unrelated shortcut bytes remain unchanged'
    }
    Assert-Test ([IO.File]::ReadAllText($dataSentinel) -ceq $sentinelText) 'Uninstallation preserves user data exactly'
    Assert-Test ([IO.File]::ReadAllText($unknownFile) -ceq $sentinelText) 'Uninstallation preserves unknown installation files exactly'
    Assert-Test ([IO.File]::Exists((Join-Path $dataDirectory 'state.json'))) 'Uninstallation preserves collected usage state'
    Assert-DefaultDataUnchanged 'Uninstallation'
    $passed = $true
    Write-TestLog ('PASS: ' + $script:assertionCount + ' assertions; native installation, upgrade, graceful background collector shutdown, and uninstallation.')
} catch {
    Write-TestLog $_.Exception.Message
    # The uploaded log must locate the failing statement without a local re-run.
    if ($null -ne $_.InvocationInfo -and -not [string]::IsNullOrWhiteSpace($_.InvocationInfo.PositionMessage)) {
        Write-TestLog ('At: ' + (($_.InvocationInfo.PositionMessage -replace '\s*\r?\n\s*', ' | ').Trim()))
    }
    if (-not [string]::IsNullOrWhiteSpace($_.ScriptStackTrace)) {
        Write-TestLog ('Stack: ' + (($_.ScriptStackTrace -replace '\s*\r?\n\s*', ' | ').Trim()))
    }
    throw
} finally {
    if ($null -ne $script:activeCollector) {
        try {
            $null = Stop-MeterCollector -DataDirectory $dataDirectory
            Write-TestLog 'Cleanup requested a graceful stop for the test collector.'
        } catch { Write-TestLog ('Cleanup could not stop test collector: ' + $_.Exception.Message) }
        if ($null -ne $script:activeCollector.Worker) { $script:activeCollector.Worker.Dispose() }
    }
    if ($passed -and -not $KeepArtifacts -and (Test-Path -LiteralPath $testRoot)) {
        Assert-SafeTestRoot
        $reparsePoints = @(Get-ChildItem -LiteralPath $testRoot -Recurse -Force | Where-Object { ($_.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 })
        if ($reparsePoints.Count -gt 0) { throw 'Refusing cleanup because the test root contains a reparse point.' }
        Remove-Item -LiteralPath $testRoot -Recurse -Force
        Write-TestLog ('Removed verified test fixture directory: ' + $testRoot)
    } elseif (Test-Path -LiteralPath $testRoot) {
        Write-TestLog ('Preserved test artifacts: ' + $testRoot)
    }
    Write-TestLog ('Result log: ' + $script:logPath)
}
