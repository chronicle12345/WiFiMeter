Set-StrictMode -Version 2
Import-Module (Join-Path $PSScriptRoot 'Storage.psm1') -Scope Local

function New-MeterState {
    [CmdletBinding()]
    param()
    $now = [DateTimeOffset]::UtcNow.ToString('o', [cultureinfo]::InvariantCulture)
    [pscustomobject]@{ SchemaVersion = 1; StartedAt = $now; UpdatedAt = $now; Networks = @() }
}

function New-MeterSession {
    [CmdletBinding()]
    param()
    [pscustomobject]@{ Baselines = [System.Collections.Generic.Dictionary[string,object]]::new([StringComparer]::Ordinal) }
}

function Assert-ByteCount($Value) {
    if (($Value -isnot [int] -and $Value -isnot [long]) -or $Value -lt 0) {
        throw '流量字节数必须是非负 64 位整数。'
    }
}

function Add-ByteCount([long]$Left, [long]$Right) {
    $sum = [decimal]$Left + [decimal]$Right
    if ($sum -gt [long]::MaxValue) { throw '累计流量超过 64 位整数的存储范围。' }
    [long]$sum
}

function Assert-IsoTimestamp($Value) {
    $parsed = [DateTimeOffset]::MinValue
    if ($Value -isnot [string] -or $Value -notmatch '^\d{4}-\d{2}-\d{2}T.+(Z|[+-]\d{2}:\d{2})$' -or
        -not [DateTimeOffset]::TryParse($Value, [cultureinfo]::InvariantCulture, [Globalization.DateTimeStyles]::None, [ref]$parsed)) {
        throw '数据文件包含无效的时间。'
    }
}

