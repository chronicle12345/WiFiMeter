#requires -Version 5.1
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$root = Split-Path $PSScriptRoot -Parent
foreach ($module in @('Core', 'Preferences', 'QuotaRuntime')) { Import-Module (Join-Path $root ('src\' + $module + '.psm1')) -Force }
function Assert($Condition, [string]$Message) { if (-not $Condition) { throw ('FAIL: ' + $Message) } }
function Local-Date([string]$Text) { [DateTimeOffset]([DateTime]::SpecifyKind([DateTime]::ParseExact($Text, 'yyyy-MM-dd', [cultureinfo]::InvariantCulture), [DateTimeKind]::Local)) }
function Delta([string]$SSID, [long]$Bytes) { [pscustomobject]@{ SSID = $SSID; RxBytes = $Bytes; TxBytes = 0L } }
$now = Local-Date '2026-09-20'
$state = New-MeterState
$preferences = [pscustomobject]@{ Networks = @([pscustomobject]@{ SSID = 'Home'; Alias = 'Home hotspot'; Period = 'Month'; LimitGB = 1; WarnPercent = 80; DisconnectAtLimit = $false }) }
$ledger = New-MeterQuotaLedger
$null = Update-MeterQuotaLedger $ledger $state $preferences -Timestamp $now
$actions = @(Update-MeterQuotaLedger $ledger $state $preferences -Deltas @((Delta 'home' 900000000)) -Timestamp $now)
Assert ($actions.Count -eq 0 -and $ledger.Networks[0].UsedBytes -eq 0) 'Quota SSIDs must be case-sensitive.'
$actions = @(Update-MeterQuotaLedger $ledger $state $preferences -Deltas @((Delta 'Home' 800000000)) -Timestamp $now)
Assert ($actions.Count -eq 1 -and $actions[0].Notice.Type -eq 'Warning' -and -not $actions[0].Disconnect) 'Warning must fire exactly at threshold without disconnect.'
$actions = @(Update-MeterQuotaLedger $ledger $state $preferences -Timestamp $now)
Assert ($null -eq $actions[0].Notice) 'Warning must not repeat every sample.'
$actions = @(Update-MeterQuotaLedger $ledger $state $preferences -Deltas @((Delta 'Home' 200000000)) -Timestamp $now)
Assert ($actions[0].Notice.Type -eq 'Limit' -and -not $actions[0].Disconnect) 'Limit notification must not implicitly enable disconnect.'
$preferences.Networks[0].DisconnectAtLimit = $true
$actions = @(Update-MeterQuotaLedger $ledger $state $preferences -Timestamp $now)
Assert ($actions[0].Disconnect -and $null -eq $actions[0].Notice) 'Opted-in disconnect must apply even if notification was already acknowledged.'
$state | Add-Member QuotaLedger $ledger
$restored = $state | ConvertTo-Json -Depth 12 | ConvertFrom-Json
$restoredLedger = Read-MeterQuotaLedger $restored
$null = Remove-MeterExpiredRecords -State $restored -RetentionDays 1 -Timestamp $now.AddDays(1)
$actions = @(Update-MeterQuotaLedger $restoredLedger $restored $preferences -Timestamp $now.AddDays(1))
Assert ($restoredLedger.Networks[0].UsedBytes -eq 1000000000 -and $null -eq $actions[0].Notice) 'Restart or history pruning must not reset active quota or acknowledgement.'
$actions = @(Update-MeterQuotaLedger $restoredLedger $restored $preferences -Timestamp (Local-Date '2026-10-01'))
Assert ($actions.Count -eq 0 -and $restoredLedger.Networks[0].UsedBytes -eq 0) 'A new month must start a new quota counter.'
$preferences.Networks[0].Period = 'Day'
$null = Update-MeterQuotaLedger $ledger $state $preferences -Timestamp $now
$actions = @(Update-MeterQuotaLedger $ledger $state $preferences -Deltas @((Delta 'Home' 1000000000)) -Timestamp $now)
Assert ($actions[0].Notice.Type -eq 'Limit') 'Daily quota should notify.'
$actions = @(Update-MeterQuotaLedger $ledger $state $preferences -Timestamp $now.AddDays(1))
Assert ($actions.Count -eq 0) 'Daily quota must reset at local midnight.'
$preferences.Networks[0].Period = 'All'
$null = Update-MeterQuotaLedger $ledger $state $preferences -Timestamp $now
$null = Update-MeterQuotaLedger $ledger $state $preferences -Deltas @((Delta 'Home' 900000000)) -Timestamp $now
$preferences.Networks[0].LimitGB = 2
$actions = @(Update-MeterQuotaLedger $ledger $state $preferences -Timestamp $now.AddMonths(1))
Assert ($ledger.Networks[0].UsedBytes -eq 900000000 -and $actions.Count -eq 0) 'Changing limit or month must preserve an all-time counter.'
$preferences.Networks[0].LimitGB = 0.5
$actions = @(Update-MeterQuotaLedger $ledger $state $preferences -Timestamp $now.AddMonths(1))
Assert ($actions[0].Notice.Type -eq 'Limit') 'A changed limit must be evaluated against existing usage.'
$bad = [pscustomobject]@{ QuotaLedger = [pscustomobject]@{ Version = 1; Networks = @([pscustomobject]@{ SSID = 'Home'; PeriodKey = 'All'; UsedBytes = -1 }); Notices = @() } }
$rejected = $false
try { $null = Read-MeterQuotaLedger $bad } catch { $rejected = $true }
Assert $rejected 'Malformed quota counters must be rejected.'
Add-Type -Path (Join-Path $root 'src\NetworkControl.cs')
$attributes = New-Object byte[] 556
[BitConverter]::GetBytes(1).CopyTo($attributes, 0)
$ssidBytes = [Text.Encoding]::UTF8.GetBytes('家庭 WiFi')
[BitConverter]::GetBytes($ssidBytes.Length).CopyTo($attributes, 520)
$ssidBytes.CopyTo($attributes, 524)
Assert ([WiFiMeter.Networking.WirelessControl]::MatchesConnection($attributes, '家庭 WiFi')) 'Native connection prefix must correctly parse Unicode SSIDs.'
Assert (-not [WiFiMeter.Networking.WirelessControl]::MatchesConnection($attributes, '家庭 wifi')) 'A different current SSID must never be disconnected.'
[BitConverter]::GetBytes(33).CopyTo($attributes, 520)
Assert (-not [WiFiMeter.Networking.WirelessControl]::MatchesConnection($attributes, '家庭 WiFi')) 'Malformed native SSID length must be rejected.'
Assert (-not [WiFiMeter.Networking.WirelessControl]::MatchesConnection((New-Object byte[] 10), 'Home')) 'Truncated native data must be rejected.'

# Total Wi-Fi quota: an independent ledger property whose seeding and accumulation
# both exclude reserved wired identities via Test-MeterWiredIdentity.
$totalState = New-MeterState
$stamp = '2026-09-20T02:00:00.0000000+00:00'
$totalState.Networks = @(
    [pscustomobject]@{ SSID = 'Home'; RxBytes = 800000000L; TxBytes = 300000000L; FirstSeen = $stamp; LastSeen = $stamp; Days = @(
        [pscustomobject]@{ Date = '2026-08-31'; RxBytes = 100000000L; TxBytes = 50000000L },
        [pscustomobject]@{ Date = '2026-09-19'; RxBytes = 200000000L; TxBytes = 0L },
        [pscustomobject]@{ Date = '2026-09-20'; RxBytes = 500000000L; TxBytes = 250000000L }) },
    [pscustomobject]@{ SSID = 'Hotspot'; RxBytes = 500000000L; TxBytes = 150000000L; FirstSeen = $stamp; LastSeen = $stamp; Days = @(
        [pscustomobject]@{ Date = '2026-08-31'; RxBytes = 100000000L; TxBytes = 50000000L },
        [pscustomobject]@{ Date = '2026-09-20'; RxBytes = 400000000L; TxBytes = 100000000L }) },
    [pscustomobject]@{ SSID = 'Ethernet:GUID-1'; RxBytes = 900000000L; TxBytes = 100000000L; FirstSeen = $stamp; LastSeen = $stamp; Days = @(
        [pscustomobject]@{ Date = '2026-09-20'; RxBytes = 900000000L; TxBytes = 100000000L }) }
)
$totalPreferences = [pscustomobject]@{ Networks = @(); TotalLimit = [pscustomobject]@{ LimitGB = 1; Period = 'Month'; WarnPercent = 80; DisconnectAtLimit = $false } }
$totalLedger = New-MeterQuotaLedger
Assert ($null -eq $totalLedger.Total) 'A new ledger must start without a total counter.'
$actions = @(Update-MeterQuotaLedger $totalLedger $totalState $totalPreferences -Timestamp $now)
Assert ($totalLedger.Total.UsedBytes -eq 1450000000) 'The total must seed from every Wi-Fi network of the period and exclude wired identities.'
Assert (@($totalLedger.Networks).Count -eq 0) 'The total must never be stored as a fake SSID inside Networks.'
Assert ($actions.Count -eq 1 -and $actions[0].Scope -ceq 'Total' -and $actions[0].Notice.Type -eq 'Limit') 'The total quota must notify with its own scope.'
$actions = @(Update-MeterQuotaLedger $totalLedger $totalState $totalPreferences -Timestamp $now)
Assert ($actions.Count -eq 1 -and $null -eq $actions[0].Notice) 'A total limit notification must not repeat every sample.'
$actions = @(Update-MeterQuotaLedger $totalLedger $totalState $totalPreferences -Deltas @((Delta 'Ethernet:GUID-2' 500000000), (Delta 'Hotspot' 100000000)) -Timestamp $now)
Assert ($totalLedger.Total.UsedBytes -eq 1550000000) 'Total accumulation must add Wi-Fi deltas only, never wired deltas.'
$totalPreferences.TotalLimit.DisconnectAtLimit = $true
$actions = @(Update-MeterQuotaLedger $totalLedger $totalState $totalPreferences -Timestamp $now)
Assert ($actions[0].Disconnect) 'The total limit must honor DisconnectAtLimit.'
$totalPreferences.TotalLimit.Period = 'Day'
$null = Update-MeterQuotaLedger $totalLedger $totalState $totalPreferences -Timestamp $now
Assert ($totalLedger.Total.PeriodKey -ceq 'Day:2026-09-20' -and $totalLedger.Total.UsedBytes -eq 1250000000) 'A period change must reseed the total from that period of Wi-Fi history.'
$totalPreferences.TotalLimit.Period = 'Month'
$null = Update-MeterQuotaLedger $totalLedger $totalState $totalPreferences -Timestamp (Local-Date '2026-10-01')
Assert ($totalLedger.Total.PeriodKey -ceq 'Month:2026-10' -and $totalLedger.Total.UsedBytes -eq 0) 'A new month must start a new total counter.'
$bothPreferences = [pscustomobject]@{
    Networks = @([pscustomobject]@{ SSID = 'Hotspot'; Alias = 'Hot'; Period = 'Month'; LimitGB = 0.5; WarnPercent = 80; DisconnectAtLimit = $false })
    TotalLimit = [pscustomobject]@{ LimitGB = 1; Period = 'Month'; WarnPercent = 80; DisconnectAtLimit = $false }
}
$bothLedger = New-MeterQuotaLedger
$actions = @(Update-MeterQuotaLedger $bothLedger $totalState $bothPreferences -Timestamp $now)
Assert ($actions.Count -eq 2 -and @($bothLedger.Networks).Count -eq 1) 'Network and total quotas must stay independent ledger entries.'
Assert ($bothLedger.Networks[0].UsedBytes -eq 500000000 -and $bothLedger.Networks[0].SSID -ceq 'Hotspot') 'A total policy must not disturb per-network counters.'
Assert (@($actions | Where-Object { $null -ne $_.PSObject.Properties['Scope'] -and $_.Scope -ceq 'Total' }).Count -eq 1) 'The total action must be distinguishable by scope.'
$trackPreferences = [pscustomobject]@{ Networks = @(); TotalLimit = [pscustomobject]@{ LimitGB = 0; Period = 'Month'; WarnPercent = 80; DisconnectAtLimit = $false } }
$trackLedger = New-MeterQuotaLedger
$null = Update-MeterQuotaLedger $trackLedger $totalState $trackPreferences -Timestamp $now
$null = Update-MeterQuotaLedger $trackLedger $totalState $trackPreferences -Deltas @((Delta 'Home' 700000000)) -Timestamp $now
Assert ($trackLedger.Total.UsedBytes -eq 2150000000) 'A disabled total must keep tracking Wi-Fi usage for a later limit.'
$roundtripState = New-MeterState
$roundtripState | Add-Member QuotaLedger $trackLedger
$serialized = $roundtripState | ConvertTo-Json -Depth 12 | ConvertFrom-Json
$restoredTotal = Read-MeterQuotaLedger $serialized
Assert ($restoredTotal.Total.UsedBytes -eq 2150000000 -and $restoredTotal.Total.PeriodKey -ceq 'Month:2026-09') 'A total counter must survive a save and load roundtrip.'
$legacy = [pscustomobject]@{ QuotaLedger = [pscustomobject]@{ Version = 1; Networks = @(); Notices = @() } }
Assert ($null -eq (Read-MeterQuotaLedger $legacy).Total) 'A ledger without a total counter must remain readable.'
$badTotal = [pscustomobject]@{ QuotaLedger = [pscustomobject]@{ Version = 1; Networks = @(); Notices = @(); Total = [pscustomobject]@{ PeriodKey = 'All'; UsedBytes = -1 } } }
$rejected = $false
try { $null = Read-MeterQuotaLedger $badTotal } catch { $rejected = $true }
Assert $rejected 'Malformed total counters must be rejected.'
$badTotal = [pscustomobject]@{ QuotaLedger = [pscustomobject]@{ Version = 1; Networks = @(); Notices = @(); Total = [pscustomobject]@{ PeriodKey = 'Fortnight:2026-09'; UsedBytes = 0 } } }
$rejected = $false
try { $null = Read-MeterQuotaLedger $badTotal } catch { $rejected = $true }
Assert $rejected 'An unknown total period key must be rejected.'
Write-Output 'PASS: quota thresholds, opt-in disconnect, acknowledgements, restart, retention, period rollover, total Wi-Fi quota, native SSID guard (no network disconnection).'
