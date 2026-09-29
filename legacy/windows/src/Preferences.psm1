#requires -Version 5.1
Set-StrictMode -Version Latest
Import-Module (Join-Path $PSScriptRoot 'Storage.psm1') -Scope Local

function ConvertTo-MeterPropertyMap {
    param([Parameter(Mandatory)]$Value)
    $properties = [ordered]@{}
    if ($Value -is [System.Collections.IDictionary]) {
        foreach ($key in $Value.Keys) { $properties[[string]$key] = $Value[$key] }
    } elseif ($Value -is [System.Management.Automation.PSCustomObject]) {
        foreach ($property in $Value.PSObject.Properties) { $properties[$property.Name] = $property.Value }
    } else { throw 'Settings must be a JSON object.' }
    return $properties
}

function Test-MeterNumber {
    param($Value)
    return ($Value -is [byte] -or $Value -is [int16] -or $Value -is [int] -or
        $Value -is [long] -or $Value -is [float] -or $Value -is [double] -or $Value -is [decimal])
}

function ConvertTo-ValidatedMeterNetwork {
    param([Parameter(Mandatory)]$Network)
    $value = ConvertTo-MeterPropertyMap $Network
    if (-not $value.Contains('SSID') -or $value.SSID -isnot [string]) { throw 'A network setting requires its original SSID.' }
    $defaults = [ordered]@{ Alias = ''; LimitGB = 0; Period = 'Month'; WarnPercent = 80; DisconnectAtLimit = $false }
    foreach ($key in $defaults.Keys) {
        if (-not $value.Contains($key)) { $value[$key] = $defaults[$key] }
    }
    if ($value.Alias -isnot [string] -or $value.Alias.Length -gt 80 -or $value.Alias -match '[\x00-\x1f\x7f]') {
        throw 'A network alias must contain no more than 80 characters and no control characters.'
    }
    if (-not (Test-MeterNumber $value.LimitGB) -or [double]::IsNaN([double]$value.LimitGB) -or
        [double]::IsInfinity([double]$value.LimitGB) -or $value.LimitGB -lt 0 -or $value.LimitGB -gt 9000000000) {
        throw 'The traffic limit must be a number from 0 to 9000000000 GB.'
    }
    if ($value.LimitGB -gt 0 -and $value.LimitGB -lt 0.000000001) { throw 'An enabled traffic limit must be at least one byte.' }
    if ($value.Period -isnot [string] -or $value.Period -cnotin @('Day', 'Month', 'All')) {
        throw 'The quota period must be Day, Month, or All.'
    }
    if (-not (Test-MeterNumber $value.WarnPercent) -or [double]::IsNaN([double]$value.WarnPercent) -or
        [double]::IsInfinity([double]$value.WarnPercent) -or $value.WarnPercent -lt 1 -or $value.WarnPercent -gt 100) {
        throw 'The warning threshold must be a number from 1 to 100 percent.'
    }
    if ($value.DisconnectAtLimit -isnot [bool]) { throw 'DisconnectAtLimit must be true or false.' }
    $value.LimitGB = [decimal]$value.LimitGB
    $value.WarnPercent = [decimal]$value.WarnPercent
    return [pscustomobject]$value
}

