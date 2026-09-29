$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2
$modulePath = Join-Path (Split-Path $PSScriptRoot -Parent) 'src\Core.psm1'
if (Test-Path -LiteralPath $modulePath) { Import-Module $modulePath -Force }
$script:Passed = 0
$script:Failed = 0
$script:TempDirectories = @()

function Assert-Equal($Actual, $Expected, [string]$Message = '') {
    if ($Actual -cne $Expected) { throw "${Message}: expected [$Expected], received [$Actual]" }
}
function Assert-True($Value, [string]$Message) { if (-not $Value) { throw $Message } }
function Assert-Throws([scriptblock]$Action, [string]$MessageContains = '') {
    $caught = $false
    try { & $Action } catch {
        $caught = $true
        if ($MessageContains -and -not $_.Exception.Message.Contains($MessageContains)) { throw "Expected exception containing [$MessageContains], received [$($_.Exception.Message)]" }
    }
    if (-not $caught) { throw 'Expected an exception.' }
}
function Test-Case([string]$Name, [scriptblock]$Body) {
    try { & $Body; $script:Passed++; Write-Host "PASS $Name" }
    catch { $script:Failed++; Write-Host "FAIL $Name : $($_.Exception.Message)" }
}
function Sample([string]$Id, [string]$SSID, [long]$Rx, [long]$Tx) {
    [pscustomobject]@{ AdapterId = $Id; SSID = $SSID; RxBytes = $Rx; TxBytes = $Tx }
}
function Local-Time([string]$Text) {
    [DateTimeOffset]([DateTime]::SpecifyKind([DateTime]::ParseExact($Text, 'yyyy-MM-dd HH:mm:ss', [cultureinfo]::InvariantCulture), [DateTimeKind]::Local))
}
function New-TestDirectory {
    $path = Join-Path $env:TEMP ('WiFiMeter-CoreTest-' + [guid]::NewGuid().ToString('N'))
    [void](New-Item -ItemType Directory -Path $path)
    $script:TempDirectories += $path
    $path
}
function Seed-State([string]$SSID = 'Home') {
    $state = New-MeterState
    $session = New-MeterSession
    $time = Local-Time '2026-09-19 10:00:00'
    $null = Add-MeterSamples $state $session @((Sample 'a' $SSID 100 20)) $time
    $null = Add-MeterSamples $state $session @((Sample 'a' $SSID 1100 120)) $time.AddSeconds(5)
    $state
}
function Seed-RangeState([string]$SSID = 'Home') {
    $state = New-MeterState; $session = New-MeterSession; [long]$amount = 1000000000
    foreach ($date in @('2026-08-30','2026-08-31','2026-09-01','2026-09-02')) {
        $time = Local-Time ($date + ' 10:00:00')
        $null = Add-MeterSamples $state $session @((Sample 'a' $SSID 100 10)) $time
        $null = Add-MeterSamples $state $session @((Sample 'a' $SSID (100L + $amount) (10L + $amount / 10L))) $time.AddSeconds(5)
        $amount += 1000000000L
    }
    $state
}

