#requires -Version 5.1
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$root = Split-Path $PSScriptRoot -Parent
$module = Join-Path $root 'src\Preferences.psm1'
if (Test-Path -LiteralPath $module) { Import-Module $module -Force }
Import-Module (Join-Path $root 'src\Core.psm1') -Force
$script:passed = 0
$script:failed = 0
$artifactDirectory = Join-Path $root 'artifacts'
$testRoot = Join-Path $artifactDirectory ('preferences-' + [guid]::NewGuid().ToString('N'))
[void][IO.Directory]::CreateDirectory($testRoot)

function Assert-Equal($Actual, $Expected) {
    if ($Actual -cne $Expected) { throw "Expected [$Expected], received [$Actual]." }
}
function Assert-True($Value, [string]$Message = 'Assertion failed.') {
    if (-not $Value) { throw $Message }
}
function Assert-Throws([scriptblock]$Action) {
    $caught = $false
    try { & $Action } catch { $caught = $true }
    if (-not $caught) { throw 'Expected an exception.' }
}
function Test-Case([string]$Name, [scriptblock]$Action) {
    try { & $Action; $script:passed++; Write-Host "PASS $Name" }
    catch { $script:failed++; Write-Host "FAIL $Name : $($_.Exception.Message)" }
}
function New-TestDirectory {
    $path = Join-Path $testRoot ([guid]::NewGuid().ToString('N'))
    [void][IO.Directory]::CreateDirectory($path)
    return $path
}
function Local-Time([string]$Text) {
    return [DateTimeOffset]([datetime]::SpecifyKind([datetime]::ParseExact($Text, 'yyyy-MM-dd HH:mm:ss', [cultureinfo]::InvariantCulture), [DateTimeKind]::Local))
}
function New-Network([string]$SSID, [double]$Limit = 1, [string]$Period = 'Month', [bool]$Disconnect = $false) {
    return [pscustomobject]@{ SSID = $SSID; Alias = ''; LimitGB = $Limit; Period = $Period; WarnPercent = 80; DisconnectAtLimit = $Disconnect }
}
function New-UsageState {
    $state = New-MeterState
    $stamp = (Local-Time '2026-09-20 10:00:00').ToUniversalTime().ToString('o')
    $state.Networks = @([pscustomobject]@{
        SSID = 'Home'; RxBytes = 1600000000L; TxBytes = 400000000L; FirstSeen = $stamp; LastSeen = $stamp
        Days = @(
            [pscustomobject]@{ Date = '2026-08-31'; RxBytes = 800000000L; TxBytes = 200000000L },
            [pscustomobject]@{ Date = '2026-09-19'; RxBytes = 160000000L; TxBytes = 40000000L },
            [pscustomobject]@{ Date = '2026-09-20'; RxBytes = 640000000L; TxBytes = 160000000L }
        )
    })
    return $state
}

