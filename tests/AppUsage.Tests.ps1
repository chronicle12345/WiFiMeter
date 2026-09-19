#requires -Version 5.1
[CmdletBinding()]
param([switch]$Live)

Set-StrictMode -Version 2
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
$modulePath = Join-Path $root 'src\AppUsage.psm1'
$artifactDirectory = Join-Path $root 'artifacts'
$temporary = Join-Path $artifactDirectory ('app-usage-' + [guid]::NewGuid().ToString('N'))
[void][IO.Directory]::CreateDirectory($temporary)
$script:count = 0

function Assert-True([bool]$Condition, [string]$Message) {
    if (-not $Condition) { throw $Message }
}

function New-TestProfile([string]$Ssid, [string]$Name = 'Profile A') {
    $details = [pscustomobject]@{ Ssid = $Ssid }
    $details | Add-Member ScriptMethod GetConnectedSsid { return $this.Ssid }
    return [pscustomobject]@{
        IsWlanConnectionProfile = $true
        ProfileName = $Name
        NetworkAdapter = [pscustomobject]@{ NetworkAdapterId = [guid]'ba624651-7bdc-42cf-ac4a-84fbaf31139c' }
        WlanConnectionProfileDetails = $details
    }
}

function Invoke-AppTest([string]$Name, [scriptblock]$Body) {
    $directory = Join-Path $temporary ([guid]::NewGuid().ToString('N'))
    [void][IO.Directory]::CreateDirectory($directory)
    $module = Import-Module $modulePath -Force -PassThru
    try {
        & $module {
            $script:TestProfiles = @()
            $script:QueryCount = 0
            $script:QueryWindows = [Collections.Generic.List[object]]::new()
            $script:QueryOperations = [Collections.Generic.List[object]]::new()
            $script:TestFailure = ''
            $script:TestNeverCompletes = $false
            function script:Get-MeterAppNow { [DateTimeOffset]'2026-09-20T12:00:00+08:00' }
            function script:Get-MeterAppConnectionProfiles { $script:TestProfiles }
            function script:Start-MeterAppQuery($Profile, [DateTimeOffset]$Start, [DateTimeOffset]$End) {
                $script:QueryCount++
                $script:QueryWindows.Add([pscustomobject]@{ Start = $Start; End = $End })
                $operation = [pscustomobject]@{ Cancelled = $false; Closed = $false }
                $operation | Add-Member ScriptMethod Cancel { $this.Cancelled = $true }
                $operation | Add-Member ScriptMethod Close { $this.Closed = $true }
                $script:QueryOperations.Add($operation)
                [pscustomobject]@{
                    Operation = $operation
                    Task = [pscustomobject]@{ IsCompleted = -not $script:TestNeverCompletes }
                }
            }
            function script:Read-MeterAppQuery($Query) {
                if ($script:TestFailure -eq 'AccessDenied') { throw [UnauthorizedAccessException]::new('Test access denied.') }
                if ($script:TestFailure -eq 'Empty') { return }
                [pscustomobject]@{ AppId = 'C:\Apps\Browser.exe'; Name = 'Browser'; RxBytes = [long]100; TxBytes = [long]25; TotalBytes = [long]125 }
                [pscustomobject]@{ AppId = 'C:\Apps\Sync.exe'; Name = 'Sync'; RxBytes = [long]20; TxBytes = [long]50; TotalBytes = [long]70 }
            }
        }
        & $Body $module $directory
        $script:count++
        Write-Output ('PASS: ' + $Name)
    }
    finally { Remove-Module $module -Force }
}

