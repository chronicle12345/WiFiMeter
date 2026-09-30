#requires -Version 5.1
Set-StrictMode -Version 2
Import-Module (Join-Path $PSScriptRoot 'Storage.psm1') -Scope Local

# Bound for the proxy observation file: at most this many tracked days and
# deduplicated connections per day, so proxy-clients.json cannot grow freely.
$script:ProxyMaxFileBytes = 8388608
$script:ProxyMaxDays = 60
$script:ProxyMaxKeysPerDay = 1024
$script:ProxyMaxClientsPerDay = 48

function Add-MeterTcpTableType {
    if (-not ('WiFiMeter.Networking.TcpTable' -as [type])) {
        Add-Type -Path (Join-Path $PSScriptRoot 'TcpTable.cs') -ErrorAction Stop
    }
}

function Get-MeterTcpConnections {
    # Hook: returns established TCP rows with owner PIDs. Tests override this function.
    Add-MeterTcpTableType
    return @([WiFiMeter.Networking.TcpTable]::GetEstablishedConnections())
}

function Get-MeterProcessNames {
    param([AllowEmptyCollection()][int[]]$ProcessIds)
    # Hook: maps owner PIDs to process names. Tests override this function.
    $map = [Collections.Generic.Dictionary[int, string]]::new()
    if (@($ProcessIds).Count -eq 0) { return $map }
    try {
        foreach ($process in @(Get-Process -Id $ProcessIds -ErrorAction SilentlyContinue)) {
            if ($null -eq $process) { continue }
            $map[[int]$process.Id] = [string]$process.ProcessName
            $process.Dispose()
        }
    } catch { }
    return $map
}

function Get-MeterProcessKey([string]$Name) {
    # Process names compare without case and without a trailing .exe extension.
    if ([string]::IsNullOrWhiteSpace($Name)) { return '' }
    $key = $Name.Trim()
    if ($key.Length -ge 4 -and $key.EndsWith('.exe', [StringComparison]::OrdinalIgnoreCase)) {
        $key = $key.Substring(0, $key.Length - 4)
    }
    return $key.ToLowerInvariant()
}

function Get-MeterProxyClientSample {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][AllowEmptyCollection()][int[]]$Ports,
        [Parameter(Mandatory = $true)][AllowEmptyCollection()][string[]]$ProcessNames
    )

    # 归属规则：代理进程 = 本地端口在配置端口中，或进程名在配置名单中。
    # 客户端行 = 已建立连接、远端为环回、远端端口为配置端口，且属主不是代理进程。
    $portSet = [Collections.Generic.HashSet[int]]::new()
    foreach ($port in $Ports) { [void]$portSet.Add([int]$port) }
    $nameSet = [Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
    foreach ($name in $ProcessNames) {
        $key = Get-MeterProcessKey $name
        if ($key) { [void]$nameSet.Add($key) }
    }

    $clients = [Collections.Generic.List[object]]::new()
    if ($portSet.Count -eq 0 -and $nameSet.Count -eq 0) {
        return [pscustomobject]@{ Clients = [object[]]$clients.ToArray() }
    }

    $rows = @(Get-MeterTcpConnections)
    $ownerIds = @($rows | ForEach-Object { [int]$_.OwningPid } | Select-Object -Unique)
    $owners = Get-MeterProcessNames -ProcessIds $ownerIds

    foreach ($row in $rows) {
        try {
            $ownerName = ''
            $ownerId = [int]$row.OwningPid
            if ($owners.ContainsKey($ownerId)) { $ownerName = [string]$owners[$ownerId] }
            $ownerKey = Get-MeterProcessKey $ownerName

            $isProxy = $false
            if ($portSet.Contains([int]$row.LocalPort)) { $isProxy = $true }
            if (-not $isProxy -and $ownerKey -and $nameSet.Contains($ownerKey)) { $isProxy = $true }
            if ($isProxy) { continue }

            # 属主进程无法识别（采样瞬间退出）时不归属，避免把流量记到无效名称上。
            if (-not $ownerKey) { continue }
            if (-not [bool]$row.RemoteIsLoopback) { continue }
            if (-not $portSet.Contains([int]$row.RemotePort)) { continue }
            if ([string]::IsNullOrEmpty([string]$row.LocalAddress) -or [string]::IsNullOrEmpty([string]$row.RemoteAddress)) { continue }

            $clients.Add([pscustomobject]@{
                Name = [string]$ownerName
                Key = ('{0}:{1}>{2}:{3}' -f $row.LocalAddress, [int]$row.LocalPort, $row.RemoteAddress, [int]$row.RemotePort)
            })
        } catch { }
    }

    return [pscustomobject]@{ Clients = [object[]]$clients.ToArray() }
}

