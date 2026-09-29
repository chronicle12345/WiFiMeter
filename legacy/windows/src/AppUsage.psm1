#requires -Version 5.1
Set-StrictMode -Version 2
Import-Module (Join-Path $PSScriptRoot 'Storage.psm1') -Scope Local

$script:AppDayCache = [Collections.Generic.Dictionary[string,object]]::new([StringComparer]::Ordinal)
$script:AppAsTaskMethod = $null

function Get-MeterAppNow { [DateTimeOffset]::Now }

function Read-MeterAppJson([string]$Path, [long]$MaximumBytes = 2097152) {
    if (-not [IO.File]::Exists($Path)) { return $null }
    $stream = [IO.File]::Open($Path, 'Open', 'Read', ([IO.FileShare]::ReadWrite -bor [IO.FileShare]::Delete))
    $reader = $null
    try {
        if ($stream.Length -gt $MaximumBytes) { throw 'The application usage metadata file is too large.' }
        $reader = [IO.StreamReader]::new($stream, [Text.Encoding]::UTF8, $true)
        return ($reader.ReadToEnd() | ConvertFrom-Json -ErrorAction Stop)
    }
    finally {
        if ($null -ne $reader) { $reader.Dispose() } else { $stream.Dispose() }
    }
}

function Get-MeterAppConnectionProfiles {
    Add-Type -AssemblyName System.Runtime.WindowsRuntime -ErrorAction Stop
    return [Windows.Networking.Connectivity.NetworkInformation, Windows.Networking.Connectivity, ContentType = WindowsRuntime]::GetConnectionProfiles()
}

function Get-MeterAppProfileKey($Profile) {
    if ($null -eq $Profile.NetworkAdapter -or [string]::IsNullOrEmpty($Profile.ProfileName)) { return '' }
    return ([guid]$Profile.NetworkAdapter.NetworkAdapterId).ToString('D') + "`n" + [string]$Profile.ProfileName
}

function Read-MeterAppProfiles([string]$DataDirectory) {
    $map = [Collections.Generic.Dictionary[string,object]]::new([StringComparer]::Ordinal)
    try {
        $saved = Read-MeterAppJson (Join-Path $DataDirectory 'app-usage-profiles.json')
        if ($null -ne $saved -and $saved.SchemaVersion -eq 1 -and $saved.Profiles -is [array]) {
            foreach ($item in $saved.Profiles) {
                if ($item.Key -is [string] -and $item.Key.Length -le 1024 -and
                    $item.SSID -is [string] -and $item.SSID.Length -gt 0 -and $item.SSID.Length -le 128) {
                    $map[$item.Key] = $item
                }
                if ($map.Count -ge 512) { break }
            }
        }
    } catch { }
    return ,$map
}

function New-MeterAppMutex([string]$DataDirectory, [string]$Purpose) {
    $sha = [Security.Cryptography.SHA256]::Create()
    try {
        $path = [IO.Path]::GetFullPath($DataDirectory).TrimEnd('\').ToUpperInvariant()
        $identity = [BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($path))).Replace('-', '').Substring(0, 20)
    } finally { $sha.Dispose() }
    return [Threading.Mutex]::new($false, ('Local\WiFiMeterApp' + $Purpose + '_' + $identity))
}

function Get-MeterAppRetentionCutoff([string]$DataDirectory, [DateTimeOffset]$Now) {
    $cutoff = $Now.AddDays(-60)
    $settings = Read-MeterAppJson (Join-Path $DataDirectory 'settings.json')
    if ($null -ne $settings -and $null -ne $settings.PSObject.Properties['RetentionDays']) {
        $retention = [int]$settings.RetentionDays
        if ($retention -gt 0) {
            $retainedStart = [DateTimeOffset]$Now.LocalDateTime.Date.AddDays(1 - $retention)
            if ($retainedStart -gt $cutoff) { $cutoff = $retainedStart }
        }
    }
    return $cutoff
}

