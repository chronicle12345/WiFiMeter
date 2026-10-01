#requires -Version 5.1
$ErrorActionPreference = 'Stop'
$modulePath = Join-Path (Split-Path $PSScriptRoot -Parent) 'src\AppNetworkControl.psm1'
if (-not (Test-Path -LiteralPath $modulePath)) { throw 'FAIL: AppNetworkControl module is missing.' }
Import-Module $modulePath -Force
$module = Get-Module AppNetworkControl
& $module {
    function Assert($Condition, $Message) { if (-not $Condition) { throw "FAIL: $Message" } }
    function ExpectError([scriptblock]$Code) { $caught = $false; try { & $Code } catch { $caught = $true }; Assert $caught 'expected an error' }
    $script:truncateQos = $false
    $realProvider = ${function:Invoke-MeterNetworkProvider}
    $realHelper = ${function:Start-MeterNetworkHelper}
    $script:fw = @(); $script:qos = @(); $script:calls = @(); $script:qosSupported = $true
    # All policy access is replaced inside the module. Never invoke Windows policy cmdlets.
    function script:Invoke-MeterNetworkProvider {
        param($Operation, $Parameters)
        $script:calls += [pscustomobject]@{ Operation = $Operation; Parameters = $Parameters }
        switch ($Operation) {
            'ReadFirewall' { return $script:fw }
            'ReadQos' { return $script:qos }
            'QosSupport' { return $script:qosSupported }
            'AddFirewall' { $script:fw += [pscustomobject]@{ Name = $Parameters.Name; Group = $Parameters.Group; Program = $Parameters.Program; Direction = $Parameters.Direction; Action = 'Block'; Enabled = 'True' }; return }
            'RemoveFirewall' { $script:fw = @($script:fw | Where-Object Name -CNE $Parameters.Name); return }
            'AddQos' { $script:qos += [pscustomobject]@{ Name = $Parameters.Name; AppPathName = $(if ($script:truncateQos) { 'app.exe' } else { $Parameters.AppPathNameMatchCondition }); ThrottleRate = $Parameters.ThrottleRateActionBitsPerSecond }; return }
            'RemoveQos' { $script:qos = @($script:qos | Where-Object Name -CNE $Parameters.Name); return }
            default { throw "Unexpected provider operation: $Operation" }
        }
    }
    # Inspect the real launcher using a Start-Process mock; never prompt for UAC.
    function script:Start-Process {
        param($FilePath, $ArgumentList, $Verb, $WindowStyle, [switch]$PassThru, $ErrorAction)
        $script:launch = $PSBoundParameters
        return [pscustomobject]@{ Mock = $true }
    }
    $hostilePath = 'C:\中文 空格\x''; Write-Output INJECTED; #.exe'
    $null = & $realHelper $hostilePath Block 0
    Assert ($script:launch.Verb -eq 'RunAs' -and $script:launch.WindowStyle -eq 'Hidden') 'real UAC flags'
    Assert ($script:launch.FilePath -like '*\System32\WindowsPowerShell\v1.0\powershell.exe') 'absolute helper executable'
    $arguments = $script:launch.ArgumentList
    Assert ($arguments.Count -eq 4 -and $arguments[2] -eq '-EncodedCommand') 'fixed argument shape'
    $code = [Text.Encoding]::Unicode.GetString([Convert]::FromBase64String($arguments[3]))
    Assert (-not $code.Contains('INJECTED')) 'untrusted path not interpolated into script'
    Assert ($code -match "FromBase64String\('([A-Za-z0-9+/=]+)'\)") 'base64 JSON payload'
    $data = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($Matches[1])) | ConvertFrom-Json
    Assert ($data.Path -ceq $hostilePath -and $data.Action -eq 'Block') 'payload round trip'
    Assert ($data.Module -eq $script:MeterNetworkModulePath) 'fixed module identity'
    $parseErrors = $null; $tokens = $null
    $null = [Management.Automation.Language.Parser]::ParseInput($code, [ref]$tokens, [ref]$parseErrors)
    Assert ($parseErrors.Count -eq 0) 'helper syntax'
    # Exercise the actual adapter with fake cmdlets, including mandatory policy-store flags.
    function script:New-NetFirewallRule { param($Name,$DisplayName,$Group,$Program,$Direction,$Action,$Enabled,$Profile,$Protocol,$PolicyStore,$ErrorAction); $script:bound = $PSBoundParameters }
    function script:Remove-NetFirewallRule { param($Name,$PolicyStore,$ErrorAction); $script:bound = $PSBoundParameters }
    function script:New-NetQosPolicy { param($Name,$AppPathNameMatchCondition,$ThrottleRateActionBitsPerSecond,$NetworkProfile,$PolicyStore,$ErrorAction); $script:bound = $PSBoundParameters }
    function script:Remove-NetQosPolicy { param($Name,$PolicyStore,$Confirm,$ErrorAction); $script:bound = $PSBoundParameters }
    & $realProvider AddFirewall @{ Name = 'WiFiMeter.AppNetwork.v1-test-In'; Program = $hostilePath; Direction = 'Inbound'; Action = 'Block'; Enabled = 'True'; Group = $script:MeterNetworkGroup; Profile = 'Any'; Protocol = 'Any' }
    Assert ($script:bound.Program -ceq $hostilePath -and $script:bound.PolicyStore -eq 'PersistentStore') 'firewall adapter uses literal program and persistent store'
    & $realProvider RemoveFirewall @{ Name = 'WiFiMeter.AppNetwork.v1-test-In' }
    Assert ($script:bound.Name -ceq 'WiFiMeter.AppNetwork.v1-test-In' -and $script:bound.PolicyStore -eq 'PersistentStore') 'firewall adapter exact removal'
    & $realProvider AddQos @{ Name = 'WiFiMeter.AppNetwork.v1-test-Upload'; AppPathNameMatchCondition = $hostilePath; ThrottleRateActionBitsPerSecond = 8000; NetworkProfile = 'All' }
    Assert ($script:bound.AppPathNameMatchCondition -ceq $hostilePath -and $script:bound.ThrottleRateActionBitsPerSecond -eq 8000 -and $script:bound.PolicyStore -eq 'localhost') 'QoS adapter parameters'
    & $realProvider RemoveQos @{ Name = 'WiFiMeter.AppNetwork.v1-test-Upload' }
    Assert ($script:bound.Confirm -eq $false -and $script:bound.PolicyStore -eq 'localhost') 'QoS adapter removal flags'
    $path = 'C:\Program Files\Example\app.exe'
    ExpectError { Resolve-MeterAppPath 'app.exe' }
    ExpectError { Resolve-MeterAppPath 'C:app.exe' }
    ExpectError { Resolve-MeterAppPath 'C:\app*.exe' }
    ExpectError { Resolve-MeterAppPath 'C:\app.exe:stream.exe' }
    $script:fw = @([pscustomobject]@{ Name = 'UserRule'; Group = 'User'; Program = $path; Direction = 'Outbound'; Action = 'Allow'; Enabled = 'True' })
    Invoke-MeterNetworkMutation $path Block 0
    Assert ($script:fw.Count -eq 3) 'block must add two rules'
    Assert ((Get-MeterAppNetworkState $path).Blocked) 'block state'
    Invoke-MeterNetworkMutation $path Block 0
    Assert ($script:fw.Count -eq 3) 'block is idempotent'
    Invoke-MeterNetworkMutation $path Unblock 0
    Assert ($script:fw.Count -eq 1 -and $script:fw[0].Name -eq 'UserRule') 'preserve user rules'
    Invoke-MeterNetworkMutation $path Throttle 128
    Assert ((Get-MeterAppNetworkState $path).UploadKbps -eq 128) 'upload rate round trip'
    $add = @($script:calls | Where-Object Operation -EQ AddQos)[0].Parameters
    Assert ($add.ThrottleRateActionBitsPerSecond -eq 128000) 'Kbps uses decimal bits per second'
    Assert ($add.AppPathNameMatchCondition -eq $path) 'full executable path'
    Invoke-MeterNetworkMutation $path Unthrottle 0
    Assert ($script:qos.Count -eq 0) 'remove owned QoS'
    $script:truncateQos = $true
    ExpectError { Invoke-MeterNetworkMutation $path Throttle 128 }
    Assert ($script:qos.Count -eq 0) 'unsupported full-path readback rolls back created policy'
    $script:truncateQos = $false
    $script:qosSupported = $false
    ExpectError { Invoke-MeterNetworkMutation $path Throttle 128 }
    Assert (-not (Get-MeterAppNetworkState $path).QosSupported) 'report unavailable QoS'
    $script:qosSupported = $true
    $identity = Get-MeterNetworkIdentity $path
    $script:fw += [pscustomobject]@{ Name = $identity + '-Out'; Group = 'User'; Program = $path; Direction = 'Outbound'; Action = 'Block'; Enabled = 'True' }
    ExpectError { Invoke-MeterNetworkMutation $path Unblock 0 }
    Assert ($script:fw.Count -eq 2) 'foreign collision preserved'
    $script:fw = @()
    $script:qos = @([pscustomobject]@{ Name = $identity + '-Upload'; AppPathName = 'app.exe'; ThrottleRate = 128000 })
    ExpectError { Invoke-MeterNetworkMutation $path Unthrottle 0 }
    Assert ($script:qos.Count -eq 1) 'basename QoS never considered exact path owned'
    $script:qos = @()
    function script:Start-MeterNetworkHelper { param($Path, $Action, $UploadKbps); throw (New-Object ComponentModel.Win32Exception 1223) }
    $cancelled = Invoke-MeterAppNetworkAction $path Block
    Assert ($cancelled.Status -eq 'Cancelled' -and $cancelled.ErrorCode -eq 'UacCancelled') 'UAC cancellation'
    function script:Start-MeterNetworkHelper { param($Path, $Action, $UploadKbps); throw 'launch failed' }
    Assert ((Invoke-MeterAppNetworkAction $path Block).Status -eq 'Failed') 'launch error'
    Assert ((Invoke-MeterAppNetworkAction $path Throttle -UploadKbps 0).ErrorCode -eq 'InvalidRequest') 'invalid throttle error'
    $script:fakeProcess = [pscustomobject]@{ HasExited = $false; ExitCode = 0 }
    $script:fakeProcess | Add-Member ScriptMethod WaitForExit { param($Milliseconds); return $this.HasExited }
    $script:fakeProcess | Add-Member ScriptMethod Dispose { }
    function script:Start-MeterNetworkHelper { param($Path, $Action, $UploadKbps); return $script:fakeProcess }
    $pending = Invoke-MeterAppNetworkAction $path Block
    Assert ($pending.Status -eq 'Running') 'async operation'
    Assert ((Receive-MeterAppNetworkAction $pending -WaitMilliseconds 1).Status -eq 'Running') 'bounded wait pending'
    Invoke-MeterNetworkMutation $path Block 0
    $script:fakeProcess.HasExited = $true
    Assert ((Receive-MeterAppNetworkAction $pending).Status -eq 'Succeeded') 'completed state verified'
    $script:fakeProcess.ExitCode = 1
    Assert ((Invoke-MeterAppNetworkAction $path Block -WaitMilliseconds 1).ErrorCode -eq 'HelperFailed') 'nonzero helper exit'
    $script:fakeProcess.ExitCode = 0
    Assert ((Invoke-MeterAppNetworkAction $path Unblock).ErrorCode -eq 'VerificationFailed') 'zero exit without requested state is failure'
    Assert ((Get-MeterNetworkIdentity (Resolve-MeterAppPath 'c:\PROGRAM FILES\Example\..\Example\app.exe')) -eq (Get-MeterNetworkIdentity $path)) 'normalized path identity'
    $script:qos = @([pscustomobject]@{ Name = 'UserUploadRule'; AppPathName = $path; ThrottleRate = 96000 })
    Invoke-MeterNetworkMutation $path Throttle 256
    Invoke-MeterNetworkMutation $path Unthrottle 0
    Assert ($script:qos.Count -eq 1 -and $script:qos[0].Name -eq 'UserUploadRule') 'preserve user QoS'
    function script:Invoke-MeterNetworkProvider { param($Operation,$Parameters); if ($Operation -eq 'QosSupport') { return $true }; throw 'mock access denied' }
    $denied = Get-MeterAppNetworkState $path
    Assert ($null -eq $denied.Blocked -and $null -eq $denied.Throttled) 'failed reads are unknown, not unblocked'
    Assert ($denied.FirewallErrorCode -eq 'FirewallQueryFailed' -and $denied.QosErrorCode -eq 'QosQueryFailed') 'query error codes'
    Write-Output 'PASS: isolated ownership, parameters, exact paths, unsupported QoS, errors, UAC cancellation, async completion.'
}
Remove-Module AppNetworkControl