function New-MeterProxyClientsState {
    [CmdletBinding()]
    param()
    [pscustomobject]@{
        SchemaVersion = 1
        Days = [Collections.Generic.List[object]]::new()
    }
}

function Get-MeterProxyDayRecord {
    param([Parameter(Mandatory = $true)]$State, [Parameter(Mandatory = $true)][string]$Date)
    foreach ($day in $State.Days) {
        if ($day.Date -ceq $Date) { return $day }
    }
    $day = [pscustomobject]@{
        Date = $Date
        Counts = [Collections.Generic.Dictionary[string, long]]::new([StringComparer]::OrdinalIgnoreCase)
        Keys = [Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
    }
    $State.Days.Add($day)
    return $day
}

function Update-MeterProxyDay {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)]$State,
        [Parameter(Mandatory = $true)][DateTimeOffset]$Timestamp,
        [Parameter(Mandatory = $true)]$Sample
    )
    # 口径：按（本地地址:端口,远端地址:端口）四元组当日首次出现计 1，持续在场不重复计。
    $date = $Timestamp.ToLocalTime().ToString('yyyy-MM-dd', [cultureinfo]::InvariantCulture)
    $day = Get-MeterProxyDayRecord -State $State -Date $date
    $changed = $false
    foreach ($client in @($Sample.Clients)) {
        if ($client.Key -isnot [string] -or [string]::IsNullOrEmpty($client.Key)) { continue }
        if ($day.Keys.Contains($client.Key)) { continue }
        if ($day.Keys.Count -ge $script:ProxyMaxKeysPerDay) { break }
        [void]$day.Keys.Add($client.Key)
        $name = ''
        if ($client.PSObject.Properties['Name']) { $name = [string]$client.Name }
        if ([string]::IsNullOrWhiteSpace($name)) { $name = 'unknown' }
        if ($day.Counts.ContainsKey($name)) { $day.Counts[$name] += 1 } else { $day.Counts[$name] = 1L }
        $changed = $true
    }
    return $changed
}

function Read-MeterProxyClients {
    [CmdletBinding()]
    param([Parameter(Mandatory = $true)][string]$DataDirectory)
    $state = New-MeterProxyClientsState
    try {
        $path = Join-Path ([IO.Path]::GetFullPath($DataDirectory)) 'proxy-clients.json'
        if (-not [IO.File]::Exists($path)) { return $state }
        $stream = [IO.File]::Open($path, 'Open', 'Read', ([IO.FileShare]::ReadWrite -bor [IO.FileShare]::Delete))
        $reader = $null
        try {
            if ($stream.Length -gt $script:ProxyMaxFileBytes) { return $state }
            $reader = [IO.StreamReader]::new($stream, [Text.Encoding]::UTF8, $true)
            $saved = $reader.ReadToEnd() | ConvertFrom-Json -ErrorAction Stop
            if ($null -eq $saved -or $saved.SchemaVersion -ne 1 -or $saved.Days -isnot [array]) { return $state }
            foreach ($savedDay in $saved.Days) {
                if ($savedDay.Date -isnot [string] -or $savedDay.Date -cnotmatch '^\d{4}-\d{2}-\d{2}$') { continue }
                $day = Get-MeterProxyDayRecord -State $state -Date $savedDay.Date
                $keysProperty = $savedDay.PSObject.Properties['Keys']
                if ($null -ne $keysProperty -and $keysProperty.Value -is [array]) {
                    foreach ($key in $keysProperty.Value) {
                        if ($key -is [string] -and $key.Length -gt 0 -and $key.Length -le 260) { [void]$day.Keys.Add($key) }
                    }
                }
                $clientsProperty = $savedDay.PSObject.Properties['Clients']
                if ($null -eq $clientsProperty -or $clientsProperty.Value -isnot [array]) { continue }
                foreach ($client in $clientsProperty.Value) {
                    if ($client.Name -isnot [string] -or [string]::IsNullOrWhiteSpace($client.Name)) { continue }
                    if ($client.Connections -isnot [int] -and $client.Connections -isnot [long]) { continue }
                    $count = [long]$client.Connections
                    if ($count -le 0) { continue }
                    if ($day.Counts.ContainsKey($client.Name)) {
                        if ($day.Counts[$client.Name] -lt $count) { $day.Counts[$client.Name] = $count }
                    } else { $day.Counts[$client.Name] = $count }
                }
            }
        } finally {
            if ($null -ne $reader) { $reader.Dispose() } else { $stream.Dispose() }
        }
    } catch {
        return (New-MeterProxyClientsState)
    }
    return $state
}

