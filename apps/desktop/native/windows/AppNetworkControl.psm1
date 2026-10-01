﻿#requires -Version 5.1
Set-StrictMode -Version Latest
$script:MeterNetworkModulePath = $PSCommandPath
$script:MeterNetworkGroup = 'WiFiMeter.AppNetwork.v1'
$script:MeterNetworkWarning = 'Windows Firewall 对本地代理环回连接不一定可靠；规则状态不代表彻底阻断联网。QoS 仅限制匹配进程的上传，不限制下载或代理进程。'

function Resolve-MeterAppPath {
    param([Parameter(Mandatory)][string]$Path)
    if ($Path -notmatch '^[a-zA-Z]:\\' -or $Path.Substring(2) -match '[:*?"<>|\x00-\x1f]' -or
        [IO.Path]::GetExtension($Path) -ine '.exe') { throw '必须提供本地磁盘上的绝对 exe 路径，不能包含通配符或备用数据流。' }
    foreach ($part in $Path.Substring(3).Split('\')) {
        if ($part -match '[ .]$' -and $part -notin @('.', '..')) { throw '路径段不能以空格或点结尾。' }
    }
    return [IO.Path]::GetFullPath($Path)
}

function Get-MeterNetworkIdentity {
    param([string]$Path)
    $sha = [Security.Cryptography.SHA256]::Create()
    try { return 'WiFiMeter.AppNetwork.v1-' + ([BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($Path.ToUpperInvariant())))).Replace('-', '') }
    finally { $sha.Dispose() }
}

function Invoke-MeterNetworkProvider {
    param([string]$Operation, [hashtable]$Parameters = @{})
    # Sole Windows policy boundary; replaced in isolated tests.
    switch ($Operation) {
        'ReadFirewall' {
            foreach ($rule in @(Get-NetFirewallRule -PolicyStore PersistentStore -ErrorAction Stop)) {
                if ($rule.Name -like 'WiFiMeter.AppNetwork.v1-*') {
                    $filters = @($rule | Get-NetFirewallApplicationFilter -ErrorAction Stop)
                    [pscustomobject]@{ Name = $rule.Name; Group = $rule.Group; Program = $(if ($filters.Count -eq 1) { $filters[0].Program } else { '' }); Direction = [string]$rule.Direction; Action = [string]$rule.Action; Enabled = [string]$rule.Enabled }
                }
            }
        }
        'AddFirewall' { $null = New-NetFirewallRule @Parameters -PolicyStore PersistentStore -ErrorAction Stop }
        'RemoveFirewall' { Remove-NetFirewallRule @Parameters -PolicyStore PersistentStore -ErrorAction Stop }
        'QosSupport' {
            $new = Get-Command New-NetQosPolicy -ErrorAction SilentlyContinue
            return ($null -ne $new -and $new.Parameters.ContainsKey('AppPathNameMatchCondition') -and
                $new.Parameters.ContainsKey('ThrottleRateActionBitsPerSecond') -and
                $null -ne (Get-Command Get-NetQosPolicy -ErrorAction SilentlyContinue) -and
                $null -ne (Get-Command Remove-NetQosPolicy -ErrorAction SilentlyContinue))
        }
        'ReadQos' { Get-NetQosPolicy -PolicyStore localhost -ErrorAction Stop }
        'AddQos' { $null = New-NetQosPolicy @Parameters -PolicyStore localhost -ErrorAction Stop }
        'RemoveQos' { Remove-NetQosPolicy @Parameters -PolicyStore localhost -Confirm:$false -ErrorAction Stop }
        default { throw "未知策略操作: $Operation" }
    }
}

function Get-MeterQosValue {
    param($Policy, [string[]]$Names)
    foreach ($name in $Names) { if ($null -ne $Policy.PSObject.Properties[$name]) { return $Policy.$name } }
    throw ('NetQos 未提供可验证字段: ' + ($Names -join ', '))
}

function Get-MeterOwnedNetworkPolicy {
    param([string]$Path)
    $id = Get-MeterNetworkIdentity $Path
    $rules = @(Invoke-MeterNetworkProvider ReadFirewall | Where-Object { $_.Name -ceq ($id + '-In') -or $_.Name -ceq ($id + '-Out') })
    foreach ($rule in $rules) {
        if ($rule.Group -cne $script:MeterNetworkGroup -or $rule.Program -ine $Path) { throw '防火墙规则名称冲突，拒绝修改不属于本应用路径的规则。' }
    }
    return [pscustomobject]@{ Firewall = $rules }
}