function Assert-MeterState($State) {
    if ($null -eq $State -or ($State.SchemaVersion -isnot [int] -and $State.SchemaVersion -isnot [long]) -or $State.SchemaVersion -ne 1) { throw '不支持的数据文件版本。' }
    Assert-IsoTimestamp $State.StartedAt
    Assert-IsoTimestamp $State.UpdatedAt
    if ($State.Networks -isnot [array]) { throw '网络列表格式无效。' }
    $names = [System.Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
    foreach ($network in $State.Networks) {
        if ($network.SSID -isnot [string] -or -not $names.Add($network.SSID)) { throw '网络名称无效或重复。' }
        Assert-ByteCount $network.RxBytes
        Assert-ByteCount $network.TxBytes
        Assert-IsoTimestamp $network.FirstSeen
        Assert-IsoTimestamp $network.LastSeen
        if ($network.Days -isnot [array]) { throw '每日流量列表格式无效。' }
        $dates = [System.Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
        [long]$rx = 0; [long]$tx = 0
        foreach ($day in $network.Days) {
            $parsed = [datetime]::MinValue
            if ($day.Date -isnot [string] -or
                -not [datetime]::TryParseExact($day.Date, 'yyyy-MM-dd', [cultureinfo]::InvariantCulture, [Globalization.DateTimeStyles]::None, [ref]$parsed) -or
                -not $dates.Add($day.Date)) { throw '每日流量日期无效或重复。' }
            Assert-ByteCount $day.RxBytes; Assert-ByteCount $day.TxBytes
            $rx = Add-ByteCount $rx $day.RxBytes; $tx = Add-ByteCount $tx $day.TxBytes
        }
        if ($rx -ne $network.RxBytes -or $tx -ne $network.TxBytes) { throw '累计流量与每日流量不一致。' }
    }
}

function Add-MeterSamples {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)]$State,
        [Parameter(Mandatory = $true)]$Session,
        [Parameter(Mandatory = $true)][AllowEmptyCollection()][object[]]$Samples,
        [DateTimeOffset]$Timestamp = [DateTimeOffset]::Now
    )
    $seen = [System.Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
    foreach ($sample in $Samples) {
        if ($sample.AdapterId -isnot [string] -or [string]::IsNullOrEmpty($sample.AdapterId) -or
            -not $seen.Add($sample.AdapterId) -or $sample.SSID -isnot [string]) { throw '采样中的网络适配器或网络名称无效。' }
        Assert-ByteCount $sample.RxBytes; Assert-ByteCount $sample.TxBytes
    }
    [long]$download = 0; [long]$upload = 0; [int]$skipped = 0
    $reasons = [System.Collections.Generic.List[string]]::new()
    $stamp = $Timestamp.ToUniversalTime().ToString('o', [cultureinfo]::InvariantCulture)
    $date = $Timestamp.ToLocalTime().ToString('yyyy-MM-dd', [cultureinfo]::InvariantCulture)
    foreach ($id in @($Session.Baselines.Keys)) {
        if (-not $seen.Contains($id)) {
            [void]$Session.Baselines.Remove($id)
            $skipped++
            if (-not $reasons.Contains('Disconnected')) { $reasons.Add('Disconnected') }
        }
    }
    foreach ($sample in $Samples) {
        $network = $null
        foreach ($item in $State.Networks) {
            if ([string]::Equals($item.SSID, $sample.SSID, [StringComparison]::Ordinal)) { $network = $item; break }
        }
        if ($null -eq $network) {
            $network = [pscustomobject]@{
                SSID = $sample.SSID; RxBytes = [long]0; TxBytes = [long]0
                FirstSeen = $stamp; LastSeen = $stamp; Days = @()
            }
            $State.Networks = @($State.Networks) + @($network)
        }
        if ($Timestamp -ge [DateTimeOffset]::Parse($network.LastSeen, [cultureinfo]::InvariantCulture)) { $network.LastSeen = $stamp }
        $day = $null
        foreach ($item in $network.Days) { if ($item.Date -ceq $date) { $day = $item; break } }
        if ($null -eq $day) {
            $day = [pscustomobject]@{ Date = $date; RxBytes = [long]0; TxBytes = [long]0 }
            $network.Days = @($network.Days) + @($day)
        }
        $reason = 'Baseline'
        if ($Session.Baselines.ContainsKey($sample.AdapterId)) {
            $previous = $Session.Baselines[$sample.AdapterId]
            $elapsed = ($Timestamp - $previous.Timestamp).TotalSeconds
            if ($elapsed -lt 0) { $reason = 'ClockRollback' }
            elseif ($elapsed -gt 15) { $reason = 'Gap' }
            elseif (-not [string]::Equals($sample.SSID, $previous.SSID, [StringComparison]::Ordinal)) { $reason = 'NetworkChanged' }
            elseif ($sample.RxBytes -lt $previous.RxBytes -or $sample.TxBytes -lt $previous.TxBytes) { $reason = 'CounterReset' }
            else {
                $reason = 'Counted'
                [long]$rx = $sample.RxBytes - $previous.RxBytes
                [long]$tx = $sample.TxBytes - $previous.TxBytes
                $network.RxBytes = Add-ByteCount $network.RxBytes $rx
                $network.TxBytes = Add-ByteCount $network.TxBytes $tx
                $day.RxBytes = Add-ByteCount $day.RxBytes $rx
                $day.TxBytes = Add-ByteCount $day.TxBytes $tx
                $download = Add-ByteCount $download $rx
                $upload = Add-ByteCount $upload $tx
            }
            if ($reason -cne 'Counted') { $skipped++ }
        }
        if (-not $reasons.Contains($reason)) { $reasons.Add($reason) }
        $Session.Baselines[$sample.AdapterId] = [pscustomobject]@{
            SSID = $sample.SSID; RxBytes = [long]$sample.RxBytes; TxBytes = [long]$sample.TxBytes; Timestamp = $Timestamp
        }
    }
    if ($Samples.Count -eq 0 -and $reasons.Count -eq 0) { $reasons.Add('NoSamples') }
    $State.UpdatedAt = $stamp
    [pscustomobject]@{ DownloadBytes = $download; UploadBytes = $upload; SkippedIntervals = $skipped; Reason = ($reasons -join ',') }
}