function ConvertTo-ValidatedMeterPreferences {
    param([Parameter(Mandatory)]$Preferences)
    $value = ConvertTo-MeterPropertyMap $Preferences
    $defaults = [ordered]@{ Language = 'en'; RetentionDays = 0; Networks = @() }
    foreach ($key in $defaults.Keys) {
        if (-not $value.Contains($key)) { $value[$key] = $defaults[$key] }
    }
    if ($value.Language -isnot [string] -or $value.Language -cnotin @('en', 'zh-CN')) {
        throw 'The language must be en or zh-CN.'
    }
    if (($value.RetentionDays -isnot [int] -and $value.RetentionDays -isnot [long]) -or
        $value.RetentionDays -lt 0 -or $value.RetentionDays -gt 36500) {
        throw 'Record retention must be a whole number from 0 to 36500 days.'
    }
    if ($value.Networks -isnot [array]) { throw 'Network settings must be an array.' }
    $names = [System.Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
    $networks = @(
        foreach ($network in $value.Networks) {
            $validated = ConvertTo-ValidatedMeterNetwork $network
            if (-not $names.Add($validated.SSID)) { throw 'The settings contain a duplicate SSID.' }
            $validated
        }
    )
    $value.RetentionDays = [int]$value.RetentionDays
    $value.Networks = $networks
    return [pscustomobject]$value
}

function Read-MeterPreferences {
    [CmdletBinding()]
    param([Parameter(Mandatory)][string]$DataDirectory)
    $path = Join-Path ([IO.Path]::GetFullPath($DataDirectory)) 'settings.json'
    if (-not [IO.File]::Exists($path)) { return (ConvertTo-ValidatedMeterPreferences ([pscustomobject]@{})) }
    $stream = $null
    $reader = $null
    try {
        # Readers keep the old snapshot open while a writer replaces settings.json.
        $stream = [IO.File]::Open($path, [IO.FileMode]::Open, [IO.FileAccess]::Read, ([IO.FileShare]::ReadWrite -bor [IO.FileShare]::Delete))
        $reader = [IO.StreamReader]::new($stream, [Text.Encoding]::UTF8, $true)
        $value = $reader.ReadToEnd() | ConvertFrom-Json -ErrorAction Stop
        if ($null -eq $value) { throw 'The settings file is empty.' }
        return (ConvertTo-ValidatedMeterPreferences $value)
    } catch { throw "Cannot read settings.json: $($_.Exception.Message)" }
    finally {
        if ($null -ne $reader) { $reader.Dispose() }
        elseif ($null -ne $stream) { $stream.Dispose() }
    }
}

function Write-MeterPreferencesFile {
    param([string]$DataDirectory, $Preferences)
    [void][IO.Directory]::CreateDirectory($DataDirectory)
    $path = Join-Path $DataDirectory 'settings.json'
    $temporary = $path + '.' + [guid]::NewGuid().ToString('N') + '.tmp'
    $stream = $null
    try {
        $encoding = [Text.UTF8Encoding]::new($true)
        $bytes = $encoding.GetBytes(($Preferences | ConvertTo-Json -Depth 16))
        $stream = [IO.File]::Open($temporary, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
        $preamble = $encoding.GetPreamble()
        $stream.Write($preamble, 0, $preamble.Length)
        $stream.Write($bytes, 0, $bytes.Length)
        $stream.Flush($true)
        $stream.Dispose(); $stream = $null
        if ([IO.File]::Exists($path)) {
            Invoke-MeterFileReplace -Source $temporary -Destination $path
        } else { [IO.File]::Move($temporary, $path) }
    } finally {
        if ($null -ne $stream) { $stream.Dispose() }
        if ([IO.File]::Exists($temporary)) { [IO.File]::Delete($temporary) }
    }
}

function Update-MeterPreferences {
    param([string]$DataDirectory, [scriptblock]$Update)
    $directory = [IO.Path]::GetFullPath($DataDirectory)
    if ($directory.Length -gt [IO.Path]::GetPathRoot($directory).Length) {
        $directory = $directory.TrimEnd('\', '/')
    }
    $sha = [Security.Cryptography.SHA256]::Create()
    try {
        $identity = ([BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($directory.ToUpperInvariant())))).Replace('-', '')
    } finally { $sha.Dispose() }
    $mutex = [Threading.Mutex]::new($false, ('Local\WiFiMeterPreferences_' + $identity))
    $locked = $false
    try {
        try { $locked = $mutex.WaitOne(10000) }
        catch [Threading.AbandonedMutexException] { $locked = $true }
        if (-not $locked) { throw 'Another settings update is still running. Please try again.' }
        $preferences = Read-MeterPreferences -DataDirectory $directory
        $updated = & $Update $preferences
        $validated = ConvertTo-ValidatedMeterPreferences $updated
        Write-MeterPreferencesFile -DataDirectory $directory -Preferences $validated
        return $validated
    } finally {
        if ($locked) { $mutex.ReleaseMutex() }
        $mutex.Dispose()
    }
}

function Save-MeterPreferences {
    [CmdletBinding()]
    param([Parameter(Mandatory)][string]$DataDirectory, [Parameter(Mandatory)]$Preferences)
    $changes = ConvertTo-MeterPropertyMap $Preferences
    return Update-MeterPreferences -DataDirectory $DataDirectory -Update {
        param($existing)
        $merged = ConvertTo-MeterPropertyMap $existing
        foreach ($key in $changes.Keys) { $merged[$key] = $changes[$key] }
        return [pscustomobject]$merged
    }
}

function Get-MeterNetworkPreference {
    [CmdletBinding()]
    param([Parameter(Mandatory)]$Preferences, [Parameter(Mandatory)][AllowEmptyString()][string]$SSID)
    $validated = ConvertTo-ValidatedMeterPreferences $Preferences
    foreach ($network in $validated.Networks) {
        if ([string]::Equals($network.SSID, $SSID, [StringComparison]::Ordinal)) { return $network }
    }
    return (ConvertTo-ValidatedMeterNetwork ([pscustomobject]@{ SSID = $SSID }))
}

function Set-MeterNetworkPreference {
    [CmdletBinding()]
    param([Parameter(Mandatory)][string]$DataDirectory, [Parameter(Mandatory)]$Network)
    $validatedNetwork = ConvertTo-ValidatedMeterNetwork $Network
    return Update-MeterPreferences -DataDirectory $DataDirectory -Update {
        param($existing)
        $replaced = $false
        $existing.Networks = @(
            foreach ($item in $existing.Networks) {
                if ([string]::Equals($item.SSID, $validatedNetwork.SSID, [StringComparison]::Ordinal)) {
                    $validatedNetwork
                    $replaced = $true
                } else { $item }
            }
            if (-not $replaced) { $validatedNetwork }
        )
        return $existing
    }
}

function Set-MeterRetention {
    [CmdletBinding()]
    param([Parameter(Mandatory)][string]$DataDirectory, [Parameter(Mandatory)][ValidateRange(0, 36500)][int]$Days)
    return Update-MeterPreferences -DataDirectory $DataDirectory -Update {
        param($existing)
        $existing.RetentionDays = $Days
        return $existing
    }
}

function Set-MeterLanguagePreference {
    [CmdletBinding()]
    param([Parameter(Mandatory)][string]$DataDirectory, [Parameter(Mandatory)][ValidateSet('en', 'zh-CN')][string]$Language)
    return Update-MeterPreferences -DataDirectory $DataDirectory -Update {
        param($existing)
        $existing.Language = $Language
        return $existing
    }
}

function Get-MeterQuotaActions {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]$State,
        [Parameter(Mandatory)]$Preferences,
        [DateTimeOffset]$Timestamp = [DateTimeOffset]::Now
    )
    $validated = ConvertTo-ValidatedMeterPreferences $Preferences
    $networks = [System.Collections.Generic.Dictionary[string,object]]::new([StringComparer]::Ordinal)
    foreach ($network in $State.Networks) { $networks[$network.SSID] = $network }
    $today = $Timestamp.ToLocalTime().ToString('yyyy-MM-dd', [cultureinfo]::InvariantCulture)
    $month = $today.Substring(0, 7)
    foreach ($preference in $validated.Networks) {
        if ($preference.LimitGB -le 0 -or -not $networks.ContainsKey($preference.SSID)) { continue }
        $network = $networks[$preference.SSID]
        [decimal]$used = 0
        if ($preference.Period -ceq 'All') {
            $used = [decimal]$network.RxBytes + [decimal]$network.TxBytes
            $periodKey = 'All'
        } else {
            $periodKey = if ($preference.Period -ceq 'Day') { 'Day:' + $today } else { 'Month:' + $month }
            foreach ($day in $network.Days) {
                if (($preference.Period -ceq 'Day' -and $day.Date -ceq $today) -or
                    ($preference.Period -ceq 'Month' -and $day.Date.StartsWith($month, [StringComparison]::Ordinal))) {
                    $used += [decimal]$day.RxBytes + [decimal]$day.TxBytes
                }
            }
        }
        [decimal]$limit = $preference.LimitGB * [decimal]1000000000
        [decimal]$percent = ($used / $limit) * 100
        $warning = $percent -ge $preference.WarnPercent
        if (-not $warning -and $used -lt $limit) { continue }
        [pscustomobject]@{
            SSID = $preference.SSID
            Alias = $preference.Alias
            PeriodKey = $periodKey
            UsedBytes = $used
            LimitBytes = $limit
            Percent = $percent
            Warning = $warning
            Disconnect = ($preference.DisconnectAtLimit -and $used -ge $limit)
        }
    }
}

