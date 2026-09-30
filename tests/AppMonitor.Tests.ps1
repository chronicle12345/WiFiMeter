#requires -Version 5.1
[CmdletBinding()]
param([switch]$Live)

Set-StrictMode -Version 2
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
$modulePath = Join-Path $root 'src\AppMonitor.psm1'
$artifactDirectory = Join-Path $root 'artifacts'
$temporary = Join-Path $artifactDirectory ('app-monitor-' + [guid]::NewGuid().ToString('N'))
[void][IO.Directory]::CreateDirectory($temporary)
$script:count = 0

function Assert-True([bool]$Condition, [string]$Message) {
    if (-not $Condition) { throw $Message }
}

function Assert-Equal($Actual, $Expected, [string]$Message = '') {
    if ($Actual -cne $Expected) { throw "${Message}: expected [$Expected], received [$Actual]" }
}

function New-Row {
    param([string]$Local, [int]$LocalPort, [string]$Remote, [int]$RemotePort, [int]$OwnerId, [bool]$Loopback)
    [pscustomobject]@{ State = 5; LocalAddress = $Local; LocalPort = $LocalPort; RemoteAddress = $Remote; RemotePort = $RemotePort; OwningPid = $OwnerId; RemoteIsLoopback = $Loopback }
}

function Invoke-MonitorTest([string]$Name, [scriptblock]$Body) {
    $directory = Join-Path $temporary ([guid]::NewGuid().ToString('N'))
    [void][IO.Directory]::CreateDirectory($directory)
    $module = Import-Module $modulePath -Force -PassThru
    try {
        & $module {
            $script:TestRows = @()
            $script:TestOwners = @{}
            function script:Get-MeterTcpConnections { $script:TestRows }
            function script:Get-MeterProcessNames {
                param([int[]]$ProcessIds)
                $map = [Collections.Generic.Dictionary[int, string]]::new()
                foreach ($id in $ProcessIds) { if ($script:TestOwners.ContainsKey($id)) { $map[$id] = $script:TestOwners[$id] } }
                return $map
            }
        }
        & $Body $module $directory
        $script:count++
        Write-Output ('PASS: ' + $Name)
    }
    finally { Remove-Module $module -Force }
}