function Read-MeterAppCache([string]$DataDirectory, [DateTimeOffset]$Now, [DateTimeOffset]$Cutoff) {
    try {
        $cache = Read-MeterAppJson (Join-Path $DataDirectory 'app-usage.json') 8388608
        if ($null -eq $cache -or $cache.SchemaVersion -ne 1 -or $cache.Records -isnot [array] -or $cache.Records.Count -gt 4) { return }
        foreach ($record in $cache.Records) {
            try {
                if ($record.SSID -isnot [string] -or $record.SSID.Length -gt 128 -or $record.SSID.Length -eq 0) { continue }
                $rangeStart = [datetime]::ParseExact($record.StartDate, 'yyyy-MM-dd', [cultureinfo]::InvariantCulture)
                $rangeEnd = [datetime]::ParseExact($record.EndDate, 'yyyy-MM-dd', [cultureinfo]::InvariantCulture)
                $result = $record.Result
                $savedAt = [DateTimeOffset]::Parse($result.UpdatedAt, [cultureinfo]::InvariantCulture)
                $effectiveStart = [DateTimeOffset]::Parse($result.EffectiveStart, [cultureinfo]::InvariantCulture)
                $effectiveEnd = [DateTimeOffset]::Parse($result.EffectiveEnd, [cultureinfo]::InvariantCulture)
                if ($savedAt -gt $Now -or ($Now - $savedAt).TotalMinutes -ge 5 -or $effectiveStart -lt $Cutoff -or
                    $effectiveStart -ge $effectiveEnd -or $effectiveEnd -gt $savedAt -or $rangeStart -gt $rangeEnd -or
                    $result.Available -ne $true -or $result.MessageCode -notin @('Available', 'Partial', 'NoData') -or
                    $result.CompletedDays -ne $result.RequestedDays -or $result.RequestedDays -le 0 -or
                    $result.Rows -isnot [array] -or $result.Days -isnot [array] -or
                    $result.Rows.Count -gt 12000 -or $result.Days.Count -gt 12000) { continue }
                foreach ($row in @($result.Rows) + @($result.Days)) {
                    if ($row.AppId -isnot [string] -or $row.AppId.Length -gt 8192 -or $row.Name -isnot [string] -or $row.Name.Length -gt 1024 -or
                        [decimal]$row.RxBytes % 1 -ne 0 -or [decimal]$row.TxBytes % 1 -ne 0) { throw 'Invalid cached application record.' }
                    $row.RxBytes = [long]$row.RxBytes
                    $row.TxBytes = [long]$row.TxBytes
                    $total = Add-MeterAppBytes $row.RxBytes $row.TxBytes
                    if ($total -ne $row.TotalBytes) { throw 'Invalid cached application total.' }
                    $row.TotalBytes = $total
                }
                foreach ($row in $result.Days) {
                    $date = [datetime]::ParseExact($row.Date, 'yyyy-MM-dd', [cultureinfo]::InvariantCulture)
                    if ($date -lt $rangeStart -or $date -gt $rangeEnd) { throw 'Invalid cached application date.' }
                }
                $record
            } catch { }
        }
    } catch { }
}