function Get-MeterRows {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)]$State,
        [ValidateSet('All','Today','Month','Range')][string]$Period = 'All',
        [DateTimeOffset]$Now = [DateTimeOffset]::Now,
        [datetime]$StartDate,
        [datetime]$EndDate
    )
    if ($Period -eq 'Range') {
        if (-not $PSBoundParameters.ContainsKey('StartDate') -or -not $PSBoundParameters.ContainsKey('EndDate')) {
            throw '自选日期范围需要同时提供开始日期和结束日期。'
        }
        if ($StartDate.Date -gt $EndDate.Date) { throw '开始日期不能晚于结束日期。' }
        $startKey = $StartDate.Date.ToString('yyyy-MM-dd', [cultureinfo]::InvariantCulture)
        $endKey = $EndDate.Date.ToString('yyyy-MM-dd', [cultureinfo]::InvariantCulture)
    }
    $today = $Now.ToLocalTime().ToString('yyyy-MM-dd', [cultureinfo]::InvariantCulture)
    $month = $today.Substring(0, 7)
    $rows = foreach ($network in $State.Networks) {
        [long]$rx = 0; [long]$tx = 0
        if ($Period -eq 'All') { $rx = $network.RxBytes; $tx = $network.TxBytes }
        else {
            foreach ($day in $network.Days) {
                if (($Period -eq 'Today' -and $day.Date -ceq $today) -or
                    ($Period -eq 'Month' -and $day.Date.StartsWith($month, [StringComparison]::Ordinal)) -or
                    ($Period -eq 'Range' -and [string]::CompareOrdinal($day.Date, $startKey) -ge 0 -and [string]::CompareOrdinal($day.Date, $endKey) -le 0)) {
                    $rx = Add-ByteCount $rx $day.RxBytes; $tx = Add-ByteCount $tx $day.TxBytes
                }
            }
        }
        [pscustomobject]@{ SSID = $network.SSID; RxBytes = $rx; TxBytes = $tx; TotalBytes = (Add-ByteCount $rx $tx) }
    }
    $rows | Sort-Object -Property @{ Expression = 'TotalBytes'; Descending = $true }, SSID
}

function Read-ValidatedStateFile([string]$Path) {
    # FileShare.Delete permits an atomic writer to replace the file while this reader holds the old snapshot.
    $stream = [IO.File]::Open($Path, [IO.FileMode]::Open, [IO.FileAccess]::Read, ([IO.FileShare]::ReadWrite -bor [IO.FileShare]::Delete))
    $reader = $null
    try {
        $reader = [IO.StreamReader]::new($stream, [Text.Encoding]::UTF8, $true)
        $state = $reader.ReadToEnd() | ConvertFrom-Json -ErrorAction Stop
        Assert-MeterState $state
        foreach ($network in $state.Networks) {
            $network.RxBytes = [long]$network.RxBytes; $network.TxBytes = [long]$network.TxBytes
            foreach ($day in $network.Days) { $day.RxBytes = [long]$day.RxBytes; $day.TxBytes = [long]$day.TxBytes }
        }
        $state
    } finally {
        if ($null -ne $reader) { $reader.Dispose() } else { $stream.Dispose() }
    }
}

function Read-MeterState {
    [CmdletBinding()]
    param([Parameter(Mandatory = $true)][string]$DataDirectory)
    $primary = Join-Path $DataDirectory 'state.json'
    $backup = Join-Path $DataDirectory 'state.json.bak'
    if (-not [IO.File]::Exists($primary) -and -not [IO.File]::Exists($backup)) { return (New-MeterState) }
    $primaryError = '主文件不存在'
    if ([IO.File]::Exists($primary)) {
        try { return (Read-ValidatedStateFile $primary) } catch { $primaryError = $_.Exception.Message }
    }
    if ([IO.File]::Exists($backup)) {
        try { $state = Read-ValidatedStateFile $backup } catch { throw "主数据和备份均无法读取。主文件：$primaryError；备份：$($_.Exception.Message)" }
        Write-Warning "主数据无法读取，已使用备份恢复。原因：$primaryError"
        return $state
    }
    throw "数据文件无法读取，且没有可用备份：$primaryError"
}