function Get-MeterAppNetworkState {
    <#
    .SYNOPSIS
    查询本软件保存的路径专属策略。Blocked 是本地配置状态，不是连通性探测。
    .DESCRIPTION
    FirewallError/QosError 非空表示该部分查询失败；此时对应状态为 null。
    QosSupported 表示命令支持路径条件；ExactPathQosVerified 仅在已有策略完整路径可读时为 true。
    没有策略时无法无副作用探测系统是否保留完整路径；Throttle 会在创建后验证，不支持即失败。
    #>
    [CmdletBinding()]
    param([Parameter(Mandatory)][string]$Path)
    $Path = Resolve-MeterAppPath $Path
    $state = [pscustomobject]@{
        Path = $Path; Blocked = $null; InboundBlocked = $null; OutboundBlocked = $null
        FirewallRuleCount = $null; FirewallError = $null; FirewallErrorCode = $null; QosSupported = $false
        ExactPathQosVerified = $false; Throttled = $null; UploadKbps = $null; QosError = $null; QosErrorCode = $null
        Scope = 'LocalConfiguredPolicy'; Warning = $script:MeterNetworkWarning
    }
    try {
        $owned = Get-MeterOwnedNetworkPolicy $Path
        $state.FirewallRuleCount = $owned.Firewall.Count
        $state.InboundBlocked = @($owned.Firewall | Where-Object { $_.Direction -eq 'Inbound' -and $_.Action -eq 'Block' -and $_.Enabled -eq 'True' }).Count -eq 1
        $state.OutboundBlocked = @($owned.Firewall | Where-Object { $_.Direction -eq 'Outbound' -and $_.Action -eq 'Block' -and $_.Enabled -eq 'True' }).Count -eq 1
        $state.Blocked = $state.InboundBlocked -and $state.OutboundBlocked
    } catch { $state.FirewallError = $_.Exception.Message; $state.FirewallErrorCode = 'FirewallQueryFailed' }
    try {
        $state.QosSupported = [bool](Invoke-MeterNetworkProvider QosSupport)
        if (-not $state.QosSupported) { throw '此系统未提供支持 exe 路径条件的 Windows NetQos 命令。' }
        $id = Get-MeterNetworkIdentity $Path
        $policies = @(Invoke-MeterNetworkProvider ReadQos | Where-Object { $_.Name -ceq ($id + '-Upload') })
        if ($policies.Count -gt 1) { throw '存在重复的上传限速策略。' }
        $state.Throttled = $false
        if ($policies.Count -eq 1) {
            if ((Get-MeterQosValue $policies[0] @('AppPathName', 'AppPathNameMatchCondition')) -ine $Path) { throw 'NetQos 策略未匹配完整 exe 路径。' }
            $rate = [uint64](Get-MeterQosValue $policies[0] @('ThrottleRate', 'ThrottleRateAction', 'ThrottleRateActionBitsPerSecond'))
            if ($rate -eq 0) { throw 'NetQos 返回的限速值无效。' }
            $state.ExactPathQosVerified = $true
            $state.Throttled = $true
            $state.UploadKbps = $rate / 1000.0
        }
    } catch { $state.QosError = $_.Exception.Message; $state.Throttled = $null; $state.QosErrorCode = if ($state.QosSupported) { 'QosQueryFailed' } else { 'QosUnsupported' } }
    return $state
}

