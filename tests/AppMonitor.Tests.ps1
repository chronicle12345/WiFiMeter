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
            $script:TestListeners = @()
            $script:TestOwners = @{}
            function script:Get-MeterTcpConnections { $script:TestRows }
            function script:Get-MeterTcpListeners { $script:TestListeners }
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
    finally { if (Get-Module $module.Name) { Remove-Module $module -Force } }
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
    Invoke-MonitorTest 'Port-only sampling excludes all connections owned by the listener' {
        param($module, $directory)
        & $module {
            $script:TestListeners = @([pscustomobject]@{ State = 2; LocalPort = 7890; OwningPid = 111 })
            $script:TestOwners = @{ 111 = 'proxy'; 222 = 'chrome' }
        }
        & $module { param($rows) $script:TestRows = $rows } @(
            (New-Row '127.0.0.1' 51000 '127.0.0.1' 7890 111 $true),
            (New-Row '127.0.0.1' 51001 '127.0.0.1' 7890 222 $true)
        )
        $sample = Get-MeterProxyClientSample -Ports @(7890) -ProcessNames @()
        Assert-Equal @($sample.Clients).Count 1
        Assert-Equal $sample.Clients[0].Name 'chrome'
    }
    Invoke-MonitorTest 'Port-only configuration without a listener leaves usage unchanged' {
        param($module, $directory)
        [IO.File]::WriteAllText((Join-Path $directory 'settings.json'), '{"Proxy":{"Ports":[7890]}}')
        & $module { param($rows) $script:TestRows = $rows; $script:TestOwners = @{ 111 = 'ordinary' } } @(
            (New-Row '192.168.1.5' 7890 '93.184.216.34' 443 111 $false)
        )
        $fake = [pscustomobject]@{ Available = $true; Rows = @(); Days = @(
            [pscustomobject]@{ Date = '2026-10-01'; AppId = ''; Name = 'ordinary'; RxBytes = 300L; TxBytes = 0L; TotalBytes = 300L }
        ) }
        $before = $fake | ConvertTo-Json -Depth 6
        $actual = Repair-MeterProxyAttribution -Result $fake -DataDirectory $directory -UnattributedName 'Via proxy'
        Assert-Equal ($actual | ConvertTo-Json -Depth 6) $before
        Assert-Equal @( (Get-MeterProxyClientSample -Ports @(7890) -ProcessNames @()).Clients ).Count 0
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
    Invoke-MonitorTest 'Port-only proxy settings are attributed with only an idle listener' {
        param($module, $directory)
        & $module {
            param($Rows, $Owners)
            $script:TestListeners = $Rows
            $script:TestOwners = $Owners
        } @(
            ([pscustomobject]@{ State = 2; LocalPort = 7890; OwningPid = 111 })
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
    Invoke-MonitorTest 'Detected listeners supplement explicit process names' {
        param($module, $directory)
        & $module {
            $script:TestListeners = @([pscustomobject]@{ State = 2; LocalPort = 7890; OwningPid = 111 })
            $script:TestOwners = @{ 111 = 'auto-proxy' }
        }
        [IO.File]::WriteAllText((Join-Path $directory 'settings.json'), '{"Proxy":{"Ports":[7890],"ProcessNames":["Manual.EXE"]}}')
        $fake = [pscustomobject]@{ Available = $true; Rows = @(); Days = @(
            [pscustomobject]@{ Date = '2026-10-01'; AppId = ''; Name = 'auto-proxy'; RxBytes = 300L; TxBytes = 0L; TotalBytes = 300L },
            [pscustomobject]@{ Date = '2026-10-01'; AppId = ''; Name = 'manual'; RxBytes = 100L; TxBytes = 0L; TotalBytes = 100L }
        ) }
        $actual = Repair-MeterProxyAttribution -Result $fake -DataDirectory $directory -UnattributedName 'Via proxy'
        Assert-Equal @($actual.Days).Count 1
        Assert-Equal $actual.Days[0].Name 'Via proxy'
        Assert-Equal $actual.Days[0].RxBytes 400L
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
    Invoke-MonitorTest 'Network monitor has a nonblocking stopped snapshot and idempotent cleanup' {
        param($module, $directory)
        Stop-MeterAppNetworkMonitor
        $sample = Get-MeterAppNetworkSample
        Assert-Equal $sample.Status 'Stopped'
        Assert-True (-not $sample.Available) 'A stopped monitor must not claim zero traffic.'
        Assert-Equal @($sample.Rows).Count 0
        Stop-MeterAppNetworkMonitor
    }
    Invoke-MonitorTest 'TCP byte intervals preserve paths, aggregate sockets and have no top twelve cutoff' {
        param($module, $directory)
        Add-Type -Path (Join-Path $root 'src/AppNetworkSampler.cs')
        $assembly = [WiFiMeter.Networking.AppNetworkMonitor].Assembly
        $counterType = $assembly.GetType('WiFiMeter.Networking.TcpByteCounter')
        $windowType = $assembly.GetType('WiFiMeter.Networking.TcpRateWindow')
        $listType = [Collections.Generic.List``1].MakeGenericType($counterType)
        $window = [Activator]::CreateInstance($windowType, $true)
        $update = $windowType.GetMethod('Update', [Reflection.BindingFlags]'Instance,NonPublic')
        function New-Counters([uint64]$rx, [uint64]$tx, [string]$generation = 'first') {
            $list = [Activator]::CreateInstance($listType)
            foreach ($id in 1..20) {
                $counter = [Activator]::CreateInstance($counterType, $true)
                $counter.Key = "$id-$generation"; $counter.ProcessId = $id
                $counter.Name = "app$id"; $counter.AppId = "C:\Apps\app$id.exe"
                $counter.Rx = $rx; $counter.Tx = $tx
                $list.Add($counter)
            }
            return ,$list
        }
        $first = $update.Invoke($window, @((New-Counters 100000 50000), 10.0, 0, 0))
        Assert-Equal $first.Status 'WarmingUp'
        Assert-True (-not $first.Available) 'Initial lifetime bytes are not interval traffic.'
        Assert-Equal $first.Rows.Count 20 'All process paths are retained even during warmup.'
        Assert-True ($null -eq $first.Rows[0].DownloadPerSecond) 'Warmup must use null, not zero.'
        $second = $update.Invoke($window, @((New-Counters 104096 52048), 12.0, 0, 0))
        Assert-Equal $second.Status 'Available'
        Assert-True $second.Available 'A measured interval is available.'
        Assert-Equal $second.Rows.Count 20
        Assert-Equal $second.Rows[0].DownloadPerSecond 2048.0
        Assert-Equal $second.Rows[0].UploadPerSecond 1024.0
        Assert-Equal $second.Rows[0].AppId 'C:\Apps\app1.exe'
        Assert-Equal $second.Rows[0].Connections 1
        $multiple = New-Counters 108192 54096
        $extra = [Activator]::CreateInstance($counterType, $true)
        $extra.Key = 'extra'; $extra.ProcessId = 1; $extra.Name = 'app1'; $extra.AppId = 'C:\Apps\app1.exe'
        $extra.Rx = 900000; $extra.Tx = 900000; $multiple.Add($extra)
        $third = $update.Invoke($window, @($multiple, 14.0, 0, 0))
        Assert-Equal $third.Status 'Partial' 'A new socket needs its own baseline.'
        Assert-Equal $third.Rows[0].Connections 2
        Assert-Equal $third.Rows[0].SampledConnections 1
        Assert-Equal $third.Rows[0].DownloadPerSecond 2048.0 'New socket lifetime bytes must be excluded.'
        $multiple = New-Counters 112288 56144
        $extra = [Activator]::CreateInstance($counterType, $true)
        $extra.Key = 'extra'; $extra.ProcessId = 1; $extra.Name = 'app1'; $extra.AppId = 'C:\Apps\app1.exe'
        $extra.Rx = 902048; $extra.Tx = 901024; $multiple.Add($extra)
        $fourth = $update.Invoke($window, @($multiple, 16.0, 0, 0))
        Assert-Equal $fourth.Rows[0].DownloadPerSecond 3072.0 'Two measured sockets aggregate by PID.'
        Assert-Equal $fourth.Rows[0].UploadPerSecond 1536.0
        $reset = $update.Invoke($window, @((New-Counters 1 1), 18.0, 0, 0))
        Assert-Equal $reset.Status 'WarmingUp'
        Assert-True ($null -eq $reset.Rows[0].DownloadPerSecond) 'Counter resets cannot produce negative speed.'
        $reused = $update.Invoke($window, @((New-Counters 100000 50000 'new-process'), 20.0, 0, 0))
        Assert-True ($null -eq $reused.Rows[0].UploadPerSecond) 'PID reuse establishes a new baseline.'
        $empty = [Activator]::CreateInstance($listType)
        $denied = $update.Invoke($window, @($empty, 22.0, 3, 5))
        Assert-Equal $denied.Status 'AccessDenied'
        Assert-True (-not $denied.Available) 'Native failure must not become a zero speed.'
        Assert-Equal $denied.Rows.Count 0 'Failed reads discard stale applications.'
        $resumed = $update.Invoke($window, @((New-Counters 200000 100000 'new-process'), 24.0, 0, 0))
        Assert-Equal $resumed.Status 'WarmingUp' 'A failed interval clears the old baselines.'
        $sameTime = $update.Invoke($window, @((New-Counters 200000 100000 'new-process'), 24.0, 0, 0))
        Assert-True (-not $sameTime.Available) 'Zero elapsed time must never divide by zero.'
        $idle = $update.Invoke($window, @($empty, 26.0, 0, 0))
        Assert-Equal $idle.Status 'Available'
        Assert-Equal $idle.Rows.Count 0 'Exited processes disappear from the next snapshot.'
        $window = [Activator]::CreateInstance($windowType, $true)
        function New-SharedPathCounters([uint64]$rx) {
            $list = [Activator]::CreateInstance($listType)
            foreach ($id in 1..5) {
                $counter = [Activator]::CreateInstance($counterType, $true)
                $counter.Key = "shared-$id"; $counter.ProcessId = $id
                $counter.Name = 'browser'
                $counter.AppId = @('C:\Browser\browser.exe', 'c:\browser\BROWSER.exe', 'D:\Other\browser.exe', '', '')[$id - 1]
                $counter.Rx = $rx; $counter.Tx = $rx
                $list.Add($counter)
            }
            return ,$list
        }
        $null = $update.Invoke($window, @((New-SharedPathCounters 100), 1.0, 0, 0))
        $grouped = $update.Invoke($window, @((New-SharedPathCounters 300), 3.0, 0, 0))
        Assert-Equal $grouped.Rows.Count 4 'Same path merges; different paths and unknown paths remain separate.'
        $shared = @($grouped.Rows | Where-Object { $_.AppId -ieq 'C:\Browser\browser.exe' })
        Assert-Equal $shared.Count 1 'Application identity uses a case-insensitive executable path.'
        Assert-Equal $shared[0].DownloadPerSecond 200.0
        Assert-Equal $shared[0].UploadPerSecond 200.0
        Assert-Equal $shared[0].Connections 2
        Assert-Equal ($shared[0].ProcessIds -join ',') '1,2'
        Assert-Equal @($grouped.Rows | Where-Object { $_.AppId -eq 'D:\Other\browser.exe' }).Count 1 'Same display name must not merge different executables.'
        Assert-Equal @($grouped.Rows | Where-Object { $_.AppId -eq '' }).Count 2 'Unknown paths retain PID identity.'
    }
    Invoke-MonitorTest 'Background monitor starts once, returns quickly and cleans up on module removal' {
        param($module, $directory)
        Start-MeterAppNetworkMonitor
        $instance = & $module { $script:AppNetworkMonitor }
        Start-MeterAppNetworkMonitor
        $again = & $module { $script:AppNetworkMonitor }
        Assert-True ([object]::ReferenceEquals($instance, $again)) 'Repeated starts must not create workers.'
        $timer = [Diagnostics.Stopwatch]::StartNew()
        1..50 | ForEach-Object { $null = Get-MeterAppNetworkSample }
        Assert-True ($timer.Elapsed.TotalSeconds -lt 2) 'Snapshot reads must not wait for the sampling interval.'
        Remove-Module $module -Force
        Assert-Equal $instance.GetSnapshot().Status 'Stopped' 'Module unload must dispose the worker.'
    }
    if ($Live) {
        $module = Import-Module $modulePath -Force -PassThru
        try {
            Start-MeterAppNetworkMonitor
            try {
                $deadline = [DateTime]::UtcNow.AddSeconds(8)
                do {
                    Start-Sleep -Milliseconds 100
                    $network = Get-MeterAppNetworkSample
                } while ($network.Status -eq 'Starting' -and [DateTime]::UtcNow -lt $deadline)
                if ($network.Status -eq 'AccessDenied') {
                    Assert-True (-not $network.Available) 'Unelevated monitoring must report unavailable.'
                    Assert-Equal $network.Rows.Count 0
                    Write-Output 'PASS: Live EStats permission failure is explicit (AccessDenied).'
                    Write-Output 'SKIP: Live TCP byte transfer requires an elevated Windows PowerShell process.'
                } else {
                    Assert-True ($network.Status -ne 'Unavailable') ('Native EStats initialization failed: ' + $network.NativeErrorCode)
                    foreach ($address in @([Net.IPAddress]::Loopback, [Net.IPAddress]::IPv6Loopback)) {
                        $listener = [Net.Sockets.TcpListener]::new($address, 0)
                        $client = $null; $server = $null
                        try {
                            $listener.Start()
                            $client = [Net.Sockets.TcpClient]::new($address.AddressFamily)
                            $client.Connect($address, $listener.LocalEndpoint.Port)
                            $server = $listener.AcceptTcpClient()
                            $server.ReceiveTimeout = 5000
                            $client.ReceiveTimeout = 5000
                            $deadline = [DateTime]::UtcNow.AddSeconds(10)
                            $warmTimestamp = (Get-MeterAppNetworkSample).TimestampUtc
                            $freshSamples = 0
                            do {
                                Start-Sleep -Milliseconds 100
                                $network = Get-MeterAppNetworkSample
                                if ($network.TimestampUtc -gt $warmTimestamp) {
                                    $warmTimestamp = $network.TimestampUtc
                                    $freshSamples++
                                }
                                $own = @($network.Rows | Where-Object { $_.ProcessIds -contains $PID -and $_.SampledConnections -ge 2 })
                            } while (($own.Count -eq 0 -or $freshSamples -lt 2) -and [DateTime]::UtcNow -lt $deadline)
                            Assert-True ($own.Count -eq 1 -and $freshSamples -ge 2) ('Live sockets did not finish EStats warmup: ' + $network.Status + '/' + $network.NativeErrorCode)
                            Assert-True ([IO.Path]::IsPathRooted($own[0].AppId)) 'Control needs a full executable path.'
                            $seen = $network.TimestampUtc
                            $payload = New-Object byte[] 8192
                            $client.GetStream().Write($payload, 0, $payload.Length)
                            $received = 0
                            while ($received -lt $payload.Length) {
                                $read = $server.GetStream().Read($payload, $received, $payload.Length - $received)
                                Assert-True ($read -gt 0) 'TCP receive unexpectedly closed.'
                                $received += $read
                            }
                            $rx = 0L; $tx = 0L
                            $deadline = [DateTime]::UtcNow.AddSeconds(5)
                            do {
                                Start-Sleep -Milliseconds 100
                                $network = Get-MeterAppNetworkSample
                                if ($network.TimestampUtc -gt $seen) {
                                    $seen = $network.TimestampUtc
                                    foreach ($row in @($network.Rows | Where-Object { $_.ProcessIds -contains $PID })) {
                                        $rx += [long]$row.RxBytes; $tx += [long]$row.TxBytes
                                        if ($row.RxBytes -gt 0) {
                                            Assert-True ([math]::Abs($row.DownloadPerSecond * $network.IntervalSeconds - $row.RxBytes) -lt 0.01) 'Live speed must use the actual elapsed interval.'
                                        }
                                    }
                                }
                            } while (($rx -lt 8192 -or $tx -lt 8192) -and [DateTime]::UtcNow -lt $deadline)
                            Assert-True ($rx -ge 8192 -and $tx -ge 8192) ('EStats failed to measure real TCP bytes: rx=' + $rx + ', tx=' + $tx)
                            Write-Output ('PASS: Live EStats byte transfer, path and interval: ' + $address.AddressFamily + ', rx=' + $rx + ', tx=' + $tx)
                        } finally {
                            if ($null -ne $client) { $client.Dispose() }
                            if ($null -ne $server) { $server.Dispose() }
                            $listener.Stop()
                        }
                    }
                }
            } finally { Stop-MeterAppNetworkMonitor }
            $sample = Get-MeterProxyClientSample -Ports @(1) -ProcessNames @('definitely-not-running-proxy')
            Assert-True ($null -ne $sample.Clients) 'The live table read must return a stable collection.'
            Write-Output ('PASS: Live TCP table rows classified: {0}' -f @($sample.Clients).Count)
            foreach ($address in @([Net.IPAddress]::Any, [Net.IPAddress]::IPv6Any)) {
                $listener = [Net.Sockets.TcpListener]::new($address, 0)
                try {
                    $listener.Start()
                    $port = $listener.LocalEndpoint.Port
                    $listeners = @([WiFiMeter.Networking.TcpTable]::GetListeners() | Where-Object { $_.LocalPort -eq $port -and $_.OwningPid -eq $PID })
                    Assert-Equal $listeners.Count 1 'Native table must identify an idle listener and its owner.'
                    Assert-Equal $listeners[0].State 2
                    Assert-Equal @([WiFiMeter.Networking.TcpTable]::GetEstablishedConnections() | Where-Object { $_.LocalPort -eq $port }).Count 0 'Listening sockets must not inflate established connection counts.'
                    [IO.File]::WriteAllText((Join-Path $temporary 'settings.json'), ('{"Proxy":{"Ports":[' + $port + ']}}'))
                    [IO.File]::WriteAllText((Join-Path $temporary 'proxy-clients.json'), '{"SchemaVersion":1,"Days":[{"Date":"2026-10-01","Clients":[{"Name":"browser-client","Connections":1}],"Keys":["a"]}]}')
                    $process = Get-Process -Id $PID
                    try { $ownerName = $process.ProcessName } finally { $process.Dispose() }
                    $fake = [pscustomobject]@{ Available = $true; Rows = @(); Days = @(
                        [pscustomobject]@{ Date = '2026-10-01'; AppId = ''; Name = $ownerName; RxBytes = 300L; TxBytes = 20L; TotalBytes = 320L }
                    ) }
                    $original = $fake | ConvertTo-Json -Depth 6
                    $actual = Repair-MeterProxyAttribution -Result $fake -DataDirectory $temporary -UnattributedName 'Via proxy'
                    Assert-Equal $actual.Days[0].Name 'browser-client' 'Port-only settings must resolve the real idle listener owner.'
                    Assert-Equal $actual.Days[0].TotalBytes 320L
                    Assert-True $actual.Days[0].Estimated 'Proxy attribution remains an estimate.'
                    $listener.Stop()
                    $fake = $original | ConvertFrom-Json
                    $actual = Repair-MeterProxyAttribution -Result $fake -DataDirectory $temporary -UnattributedName 'Via proxy'
                    Assert-Equal ($actual | ConvertTo-Json -Depth 6) $original 'A stopped listener must not leave stale process attribution.'
                    Write-Output ('PASS: Live port-only attribution and stopped listener: ' + $address.AddressFamily)
                } finally { $listener.Stop() }
            }

        } finally { if (Get-Module $module.Name) { Remove-Module $module -Force } }
    }
    Write-Output ('App monitor tests passed: ' + $script:count)
}
finally {
    $resolved = [IO.Path]::GetFullPath($temporary)
    $expected = [IO.Path]::GetFullPath($artifactDirectory).TrimEnd('\') + '\app-monitor-'
    if (-not $resolved.StartsWith($expected, [StringComparison]::OrdinalIgnoreCase)) { throw 'Unsafe test cleanup path.' }
    if (Test-Path -LiteralPath $resolved) { Remove-Item -LiteralPath $resolved -Recurse -Force }
}