try {
    Invoke-AppTest 'Daily application totals use the exact SSID and inclusive local dates' {
        param($module, $directory)
        & $module { param($Profiles) $script:TestProfiles = $Profiles } @((New-TestProfile 'Home'), (New-TestProfile 'home' 'Profile B'))
        $result = Get-MeterAppUsage -SSID 'Home' -StartDate '2026-09-18' -EndDate '2026-09-19' -DataDirectory $directory
        Assert-True $result.Available 'A successful Windows query must be available.'
        Assert-True ($result.Rows.Count -eq 2 -and $result.Days.Count -eq 4) 'Expected two applications over two days.'
        Assert-True ($result.Rows[0].RxBytes -eq 200 -and $result.Rows[0].TotalBytes -eq 250) 'Daily rows must sum without duplicating profiles.'
        Assert-True (($result.Days | Select-Object -ExpandProperty Date -Unique) -join ',' -eq '2026-09-18,2026-09-19') 'Date selection must include both endpoint days.'
        Assert-True ((& $module { $script:QueryCount }) -eq 2) 'SSID matching must remain case sensitive.'
    }
    Invoke-AppTest 'Historical profiles use observed mappings without guessing from profile names' {
        param($module, $directory)
        & $module { param($Profiles) $script:TestProfiles = $Profiles } @((New-TestProfile 'Verified SSID' 'Renamed profile'))
        Update-MeterAppUsageProfiles -DataDirectory $directory
        & $module { param($Profiles) $script:TestProfiles = $Profiles } @((New-TestProfile '' 'Renamed profile'))
        $result = Get-MeterAppUsage -SSID 'Verified SSID' -StartDate '2026-09-19' -EndDate '2026-09-19' -DataDirectory $directory
        Assert-True $result.Available 'An observed mapping must work after the network disconnects.'
        $unknown = Get-MeterAppUsage -SSID 'Renamed profile' -StartDate '2026-09-19' -EndDate '2026-09-19' -DataDirectory $directory
        Assert-True (-not $unknown.Available -and $unknown.MessageCode -eq 'ProfileUnavailable') 'A profile display name is not evidence of the SSID.'
    }
    Invoke-AppTest 'Retention and the tracking start trim Windows requests' {
        param($module, $directory)
        [IO.File]::WriteAllText((Join-Path $directory 'settings.json'), '{"RetentionDays":2}')
        [IO.File]::WriteAllText((Join-Path $directory 'state.json'), '{"StartedAt":"2026-09-19T13:30:00+08:00"}')
        & $module { param($Profiles) $script:TestProfiles = $Profiles } @((New-TestProfile 'Home'))
        $result = Get-MeterAppUsage -SSID 'Home' -StartDate '2026-01-01' -EndDate '2026-09-20' -DataDirectory $directory
        $windows = @(& $module { $script:QueryWindows.ToArray() })
        Assert-True ($windows.Count -eq 2) 'Only retained days should be requested.'
        Assert-True ($windows[0].Start -eq [DateTimeOffset]'2026-09-19T13:30:00+08:00') 'The first request must start when tracking began.'
        Assert-True ($windows[1].End -eq [DateTimeOffset]'2026-09-20T12:00:00+08:00') 'Today must not request future usage.'
        Assert-True $result.Partial 'The result must state that its available interval was limited.'
    }
    Invoke-AppTest 'Old records and reversed ranges never produce provider requests' {
        param($module, $directory)
        & $module { param($Profiles) $script:TestProfiles = $Profiles } @((New-TestProfile 'Home'))
        $old = Get-MeterAppUsage -SSID 'Home' -StartDate '2020-01-01' -EndDate '2020-01-30' -DataDirectory $directory
        Assert-True (-not $old.Available -and $old.MessageCode -eq 'OutsideAvailableRange') 'Windows history limits must be explicit.'
        $threw = $false
        try { Get-MeterAppUsage -SSID 'Home' -StartDate '2026-09-20' -EndDate '2026-09-19' -DataDirectory $directory | Out-Null } catch { $threw = $true }
        Assert-True $threw 'Reversed dates must fail validation.'
        Assert-True ((& $module { $script:QueryCount }) -eq 0) 'Invalid or unavailable intervals must not query Windows.'
    }
    Invoke-AppTest 'Empty and denied responses never invent application traffic' {
        param($module, $directory)
        & $module { param($Profiles) $script:TestProfiles = $Profiles; $script:TestFailure = 'Empty' } @((New-TestProfile 'Home'))
        $empty = Get-MeterAppUsage -SSID 'Home' -StartDate '2026-09-19' -EndDate '2026-09-19' -DataDirectory $directory
        Assert-True ($empty.Available -and $empty.MessageCode -eq 'NoData' -and $empty.Rows.Count -eq 0) 'An empty Windows result must be explicit.'
        & $module { $script:TestFailure = 'AccessDenied'; $script:AppDayCache.Clear() }
        [IO.File]::Delete((Join-Path $directory 'app-usage.json'))
        $denied = Get-MeterAppUsage -SSID 'Home' -StartDate '2026-09-19' -EndDate '2026-09-19' -DataDirectory $directory
        Assert-True (-not $denied.Available -and $denied.MessageCode -eq 'AccessDenied' -and $denied.Rows.Count -eq 0) 'Access failures must not fabricate data.'
    }
    Invoke-AppTest 'Provider calls are bounded and successful days are cached' {
        param($module, $directory)
        & $module { param($Profiles) $script:TestProfiles = $Profiles } @((New-TestProfile 'Home'))
        Get-MeterAppUsage -SSID 'Home' -StartDate '2026-09-19' -EndDate '2026-09-19' -DataDirectory $directory | Out-Null
        Get-MeterAppUsage -SSID 'Home' -StartDate '2026-09-19' -EndDate '2026-09-19' -DataDirectory $directory | Out-Null
        Assert-True ((& $module { $script:QueryCount }) -eq 1) 'Repeated requests should reuse a recent daily result.'
        & $module { $script:TestNeverCompletes = $true; $script:AppDayCache.Clear() }
        $timer = [Diagnostics.Stopwatch]::StartNew()
        $result = Get-MeterAppUsage -SSID 'Home' -StartDate '2026-09-01' -EndDate '2026-09-19' -DataDirectory $directory -TimeoutMilliseconds 500
        Assert-True ($timer.Elapsed.TotalSeconds -lt 3 -and $result.MessageCode -eq 'Timeout') 'A stalled provider must return within the request budget.'
        Assert-True ((& $module { $script:QueryCount }) -le 5) 'At most four Windows operations should be in flight.'
        Assert-True (@(& $module { $script:QueryOperations | Where-Object { -not $_.Closed } }).Count -eq 0) 'Finished and cancelled operations must release their native resources.'
    }
    Invoke-AppTest 'A bounded disk cache survives fresh UI workers and expires' {
        param($module, $directory)
        & $module { param($Profiles) $script:TestProfiles = $Profiles } @((New-TestProfile 'Home'))
        $first = Get-MeterAppUsage -SSID 'Home' -StartDate '2026-09-19' -EndDate '2026-09-19' -DataDirectory $directory
        Assert-True (Test-Path -LiteralPath (Join-Path $directory 'app-usage.json')) 'Successful daily snapshots should be cached on disk.'
        & $module { $script:AppDayCache.Clear() }
        $second = Get-MeterAppUsage -SSID 'Home' -StartDate '2026-09-19' -EndDate '2026-09-19' -DataDirectory $directory
        Assert-True ((& $module { $script:QueryCount }) -eq 1 -and $second.Rows[0].TotalBytes -eq $first.Rows[0].TotalBytes) 'Fresh workers should reuse recent results without adding the totals twice.'
        & $module { function script:Get-MeterAppNow { [DateTimeOffset]'2026-09-20T12:06:00+08:00' }; $script:AppDayCache.Clear() }
        Get-MeterAppUsage -SSID 'Home' -StartDate '2026-09-19' -EndDate '2026-09-19' -DataDirectory $directory | Out-Null
        Assert-True ((& $module { $script:QueryCount }) -eq 2) 'Expired snapshots must be refreshed for late Windows accounting.'
    }
    Invoke-AppTest 'Profile maintenance prunes application cache according to retention' {
        param($module, $directory)
        & $module { param($Profiles) $script:TestProfiles = $Profiles } @((New-TestProfile 'Home'))
        Get-MeterAppUsage -SSID 'Home' -StartDate '2026-09-18' -EndDate '2026-09-18' -DataDirectory $directory | Out-Null
        [IO.File]::WriteAllText((Join-Path $directory 'settings.json'), '{"RetentionDays":2}')
        Update-MeterAppUsageProfiles -DataDirectory $directory
        Assert-True (-not (Test-Path -LiteralPath (Join-Path $directory 'app-usage.json'))) 'Expired stored application records must be removed without opening their detail view.'
    }
    Invoke-AppTest 'The disk cache keeps only the latest four requested ranges' {
        param($module, $directory)
        & $module { param($Profiles) $script:TestProfiles = $Profiles } @((New-TestProfile 'Home'))
        foreach ($day in 14..18) {
            $date = [datetime]::new(2026, 9, $day)
            Get-MeterAppUsage -SSID 'Home' -StartDate $date -EndDate $date -DataDirectory $directory | Out-Null
        }
        $file = Get-Item -LiteralPath (Join-Path $directory 'app-usage.json')
        $cache = [IO.File]::ReadAllText($file.FullName) | ConvertFrom-Json
        Assert-True ($cache.Records.Count -eq 4 -and $file.Length -le 8388608) 'Stored query windows and file size must stay bounded.'
        Assert-True ($cache.Records[0].StartDate -eq '2026-09-18' -and @($cache.Records | Where-Object StartDate -eq '2026-09-14').Count -eq 0) 'The newest query must replace the oldest query even when timestamps match.'
    }
    Invoke-AppTest 'Malformed cache data is ignored without inventing application rows' {
        param($module, $directory)
        & $module { param($Profiles) $script:TestProfiles = $Profiles; $script:TestFailure = 'Empty' } @((New-TestProfile 'Home'))
        [IO.File]::WriteAllText((Join-Path $directory 'app-usage.json'), '{"SchemaVersion":1,"Records":[{"SSID":"Home","Result":{"Rows":[{"RxBytes":-999}]}}]}')
        $result = Get-MeterAppUsage -SSID 'Home' -StartDate '2026-09-19' -EndDate '2026-09-19' -DataDirectory $directory
        Assert-True ($result.Available -and $result.Rows.Count -eq 0 -and (& $module { $script:QueryCount }) -eq 1) 'An invalid cache must fall back to the Windows query.'
    }
    Invoke-AppTest 'Large provider responses stop at the daily record limit' {
        param($module, $directory)
        & $module {
            param($Profiles)
            $script:TestProfiles = $Profiles
            function script:Read-MeterAppQuery($Query) {
                foreach ($index in 1..6001) {
                    [pscustomobject]@{ AppId = ('app-' + $index); Name = ('Application ' + $index); RxBytes = [long]1; TxBytes = [long]0; TotalBytes = [long]1 }
                }
            }
        } @((New-TestProfile 'Home'))
        $result = Get-MeterAppUsage -SSID 'Home' -StartDate '2026-09-18' -EndDate '2026-09-19' -DataDirectory $directory
        Assert-True (-not $result.Available -and $result.MessageCode -eq 'RecordLimit' -and $result.Rows.Count -eq 0) 'A record limit must be explicit instead of displaying incomplete totals as complete.'
        Assert-True (@(& $module { $script:QueryOperations | Where-Object { -not $_.Closed } }).Count -eq 0) 'The record limit must still release provider operations.'
    }
    if ($Live) {
        $module = Import-Module $modulePath -Force -PassThru
        try {
            $profiles = @(& $module { Get-MeterAppConnectionProfiles })
            $current = $profiles | Where-Object { $_.IsWlanConnectionProfile -and -not [string]::IsNullOrEmpty($_.WlanConnectionProfileDetails.GetConnectedSsid()) } | Select-Object -First 1
            if ($null -ne $current) {
                $result = Get-MeterAppUsage -SSID $current.WlanConnectionProfileDetails.GetConnectedSsid() -StartDate ([datetime]::Today.AddDays(-29)) -EndDate ([datetime]::Today) -DataDirectory $temporary
                Assert-True ($result.Rows -is [array] -and $result.Days -is [array]) 'The live provider must return stable collection types.'
                Write-Output ('PASS: Live Windows provider: available={0}, status={1}, apps={2}, daily rows={3}' -f $result.Available, $result.MessageCode, $result.Rows.Count, $result.Days.Count)
            } else { Write-Output 'SKIP: Live Windows provider needs a connected Wi-Fi network.' }
        } finally { Remove-Module $module -Force }
    }
    Write-Output ('App usage tests passed: ' + $script:count)
}
finally {
    $resolved = [IO.Path]::GetFullPath($temporary)
    $expected = [IO.Path]::GetFullPath($artifactDirectory).TrimEnd('\') + '\app-usage-'
    if (-not $resolved.StartsWith($expected, [StringComparison]::OrdinalIgnoreCase)) { throw 'Unsafe test cleanup path.' }
    if (Test-Path -LiteralPath $resolved) { Remove-Item -LiteralPath $resolved -Recurse -Force }
}