function ConvertTo-MeterProxySerializable {
    param([Parameter(Mandatory = $true)]$State)
    $days = [Collections.Generic.List[object]]::new()
    foreach ($day in $State.Days) {
        $clients = @($day.Counts.GetEnumerator() |
            Sort-Object -Property @{ Expression = 'Value'; Descending = $true }, Key |
            Select-Object -First $script:ProxyMaxClientsPerDay |
            ForEach-Object { [pscustomobject]@{ Name = [string]$_.Key; Connections = [long]$_.Value } })
        $days.Add([pscustomobject]@{
            Date = [string]$day.Date
            Clients = [object[]]$clients
            Keys = [string[]]@($day.Keys)
        })
    }
    return [pscustomobject]@{ SchemaVersion = 1; Days = [object[]]$days.ToArray() }
}

function Save-MeterProxyClients {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][string]$DataDirectory,
        [Parameter(Mandatory = $true)]$State
    )
    $destination = Join-Path ([IO.Path]::GetFullPath($DataDirectory)) 'proxy-clients.json'
    $json = ConvertTo-MeterProxySerializable $State | ConvertTo-Json -Depth 6 -Compress
    # 跳过内容相同的维护写入；该文件属于观测证据，没有备份副本。
    if ([IO.File]::Exists($destination) -and [IO.File]::ReadAllText($destination) -ceq $json) { return }
    [void][IO.Directory]::CreateDirectory($DataDirectory)
    $temporary = $destination + '.' + [guid]::NewGuid().ToString('N') + '.tmp'
    try {
        [IO.File]::WriteAllText($temporary, $json, [Text.UTF8Encoding]::new($true))
        if ([IO.File]::Exists($destination)) { Invoke-MeterFileReplace -Source $temporary -Destination $destination }
        else { [IO.File]::Move($temporary, $destination) }
    } finally {
        if ([IO.File]::Exists($temporary)) { [IO.File]::Delete($temporary) }
    }
}

function Remove-MeterExpiredProxyDays {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)]$State,
        [Parameter(Mandatory = $true)][ValidateRange(0, 36500)][int]$RetentionDays,
        [Parameter(Mandatory = $true)][DateTimeOffset]$Timestamp
    )
    $before = $State.Days.Count
    $kept = [Collections.Generic.List[object]]::new()
    if ($RetentionDays -gt 0) {
        $cutoff = $Timestamp.ToLocalTime().Date.AddDays(1 - $RetentionDays).ToString('yyyy-MM-dd', [cultureinfo]::InvariantCulture)
        foreach ($day in $State.Days) {
            if ([string]::CompareOrdinal($day.Date, $cutoff) -ge 0) { $kept.Add($day) }
        }
    } else {
        foreach ($day in $State.Days) { $kept.Add($day) }
    }
    # 无论保留设置如何，观测证据最多保留固定天数，保证文件有界。
    if ($kept.Count -gt $script:ProxyMaxDays) {
        $kept.RemoveRange(0, $kept.Count - $script:ProxyMaxDays)
    }
    $State.Days = $kept
    return $before - $State.Days.Count
}