function Save-MeterAppCache([string]$DataDirectory, $Record = $null) {
    $destination = Join-Path $DataDirectory 'app-usage.json'
    if ($null -eq $Record -and -not [IO.File]::Exists($destination)) { return }
    $mutex = New-MeterAppMutex $DataDirectory 'Cache'
    $owned = $false
    $temporary = $null
    try {
        try { $owned = $mutex.WaitOne(200) } catch [Threading.AbandonedMutexException] { $owned = $true }
        if (-not $owned) { return }
        $now = Get-MeterAppNow
        $cutoff = Get-MeterAppRetentionCutoff $DataDirectory $now
        $records = @(Read-MeterAppCache $DataDirectory $now $cutoff)
        if ($null -ne $Record -and [DateTimeOffset]::Parse($Record.Result.EffectiveStart, [cultureinfo]::InvariantCulture) -ge $cutoff) {
            $records = @($Record) + @($records | Where-Object {
                -not ([string]::Equals($_.SSID, $Record.SSID, [StringComparison]::Ordinal) -and
                    $_.StartDate -eq $Record.StartDate -and $_.EndDate -eq $Record.EndDate)
            })
        }
        $records = @($records | Select-Object -First 4)
        $json = ''
        while ($records.Count -gt 0) {
            $json = [pscustomobject]@{ SchemaVersion = 1; Records = [object[]]$records } | ConvertTo-Json -Depth 8 -Compress
            if ([Text.Encoding]::UTF8.GetByteCount($json) -le 8388605) { break }
            $records = @($records | Select-Object -First ($records.Count - 1))
        }
        if ($records.Count -eq 0) {
            if ([IO.File]::Exists($destination)) { [IO.File]::Delete($destination) }
            return
        }
        # Skip an identical maintenance write. This cache is disposable; it has no backup.
        if ([IO.File]::Exists($destination) -and [IO.File]::ReadAllText($destination) -ceq $json) { return }
        [void][IO.Directory]::CreateDirectory($DataDirectory)
        $temporary = $destination + '.' + [guid]::NewGuid().ToString('N') + '.tmp'
        [IO.File]::WriteAllText($temporary, $json, [Text.UTF8Encoding]::new($true))
        if ([IO.File]::Exists($destination)) { Invoke-MeterFileReplace -Source $temporary -Destination $destination }
        else { [IO.File]::Move($temporary, $destination) }
    }
    catch { Write-Verbose ('The application usage cache could not be saved: ' + $_.Exception.Message) }
    finally {
        if ($null -ne $temporary -and [IO.File]::Exists($temporary)) { [IO.File]::Delete($temporary) }
        if ($owned) { $mutex.ReleaseMutex() }
        $mutex.Dispose()
    }
}

function Update-MeterAppUsageProfiles {
    [CmdletBinding()]
    param([Parameter(Mandatory = $true)][string]$DataDirectory)

    $path = [IO.Path]::GetFullPath($DataDirectory)
    Save-MeterAppCache $path
    $mutex = New-MeterAppMutex $path 'Profiles'
    $owned = $false
    $temporary = $null
    try {
        try { $owned = $mutex.WaitOne(200) } catch [Threading.AbandonedMutexException] { $owned = $true }
        if (-not $owned) { return }
        $map = Read-MeterAppProfiles $path
        $changed = $false
        foreach ($profile in @(Get-MeterAppConnectionProfiles)) {
            try {
                if (-not $profile.IsWlanConnectionProfile) { continue }
                $ssid = [string]$profile.WlanConnectionProfileDetails.GetConnectedSsid()
                $key = Get-MeterAppProfileKey $profile
                if ([string]::IsNullOrEmpty($ssid) -or [string]::IsNullOrEmpty($key)) { continue }
                if (-not $map.ContainsKey($key) -or -not [string]::Equals($map[$key].SSID, $ssid, [StringComparison]::Ordinal)) {
                    $map[$key] = [pscustomobject]@{ Key = $key; SSID = $ssid }
                    $changed = $true
                }
            } catch { }
        }
        if (-not $changed) { return }
        [void][IO.Directory]::CreateDirectory($path)
        $destination = Join-Path $path 'app-usage-profiles.json'
        $temporary = $destination + '.' + [guid]::NewGuid().ToString('N') + '.tmp'
        $saved = [pscustomobject]@{ SchemaVersion = 1; Profiles = @($map.Values | Select-Object -Last 512) }
        [IO.File]::WriteAllText($temporary, ($saved | ConvertTo-Json -Depth 4), [Text.UTF8Encoding]::new($true))
        if ([IO.File]::Exists($destination)) { Invoke-MeterFileReplace -Source $temporary -Destination $destination }
        else { [IO.File]::Move($temporary, $destination) }
    }
    finally {
        if ($null -ne $temporary -and [IO.File]::Exists($temporary)) { [IO.File]::Delete($temporary) }
        if ($owned) { $mutex.ReleaseMutex() }
        $mutex.Dispose()
    }
}