function Remove-MeterExpiredRecords {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]$State,
        [Parameter(Mandatory)][ValidateRange(0, 36500)][int]$RetentionDays,
        [DateTimeOffset]$Timestamp = [DateTimeOffset]::Now
    )
    if ($RetentionDays -eq 0) { return 0 }
    $today = $Timestamp.ToLocalTime().Date
    $offset = [Math]::Min(($RetentionDays - 1), ($today - [datetime]::MinValue).Days)
    $cutoff = $today.AddDays(-$offset).ToString('yyyy-MM-dd', [cultureinfo]::InvariantCulture)
    $removed = 0
    foreach ($network in $State.Networks) {
        $kept = @($network.Days | Where-Object { [string]::CompareOrdinal($_.Date, $cutoff) -ge 0 })
        $removed += @($network.Days).Count - $kept.Count
        [decimal]$rx = 0; [decimal]$tx = 0
        foreach ($day in $kept) { $rx += [decimal]$day.RxBytes; $tx += [decimal]$day.TxBytes }
        $network.RxBytes = [long]$rx
        $network.TxBytes = [long]$tx
        $network.Days = $kept
    }
    return $removed
}

Export-ModuleMember -Function Read-MeterPreferences, Save-MeterPreferences, Get-MeterNetworkPreference, Set-MeterNetworkPreference, Set-MeterRetention, Set-MeterLanguagePreference, Get-MeterQuotaActions, Remove-MeterExpiredRecords
