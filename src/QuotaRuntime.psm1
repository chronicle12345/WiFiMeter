#requires -Version 5.1
Set-StrictMode -Version Latest

function New-MeterQuotaLedger {
    [pscustomobject]@{ Version = 1; Networks = @(); Notices = @() }
}

function Read-MeterQuotaLedger {
    param([Parameter(Mandatory)]$State)
    if ($null -eq $State.PSObject.Properties['QuotaLedger']) { return New-MeterQuotaLedger }
    $ledger = $State.QuotaLedger
    if ($ledger.Version -ne 1 -or $ledger.Networks -isnot [array] -or $ledger.Notices -isnot [array]) { throw 'Invalid quota ledger.' }
    $identities = [Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
    foreach ($entry in $ledger.Networks) {
        [decimal]$bytes = 0
        if ($entry.SSID -isnot [string] -or $entry.PeriodKey -isnot [string] -or
            $entry.PeriodKey -cnotmatch '^(All|Day:\d{4}-\d{2}-\d{2}|Month:\d{4}-\d{2})$' -or
            -not [decimal]::TryParse([string]$entry.UsedBytes, [ref]$bytes) -or $bytes -lt 0 -or [decimal]::Truncate($bytes) -ne $bytes -or
            -not $identities.Add($entry.SSID)) { throw 'Invalid quota counter.' }
    }
    foreach ($notice in $ledger.Notices) {
        if ($notice.Key -isnot [string] -or $notice.Id -isnot [string]) { throw 'Invalid quota notification.' }
    }
    return $ledger
}

function Update-MeterQuotaLedger {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]$Ledger,
        [Parameter(Mandatory)]$State,
        [Parameter(Mandatory)]$Preferences,
        [object[]]$Deltas = @(),
        [DateTimeOffset]$Timestamp = [DateTimeOffset]::Now
    )
    $actions = [Collections.Generic.List[object]]::new()
    $records = [Collections.Generic.List[object]]::new()
    $activeNoticeKeys = [Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
    foreach ($policy in $Preferences.Networks) {
        $key = switch ($policy.Period) {
            'Day' { 'Day:' + $Timestamp.ToLocalTime().ToString('yyyy-MM-dd') }
            'Month' { 'Month:' + $Timestamp.ToLocalTime().ToString('yyyy-MM') }
            default { 'All' }
        }
        $entry = $null
        foreach ($candidate in $Ledger.Networks) {
            if ($candidate.SSID -ceq $policy.SSID -and $candidate.PeriodKey -ceq $key) { $entry = $candidate; break }
        }
        if ($null -eq $entry) {
            # Seed from retained history. Future increments are independent of history pruning.
            $period = if ($policy.Period -eq 'Day') { 'Today' } else { $policy.Period }
            [decimal]$used = 0
            foreach ($row in @(Get-MeterRows -State $State -Period $period -Now $Timestamp)) {
                if ($row.SSID -ceq $policy.SSID) { $used = [decimal]$row.RxBytes + [decimal]$row.TxBytes; break }
            }
            $entry = [pscustomobject]@{ SSID = $policy.SSID; PeriodKey = $key; UsedBytes = $used }
        } else {
            foreach ($delta in $Deltas) {
                if ($delta.SSID -ceq $policy.SSID) {
                    $entry.UsedBytes = [decimal]$entry.UsedBytes + [decimal]$delta.RxBytes + [decimal]$delta.TxBytes
                }
            }
        }
        $records.Add($entry)
        [decimal]$limit = [decimal]$policy.LimitGB * 1000000000
        if ($limit -le 0) { continue }
        $noticePrefix = $policy.SSID + [char]0 + $key + [char]0 + $limit.ToString([cultureinfo]::InvariantCulture) + ':' + $policy.WarnPercent.ToString([cultureinfo]::InvariantCulture) + ':'
        [void]$activeNoticeKeys.Add($noticePrefix + 'Warning')
        [void]$activeNoticeKeys.Add($noticePrefix + 'Limit')
        [double]$percent = [double]([decimal]$entry.UsedBytes / $limit * 100)
        if ($percent -lt $policy.WarnPercent -and $percent -lt 100) { continue }
        $type = if ($percent -ge 100) { 'Limit' } else { 'Warning' }
        $noticeKey = $noticePrefix + $type
        $known = @($Ledger.Notices | Where-Object { $_.Key -ceq $noticeKey }).Count -gt 0
        $notice = $null
        if (-not $known) {
            $notice = [pscustomobject]@{
                Key = $noticeKey; Id = [guid]::NewGuid().ToString('N'); SSID = $policy.SSID
                Alias = $policy.Alias; Type = $type; Percent = $percent
                UsedBytes = [decimal]$entry.UsedBytes; LimitBytes = $limit; Timestamp = $Timestamp.ToString('o')
            }
            $Ledger.Notices = @($Ledger.Notices) + @($notice)
        }
        $actions.Add([pscustomobject]@{
            SSID = $policy.SSID; Alias = $policy.Alias; Percent = $percent
            Disconnect = ($percent -ge 100 -and $policy.DisconnectAtLimit); Notice = $notice
        })
    }
    $Ledger.Networks = $records.ToArray()
    # Keep at most two acknowledgement records per active policy, without limiting network count.
    $Ledger.Notices = @($Ledger.Notices | Where-Object { $activeNoticeKeys.Contains($_.Key) })
    return $actions.ToArray()
}

function Disconnect-MeterWifi {
    [CmdletBinding()]
    param([Parameter(Mandatory)][guid]$AdapterId, [Parameter(Mandatory)][string]$SSID)
    if (-not ('WiFiMeter.Networking.WirelessControl' -as [type])) {
        Add-Type -Path (Join-Path $PSScriptRoot 'NetworkControl.cs') -ErrorAction Stop
    }
    return [WiFiMeter.Networking.WirelessControl]::DisconnectIfConnected($AdapterId, $SSID)
}

Export-ModuleMember -Function New-MeterQuotaLedger, Read-MeterQuotaLedger, Update-MeterQuotaLedger, Disconnect-MeterWifi
