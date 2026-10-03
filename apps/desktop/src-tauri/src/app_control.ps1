$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = New-Object Text.UTF8Encoding($false)
try {
    $data = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('__PAYLOAD__')) | ConvertFrom-Json
    Import-Module -Name $data.Module -Force -WarningAction SilentlyContinue
    if ($data.Action -eq 'Read') {
        $state = Get-MeterAppNetworkState -Path $data.Path
        $result = [pscustomobject]@{ Status = 'Succeeded'; Path = $data.Path; State = $state; Warning = $state.Warning; Error = $null; ErrorCode = $null }
    } else {
        $result = Invoke-MeterAppNetworkAction -Path $data.Path -Action $data.Action -UploadKbps ([long]$data.UploadKbps)
        $clock = [Diagnostics.Stopwatch]::StartNew()
        while ($result.Status -eq 'Running' -and $clock.ElapsedMilliseconds -lt 120000) {
            $result = Receive-MeterAppNetworkAction -Operation $result -WaitMilliseconds 1000
        }
        if ($result.Status -eq 'Running') {
            $result.Status = 'Failed'
            $result.ErrorCode = 'HelperTimeout'
            $result.Error = '等待策略操作超时；提权进程可能仍在运行，请稍后主动查询状态。'
            $result.State = Get-MeterAppNetworkState -Path $data.Path
            $result.Process.Dispose()
        }
        $result.Process = $null
    }
    $result | Select-Object Status, Path, State, Warning, Error, ErrorCode | ConvertTo-Json -Depth 8 -Compress
} catch {
    [pscustomobject]@{ Status = 'Failed'; ErrorCode = 'OperationFailed'; Error = $_.Exception.Message; State = $null } | ConvertTo-Json -Compress
}