function Start-MeterAppQuery($Profile, [DateTimeOffset]$Start, [DateTimeOffset]$End) {
    [Windows.Networking.Connectivity.AttributedNetworkUsage, Windows.Networking.Connectivity, ContentType = WindowsRuntime] | Out-Null
    [Windows.Networking.Connectivity.NetworkUsageStates, Windows.Networking.Connectivity, ContentType = WindowsRuntime] | Out-Null
    $states = New-Object Windows.Networking.Connectivity.NetworkUsageStates
    $states.Roaming = [Windows.Networking.Connectivity.TriStates]::DoNotCare
    $states.Shared = [Windows.Networking.Connectivity.TriStates]::DoNotCare
    if ($null -eq $script:AppAsTaskMethod) {
        $asTask = [System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
            $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
        } | Select-Object -First 1
        $script:AppAsTaskMethod = $asTask.MakeGenericMethod([Collections.Generic.IReadOnlyList[Windows.Networking.Connectivity.AttributedNetworkUsage]])
    }
    $operation = $Profile.GetAttributedNetworkUsageAsync($Start, $End, $states)
    try {
        $task = $script:AppAsTaskMethod.Invoke($null, @($operation))
        return [pscustomobject]@{ Operation = $operation; Task = $task }
    } catch { $operation.Cancel(); try { $operation.Close() } catch { }; throw }
}

function Read-MeterAppQuery($Query) {
    # Wait is called only after completion; it propagates asynchronous provider errors.
    [void]$Query.Task.Wait(0)
    $count = 0
    foreach ($usage in $Query.Task.Result) {
        if (++$count -gt 10000) { throw 'Windows returned too many application records.' }
        if ($usage.BytesReceived -gt [long]::MaxValue -or $usage.BytesSent -gt [long]::MaxValue) { throw 'The Windows byte count exceeded the supported range.' }
        $rx = [long]$usage.BytesReceived
        $tx = [long]$usage.BytesSent
        if ($rx -eq 0 -and $tx -eq 0) { continue }
        $id = [string]$usage.AttributionId
        if ([string]::IsNullOrWhiteSpace($id)) { $id = 'unattributed' }
        $name = [string]$usage.AttributionName
        if ([string]::IsNullOrWhiteSpace($name)) {
            try { $name = [IO.Path]::GetFileName($id) } catch { $name = $id }
            if ([string]::IsNullOrWhiteSpace($name)) { $name = $id }
        }
        $name = [regex]::Replace($name, '[\x00-\x1f\x7f]', ' ')
        if ($id.Length -gt 8192 -or $name.Length -gt 1024) { throw 'Windows returned an application identifier that is too long.' }
        [pscustomobject]@{ AppId = $id; Name = $name; RxBytes = $rx; TxBytes = $tx; TotalBytes = (Add-MeterAppBytes $rx $tx) }
    }
}

function Add-MeterAppBytes([long]$Left, [long]$Right) {
    $sum = [decimal]$Left + [decimal]$Right
    if ($Left -lt 0 -or $Right -lt 0 -or $sum -gt [long]::MaxValue) { throw 'Application byte counts exceeded the supported range.' }
    return [long]$sum
}