try {
    Invoke-MonitorTest 'Client rows need loopback, a configured port and a non-proxy owner' {
        param($module, $directory)
        & $module {
            param($Rows, $Owners)
            $script:TestRows = $Rows
            $script:TestOwners = $Owners
        } @(
            (New-Row '127.0.0.1' 50434 '127.0.0.1' 7897 222 $true),
            (New-Row '127.0.0.1' 50435 '127.0.0.1' 9999 222 $true),
            (New-Row '192.168.1.5' 50436 '93.184.216.34' 7897 222 $false),
            (New-Row '127.0.0.1' 50437 '127.0.0.1' 7897 555 $true),
            (New-Row '127.0.0.1' 7897 '10.0.0.9' 443 111 $false),
            (New-Row '127.0.0.1' 50438 '127.0.0.1' 7897 333 $true),
            (New-Row '127.0.0.1' 50439 '127.0.0.1' 7897 444 $true)
        ) @{ 111 = 'mihomo'; 222 = 'chrome'; 444 = 'SurfController'; 555 = 'SurfProxy'; 333 = '' }
        $sample = Get-MeterProxyClientSample -Ports @(7897) -ProcessNames @('SurfProxy')
        Assert-Equal @($sample.Clients).Count 2 'Only verified client rows may stay.'
        $names = @($sample.Clients | ForEach-Object { $_.Name } | Sort-Object -Unique)
        Assert-True ($names.Count -eq 2 -and $names -ccontains 'chrome' -and $names -ccontains 'SurfController') 'Client names must keep the observed process name.'
        Assert-Equal $sample.Clients[0].Key '127.0.0.1:50434>127.0.0.1:7897' 'Client keys must be the full connection tuple.'
    }
    Invoke-MonitorTest 'A proxy is recognized by its local port or its process name' {
        param($module, $directory)
        & $module {
            param($Rows, $Owners)
            $script:TestRows = $Rows
            $script:TestOwners = $Owners
        } @(
            (New-Row '127.0.0.1' 50440 '127.0.0.1' 7898 555 $true),
            (New-Row '192.168.1.5' 52011 '93.184.216.34' 443 555 $false)
        ) @{ 555 = 'UnknownProxy' }
        $sample = Get-MeterProxyClientSample -Ports @(7898) -ProcessNames @('UnknownProxy')
        Assert-Equal @($sample.Clients).Count 0 'Proxy rows must never be counted as clients.'
    }
    Invoke-MonitorTest 'Repeated observations of one connection count once per day' {
        param($module, $directory)
        $sample = [pscustomobject]@{ Clients = @(
            [pscustomobject]@{ Name = 'chrome'; Key = '127.0.0.1:50434>127.0.0.1:7897' },
            [pscustomobject]@{ Name = 'chrome'; Key = '127.0.0.1:50450>127.0.0.1:7897' }
        ) }
        $state = Read-MeterProxyClients -DataDirectory $directory
        $time = [DateTimeOffset]'2026-10-01T10:00:00+08:00'
        $null = Update-MeterProxyDay -State $state -Timestamp $time -Sample $sample
        $null = Update-MeterProxyDay -State $state -Timestamp $time.AddSeconds(5) -Sample $sample
        $day = @($state.Days | Where-Object { $_.Date -ceq '2026-10-01' })[0]
        Assert-Equal $day.Keys.Count 2 'The same tuple must not be counted twice.'
        Assert-Equal $day.Counts['chrome'] 2L 'Two distinct connections belong to the client.'
        $nextDay = [pscustomobject]@{ Clients = @([pscustomobject]@{ Name = 'chrome'; Key = '127.0.0.1:50434>127.0.0.1:7897' }) }
        $null = Update-MeterProxyDay -State $state -Timestamp $time.AddDays(1) -Sample $nextDay
        Assert-Equal @($state.Days).Count 2 'A new local date must start its own record.'
    }
    Invoke-MonitorTest 'Proxy observations persist atomically and survive a reload' {
        param($module, $directory)
        $state = Read-MeterProxyClients -DataDirectory $directory
        $time = [DateTimeOffset]'2026-10-01T10:00:00+08:00'
        $sample = [pscustomobject]@{ Clients = @([pscustomobject]@{ Name = 'chrome'; Key = '127.0.0.1:50434>127.0.0.1:7897' }) }
        $null = Update-MeterProxyDay -State $state -Timestamp $time -Sample $sample
        Save-MeterProxyClients -DataDirectory $directory -State $state
        $before = [IO.File]::ReadAllBytes((Join-Path $directory 'proxy-clients.json'))[0..2]
        Assert-Equal ([BitConverter]::ToString($before)) 'EF-BB-BF' 'The observation file must use a UTF-8 BOM.'
        $reloaded = Read-MeterProxyClients -DataDirectory $directory
        $day = @($reloaded.Days | Where-Object { $_.Date -ceq '2026-10-01' })[0]
        Assert-Equal $day.Counts['chrome'] 1L 'Reloaded counts must match the saved observations.'
        Save-MeterProxyClients -DataDirectory $directory -State $reloaded
        Assert-Equal @([IO.Directory]::GetFiles($directory, '*.tmp')).Count 0 'Temporary files must be cleaned up.'
        Assert-True ([IO.File]::ReadAllText((Join-Path $directory 'proxy-clients.json')).Contains('"SchemaVersion":1')) 'The file must carry its schema version.'
    }
    Invoke-MonitorTest 'Malformed observation files start from an empty state' {
        param($module, $directory)
        [IO.File]::WriteAllText((Join-Path $directory 'proxy-clients.json'), '{broken')
        $state = Read-MeterProxyClients -DataDirectory $directory
        Assert-Equal @($state.Days).Count 0 'A broken file must not produce observations.'
        [IO.File]::WriteAllText((Join-Path $directory 'proxy-clients.json'), '{"SchemaVersion":9,"Days":[{"Date":"2026-10-01","Clients":[{"Name":"chrome","Connections":5}],"Keys":["k"]}]}')
        $state = Read-MeterProxyClients -DataDirectory $directory
        Assert-Equal @($state.Days).Count 0 'Unknown schema versions must be ignored.'
    }
    Invoke-MonitorTest 'Observation history obeys retention and a hard day cap' {
        param($module, $directory)
        $state = Read-MeterProxyClients -DataDirectory $directory
        $time = [DateTimeOffset]'2026-10-01T10:00:00+08:00'
        $empty = [pscustomobject]@{ Clients = @() }
        foreach ($dayOffset in 69..0) {
            $null = Update-MeterProxyDay -State $state -Timestamp $time.AddDays(-$dayOffset) -Sample $empty
        }
        Assert-Equal @($state.Days).Count 70 'Records start complete before pruning.'
        $removed = Remove-MeterExpiredProxyDays -State $state -RetentionDays 0 -Timestamp $time
        Assert-Equal $removed 10 'Without retention the fixed cap still bounds history.'
        Assert-Equal @($state.Days).Count 60 'At most 60 observation days are kept.'
        Assert-Equal $state.Days[0].Date '2026-08-03' 'The cap must drop the oldest days.'
        Assert-Equal $state.Days[59].Date '2026-10-01' 'The newest day must survive the cap.'
        $removed = Remove-MeterExpiredProxyDays -State $state -RetentionDays 7 -Timestamp $time
        Assert-Equal $removed 53 'Retention must drop observation days older than the cutoff.'
        Assert-Equal @($state.Days).Count 7 'Only retained days stay.'
        Assert-Equal $state.Days[0].Date '2026-09-25' 'The cutoff must include the oldest kept day.'
    }
    Invoke-MonitorTest 'Proxy bytes are distributed by deduplicated connection weights' {
        param($module, $directory)
        [IO.File]::WriteAllText((Join-Path $directory 'settings.json'), '{"Proxy":{"ProcessNames":["mihomo.exe"]}}')
        [IO.File]::WriteAllText((Join-Path $directory 'proxy-clients.json'), '{"SchemaVersion":1,"Days":[{"Date":"2026-10-01","Clients":[{"Name":"chrome","Connections":2},{"Name":"msedge","Connections":1}],"Keys":["a","b","c"]}]}')
        $fake = [pscustomobject]@{
            Available = $true; MessageCode = 'Available'
            Rows = @()
            Days = @(
                [pscustomobject]@{ Date = '2026-10-01'; AppId = 'C:\proxy\mihomo.exe'; Name = 'mihomo.exe'; RxBytes = [long]700; TxBytes = [long]100; TotalBytes = [long]800 },
                [pscustomobject]@{ Date = '2026-10-01'; AppId = 'C:\apps\firefox.exe'; Name = 'firefox.exe'; RxBytes = [long]30; TxBytes = [long]10; TotalBytes = [long]40 }
            )
        }
        $repaired = Repair-MeterProxyAttribution -Result $fake -DataDirectory $directory -UnattributedName 'Via proxy'
        Assert-Equal @($repaired.Days | Where-Object { $_.Name -ieq 'mihomo.exe' }).Count 0 'The proxy row must be replaced by its clients.'
        $chrome = @($repaired.Days | Where-Object { $_.Name -ieq 'chrome' })[0]
        $msedge = @($repaired.Days | Where-Object { $_.Name -ieq 'msedge' })[0]
        Assert-Equal $chrome.RxBytes 467L 'Two thirds of the proxy bytes (rounded to nearest) belong to chrome.'
        Assert-Equal $msedge.RxBytes 233L 'The remainder must keep the day total exact.'
        Assert-Equal ($chrome.RxBytes + $msedge.RxBytes) 700L 'Distributed bytes must add up to the original proxy bytes.'
        Assert-Equal $chrome.TxBytes 67L 'Upload must be distributed the same way.'
        Assert-Equal $msedge.TxBytes 33L 'The upload remainder must keep the day total exact.'
        Assert-True ($chrome.Estimated -and $msedge.Estimated) 'Distributed rows are estimates.'
        $firefox = @($repaired.Days | Where-Object { $_.Name -ieq 'firefox.exe' })[0]
        Assert-True (-not $firefox.Estimated) 'Unrelated rows must not be marked as estimates.'
        $firefoxRow = @($repaired.Rows | Where-Object { $_.Name -ieq 'firefox.exe' })[0]
        Assert-Equal $firefoxRow.TotalBytes 40L 'Aggregated rows must stay consistent with daily rows.'
        Assert-Equal (@($repaired.Rows | Measure-Object TotalBytes -Sum).Sum) 840L 'The repaired total must be unchanged.'
    }
    Invoke-MonitorTest 'Days without client evidence keep a marked unattributed row' {
        param($module, $directory)
        [IO.File]::WriteAllText((Join-Path $directory 'settings.json'), '{"Proxy":{"ProcessNames":["mihomo"]}}')
        [IO.File]::WriteAllText((Join-Path $directory 'proxy-clients.json'), '{"SchemaVersion":1,"Days":[{"Date":"2026-10-01","Clients":[{"Name":"chrome","Connections":1}],"Keys":["a"]}]}')
        $fake = [pscustomobject]@{
            Available = $true; MessageCode = 'Available'
            Rows = @()
            Days = @(
                [pscustomobject]@{ Date = '2026-10-01'; AppId = 'C:\proxy\mihomo.exe'; Name = 'mihomo.exe'; RxBytes = [long]300; TxBytes = [long]0; TotalBytes = [long]300 },
                [pscustomobject]@{ Date = '2026-10-02'; AppId = 'C:\proxy\mihomo.exe'; Name = 'mihomo.exe'; RxBytes = [long]500; TxBytes = [long]0; TotalBytes = [long]500 }
            )
        }
        $repaired = Repair-MeterProxyAttribution -Result $fake -DataDirectory $directory -UnattributedName 'Via proxy'
        $chrome = @($repaired.Days | Where-Object { $_.Date -ceq '2026-10-01' })[0]
        Assert-Equal $chrome.RxBytes 300L 'A day with evidence distributes everything.'
        $unattributed = @($repaired.Days | Where-Object { $_.Name -ceq 'Via proxy' })
        Assert-Equal @($unattributed).Count 1 'Only the day without evidence keeps a remainder.'
        Assert-Equal $unattributed[0].Date '2026-10-02' 'The remainder belongs to the evidence-free day.'
        Assert-Equal $unattributed[0].RxBytes 500L 'The remainder must keep the unattributed bytes.'
        Assert-True $unattributed[0].Estimated 'The remainder row must be marked as an estimate.'
    }
    Invoke-MonitorTest 'Port-only proxy settings are attributed through the live table' {
        param($module, $directory)
        & $module {
            param($Rows, $Owners)
            $script:TestRows = $Rows
            $script:TestOwners = $Owners
        } @(
            (New-Row '127.0.0.1' 7890 '127.0.0.1' 51000 111 $true)
        ) @{ 111 = 'clash' }
        [IO.File]::WriteAllText((Join-Path $directory 'settings.json'), '{"Proxy":{"Ports":[7890]}}')
        [IO.File]::WriteAllText((Join-Path $directory 'proxy-clients.json'), '{"SchemaVersion":1,"Days":[{"Date":"2026-10-01","Clients":[{"Name":"chrome","Connections":1}],"Keys":["a"]}]}')
        $fake = [pscustomobject]@{
            Available = $true; MessageCode = 'Available'
            Rows = @()
            Days = @(
                [pscustomobject]@{ Date = '2026-10-01'; AppId = 'C:\proxy\clash.exe'; Name = 'clash.exe'; RxBytes = [long]300; TxBytes = [long]0; TotalBytes = [long]300 }
            )
        }
        $repaired = Repair-MeterProxyAttribution -Result $fake -DataDirectory $directory -UnattributedName 'Via proxy'
        Assert-Equal @($repaired.Days | Where-Object { $_.Name -ieq 'clash.exe' }).Count 0 'The proxy row must be split even without configured process names.'
        $chrome = @($repaired.Days | Where-Object { $_.Name -ieq 'chrome' })[0]
        Assert-Equal $chrome.RxBytes 300L 'The observed client must receive the proxy bytes.'
        Assert-True $chrome.Estimated 'Distributed rows are estimates.'
    }
    Invoke-MonitorTest 'Repairs without proxy configuration or availability stay untouched' {
        param($module, $directory)
        $fake = [pscustomobject]@{
            Available = $true; MessageCode = 'Available'
            Rows = @()
            Days = @([pscustomobject]@{ Date = '2026-10-01'; AppId = 'C:\proxy\mihomo.exe'; Name = 'mihomo.exe'; RxBytes = [long]300; TxBytes = [long]0; TotalBytes = [long]300 })
        }
        $unconfigured = Repair-MeterProxyAttribution -Result $fake -DataDirectory $directory -UnattributedName 'Via proxy'
        Assert-True ($null -ne $unconfigured.Days -and $unconfigured.Days[0].Name -ieq 'mihomo.exe') 'Without configured proxy names the result must stay unchanged.'
        [IO.File]::WriteAllText((Join-Path $directory 'settings.json'), '{"Proxy":{"ProcessNames":["mihomo"]}}')
        $unavailable = [pscustomobject]@{ Available = $false; MessageCode = 'Unavailable'; Rows = @(); Days = @() }
        $untouched = Repair-MeterProxyAttribution -Result $unavailable -DataDirectory $directory -UnattributedName 'Via proxy'
        Assert-Equal $untouched.MessageCode 'Unavailable' 'Unavailable queries must pass through unchanged.'
    }
    Invoke-MonitorTest 'Live app connections aggregate rows by owner and keep the busiest first' {
        param($module, $directory)
        & $module {
            param($Rows, $Owners)
            $script:TestRows = $Rows
            $script:TestOwners = $Owners
        } @(
            (New-Row '127.0.0.1' 10001 '93.184.216.34' 443 222 $false),
            (New-Row '127.0.0.1' 10002 '93.184.216.34' 443 222 $false),
            (New-Row '127.0.0.1' 10003 '93.184.216.34' 443 222 $false),
            (New-Row '127.0.0.1' 10004 '93.184.216.34' 443 333 $false),
            (New-Row '127.0.0.1' 10005 '93.184.216.34' 443 999 $false)
        ) @{ 222 = 'chrome'; 333 = 'msedge' }
        $apps = @(Get-MeterAppConnections)
        Assert-Equal @($apps).Count 2 'Unowned rows must not create applications.'
        Assert-Equal $apps[0].Name 'chrome'
        Assert-Equal $apps[0].Connections 3L
        Assert-Equal $apps[1].Name 'msedge'
        $limited = @(Get-MeterAppConnections -MaximumApps 1)
        Assert-Equal @($limited).Count 1 'The snapshot must honor the requested size.'
    }
    Invoke-MonitorTest 'Live app connections analyze a bounded number of rows' {
        param($module, $directory)
        & $module {
            param($Rows, $Owners)
            $script:TestRows = $Rows
            $script:TestOwners = $Owners
        } @(1..600 | ForEach-Object { New-Row '127.0.0.1' (20000 + $_) '93.184.216.34' 443 222 $false }) @{ 222 = 'chrome' }
        $apps = @(Get-MeterAppConnections)
        Assert-Equal @($apps).Count 1
        Assert-Equal $apps[0].Connections 512L 'At most 512 rows feed the snapshot.'
    }
    if ($Live) {
        $module = Import-Module $modulePath -Force -PassThru
        try {
            $sample = Get-MeterProxyClientSample -Ports @(1) -ProcessNames @('definitely-not-running-proxy')
            Assert-True ($null -ne $sample.Clients) 'The live table read must return a stable collection.'
            Write-Output ('PASS: Live TCP table rows classified: {0}' -f @($sample.Clients).Count)
        } finally { Remove-Module $module -Force }
    }
    Write-Output ('App monitor tests passed: ' + $script:count)
}
finally {
    $resolved = [IO.Path]::GetFullPath($temporary)
    $expected = [IO.Path]::GetFullPath($artifactDirectory).TrimEnd('\') + '\app-monitor-'
    if (-not $resolved.StartsWith($expected, [StringComparison]::OrdinalIgnoreCase)) { throw 'Unsafe test cleanup path.' }
    if (Test-Path -LiteralPath $resolved) { Remove-Item -LiteralPath $resolved -Recurse -Force }
}