try {
    Test-Case 'new state and empty rows' {
        $state = New-MeterState
        Assert-Equal $state.SchemaVersion 1
        Assert-Equal @($state.Networks).Count 0
        Assert-Equal @(Get-MeterRows $state).Count 0
    }
    Test-Case 'first observation shows zero without historical bytes' {
        $state = New-MeterState; $session = New-MeterSession
        $summary = Add-MeterSamples $state $session @((Sample 'a' 'Home' 9000 8000)) (Local-Time '2026-09-19 10:00:00')
        Assert-Equal @($state.Networks).Count 1
        Assert-Equal $state.Networks[0].RxBytes 0L
        Assert-Equal $summary.DownloadBytes 0L
        Assert-True ($state.Networks[0].RxBytes -is [long]) 'Byte totals must be Int64.'
    }
    Test-Case 'continuous deltas and summary' {
        $state = New-MeterState; $session = New-MeterSession; $time = Local-Time '2026-09-19 10:00:00'
        $null = Add-MeterSamples $state $session @((Sample 'a' 'Home' 200 10)) $time
        $summary = Add-MeterSamples $state $session @((Sample 'a' 'Home' 1200 110)) $time.AddSeconds(5)
        Assert-Equal $summary.DownloadBytes 1000L
        Assert-Equal $summary.UploadBytes 100L
        Assert-Equal (Get-MeterRows $state).TotalBytes 1100L
    }
    Test-Case 'SSID switch discards ambiguous interval' {
        $state = New-MeterState; $session = New-MeterSession; $time = Local-Time '2026-09-19 10:00:00'
        $null = Add-MeterSamples $state $session @((Sample 'a' 'Home' 100 100)) $time
        $summary = Add-MeterSamples $state $session @((Sample 'a' 'Cafe' 200 200)) $time.AddSeconds(5)
        Assert-Equal $summary.SkippedIntervals 1
        Assert-Equal (Get-MeterRows $state | Measure-Object -Property TotalBytes -Sum).Sum 0
        $null = Add-MeterSamples $state $session @((Sample 'a' 'Cafe' 250 225)) $time.AddSeconds(10)
        Assert-Equal ($state.Networks | Where-Object SSID -eq 'Cafe').RxBytes 50L
    }
    Test-Case 'one decreased counter discards both directions' {
        $state = New-MeterState; $session = New-MeterSession; $time = Local-Time '2026-09-19 10:00:00'
        $null = Add-MeterSamples $state $session @((Sample 'a' 'Home' 100 100)) $time
        $summary = Add-MeterSamples $state $session @((Sample 'a' 'Home' 90 500)) $time.AddSeconds(5)
        Assert-Equal $summary.DownloadBytes 0L; Assert-Equal $summary.UploadBytes 0L
        Assert-Equal $summary.SkippedIntervals 1
        $null = Add-MeterSamples $state $session @((Sample 'a' 'Home' 100 550)) $time.AddSeconds(10)
        Assert-Equal (Get-MeterRows $state).TotalBytes 60L
    }
    Test-Case 'empty samples break continuity' {
        $state = New-MeterState; $session = New-MeterSession; $time = Local-Time '2026-09-19 10:00:00'
        $null = Add-MeterSamples $state $session @((Sample 'a' 'Home' 100 100)) $time
        $null = Add-MeterSamples $state $session @() $time.AddSeconds(5)
        $null = Add-MeterSamples $state $session @((Sample 'a' 'Home' 9000 9000)) $time.AddSeconds(10)
        Assert-Equal (Get-MeterRows $state).TotalBytes 0L
    }
    Test-Case 'missing one adapter breaks only that adapter continuity' {
        $state = New-MeterState; $session = New-MeterSession; $time = Local-Time '2026-09-19 10:00:00'
        $null = Add-MeterSamples $state $session @((Sample 'a' 'Home' 100 100),(Sample 'b' 'Home' 500 500)) $time
        $null = Add-MeterSamples $state $session @((Sample 'a' 'Home' 110 110)) $time.AddSeconds(5)
        $null = Add-MeterSamples $state $session @((Sample 'a' 'Home' 120 120),(Sample 'b' 'Home' 9500 9500)) $time.AddSeconds(10)
        Assert-Equal (Get-MeterRows $state).TotalBytes 40L
    }
    Test-Case 'multiple adapters merge by exact SSID' {
        $state = New-MeterState; $session = New-MeterSession; $time = Local-Time '2026-09-19 10:00:00'
        $null = Add-MeterSamples $state $session @((Sample 'a' 'Home' 100 100),(Sample 'b' 'Home' 500 500),(Sample 'c' 'home' 100 100)) $time
        $null = Add-MeterSamples $state $session @((Sample 'a' 'Home' 110 110),(Sample 'b' 'Home' 550 550),(Sample 'c' 'home' 105 105)) $time.AddSeconds(5)
        $rows = @(Get-MeterRows $state)
        Assert-Equal $rows.Count 2
        Assert-Equal $rows[0].SSID 'Home'; Assert-Equal $rows[0].TotalBytes 120L
        Assert-Equal $rows[1].SSID 'home'; Assert-Equal $rows[1].TotalBytes 10L
    }
    Test-Case 'new session excludes stopped period' {
        $state = Seed-State; $time = Local-Time '2026-09-19 10:00:10'
        $null = Add-MeterSamples $state (New-MeterSession) @((Sample 'a' 'Home' 100000 50000)) $time
        Assert-Equal (Get-MeterRows $state).TotalBytes 1100L
    }
    Test-Case 'gap over 15 seconds discards interval and resumes' {
        $state = New-MeterState; $session = New-MeterSession; $time = Local-Time '2026-09-19 10:00:00'
        $null = Add-MeterSamples $state $session @((Sample 'a' 'Home' 100 100)) $time
        $null = Add-MeterSamples $state $session @((Sample 'a' 'Home' 200 200)) $time.AddSeconds(15)
        $summary = Add-MeterSamples $state $session @((Sample 'a' 'Home' 10000 10000)) $time.AddSeconds(31)
        Assert-Equal $summary.SkippedIntervals 1
        $null = Add-MeterSamples $state $session @((Sample 'a' 'Home' 10010 10010)) $time.AddSeconds(36)
        Assert-Equal (Get-MeterRows $state).TotalBytes 220L
    }
    Test-Case 'clock rollback discards interval' {
        $state = New-MeterState; $session = New-MeterSession; $time = Local-Time '2026-09-19 10:00:00'
        $null = Add-MeterSamples $state $session @((Sample 'a' 'Home' 100 100)) $time
        $summary = Add-MeterSamples $state $session @((Sample 'a' 'Home' 200 200)) $time.AddSeconds(-1)
        Assert-Equal $summary.SkippedIntervals 1
        Assert-Equal (Get-MeterRows $state).TotalBytes 0L
    }
    Test-Case 'day and month periods use local calendar buckets' {
        $state = New-MeterState; $session = New-MeterSession
        foreach ($day in @('2026-08-31','2026-09-01','2026-09-19')) {
            $time = Local-Time ($day + ' 10:00:00')
            $null = Add-MeterSamples $state $session @((Sample 'a' 'Home' 100 10)) $time
            $null = Add-MeterSamples $state $session @((Sample 'a' 'Home' 200 20)) $time.AddSeconds(5)
        }
        $now = Local-Time '2026-09-19 23:00:00'
        Assert-Equal (Get-MeterRows $state All $now).TotalBytes 330L
        Assert-Equal (Get-MeterRows $state Month $now).TotalBytes 220L
        Assert-Equal (Get-MeterRows $state Today $now).TotalBytes 110L
    }
    Test-Case 'missing files initialize state and save round trip is silent' {
        $dir = New-TestDirectory
        Assert-Equal (Read-MeterState $dir).Networks.Count 0
        $state = Seed-State
        Assert-Equal @(Save-MeterState $state $dir).Count 0
        $loaded = Read-MeterState $dir
        Assert-Equal (Get-MeterRows $loaded).TotalBytes 1100L
        Assert-True ($loaded.Networks[0].RxBytes -is [long]) 'Loaded network bytes must remain Int64.'
        Assert-True ($loaded.Networks[0].Days[0].TxBytes -is [long]) 'Loaded daily bytes must remain Int64.'
        Assert-True (-not ($loaded.PSObject.Properties.Name -contains 'Baselines')) 'Session baselines must not be persisted.'
    }
    Test-Case 'date range includes both boundary dates across months' {
        $state = Seed-RangeState
        $row = Get-MeterRows $state -Period Range -StartDate ([datetime]'2026-08-31') -EndDate ([datetime]'2026-09-01')
        Assert-Equal $row.RxBytes 5000000000L
        Assert-Equal $row.TxBytes 500000000L
        Assert-Equal $row.TotalBytes 5500000000L
        Assert-Equal (Get-MeterRows $state).TotalBytes 11000000000L
    }
    Test-Case 'single date range ignores time of day' {
        $row = Get-MeterRows (Seed-RangeState) -Period Range -StartDate ([datetime]'2026-08-31T23:59:59') -EndDate ([datetime]'2026-08-31T00:00:00')
        Assert-Equal $row.TotalBytes 2200000000L
    }
    Test-Case 'range without data keeps known networks with zero totals' {
        $rows = @(Get-MeterRows (Seed-RangeState) -Period Range -StartDate ([datetime]'2026-10-01') -EndDate ([datetime]'2026-10-31'))
        Assert-Equal $rows.Count 1
        Assert-Equal $rows[0].SSID 'Home'
        Assert-Equal $rows[0].TotalBytes 0L
    }
    Test-Case 'reversed date range raises clear error' {
        Assert-Throws { Get-MeterRows (Seed-RangeState) -Period Range -StartDate ([datetime]'2026-09-02') -EndDate ([datetime]'2026-09-01') } '开始日期不能晚于结束日期'
    }
    Test-Case 'range requires both dates even for empty state' {
        $state = New-MeterState
        Assert-Throws { Get-MeterRows $state -Period Range } '开始日期和结束日期'
        Assert-Throws { Get-MeterRows $state -Period Range -StartDate ([datetime]'2026-09-01') } '开始日期和结束日期'
        Assert-Throws { Get-MeterRows $state -Period Range -EndDate ([datetime]'2026-09-01') } '开始日期和结束日期'
    }
    Test-Case 'selected range export matches values and protects display name' {
        $dir = New-TestDirectory; $name = '+SUM(1,2)' + [char]34 + '家庭'
        $state = Seed-RangeState $name; Save-MeterState $state $dir
        $usageBefore = [IO.File]::ReadAllText((Join-Path $dir 'usage.csv'))
        $path = Join-Path $dir 'selected.csv'
        Assert-Equal @(Export-MeterRangeCsv -State $state -Path $path -Period Range -StartDate ([datetime]'2026-08-31') -EndDate ([datetime]'2026-09-01')).Count 0
        $bytes = [IO.File]::ReadAllBytes($path)
        Assert-Equal ([BitConverter]::ToString($bytes[0..2])) 'EF-BB-BF'
        $csv = @(Import-Csv -LiteralPath $path -Encoding UTF8)
        Assert-Equal $csv[0].'Wi-Fi' ("'" + $name)
        Assert-Equal $csv[0].'下载_GB' '5'
        Assert-Equal $csv[0].'上传_GB' '0.5'
        Assert-Equal $csv[0].'总计_GB' '5.5'
        Assert-Equal $state.Networks[0].SSID $name
        Assert-Equal ([IO.File]::ReadAllText((Join-Path $dir 'usage.csv'))) $usageBefore
    }
    Test-Case 'selected export supports existing periods and now' {
        $dir = New-TestDirectory; $state = Seed-RangeState; $path = Join-Path $dir 'selected.csv'
        $now = Local-Time '2026-09-01 12:00:00'
        foreach ($case in @(@{ Period = 'All'; Expected = '11' }, @{ Period = 'Today'; Expected = '3.3' }, @{ Period = 'Month'; Expected = '7.7' })) {
            Export-MeterRangeCsv $state $path -Period $case.Period -Now $now
            $csv = @(Import-Csv -LiteralPath $path -Encoding UTF8)
            Assert-Equal $csv[0].'总计_GB' $case.Expected
        }
    }
    Test-Case 'selected export validates range before replacing existing file' {
        $dir = New-TestDirectory; $path = Join-Path $dir 'selected.csv'; $state = Seed-RangeState
        [IO.File]::WriteAllText($path, 'keep-original')
        Assert-Throws { Export-MeterRangeCsv $state $path -Period Range -StartDate ([datetime]'2026-09-02') -EndDate ([datetime]'2026-09-01') } '开始日期不能晚于结束日期'
        Assert-Throws { Export-MeterRangeCsv $state $path -Period Range -StartDate ([datetime]'2026-09-01') } '开始日期和结束日期'
        Assert-Equal ([IO.File]::ReadAllText($path)) 'keep-original'
    }
    Test-Case 'selected export propagates locked file failure without replacing content' {
        $dir = New-TestDirectory; $path = Join-Path $dir 'selected.csv'; $state = Seed-RangeState
        Export-MeterRangeCsv $state $path -Period All
        $original = [IO.File]::ReadAllText($path)
        $lock = [IO.File]::Open($path, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::None)
        try { Assert-Throws { Export-MeterRangeCsv $state $path -Period Today -Now (Local-Time '2026-09-01 12:00:00') } }
        finally { $lock.Dispose() }
        Assert-Equal ([IO.File]::ReadAllText($path)) $original
    }
    Test-Case 'corrupt primary recovers backup and next save preserves valid backup' {
        $dir = New-TestDirectory; $state = Seed-State
        Save-MeterState $state $dir; Save-MeterState $state $dir
        [IO.File]::WriteAllText((Join-Path $dir 'state.json'), '{broken')
        $warnings = @(); $loaded = Read-MeterState $dir -WarningVariable warnings -WarningAction SilentlyContinue
        Assert-True ($warnings.Count -gt 0) 'Recovery must emit a warning.'
        Save-MeterState $loaded $dir -WarningAction SilentlyContinue
        $backup = Get-Content -LiteralPath (Join-Path $dir 'state.json.bak') -Raw | ConvertFrom-Json
        Assert-Equal $backup.Networks[0].RxBytes 1000
        Assert-Equal (Get-MeterRows (Read-MeterState $dir)).TotalBytes 1100L
    }
    Test-Case 'both corrupt files are never overwritten' {
        $dir = New-TestDirectory
        $state = New-MeterState
        [IO.File]::WriteAllText((Join-Path $dir 'state.json'), 'bad-primary')
        [IO.File]::WriteAllText((Join-Path $dir 'state.json.bak'), 'bad-backup')
        Assert-Throws { Read-MeterState $dir }
        Assert-Throws { Save-MeterState $state $dir }
        Assert-Equal ([IO.File]::ReadAllText((Join-Path $dir 'state.json'))) 'bad-primary'
        Assert-Equal ([IO.File]::ReadAllText((Join-Path $dir 'state.json.bak'))) 'bad-backup'
    }
    Test-Case 'invalid schema and negative counters rejected' {
        $dir = New-TestDirectory; $state = Seed-State
        $state.SchemaVersion = 99
        [IO.File]::WriteAllText((Join-Path $dir 'state.json'), ($state | ConvertTo-Json -Depth 10))
        Assert-Throws { Read-MeterState $dir }
        $state.SchemaVersion = 1; $state.Networks[0].RxBytes = -1L
        [IO.File]::WriteAllText((Join-Path $dir 'state.json'), ($state | ConvertTo-Json -Depth 10))
        Assert-Throws { Read-MeterState $dir }
    }
    Test-Case 'string schema version is rejected without overwriting source' {
        $dir = New-TestDirectory; $state = New-MeterState
        $state.SchemaVersion = '1'
        $path = Join-Path $dir 'state.json'
        [IO.File]::WriteAllText($path, ($state | ConvertTo-Json -Depth 10))
        Assert-Throws { Read-MeterState $dir }
    }
    Test-Case 'missing primary recovers and preserves backup' {
        $dir = New-TestDirectory; $state = Seed-State
        Save-MeterState $state $dir; Save-MeterState $state $dir
        [IO.File]::Delete((Join-Path $dir 'state.json'))
        $loaded = Read-MeterState $dir -WarningAction SilentlyContinue
        Save-MeterState $loaded $dir
        Assert-Equal (Get-MeterRows (Read-MeterState $dir)).TotalBytes 1100L
        Assert-True ([IO.File]::Exists((Join-Path $dir 'state.json.bak'))) 'Recovery must preserve backup.'
    }
    Test-Case 'atomic replacement keeps an open reader snapshot valid' {
        $dir = New-TestDirectory; $state = Seed-State; Save-MeterState $state $dir
        $path = Join-Path $dir 'state.json'
        $stream = [IO.File]::Open($path, [IO.FileMode]::Open, [IO.FileAccess]::Read, ([IO.FileShare]::ReadWrite -bor [IO.FileShare]::Delete))
        $reader = [IO.StreamReader]::new($stream, [Text.Encoding]::UTF8, $true)
        try {
            $state.Networks[0].RxBytes += 25L; $state.Networks[0].Days[0].RxBytes += 25L
            Save-MeterState $state $dir
            $old = $reader.ReadToEnd() | ConvertFrom-Json
            Assert-Equal $old.Networks[0].RxBytes 1000L
            Assert-Equal (Read-MeterState $dir).Networks[0].RxBytes 1025L
        } finally { $reader.Dispose() }
    }
    Test-Case 'empty exports retain column names' {
        $dir = New-TestDirectory; Save-MeterState (New-MeterState) $dir
        $text = [IO.File]::ReadAllText((Join-Path $dir 'usage.csv'))
        Assert-True ($text.Contains('"Wi-Fi","下载_GB","上传_GB","总计_GB"')) 'Empty CSV must retain columns.'
    }
    Test-Case 'CSV is UTF8 BOM, decimal GB, quoted and formula-safe without changing SSID' {
        $dir = New-TestDirectory; $name = '=SUM(1,2)' + [char]34 + '家庭'
        $state = Seed-State $name; Save-MeterState $state $dir
        $path = Join-Path $dir 'usage.csv'; $bytes = [IO.File]::ReadAllBytes($path)
        Assert-Equal ([BitConverter]::ToString($bytes[0..2])) 'EF-BB-BF'
        $csv = @(Import-Csv -LiteralPath $path -Encoding UTF8)
        Assert-Equal $csv[0].'Wi-Fi' ("'" + $name)
        Assert-Equal $csv[0].'下载_GB' '0.000001'
        Assert-Equal (Read-MeterState $dir).Networks[0].SSID $name
        $daily = @(Import-Csv -LiteralPath (Join-Path $dir 'daily.csv') -Encoding UTF8)
        Assert-Equal $daily[0].'日期' '2026-09-19'
    }
    Test-Case 'CSV locked by Excel does not fail durable JSON save' {
        $dir = New-TestDirectory; $state = Seed-State; Save-MeterState $state $dir
        $path = Join-Path $dir 'usage.csv'
        $lock = [IO.File]::Open($path, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::None)
        try {
            $state.Networks[0].RxBytes += 10L; $state.Networks[0].Days[0].RxBytes += 10L
            $warnings = @(); Save-MeterState $state $dir -WarningVariable warnings -WarningAction SilentlyContinue
            Assert-True ($warnings.Count -gt 0) 'CSV write failure must emit a warning.'
            Assert-Equal (Read-MeterState $dir).Networks[0].RxBytes 1010L
        } finally { $lock.Dispose() }
    }
} finally {
    foreach ($dir in $script:TempDirectories) {
        $resolved = [IO.Path]::GetFullPath($dir)
        $tempRoot = [IO.Path]::GetFullPath($env:TEMP).TrimEnd('\') + '\'
        if ($resolved.StartsWith($tempRoot, [StringComparison]::OrdinalIgnoreCase) -and [IO.Path]::GetFileName($resolved).StartsWith('WiFiMeter-CoreTest-')) {
            Remove-Item -LiteralPath $resolved -Recurse -Force
        }
    }
}
Write-Host "Core tests: $script:Passed passed, $script:Failed failed."
if ($script:Failed -gt 0) { exit 1 }