function Invoke-MeterNetworkMutation {
    param([string]$Path, [ValidateSet('Block','Unblock','Throttle','Unthrottle')][string]$Action, [long]$UploadKbps)
    $Path = Resolve-MeterAppPath $Path
    $id = Get-MeterNetworkIdentity $Path
    if ($Action -in @('Block', 'Unblock')) {
        $owned = Get-MeterOwnedNetworkPolicy $Path
        if ($Action -eq 'Unblock') {
            foreach ($rule in $owned.Firewall) { Invoke-MeterNetworkProvider RemoveFirewall @{ Name = $rule.Name } }
        } else {
            foreach ($direction in @('Inbound', 'Outbound')) {
                $suffix = if ($direction -eq 'Inbound') { '-In' } else { '-Out' }
                $name = $id + $suffix
                $existing = @($owned.Firewall | Where-Object Name -CEQ $name)
                if ($existing.Count -eq 1 -and $existing[0].Direction -eq $direction -and $existing[0].Action -eq 'Block' -and $existing[0].Enabled -eq 'True') { continue }
                foreach ($rule in $existing) { Invoke-MeterNetworkProvider RemoveFirewall @{ Name = $rule.Name } }
                Invoke-MeterNetworkProvider AddFirewall @{ Name = $name; DisplayName = $name; Group = $script:MeterNetworkGroup; Program = $Path; Direction = $direction; Action = 'Block'; Enabled = 'True'; Profile = 'Any'; Protocol = 'Any' }
            }
        }
        return
    }
    if (-not (Invoke-MeterNetworkProvider QosSupport)) { throw '系统不支持按 exe 路径配置 NetQos。' }
    if ($Action -eq 'Throttle' -and ($UploadKbps -lt 1 -or $UploadKbps -gt 1000000000)) { throw 'UploadKbps 必须在 1 到 1000000000 之间，单位为千比特每秒。' }
    $policies = @(Invoke-MeterNetworkProvider ReadQos | Where-Object { $_.Name -ceq ($id + '-Upload') })
    foreach ($policy in $policies) {
        if ((Get-MeterQosValue $policy @('AppPathName','AppPathNameMatchCondition')) -ine $Path) { throw '限速策略名称冲突或不支持精确路径，拒绝删除。' }
    }
    if ($Action -eq 'Throttle' -and $policies.Count -eq 1 -and
        [uint64](Get-MeterQosValue $policies[0] @('ThrottleRate','ThrottleRateAction', 'ThrottleRateActionBitsPerSecond')) -eq ([uint64]$UploadKbps * 1000)) { return }
    foreach ($policy in $policies) { Invoke-MeterNetworkProvider RemoveQos @{ Name = $policy.Name } }
    if ($Action -eq 'Unthrottle') { return }
    Invoke-MeterNetworkProvider AddQos @{ Name = $id + '-Upload'; AppPathNameMatchCondition = $Path; ThrottleRateActionBitsPerSecond = ([uint64]$UploadKbps * 1000); NetworkProfile = 'All' }
    try {
        $readback = @(Invoke-MeterNetworkProvider ReadQos | Where-Object { $_.Name -ceq ($id + '-Upload') })
        if ($readback.Count -ne 1 -or (Get-MeterQosValue $readback[0] @('AppPathName','AppPathNameMatchCondition')) -ine $Path -or
            [uint64](Get-MeterQosValue $readback[0] @('ThrottleRate','ThrottleRateAction','ThrottleRateActionBitsPerSecond')) -ne ([uint64]$UploadKbps * 1000)) {
            throw 'NetQos 无法验证完整 exe 路径及速率。'
        }
    } catch {
        $failure = $_.Exception.Message
        # Only the exact name just created by this invocation is rolled back.
        try { Invoke-MeterNetworkProvider RemoveQos @{ Name = $id + '-Upload' } }
        catch { throw ($failure + ' 新建策略清理失败: ' + $_.Exception.Message) }
        throw ($failure + ' 已取消新建策略。')
    }
}

function Start-MeterNetworkHelper {
    param([string]$Path, [string]$Action, [long]$UploadKbps)
    # Only this module is loaded: no caller-selected script/command or result file.
    # JSON is base64 data inside a fixed script; quotes in paths never become code.
    $payload = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes((@{
        Module = $script:MeterNetworkModulePath; Path = $Path; Action = $Action; UploadKbps = $UploadKbps
    } | ConvertTo-Json -Compress)))
    $template = @(
        '$ErrorActionPreference = ''Stop'''
        'try {'
        '    $data = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String(''__PAYLOAD__'')) | ConvertFrom-Json'
        '    $module = Import-Module -Name $data.Module -Force -PassThru'
        '    & $module { param($p, $a, $r) Invoke-MeterNetworkMutation -Path $p -Action $a -UploadKbps $r } $data.Path $data.Action ([long]$data.UploadKbps)'
        '    exit 0'
        '} catch { exit 1 }'
    ) -join "`n"
    $encoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($template.Replace('__PAYLOAD__', $payload)))
    $exe = Join-Path ([Environment]::GetFolderPath('Windows')) 'System32\WindowsPowerShell\v1.0\powershell.exe'
    return Start-Process -FilePath $exe -ArgumentList @('-NoProfile', '-NonInteractive', '-EncodedCommand', $encoded) -Verb RunAs -WindowStyle Hidden -PassThru -ErrorAction Stop
}