function Write-AtomicText([string]$Path, [string]$Content, [AllowNull()][string]$BackupPath) {
    $temporary = $Path + '.' + [guid]::NewGuid().ToString('N') + '.tmp'
    try {
        $encoding = [Text.UTF8Encoding]::new($true)
        $stream = [IO.File]::Open($temporary, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
        try {
            $preamble = $encoding.GetPreamble(); $bytes = $encoding.GetBytes($Content)
            $stream.Write($preamble, 0, $preamble.Length); $stream.Write($bytes, 0, $bytes.Length)
            $stream.Flush($true)
        } finally { $stream.Dispose() }
        if ([IO.File]::Exists($Path)) {
            Invoke-MeterFileReplace -Source $temporary -Destination $Path -BackupPath $BackupPath
        } else { [IO.File]::Move($temporary, $Path) }
    } finally {
        if ([IO.File]::Exists($temporary)) { [IO.File]::Delete($temporary) }
    }
}

function ConvertTo-CsvCell([string]$Value, [switch]$ProtectFormula) {
    if ($ProtectFormula -and $Value -match '^\s*[=+\-@\t\r\n]') { $Value = "'" + $Value }
    '"' + $Value.Replace('"', '""') + '"'
}

function ConvertTo-Gigabytes([long]$Bytes) {
    ([decimal]$Bytes / [decimal]1000000000).ToString('0.#########', [cultureinfo]::InvariantCulture)
}

function Export-MeterRangeCsv {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)]$State,
        [Parameter(Mandatory = $true)][string]$Path,
        [ValidateSet('All','Today','Month','Range')][string]$Period = 'All',
        [DateTimeOffset]$Now = [DateTimeOffset]::Now,
        [datetime]$StartDate,
        [datetime]$EndDate
    )
    $rowParameters = @{ State = $State; Period = $Period; Now = $Now }
    if ($PSBoundParameters.ContainsKey('StartDate')) { $rowParameters.StartDate = $StartDate }
    if ($PSBoundParameters.ContainsKey('EndDate')) { $rowParameters.EndDate = $EndDate }
    $rows = @(Get-MeterRows @rowParameters)
    $lines = [System.Collections.Generic.List[string]]::new()
    $lines.Add('"Wi-Fi","下载_GB","上传_GB","总计_GB"')
    foreach ($row in $rows) {
        $lines.Add(((ConvertTo-CsvCell $row.SSID -ProtectFormula), (ConvertTo-Gigabytes $row.RxBytes), (ConvertTo-Gigabytes $row.TxBytes), (ConvertTo-Gigabytes $row.TotalBytes) -join ','))
    }
    Write-AtomicText $Path (($lines -join "`r`n") + "`r`n") $null
}

function Export-MeterCsv($State, [string]$DataDirectory) {
    $usage = [System.Collections.Generic.List[string]]::new()
    $daily = [System.Collections.Generic.List[string]]::new()
    $usage.Add('"Wi-Fi","下载_GB","上传_GB","总计_GB"')
    $daily.Add('"日期","Wi-Fi","下载_GB","上传_GB","总计_GB"')
    foreach ($row in @(Get-MeterRows $State)) {
        $usage.Add(((ConvertTo-CsvCell $row.SSID -ProtectFormula), (ConvertTo-Gigabytes $row.RxBytes), (ConvertTo-Gigabytes $row.TxBytes), (ConvertTo-Gigabytes $row.TotalBytes) -join ','))
    }
    foreach ($network in $State.Networks) {
        foreach ($day in @($network.Days | Sort-Object -Property Date)) {
            $daily.Add(((ConvertTo-CsvCell $day.Date), (ConvertTo-CsvCell $network.SSID -ProtectFormula), (ConvertTo-Gigabytes $day.RxBytes), (ConvertTo-Gigabytes $day.TxBytes), (ConvertTo-Gigabytes (Add-ByteCount $day.RxBytes $day.TxBytes)) -join ','))
        }
    }
    foreach ($file in @(@{ Name = 'usage.csv'; Lines = $usage }, @{ Name = 'daily.csv'; Lines = $daily })) {
        try { Write-AtomicText (Join-Path $DataDirectory $file.Name) (($file.Lines -join "`r`n") + "`r`n") $null }
        catch { Write-Warning "统计数据已保存，但 $($file.Name) 导出失败，请关闭占用此文件的 Excel 等程序后重试：$($_.Exception.Message)" }
    }
}

function Save-MeterState {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)]$State,
        [Parameter(Mandatory = $true)][string]$DataDirectory
    )
    Assert-MeterState $State
    if (-not [IO.Directory]::Exists($DataDirectory)) { [void][IO.Directory]::CreateDirectory($DataDirectory) }
    $primary = Join-Path $DataDirectory 'state.json'
    $backup = Join-Path $DataDirectory 'state.json.bak'
    $backupPath = $null
    if ([IO.File]::Exists($primary)) {
        $primaryValid = $false
        try { $null = Read-ValidatedStateFile $primary; $primaryValid = $true } catch { }
        if ($primaryValid) { $backupPath = $backup }
        else {
            try { $null = Read-ValidatedStateFile $backup }
            catch { throw '主数据损坏且备份不可用。为保留原始文件，已停止保存。' }
        }
    } elseif ([IO.File]::Exists($backup)) {
        try { $null = Read-ValidatedStateFile $backup }
        catch { throw '现有备份已损坏。为保留原始文件，已停止保存。' }
    }
    $json = $State | ConvertTo-Json -Depth 12 -Compress
    Write-AtomicText $primary $json $backupPath
    Export-MeterCsv $State $DataDirectory
}

Export-ModuleMember -Function New-MeterState, New-MeterSession, Add-MeterSamples, Get-MeterRows, Read-MeterState, Save-MeterState, Export-MeterRangeCsv