function New-MeterAppResult([string]$Code, [bool]$Available = $false) {
    $messages = @{
        Available = 'Windows application usage may be delayed and can differ from the adapter totals.'
        NoData = 'Windows has no application usage records for this network and date range yet.'
        ProfileUnavailable = 'This Wi-Fi profile could not be matched to an observed SSID. Connect to it once while WiFiMeter is running.'
        AccessDenied = 'Windows did not allow application usage access for this profile.'
        Timeout = 'Windows did not finish the application usage request in time. Try a shorter date range.'
        RecordLimit = 'This interval contains too many daily application records. Select a shorter date range.'
        Partial = 'Only part of the selected interval is available. Windows history is limited to the most recent 60 days; saved-record settings also apply.'
        OutsideAvailableRange = 'This interval is outside the retained tracking dates or the Windows 60-day history window.'
        Unavailable = 'Windows application usage could not be read for this network.'
    }
    return [pscustomobject]@{
        Available = $Available; Message = $messages[$Code]; MessageCode = $Code
        Source = 'Windows.Networking.Connectivity'; Rows = [object[]]@(); Days = [object[]]@()
        UpdatedAt = (Get-MeterAppNow).ToUniversalTime().ToString('o')
        Partial = $false; EffectiveStart = ''; EffectiveEnd = ''; CompletedDays = 0; RequestedDays = 0
    }
}

