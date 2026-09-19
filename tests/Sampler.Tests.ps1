[CmdletBinding()]
param([switch]$Live)

Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'
$modulePath = Join-Path (Split-Path $PSScriptRoot -Parent) 'src\Sampler.psm1'
$script:testCount = 0

function Assert-True {
    param([bool]$Condition, [string]$Message)
    if (-not $Condition) { throw $Message }
}

Assert-True (Test-Path -LiteralPath $modulePath) 'Sampler module must exist.'

function New-TestProfile {
    param([string]$Id, [string]$Ssid = 'Test Network', [int]$Level = 3, [bool]$Wlan = $true)
    $details = [pscustomobject]@{ Ssid = $Ssid }
    $details | Add-Member ScriptMethod GetConnectedSsid { return $this.Ssid }
    $profile = [pscustomobject]@{
        IsWlanConnectionProfile = $Wlan
        NetworkAdapter = [pscustomobject]@{ NetworkAdapterId = [guid]$Id }
        WlanConnectionProfileDetails = $details
        Level = $Level
    }
    $profile | Add-Member ScriptMethod GetNetworkConnectivityLevel { return $this.Level }
    return $profile
}

function New-TestInterface {
    param(
        [string]$Id,
        [long]$Rx = 120,
        [long]$Tx = 80,
        [string]$Status = 'Up',
        [string]$Type = 'Wireless80211',
        [bool]$ThrowOnRead = $false
    )
    $adapter = [pscustomobject]@{
        Id = $Id
        OperationalStatus = [System.Net.NetworkInformation.OperationalStatus]::$Status
        NetworkInterfaceType = [System.Net.NetworkInformation.NetworkInterfaceType]::$Type
        Rx = $Rx
        Tx = $Tx
        ThrowOnRead = $ThrowOnRead
    }
    $adapter | Add-Member ScriptMethod GetIPStatistics {
        if ($this.ThrowOnRead) { throw 'Simulated adapter statistics failure.' }
        return [pscustomobject]@{ BytesReceived = $this.Rx; BytesSent = $this.Tx }
    }
    return $adapter
}

function Invoke-SamplerTest {
    param(
        [string]$Name,
        [object[]]$Before,
        [object[]]$After,
        [object[]]$Interfaces,
        [scriptblock]$Assert,
        [bool]$ThrowProfiles = $false,
        [bool]$ThrowInterfaces = $false,
        [int]$ProfileFailureCall = 0
    )
    $module = Import-Module $modulePath -Force -PassThru
    try {
        & $module {
            param($Initial, $Final, $Adapters, $FailProfiles, $FailInterfaces, $FailCall)
            $script:TestInitial = $Initial
            $script:TestFinal = $Final
            $script:TestAdapters = $Adapters
            $script:TestProfileCall = 0
            $script:TestFailProfiles = $FailProfiles
            $script:TestFailInterfaces = $FailInterfaces
            $script:TestFailCall = $FailCall
            function script:Get-WifiConnectionProfiles {
                if ($script:TestFailProfiles) { throw 'Simulated profile enumeration failure.' }
                $script:TestProfileCall++
                if ($script:TestProfileCall -eq $script:TestFailCall) { throw 'Simulated connection recheck failure.' }
                if ($script:TestProfileCall -eq 1) { return $script:TestInitial }
                return $script:TestFinal
            }
            function script:Get-WifiNetworkInterfaces {
                if ($script:TestFailInterfaces) { throw 'Simulated interface enumeration failure.' }
                return $script:TestAdapters
            }
        } $Before $After $Interfaces $ThrowProfiles $ThrowInterfaces $ProfileFailureCall
        $result = Get-WifiSamples
        Assert-True ($null -ne $result) 'Result must be an object.'
        Assert-True ($result.Samples -is [object[]]) 'Samples must always be an object array.'
        Assert-True ($result.Message -is [string]) 'Message must be a string.'
        Assert-True ($result.HasError -is [bool]) 'HasError must be a boolean.'
        & $Assert $result
        $script:testCount++
        Write-Output ('PASS: ' + $Name)
    }
    finally { Remove-Module $module -Force }
}

$id1 = 'ed7a8b9c-11a2-43d4-85e6-778899aabbcc'
$id2 = '9f8e7d6c-5b4a-4321-8765-abcdefabcdef'
$profile1 = New-TestProfile $id1
$profile2 = New-TestProfile $id2 'Second Test Network'
$adapter1 = New-TestInterface ('{' + $id1.ToUpperInvariant() + '}')
$adapter2 = New-TestInterface $id2 400 300

Invoke-SamplerTest 'Disconnected is an empty successful result' @() @() @() {
    param($result)
    Assert-True ($result.Samples.Count -eq 0 -and -not $result.HasError) 'Disconnected must not be an error.'
    Assert-True ($result.Message -eq '未连接 Wi-Fi') 'Disconnected message must be clear.'
}

Invoke-SamplerTest 'Adapter GUID normalization and Int64 counters' @($profile1) @($profile1) @($adapter1) {
    param($result)
    Assert-True ($result.Samples.Count -eq 1 -and -not $result.HasError) 'Expected exactly one sample.'
    $sample = $result.Samples[0]
    Assert-True ($sample.AdapterId -ceq $id1) 'Adapter ID must be a normalized GUID.'
    Assert-True ($sample.SSID -ceq 'Test Network') 'SSID must match the verified profile.'
    Assert-True ($sample.RxBytes -is [long] -and $sample.RxBytes -eq 120) 'RX must be an Int64 byte count.'
    Assert-True ($sample.TxBytes -is [long] -and $sample.TxBytes -eq 80) 'TX must be an Int64 byte count.'
}