function Read-MeterProxyDayWeights {
    [CmdletBinding()]
    param([Parameter(Mandatory = $true)][string]$DataDirectory)
    $days = [Collections.Generic.Dictionary[string, object]]::new([StringComparer]::Ordinal)
    try {
        $path = Join-Path ([IO.Path]::GetFullPath($DataDirectory)) 'proxy-clients.json'
        if (-not [IO.File]::Exists($path)) { return $days }
        $stream = [IO.File]::Open($path, 'Open', 'Read', ([IO.FileShare]::ReadWrite -bor [IO.FileShare]::Delete))
        $reader = $null
        try {
            if ($stream.Length -gt $script:ProxyMaxFileBytes) { return $days }
            $reader = [IO.StreamReader]::new($stream, [Text.Encoding]::UTF8, $true)
            $saved = $reader.ReadToEnd() | ConvertFrom-Json -ErrorAction Stop
            if ($null -eq $saved -or $saved.SchemaVersion -ne 1 -or $saved.Days -isnot [array]) { return $days }
            foreach ($day in $saved.Days) {
                if ($day.Date -isnot [string] -or $day.Date -cnotmatch '^\d{4}-\d{2}-\d{2}$' -or $days.ContainsKey($day.Date)) { continue }
                $weights = [Collections.Generic.Dictionary[string, object]]::new([StringComparer]::Ordinal)
                $clientsProperty = $day.PSObject.Properties['Clients']
                if ($null -eq $clientsProperty -or $clientsProperty.Value -isnot [array]) { $days[$day.Date] = $weights; continue }
                foreach ($client in $clientsProperty.Value) {
                    if ($client.Name -isnot [string] -or [string]::IsNullOrWhiteSpace($client.Name)) { continue }
                    if ($client.Connections -isnot [int] -and $client.Connections -isnot [long]) { continue }
                    $count = [long]$client.Connections
                    if ($count -le 0) { continue }
                    $key = Get-MeterProcessKey $client.Name
                    if (-not $key) { continue }
                    if ($weights.ContainsKey($key)) { $weights[$key].Connections += $count }
                    else { $weights[$key] = [pscustomobject]@{ Name = [string]$client.Name; Connections = $count } }
                }
                $days[$day.Date] = $weights
            }
        } finally {
            if ($null -ne $reader) { $reader.Dispose() } else { $stream.Dispose() }
        }
    } catch {
        return [Collections.Generic.Dictionary[string, object]]::new([StringComparer]::Ordinal)
    }
    return $days
}

function Add-MeterMonitorBytes([long]$Left, [long]$Right) {
    $sum = [decimal]$Left + [decimal]$Right
    if ($Left -lt 0 -or $Right -lt 0 -or $sum -gt [long]::MaxValue) { throw 'Proxy attribution byte counts exceeded the supported range.' }
    return [long]$sum
}

function Get-MeterProxyRowKey($Row, [Collections.Generic.HashSet[string]]$ProxyKeys) {
    if ($null -ne $Row.PSObject.Properties['Name']) {
        $key = Get-MeterProcessKey ([string]$Row.Name)
        if ($key -and $ProxyKeys.Contains($key)) { return $key }
    }
    if ($null -ne $Row.PSObject.Properties['AppId']) {
        $appId = [string]$Row.AppId
        if ($appId) {
            $fileName = ''
            try { $fileName = [IO.Path]::GetFileName($appId) } catch { }
            $key = Get-MeterProcessKey $fileName
            if ($key -and $ProxyKeys.Contains($key)) { return $key }
        }
    }
    return ''
}

function Set-MeterRowEstimated($Row, [bool]$Value) {
    if ($null -ne $Row.PSObject.Properties['Estimated']) { $Row.Estimated = $Value }
    else { $Row | Add-Member -NotePropertyName Estimated -NotePropertyValue $Value }
}