function Invoke-MeterAppNetworkAction {
    <#
    .SYNOPSIS
    启动 UAC helper，默认异步返回。UploadKbps 单位为 1000 bit/s。
    .DESCRIPTION
    返回 Status=Running/Succeeded/Failed/Cancelled，State 为可查询的实际本地配置。
    WaitMilliseconds 仅限制启动后的进程等待，不限制 Windows UAC 对话框等待时间。
    UI 保存操作对象并用 Receive-MeterAppNetworkAction 轮询，终态后无需再调用。
    helper 失败可能已产生部分修改，必须展示 State 和 Error；不表示网络可达性。
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][string]$Path,
        [Parameter(Mandatory)][ValidateSet('Block','Unblock','Throttle','Unthrottle')][string]$Action,
        [long]$UploadKbps = 0,
        [ValidateRange(0,5000)][int]$WaitMilliseconds = 0
    )
    $operation = [pscustomobject]@{ Id = [guid]::NewGuid().ToString('N'); Path = $Path; Action = $Action; UploadKbps = $UploadKbps; Status = 'Running'; Error = $null; ErrorCode = $null; State = $null; Process = $null; Warning = $script:MeterNetworkWarning }
    try {
        $operation.ErrorCode = 'InvalidRequest'
        $operation.Path = Resolve-MeterAppPath $Path
        if ($Action -eq 'Throttle' -and ($UploadKbps -lt 1 -or $UploadKbps -gt 1000000000)) { throw 'UploadKbps 必须在 1 到 1000000000 之间。' }
        $operation.ErrorCode = 'HelperLaunchFailed'
        $operation.Process = Start-MeterNetworkHelper $operation.Path $Action $UploadKbps
        $operation.ErrorCode = $null
        return Receive-MeterAppNetworkAction $operation -WaitMilliseconds $WaitMilliseconds
    } catch {
        $exception = $_.Exception
        $cancelled = $false
        while ($null -ne $exception) {
            if ($exception -is [ComponentModel.Win32Exception] -and $exception.NativeErrorCode -eq 1223) { $cancelled = $true }
            $exception = $exception.InnerException
        }
        $operation.Status = if ($cancelled) { 'Cancelled' } else { 'Failed' }
        if ($cancelled) { $operation.ErrorCode = 'UacCancelled' }
        $operation.Error = $_.Exception.Message
        return $operation
    }
}

function Receive-MeterAppNetworkAction {
    [CmdletBinding()]
    param([Parameter(Mandatory)]$Operation, [ValidateRange(0,5000)][int]$WaitMilliseconds = 0)
    if ($Operation.Status -ne 'Running') { return $Operation }
    try {
        if ($WaitMilliseconds -gt 0) { $null = $Operation.Process.WaitForExit($WaitMilliseconds) }
        if (-not $Operation.Process.HasExited) { return $Operation }
        $exitCode = $Operation.Process.ExitCode
        $Operation.Process.Dispose()
        $Operation.Process = $null
        $Operation.State = Get-MeterAppNetworkState $Operation.Path
        if ($exitCode -ne 0) { $Operation.ErrorCode = 'HelperFailed'; throw "权限提升 helper 失败 (exit $exitCode)，可能存在部分修改；请查看 State 中的策略状态和查询错误。" }
        $s = $Operation.State
        $ok = switch ($Operation.Action) {
            Block { $null -eq $s.FirewallError -and $s.Blocked }
            Unblock { $null -eq $s.FirewallError -and $s.FirewallRuleCount -eq 0 }
            Throttle { $null -eq $s.QosError -and $s.ExactPathQosVerified -and $s.UploadKbps -eq $Operation.UploadKbps }
            Unthrottle { $null -eq $s.QosError -and $s.Throttled -eq $false }
        }
        if (-not $ok) { $Operation.ErrorCode = 'VerificationFailed'; throw '策略回读未确认请求的配置，不能报告成功。请检查 State 的查询错误。' }
        $Operation.Status = 'Succeeded'
    } catch { $Operation.Status = 'Failed'; $Operation.Error = $_.Exception.Message; if ($null -eq $Operation.ErrorCode) { $Operation.ErrorCode = 'OperationFailed' } }
    return $Operation
}

Export-ModuleMember -Function Invoke-MeterAppNetworkAction, Get-MeterAppNetworkState, Receive-MeterAppNetworkAction