Invoke-SamplerTest 'Disconnected profiles and non-WLAN profiles are ignored' @(
    (New-TestProfile $id1 'Old Network' 0), (New-TestProfile $id2 'Wired Profile' 3 $false)
) @() @($adapter1, $adapter2) {
    param($result)
    Assert-True ($result.Samples.Count -eq 0 -and -not $result.HasError) 'Disconnected and wired profiles must be excluded.'
}

Invoke-SamplerTest 'Only active wireless interfaces are sampled' @($profile1, $profile2) @($profile1, $profile2) @(
    (New-TestInterface $id1 10 20 'Down'), (New-TestInterface $id2 10 20 'Up' 'Ethernet')
) {
    param($result)
    Assert-True ($result.Samples.Count -eq 0 -and -not $result.HasError) 'Down or wired interfaces must be excluded.'
}

Invoke-SamplerTest 'A changed SSID discards counters from the transition' @($profile1) @(
    (New-TestProfile $id1 'Changed Network')
) @($adapter1) {
    param($result)
    Assert-True ($result.Samples.Count -eq 0 -and -not $result.HasError) 'A sample spanning an SSID change must be discarded.'
}

Invoke-SamplerTest 'SSID comparisons preserve letter case' @($profile1) @(
    (New-TestProfile $id1 'test network')
) @($adapter1) {
    param($result)
    Assert-True ($result.Samples.Count -eq 0) 'Case-distinct SSIDs must not be combined.'
}

Invoke-SamplerTest 'Disconnection during a read discards the sample' @($profile1) @() @($adapter1) {
    param($result)
    Assert-True ($result.Samples.Count -eq 0 -and -not $result.HasError) 'A disconnected sample must be discarded.'
}

Invoke-SamplerTest 'One failed interface preserves the other successful sample' @($profile1, $profile2) @($profile1, $profile2) @(
    (New-TestInterface $id1 0 0 'Up' 'Wireless80211' $true), $adapter2
) {
    param($result)
    Assert-True ($result.HasError -and $result.Samples.Count -eq 1) 'Partial failure must retain successful samples.'
    Assert-True ($result.Samples[0].AdapterId -ceq $id2) 'Only the successful adapter can be included.'
    Assert-True (-not [string]::IsNullOrWhiteSpace($result.Message)) 'Errors need a readable message.'
}

Invoke-SamplerTest 'Conflicting profiles for an adapter are not attributed' @(
    $profile1, (New-TestProfile $id1 'Conflicting Network')
) @($profile1) @($adapter1) {
    param($result)
    Assert-True ($result.HasError -and $result.Samples.Count -eq 0) 'Ambiguous profiles must not produce a sample.'
}

Invoke-SamplerTest 'Profile enumeration failure is reported without throwing' @() @() @() {
    param($result)
    Assert-True ($result.HasError -and $result.Samples.Count -eq 0) 'Profile enumeration error must be explicit.'
} -ThrowProfiles $true

Invoke-SamplerTest 'Interface enumeration failure is reported without throwing' @($profile1) @($profile1) @() {
    param($result)
    Assert-True ($result.HasError -and $result.Samples.Count -eq 0) 'Interface enumeration error must be explicit.'
} -ThrowInterfaces $true

Invoke-SamplerTest 'Invalid negative counters are rejected' @($profile1) @($profile1) @(
    (New-TestInterface $id1 -1 20)
) {
    param($result)
    Assert-True ($result.HasError -and $result.Samples.Count -eq 0) 'Invalid counters must not enter totals.'
}

Invoke-SamplerTest 'Failed connection recheck discards unverified counters' @($profile1) @($profile1) @($adapter1) {
    param($result)
    Assert-True ($result.HasError -and $result.Samples.Count -eq 0) 'Unverified counters must not enter totals.'
} -ProfileFailureCall 2

$brokenProfile = New-TestProfile $id1
$brokenProfile.WlanConnectionProfileDetails | Add-Member ScriptMethod GetConnectedSsid {
    throw 'Simulated SSID read failure.'
} -Force
Invoke-SamplerTest 'One unreadable profile preserves a different verified adapter' @($brokenProfile, $profile2) @(
    $brokenProfile, $profile2
) @($adapter1, $adapter2) {
    param($result)
    Assert-True ($result.HasError -and $result.Samples.Count -eq 1) 'One unreadable profile must not remove verified adapters.'
    Assert-True ($result.Samples[0].AdapterId -ceq $id2) 'Only the verified adapter can be included.'
}

if ($Live) {
    Assert-True ($PSVersionTable.PSEdition -eq 'Desktop') 'Live WinRT tests require Windows PowerShell 5.1.'
    Import-Module $modulePath -Force
    try {
        $first = Get-WifiSamples
        Start-Sleep -Milliseconds 1000
        $second = Get-WifiSamples
        Assert-True (-not $first.HasError -and -not $second.HasError) 'Live API sampling returned an error.'
        $matched = 0
        foreach ($sample in $second.Samples) {
            $previous = @($first.Samples | Where-Object {
                $_.AdapterId -ceq $sample.AdapterId -and $_.SSID -ceq $sample.SSID
            })
            if ($previous.Count -eq 1) {
                Assert-True ($sample.RxBytes -ge $previous[0].RxBytes) 'RX counter decreased while the connection appeared stable.'
                Assert-True ($sample.TxBytes -ge $previous[0].TxBytes) 'TX counter decreased while the connection appeared stable.'
                $matched++
            }
        }
        Write-Output ('LIVE: first={0}; second={1}; stable_monotonic={2}; status=OK' -f $first.Samples.Count, $second.Samples.Count, $matched)
    }
    finally { Remove-Module Sampler -Force }
}

Write-Output ('PASS: {0} sampler contract tests.' -f $script:testCount)