function Repair-MeterProxyAttribution {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)]$Result,
        [Parameter(Mandatory = $true)][string]$DataDirectory,
        [Parameter(Mandatory = $true)][AllowEmptyString()][string]$UnattributedName
    )

    # 把 Windows 延迟归账给代理进程的字节，按各应用当日去重连接数占比分摊到逐日记录。
    # 没有观测证据的日期保留为"经代理·未归属"行并标 Estimated；失败时原样返回查询结果。
    try {
        if ($null -eq $Result -or $Result.Available -ne $true) { return $Result }
        if ($Result.PSObject.Properties['Days'] -eq $null -or @($Result.Days).Count -eq 0) { return $Result }
        $proxyNames = (Read-MeterProxySettings $DataDirectory).ProcessNames
        if ($proxyNames.Count -eq 0) { return $Result }
        $proxyKeys = [Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
        foreach ($name in $proxyNames) { [void]$proxyKeys.Add($name) }

        $byDate = [Collections.Generic.Dictionary[string, object]]::new([StringComparer]::Ordinal)
        foreach ($row in @($Result.Days)) {
            if ([string]::IsNullOrEmpty([string]$row.Date)) { continue }
            if (-not $byDate.ContainsKey([string]$row.Date)) {
                $byDate[[string]$row.Date] = [Collections.Generic.List[object]]::new()
            }
            $byDate[[string]$row.Date].Add($row)
        }

        $usage = Read-MeterProxyDayWeights -DataDirectory $DataDirectory
        $rebuilt = [Collections.Generic.List[object]]::new()
        $dates = [string[]]$byDate.Keys
        [Array]::Sort($dates, [StringComparer]::Ordinal)
        foreach ($date in $dates) {
            $rows = $byDate[$date]
            $proxyRx = [long]0
            $proxyTx = [long]0
            foreach ($row in $rows) {
                if (-not (Get-MeterProxyRowKey -Row $row -ProxyKeys $proxyKeys)) { continue }
                $proxyRx = Add-MeterMonitorBytes $proxyRx ([long]$row.RxBytes)
                $proxyTx = Add-MeterMonitorBytes $proxyTx ([long]$row.TxBytes)
            }
            if ($proxyRx -eq 0 -and $proxyTx -eq 0) {
                $rebuilt.AddRange($rows)
                continue
            }

            $kept = [Collections.Generic.List[object]]::new()
            foreach ($row in $rows) {
                if (Get-MeterProxyRowKey -Row $row -ProxyKeys $proxyKeys) { continue }
                $kept.Add($row)
            }

            $weights = $null
            if ($usage.ContainsKey($date)) { $weights = $usage[$date] }
            $totalWeight = [long]0
            if ($null -ne $weights) {
                foreach ($entry in $weights.Values) { $totalWeight += $entry.Connections }
            }
            if ($totalWeight -le 0) {
                # 该日期没有任何客户端观测证据，全部字节保留为未归属估算行。
                $unattributed = [pscustomobject]@{
                    Date = $date; AppId = ''; Name = $UnattributedName
                    RxBytes = $proxyRx; TxBytes = $proxyTx; TotalBytes = (Add-MeterMonitorBytes $proxyRx $proxyTx)
                    Estimated = $true
                }
                $kept.Add($unattributed)
            } else {
                $names = [string[]]$weights.Keys
                [Array]::Sort($names, [StringComparer]::Ordinal)
                $allocatedRx = [long]0
                $allocatedTx = [long]0
                for ($index = 0; $index -lt $names.Count; $index++) {
                    $entry = $weights[$names[$index]]
                    if ($index -eq $names.Count - 1) {
                        $shareRx = $proxyRx - $allocatedRx
                        $shareTx = $proxyTx - $allocatedTx
                    } else {
                        $shareRx = [long]([decimal]$proxyRx * [decimal]$entry.Connections / [decimal]$totalWeight)
                        $shareTx = [long]([decimal]$proxyTx * [decimal]$entry.Connections / [decimal]$totalWeight)
                        $allocatedRx = Add-MeterMonitorBytes $allocatedRx $shareRx
                        $allocatedTx = Add-MeterMonitorBytes $allocatedTx $shareTx
                    }
                    if ($shareRx -eq 0 -and $shareTx -eq 0) { continue }
                    $target = $null
                    foreach ($row in $kept) {
                        if ((Get-MeterProcessKey ([string]$row.Name)) -ceq $names[$index]) { $target = $row; break }
                    }
                    if ($null -eq $target) {
                        $target = [pscustomobject]@{
                            Date = $date; AppId = ''; Name = [string]$entry.Name
                            RxBytes = [long]0; TxBytes = [long]0; TotalBytes = [long]0
                        }
                        $kept.Add($target)
                    }
                    $target.RxBytes = Add-MeterMonitorBytes $target.RxBytes $shareRx
                    $target.TxBytes = Add-MeterMonitorBytes $target.TxBytes $shareTx
                    $target.TotalBytes = Add-MeterMonitorBytes $target.RxBytes $target.TxBytes
                    Set-MeterRowEstimated $target $true
                }
            }
            $rebuilt.AddRange($kept)
        }

        foreach ($row in $rebuilt) {
            if ($null -eq $row.PSObject.Properties['Estimated']) { Set-MeterRowEstimated $row $false }
        }
        $Result.Days = [object[]]@($rebuilt.ToArray())

        $byApp = [Collections.Generic.Dictionary[string, object]]::new([StringComparer]::Ordinal)
        foreach ($row in @($Result.Days)) {
            $key = if ([string]::IsNullOrEmpty([string]$row.AppId)) { 'name:' + (Get-MeterProcessKey ([string]$row.Name)) } else { 'id:' + [string]$row.AppId }
            if (-not $byApp.ContainsKey($key)) {
                $byApp[$key] = [pscustomobject]@{
                    AppId = [string]$row.AppId; Name = [string]$row.Name
                    RxBytes = [long]0; TxBytes = [long]0; TotalBytes = [long]0
                    Estimated = [bool]$row.Estimated
                }
            }
            $app = $byApp[$key]
            $app.RxBytes = Add-MeterMonitorBytes $app.RxBytes ([long]$row.RxBytes)
            $app.TxBytes = Add-MeterMonitorBytes $app.TxBytes ([long]$row.TxBytes)
            $app.TotalBytes = Add-MeterMonitorBytes $app.RxBytes $app.TxBytes
            if ($row.Estimated) { $app.Estimated = $true }
        }
        $Result.Rows = [object[]]@($byApp.Values | Sort-Object -Property TotalBytes -Descending)
        return $Result
    } catch {
        return $Result
    }
}