function Get-MeterAppUsage {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][ValidateNotNullOrEmpty()][string]$SSID,
        [Parameter(Mandatory = $true)][datetime]$StartDate,
        [Parameter(Mandatory = $true)][datetime]$EndDate,
        [Parameter(Mandatory = $true)][string]$DataDirectory,
        [ValidateRange(500, 60000)][int]$TimeoutMilliseconds = 15000
    )

    if ($StartDate.Date -gt $EndDate.Date) { throw 'The start date must be on or before the end date.' }
    $now = Get-MeterAppNow
    $start = [DateTimeOffset]$StartDate.Date
    $requestedStart = $start
    $end = [DateTimeOffset]$EndDate.Date.AddDays(1)
    if ($end -gt $now) { $end = $now }
    try {
        $cutoff = Get-MeterAppRetentionCutoff $DataDirectory $now
        $state = Read-MeterAppJson (Join-Path $DataDirectory 'state.json') 67108864
        if ($null -ne $state -and $null -ne $state.PSObject.Properties['StartedAt']) {
            $trackedStart = [DateTimeOffset]::Parse($state.StartedAt, [cultureinfo]::InvariantCulture)
            if ($trackedStart -gt $cutoff) { $cutoff = $trackedStart }
        }
    } catch { return (New-MeterAppResult 'Unavailable') }
    if ($start -lt $cutoff) { $start = $cutoff }
    if ($start -ge $end) { return (New-MeterAppResult 'OutsideAvailableRange') }

    foreach ($record in @(Read-MeterAppCache $DataDirectory $now $cutoff)) {
        if ([string]::Equals($record.SSID, $SSID, [StringComparison]::Ordinal) -and
            $record.StartDate -eq $StartDate.Date.ToString('yyyy-MM-dd') -and $record.EndDate -eq $EndDate.Date.ToString('yyyy-MM-dd') -and
            [DateTimeOffset]::Parse($record.Result.EffectiveStart, [cultureinfo]::InvariantCulture) -eq $start) {
            return $record.Result
        }
    }

    $profiles = [Collections.Generic.List[object]]::new()
    try {
        $map = Read-MeterAppProfiles $DataDirectory
        $seen = [Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
        foreach ($profile in @(Get-MeterAppConnectionProfiles)) {
            if (-not $profile.IsWlanConnectionProfile) { continue }
            $key = Get-MeterAppProfileKey $profile
            if ([string]::IsNullOrEmpty($key) -or -not $seen.Add($key)) { continue }
            $name = ''
            try { $name = [string]$profile.WlanConnectionProfileDetails.GetConnectedSsid() } catch { }
            if ([string]::IsNullOrEmpty($name) -and $map.ContainsKey($key)) { $name = [string]$map[$key].SSID }
            if ([string]::Equals($name, $SSID, [StringComparison]::Ordinal)) {
                $profiles.Add([pscustomobject]@{ Profile = $profile; Key = $key })
            }
        }
    } catch { return (New-MeterAppResult 'Unavailable') }
    if ($profiles.Count -eq 0) { return (New-MeterAppResult 'ProfileUnavailable') }
    if ($profiles.Count -gt 64) { return (New-MeterAppResult 'Unavailable') }

    # The UI calls this function from a worker runspace. Keep at most four native
    # requests active and cancel them when the complete request budget expires.
    $queue = [Collections.Generic.Queue[object]]::new()
    $days = [Collections.Generic.List[object]]::new()
    $completed = 0
    $requested = 0
    $directoryKey = [IO.Path]::GetFullPath($DataDirectory)
    foreach ($key in @($script:AppDayCache.Keys)) {
        if (($now - $script:AppDayCache[$key].Time).TotalMinutes -ge 5 -or $script:AppDayCache[$key].Start -lt $cutoff) {
            [void]$script:AppDayCache.Remove($key)
        }
    }
    if ($script:AppDayCache.Count -gt 1024) { $script:AppDayCache.Clear() }
    $cachedRowCount = 0
    foreach ($item in $script:AppDayCache.Values) { $cachedRowCount += $item.Rows.Count }
    if ($cachedRowCount -gt 12000) { $script:AppDayCache.Clear(); $cachedRowCount = 0 }
    for ($day = $start.LocalDateTime.Date; $day -lt $end.LocalDateTime; $day = $day.AddDays(1)) {
        $dayStart = [DateTimeOffset]$day
        if ($dayStart -lt $start) { $dayStart = $start }
        $dayEnd = [DateTimeOffset]$day.AddDays(1)
        if ($dayEnd -gt $end) { $dayEnd = $end }
        foreach ($profile in $profiles) {
            $requested++
            $cacheKey = $directoryKey + "`n" + $SSID + "`n" + $profile.Key + "`n" + $dayStart.ToString('o') + "`n" + $EndDate.Date.ToString('yyyy-MM-dd')
            $entry = [pscustomobject]@{ Profile = $profile.Profile; Start = $dayStart; End = $dayEnd; Date = $day.ToString('yyyy-MM-dd'); Key = $cacheKey }
            if ($script:AppDayCache.ContainsKey($cacheKey)) {
                foreach ($row in $script:AppDayCache[$cacheKey].Rows) { $days.Add($row) }
                $completed++
            } else { $queue.Enqueue($entry) }
        }
    }
    $pending = [Collections.Generic.List[object]]::new()
    $timer = [Diagnostics.Stopwatch]::StartNew()
    $failure = ''
    $recordLimitReached = $false
    try {
        while (($queue.Count -gt 0 -or $pending.Count -gt 0) -and $timer.ElapsedMilliseconds -lt $TimeoutMilliseconds -and -not $recordLimitReached) {
            while ($queue.Count -gt 0 -and $pending.Count -lt 4) {
                $entry = $queue.Dequeue()
                try {
                    $query = Start-MeterAppQuery $entry.Profile $entry.Start $entry.End
                    $pending.Add([pscustomobject]@{ Entry = $entry; Query = $query })
                } catch { $failure = 'Unavailable' }
            }
            $progress = $false
            for ($index = $pending.Count - 1; $index -ge 0; $index--) {
                $item = $pending[$index]
                if (-not $item.Query.Task.IsCompleted) { continue }
                $progress = $true
                $pending.RemoveAt($index)
                try {
                    $entries = [Collections.Generic.List[object]]::new()
                    foreach ($row in @(Read-MeterAppQuery $item.Query)) {
                        if ($days.Count + $entries.Count -ge 12000) {
                            $recordLimitReached = $true
                            throw 'Windows returned too many daily application records. Select a shorter date range.'
                        }
                        $entries.Add([pscustomobject]@{ Date = $item.Entry.Date; AppId = $row.AppId; Name = $row.Name; RxBytes = [long]$row.RxBytes; TxBytes = [long]$row.TxBytes; TotalBytes = [long]$row.TotalBytes })
                    }
                    foreach ($row in $entries) { $days.Add($row) }
                    if ($cachedRowCount + $entries.Count -gt 12000) { $script:AppDayCache.Clear(); $cachedRowCount = 0 }
                    $script:AppDayCache[$item.Entry.Key] = [pscustomobject]@{ Time = $now; Start = $item.Entry.Start; Rows = [object[]]$entries.ToArray() }
                    $cachedRowCount += $entries.Count
                    $completed++
                }
                catch {
                    $exception = $_.Exception
                    while ($null -ne $exception.InnerException) { $exception = $exception.InnerException }
                    if ($exception -is [UnauthorizedAccessException] -or $exception.HResult -eq -2147024891) { $failure = 'AccessDenied' }
                    else { $failure = 'Unavailable' }
                }
                finally { try { $item.Query.Operation.Close() } catch { } }
            }
            if (-not $progress -and $pending.Count -gt 0) { Start-Sleep -Milliseconds 20 }
        }
        if (-not $recordLimitReached -and ($queue.Count -gt 0 -or $pending.Count -gt 0)) { $failure = 'Timeout' }
    }
    finally {
        foreach ($item in $pending) {
            try { $item.Query.Operation.Cancel() } catch { }
            try { $item.Query.Operation.Close() } catch { }
        }
        $timer.Stop()
    }
    if ($recordLimitReached) { return (New-MeterAppResult 'RecordLimit') }
    if ($completed -eq 0 -and $failure.Length -gt 0) { return (New-MeterAppResult $failure) }

    $byDay = [Collections.Generic.Dictionary[string,object]]::new([StringComparer]::Ordinal)
    $byApp = [Collections.Generic.Dictionary[string,object]]::new([StringComparer]::Ordinal)
    foreach ($row in $days) {
        $key = $row.Date + "`n" + $row.AppId
        if (-not $byDay.ContainsKey($key)) {
            $byDay[$key] = [pscustomobject]@{ Date = $row.Date; AppId = $row.AppId; Name = $row.Name; RxBytes = [long]0; TxBytes = [long]0; TotalBytes = [long]0 }
        }
        if (-not $byApp.ContainsKey($row.AppId)) {
            $byApp[$row.AppId] = [pscustomobject]@{ AppId = $row.AppId; Name = $row.Name; RxBytes = [long]0; TxBytes = [long]0; TotalBytes = [long]0 }
        }
        foreach ($target in @($byDay[$key], $byApp[$row.AppId])) {
            $target.RxBytes = Add-MeterAppBytes $target.RxBytes $row.RxBytes
            $target.TxBytes = Add-MeterAppBytes $target.TxBytes $row.TxBytes
            $target.TotalBytes = Add-MeterAppBytes $target.RxBytes $target.TxBytes
        }
    }
    $partial = $start -gt $requestedStart -or $completed -lt $requested
    $code = 'Available'
    if ($partial) { $code = 'Partial' } elseif ($byApp.Count -eq 0) { $code = 'NoData' }
    $result = New-MeterAppResult $code $true
    $result.Partial = $partial
    $result.Rows = [object[]]@($byApp.Values | Sort-Object TotalBytes -Descending)
    $result.Days = [object[]]@($byDay.Values | Sort-Object Date, @{ Expression = 'TotalBytes'; Descending = $true })
    $result.EffectiveStart = $start.ToString('o')
    $result.EffectiveEnd = $end.ToString('o')
    $result.CompletedDays = $completed
    $result.RequestedDays = $requested
    if ($completed -eq $requested -and $result.Rows.Count -le 12000 -and $result.Days.Count -le 12000) {
        Save-MeterAppCache $DataDirectory ([pscustomobject]@{
            SSID = $SSID; StartDate = $StartDate.Date.ToString('yyyy-MM-dd'); EndDate = $EndDate.Date.ToString('yyyy-MM-dd'); Result = $result
        })
    }
    return $result
}

Export-ModuleMember -Function Get-MeterAppUsage, Update-MeterAppUsageProfiles
