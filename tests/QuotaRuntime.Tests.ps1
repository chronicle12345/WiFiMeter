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
Write-Output 'PASS: quota thresholds, opt-in disconnect, acknowledgements, restart, retention, period rollover, native SSID guard (no network disconnection).'
