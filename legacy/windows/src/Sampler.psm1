Set-StrictMode -Version 2.0

function Get-WifiConnectionProfiles {
    # 该 WinRT 投影由 Windows PowerShell 5.1 的 .NET Framework 提供。
    Add-Type -AssemblyName System.Runtime.WindowsRuntime -ErrorAction Stop
    return [Windows.Networking.Connectivity.NetworkInformation, Windows.Networking.Connectivity, ContentType = WindowsRuntime]::GetConnectionProfiles()
}

function Get-WifiNetworkInterfaces {
    return [System.Net.NetworkInformation.NetworkInterface]::GetAllNetworkInterfaces()
}

function Get-WifiProfileState {
    $byAdapter = @{}
    $excluded = New-Object 'System.Collections.Generic.HashSet[string]'
    $hasError = $false

    try {
        $profiles = @(Get-WifiConnectionProfiles)
    }
    catch {
        return [pscustomobject]@{ Profiles = $byAdapter; HasError = $true }
    }

    foreach ($profile in $profiles) {
        $adapterId = $null
        try {
            if (-not $profile.IsWlanConnectionProfile) { continue }
            if ([int]$profile.GetNetworkConnectivityLevel() -eq 0) { continue }
            if ($null -eq $profile.NetworkAdapter) { continue }

            # WinRT 和 .NET 可能采用不同的 GUID 大小写及括号格式。
            $adapterId = ([guid]$profile.NetworkAdapter.NetworkAdapterId).ToString('D')
            $ssid = [string]$profile.WlanConnectionProfileDetails.GetConnectedSsid()
            if ([string]::IsNullOrEmpty($ssid)) { throw 'Connected SSID was unavailable.' }
            if ($excluded.Contains($adapterId)) { continue }

            if ($byAdapter.ContainsKey($adapterId)) {
                # 同一接口出现不同的已连接 SSID 时，无法可靠归属这次流量。
                if (-not [string]::Equals($byAdapter[$adapterId], $ssid, [StringComparison]::Ordinal)) {
                    $byAdapter.Remove($adapterId)
                    [void]$excluded.Add($adapterId)
                    $hasError = $true
                }
            }
            else {
                $byAdapter[$adapterId] = $ssid
            }
        }
        catch {
            $hasError = $true
            if ($null -ne $adapterId) {
                $byAdapter.Remove($adapterId)
                [void]$excluded.Add($adapterId)
            }
        }
    }

    return [pscustomobject]@{ Profiles = $byAdapter; HasError = $hasError }
}

function Get-WifiSamples {
    [CmdletBinding()]
    param()

    $samples = New-Object 'System.Collections.Generic.List[object]'
    $pending = New-Object 'System.Collections.Generic.List[object]'
    $before = Get-WifiProfileState
    $hasError = [bool]$before.HasError

    if ($before.Profiles.Count -gt 0) {
        try {
            $interfaces = @(Get-WifiNetworkInterfaces)
        }
        catch {
            $interfaces = @()
            $hasError = $true
        }

        $seen = New-Object 'System.Collections.Generic.HashSet[string]'
        foreach ($interface in $interfaces) {
            try {
                if ($interface.NetworkInterfaceType -ne [System.Net.NetworkInformation.NetworkInterfaceType]::Wireless80211) { continue }
                if ($interface.OperationalStatus -ne [System.Net.NetworkInformation.OperationalStatus]::Up) { continue }

                $adapterId = ([guid]$interface.Id).ToString('D')
                if (-not $before.Profiles.ContainsKey($adapterId)) { continue }
                if (-not $seen.Add($adapterId)) { continue }

                $statistics = $interface.GetIPStatistics()
                if ($null -eq $statistics -or $null -eq $statistics.BytesReceived -or $null -eq $statistics.BytesSent) {
                    throw 'Interface byte counters were unavailable.'
                }
                $rx = [long]$statistics.BytesReceived
                $tx = [long]$statistics.BytesSent
                if ($rx -lt 0 -or $tx -lt 0) { throw 'Interface byte counters were invalid.' }

                $pending.Add([pscustomobject]@{
                    AdapterId = [string]$adapterId
                    SSID = [string]$before.Profiles[$adapterId]
                    RxBytes = $rx
                    TxBytes = $tx
                })
            }
            catch {
                # 单个接口读取失败时，继续采样其他接口。
                $hasError = $true
            }
        }

        # 计数器读取前后都确认连接，切换网络期间的样本直接丢弃。
        $after = Get-WifiProfileState
        $hasError = $hasError -or [bool]$after.HasError
        foreach ($sample in $pending) {
            if ($after.Profiles.ContainsKey($sample.AdapterId) -and
                [string]::Equals($sample.SSID, $after.Profiles[$sample.AdapterId], [StringComparison]::Ordinal)) {
                $samples.Add($sample)
            }
        }
    }

    if ($hasError) {
        if ($samples.Count -gt 0) {
            $message = '部分 Wi-Fi 接口采样失败，已保留其他接口的数据。'
        }
        else {
            $message = '无法读取 Wi-Fi 连接或流量信息，请稍后重试。'
        }
    }
    elseif ($samples.Count -eq 0) {
        $message = '未连接 Wi-Fi'
    }
    else {
        $message = ''
    }

    return [pscustomobject]@{
        Samples = [object[]]$samples.ToArray()
        Message = [string]$message
        HasError = [bool]$hasError
    }
}

Export-ModuleMember -Function Get-WifiSamples