try {
    Test-Case 'missing settings return opt-in defaults without creating a file' {
        $directory = Join-Path $testRoot 'not-created'
        $preferences = Read-MeterPreferences -DataDirectory $directory
        Assert-Equal $preferences.Language 'en'
        Assert-Equal $preferences.RetentionDays 0
        Assert-Equal @($preferences.Networks).Count 0
        Assert-True (-not [IO.Directory]::Exists($directory))
        $network = Get-MeterNetworkPreference -Preferences $preferences -SSID 'Home'
        Assert-Equal $network.LimitGB 0
        Assert-Equal $network.DisconnectAtLimit $false
    }
    Test-Case 'existing language-only settings migrate and retain language' {
        $directory = New-TestDirectory
        [IO.File]::WriteAllText((Join-Path $directory 'settings.json'), '{"Language":"zh-CN"}')
        $null = Set-MeterNetworkPreference -DataDirectory $directory -Network (New-Network 'Home')
        $actual = Read-MeterPreferences -DataDirectory $directory
        Assert-Equal $actual.Language 'zh-CN'
        Assert-Equal $actual.RetentionDays 0
        Assert-Equal @($actual.Networks).Count 1
    }
    Test-Case 'a short-lived file lock does not lose a preferences update' {
        $directory = New-TestDirectory
        $path = Join-Path $directory 'settings.json'
        [IO.File]::WriteAllText($path, '{"Language":"en"}')
        $ready = [Threading.ManualResetEventSlim]::new($false)
        $worker = [PowerShell]::Create()
        try {
            [void]$worker.AddScript('param($path, $ready) $stream = [IO.File]::Open($path, "Open", "Read", "Read"); try { $ready.Set(); Start-Sleep -Milliseconds 120 } finally { $stream.Dispose() }').AddArgument($path).AddArgument($ready)
            $pending = $worker.BeginInvoke()
            if (-not $ready.Wait(5000)) { throw 'The test reader did not acquire its lock.' }
            $null = Set-MeterRetention -DataDirectory $directory -Days 30
            $null = $worker.EndInvoke($pending)
            Assert-Equal (Read-MeterPreferences $directory).RetentionDays 30
            Assert-Equal (Read-MeterPreferences $directory).Language 'en'
        } finally { $worker.Stop(); $worker.Dispose(); $ready.Dispose() }
    }
    Test-Case 'SSID identity remains case-sensitive and preserves aliases' {
        $directory = New-TestDirectory
        $upper = New-Network 'Home'; $upper.Alias = 'Living room'
        $lower = New-Network 'home'; $lower.Alias = 'Portable hotspot'
        $null = Set-MeterNetworkPreference -DataDirectory $directory -Network $upper
        $null = Set-MeterNetworkPreference -DataDirectory $directory -Network $lower
        $preferences = Read-MeterPreferences -DataDirectory $directory
        Assert-Equal @($preferences.Networks).Count 2
        Assert-Equal (Get-MeterNetworkPreference $preferences 'Home').Alias 'Living room'
        Assert-Equal (Get-MeterNetworkPreference $preferences 'home').Alias 'Portable hotspot'
    }
    Test-Case 'language and retention updates preserve all network settings and custom fields' {
        $directory = New-TestDirectory
        $null = Save-MeterPreferences -DataDirectory $directory -Preferences ([pscustomobject]@{ Language = 'en'; CustomField = 'retained'; Networks = @((New-Network 'Home' 15 'Day' $true)) })
        $null = Set-MeterRetention -DataDirectory $directory -Days 30
        $null = Set-MeterLanguagePreference -DataDirectory $directory -Language 'zh-CN'
        $actual = Read-MeterPreferences -DataDirectory $directory
        Assert-Equal $actual.Language 'zh-CN'
        Assert-Equal $actual.RetentionDays 30
        Assert-Equal $actual.CustomField 'retained'
        Assert-Equal $actual.Networks[0].LimitGB 15
        Assert-Equal $actual.Networks[0].DisconnectAtLimit $true
    }
    Test-Case 'malformed settings cannot be silently replaced by any setter' {
        $directory = New-TestDirectory
        $path = Join-Path $directory 'settings.json'
        [IO.File]::WriteAllText($path, '{broken')
        Assert-Throws { Read-MeterPreferences -DataDirectory $directory }
        Assert-Throws { Save-MeterPreferences -DataDirectory $directory -Preferences ([pscustomobject]@{ Language = 'en' }) }
        Assert-Throws { Set-MeterRetention -DataDirectory $directory -Days 30 }
        Assert-Throws { Set-MeterLanguagePreference -DataDirectory $directory -Language 'zh-CN' }
        Assert-Throws { Set-MeterNetworkPreference -DataDirectory $directory -Network (New-Network 'Home') }
        Assert-Equal ([IO.File]::ReadAllText($path)) '{broken'
    }
    Test-Case 'invalid types and unsafe ranges are rejected before disk changes' {
        $directory = New-TestDirectory
        $null = Set-MeterRetention -DataDirectory $directory -Days 30
        $path = Join-Path $directory 'settings.json'; $before = [IO.File]::ReadAllText($path)
        foreach ($invalid in @(
            [pscustomobject]@{ Language = 'xx' },
            [pscustomobject]@{ RetentionDays = -1 },
            [pscustomobject]@{ RetentionDays = 1.5 },
            [pscustomobject]@{ RetentionDays = '30' },
            [pscustomobject]@{ Networks = 'invalid' },
            [pscustomobject]@{ Networks = @((New-Network 'Home'), (New-Network 'Home')) }
        )) { Assert-Throws { Save-MeterPreferences -DataDirectory $directory -Preferences $invalid } }
        foreach ($property in @('LimitGB', 'WarnPercent', 'DisconnectAtLimit', 'Period', 'Alias')) {
            $network = New-Network 'Home'
            switch ($property) {
                'LimitGB' { $network.LimitGB = [double]::NaN }
                'WarnPercent' { $network.WarnPercent = 101 }
                'DisconnectAtLimit' { $network.DisconnectAtLimit = 'false' }
                'Period' { $network.Period = 'Week' }
                'Alias' { $network.Alias = 'a' * 81 }
            }
            Assert-Throws { Set-MeterNetworkPreference -DataDirectory $directory -Network $network }
        }
        Assert-Equal ([IO.File]::ReadAllText($path)) $before
    }
    Test-Case 'an atomic update works while another reader holds its snapshot' {
        $directory = New-TestDirectory
        $null = Set-MeterRetention -DataDirectory $directory -Days 30
        $stream = [IO.File]::Open((Join-Path $directory 'settings.json'), 'Open', 'Read', ([IO.FileShare]::ReadWrite -bor [IO.FileShare]::Delete))
        try { $null = Set-MeterRetention -DataDirectory $directory -Days 60 }
        finally { $stream.Dispose() }
        Assert-Equal (Read-MeterPreferences $directory).RetentionDays 60
        Assert-Equal @(Get-ChildItem -LiteralPath $directory -Filter '*.tmp').Count 0
    }
    Test-Case 'parallel updates retain every network and merge independent fields' {
        $directory = New-TestDirectory
        $workers = @()
        try {
            foreach ($index in 0..7) {
                $worker = [System.Management.Automation.PowerShell]::Create()
                $null = $worker.AddScript({
                    param($Module, $Directory, $Index)
                    Import-Module $Module -Force -ErrorAction Stop
                    $null = Set-MeterNetworkPreference -DataDirectory $Directory -Network ([pscustomobject]@{ SSID = 'Network-' + $Index; Alias = 'Alias-' + $Index })
                    if ($Index -eq 0) { $null = Set-MeterLanguagePreference -DataDirectory $Directory -Language 'zh-CN' }
                    if ($Index -eq 1) { $null = Set-MeterRetention -DataDirectory $Directory -Days 30 }
                }.ToString()).AddArgument($module).AddArgument($directory).AddArgument($index)
                $workers += [pscustomobject]@{ Shell = $worker; Pending = $worker.BeginInvoke() }
            }
            foreach ($worker in $workers) {
                $null = $worker.Shell.EndInvoke($worker.Pending)
                Assert-True (-not $worker.Shell.HadErrors) (($worker.Shell.Streams.Error | Out-String).Trim())
            }
        } finally { foreach ($worker in $workers) { $worker.Shell.Dispose() } }
        $actual = Read-MeterPreferences -DataDirectory $directory
        Assert-Equal @($actual.Networks).Count 8
        Assert-Equal $actual.Language 'zh-CN'
        Assert-Equal $actual.RetentionDays 30
        foreach ($index in 0..7) { Assert-Equal (Get-MeterNetworkPreference $actual ('Network-' + $index)).Alias ('Alias-' + $index) }
    }
    Test-Case 'sub-byte limits are rejected without turning an enabled quota into zero' {
        $directory = New-TestDirectory
        foreach ($limit in @(0.0000000001, 1e-50)) {
            Assert-Throws { Set-MeterNetworkPreference -DataDirectory $directory -Network (New-Network 'Home' $limit) }
        }
        $saved = Set-MeterNetworkPreference -DataDirectory $directory -Network (New-Network 'Home' 0.000000001)
        Assert-Equal $saved.Networks[0].LimitGB ([decimal]0.000000001)
    }
    Test-Case 'invalid quota and alias values do not replace saved preferences' {
        $directory = New-TestDirectory
        $null = Set-MeterNetworkPreference -DataDirectory $directory -Network (New-Network 'Home')
        $path = Join-Path $directory 'settings.json'
        $before = [IO.File]::ReadAllText($path)
        foreach ($limit in @(-1, [double]::NegativeInfinity, [double]::PositiveInfinity, 9000000001, '10', $true)) {
            $network = New-Network 'Home'
            $network.LimitGB = $limit
            Assert-Throws { Set-MeterNetworkPreference -DataDirectory $directory -Network $network }
        }
        foreach ($threshold in @(0, [double]::NaN, [double]::PositiveInfinity, '80', $true)) {
            $network = New-Network 'Home'
            $network.WarnPercent = $threshold
            Assert-Throws { Set-MeterNetworkPreference -DataDirectory $directory -Network $network }
        }
        $network = New-Network 'Home'
        $network.Alias = "A`nB"
        Assert-Throws { Set-MeterNetworkPreference -DataDirectory $directory -Network $network }
        Assert-Equal ([IO.File]::ReadAllText($path)) $before
    }
    Test-Case 'quota warnings include the threshold and skip traffic below it' {
        $preferences = [pscustomobject]@{ Networks = @((New-Network 'Home' 1 'Day')) }
        $time = Local-Time '2026-09-20 10:00:00'
        $action = @(Get-MeterQuotaActions -State (New-UsageState) -Preferences $preferences -Timestamp $time)
        Assert-Equal $action.Count 1
        Assert-Equal $action[0].Percent 80
        Assert-Equal $action[0].Warning $true
        Assert-Equal $action[0].Disconnect $false
        Assert-Equal $action[0].PeriodKey 'Day:2026-09-20'
        $preferences.Networks[0].WarnPercent = 81
        Assert-Equal @(Get-MeterQuotaActions -State (New-UsageState) -Preferences $preferences -Timestamp $time).Count 0
    }
    Test-Case 'quota limit combines download and upload and only disconnects when enabled' {
        $preferences = [pscustomobject]@{ Networks = @((New-Network 'Home' 1 'Month' $true)) }
        $time = Local-Time '2026-09-20 10:00:00'
        $action = @(Get-MeterQuotaActions -State (New-UsageState) -Preferences $preferences -Timestamp $time)
        Assert-Equal $action[0].UsedBytes 1000000000
        Assert-Equal $action[0].LimitBytes 1000000000
        Assert-Equal $action[0].Percent 100
        Assert-Equal $action[0].Disconnect $true
        Assert-Equal $action[0].PeriodKey 'Month:2026-09'
        $preferences.Networks[0].DisconnectAtLimit = $false
        Assert-Equal @(Get-MeterQuotaActions -State (New-UsageState) -Preferences $preferences -Timestamp $time)[0].Disconnect $false
    }
    Test-Case 'new month resets quota scope while All includes every recorded day' {
        $preferences = [pscustomobject]@{ Networks = @((New-Network 'Home' 1 'Month')) }
        Assert-Equal @(Get-MeterQuotaActions -State (New-UsageState) -Preferences $preferences -Timestamp (Local-Time '2026-10-01 00:00:00')).Count 0
        $preferences.Networks[0].Period = 'All'
        $action = @(Get-MeterQuotaActions -State (New-UsageState) -Preferences $preferences -Timestamp (Local-Time '2026-10-01 00:00:00'))
        Assert-Equal $action[0].UsedBytes 2000000000
        Assert-Equal $action[0].PeriodKey 'All'
    }
    Test-Case 'disabled and differently cased network quotas never trigger' {
        $preferences = [pscustomobject]@{ Networks = @((New-Network 'Home' 0 'All' $true), (New-Network 'home' 1 'All' $true)) }
        Assert-Equal @(Get-MeterQuotaActions -State (New-UsageState) -Preferences $preferences).Count 0
    }
    Test-Case 'large counters are combined without overflowing a signed 64-bit value' {
        $state = New-UsageState
        $state.Networks[0].RxBytes = [long]::MaxValue
        $state.Networks[0].TxBytes = [long]::MaxValue
        $preferences = [pscustomobject]@{ Networks = @((New-Network 'Home' 9000000000 'All' $true)) }
        $actions = @(Get-MeterQuotaActions -State $state -Preferences $preferences)
        Assert-Equal $actions.Count 1
        Assert-Equal $actions[0].UsedBytes ([decimal][long]::MaxValue * 2)
        Assert-Equal $actions[0].LimitBytes ([decimal]9000000000000000000)
        Assert-Equal $actions[0].Disconnect $true
    }
    Test-Case 'retention includes today and preserves the exact cutoff date' {
        $state = New-UsageState
        $removed = Remove-MeterExpiredRecords -State $state -RetentionDays 2 -Timestamp (Local-Time '2026-09-20 10:00:00')
        Assert-Equal $removed 1
        Assert-Equal @($state.Networks[0].Days).Count 2
        Assert-Equal $state.Networks[0].Days[0].Date '2026-09-19'
        Assert-Equal $state.Networks[0].RxBytes 800000000L
        Assert-Equal $state.Networks[0].TxBytes 200000000L
        $directory = New-TestDirectory
        Save-MeterState -State $state -DataDirectory $directory
        Assert-Equal (Read-MeterState $directory).Networks[0].RxBytes 800000000L
    }
    Test-Case 'retention one keeps today, forever leaves history untouched, and empty networks remain valid' {
        $state = New-UsageState
        Assert-Equal (Remove-MeterExpiredRecords -State $state -RetentionDays 0 -Timestamp (Local-Time '2026-10-01 10:00:00')) 0
        Assert-Equal @($state.Networks[0].Days).Count 3
        Assert-Equal (Remove-MeterExpiredRecords -State $state -RetentionDays 1 -Timestamp (Local-Time '2026-09-20 10:00:00')) 2
        Assert-Equal @($state.Networks[0].Days).Count 1
        Assert-Equal (Remove-MeterExpiredRecords -State $state -RetentionDays 1 -Timestamp (Local-Time '2026-10-01 10:00:00')) 1
        Assert-Equal @($state.Networks[0].Days).Count 0
        Assert-Equal $state.Networks[0].RxBytes 0L
        Assert-Equal $state.Networks[0].TxBytes 0L
        Save-MeterState -State $state -DataDirectory (New-TestDirectory)
    }
} finally {
    $resolved = [IO.Path]::GetFullPath($testRoot)
    $expectedParent = [IO.Path]::GetFullPath($artifactDirectory).TrimEnd('\') + '\'
    if (-not $resolved.StartsWith($expectedParent, [StringComparison]::OrdinalIgnoreCase)) { throw 'Unsafe test cleanup path.' }
    if (Test-Path -LiteralPath $resolved) { Remove-Item -LiteralPath $resolved -Recurse -Force }
}
Write-Host "Preferences tests: $script:passed passed, $script:failed failed."
if ($script:failed -gt 0) { exit 1 }