function Read-MeterProxySettings {
    [CmdletBinding()]
    param([Parameter(Mandatory = $true)][string]$DataDirectory)
    $names = [Collections.Generic.List[string]]::new()
    try {
        $path = Join-Path ([IO.Path]::GetFullPath($DataDirectory)) 'settings.json'
        if ([IO.File]::Exists($path)) {
            $stream = [IO.File]::Open($path, 'Open', 'Read', ([IO.FileShare]::ReadWrite -bor [IO.FileShare]::Delete))
            $reader = $null
            try {
                if ($stream.Length -le 2097152) {
                    $reader = [IO.StreamReader]::new($stream, [Text.Encoding]::UTF8, $true)
                    $settings = $reader.ReadToEnd() | ConvertFrom-Json -ErrorAction Stop
                    if ($null -ne $settings -and $null -ne $settings.PSObject.Properties['Proxy'] -and $null -ne $settings.Proxy) {
                        $proxyProperty = $settings.Proxy.PSObject.Properties['ProcessNames']
                        if ($null -ne $proxyProperty -and $proxyProperty.Value -is [array]) {
                            foreach ($name in $proxyProperty.Value) {
                                if ($name -isnot [string]) { continue }
                                $key = Get-MeterProcessKey $name
                                if ($key) { [void]$names.Add($key) }
                            }
                        }
                    }
                }
            } finally {
                if ($null -ne $reader) { $reader.Dispose() } else { $stream.Dispose() }
            }
        }
    } catch { }
    return [pscustomobject]@{ ProcessNames = [string[]]$names.ToArray() }
}

Export-ModuleMember -Function Get-MeterProxyClientSample, Update-MeterProxyDay, Read-MeterProxyClients, Save-MeterProxyClients, Remove-MeterExpiredProxyDays, Repair-MeterProxyAttribution
