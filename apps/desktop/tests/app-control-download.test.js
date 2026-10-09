import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const native = fileURLToPath(new URL('../native/windows/', import.meta.url));
const source = path.join(native, 'DownloadLimiter.cs');
const modulePath = path.join(native, 'AppNetworkControl.psm1');
const windows = { skip: process.platform !== 'win32' };
function powershell(script) {
    const command = `$ErrorActionPreference = 'Stop'\n$ProgressPreference = 'SilentlyContinue'\n[Console]::OutputEncoding = New-Object Text.UTF8Encoding($false)\n${script}`;
    return execFileSync(path.win32.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
        ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(command, 'utf16le').toString('base64')],
        { encoding: 'utf8', windowsHide: true, shell: false, timeout: 30000, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}
const literal = value => `'${value.replaceAll("'", "''")}'`;

function failedReceiveSource() {
    // Replace only the native boundary; exercise the actual receive loops without loading a driver.
    const declaration = String.raw`\[DllImport\("WinDivert\.dll"[^\n]*\] private static extern bool WinDivertRecv\([^\n]*\);`;
    const replacement = 'private static bool WinDivertRecv(IntPtr handle, byte[] packet, uint capacity, out uint length, byte[] address) { length = 0; return false; }';
    return `$nativeSource = [IO.File]::ReadAllText(${literal(source)})
$nativeSource = [Text.RegularExpressions.Regex]::Replace($nativeSource, ${literal(declaration)}, ${literal(replacement)})
Add-Type -TypeDefinition $nativeSource`;
}

function mockDaemonSource() {
    // Exercise the real daemon, pipe protocol and cleanup. Only OS boundaries are replaced.
    const replacements = {
        LoadLibraryEx: 'private static IntPtr LoadLibraryEx(string path, IntPtr file, uint flags) { return NativeMock.Load(); }',
        WinDivertOpen: 'private static IntPtr WinDivertOpen(string filter, int layer, short priority, ulong flags) { return NativeMock.Open(layer); }',
        WinDivertRecv: 'private static bool WinDivertRecv(IntPtr handle, byte[] packet, uint capacity, out uint length, byte[] address) { length = 0; return NativeMock.Receive(); }',
        WinDivertSend: 'private static bool WinDivertSend(IntPtr handle, byte[] packet, uint length, out uint sent, byte[] address) { sent = length; return true; }',
        WinDivertClose: 'private static bool WinDivertClose(IntPtr handle) { Interlocked.Increment(ref NativeMock.Closed); return true; }',
        WinDivertShutdown: 'private static bool WinDivertShutdown(IntPtr handle, uint how) { NativeMock.Stopped = true; return true; }',
        WinDivertSetParam: 'private static bool WinDivertSetParam(IntPtr handle, int parameter, ulong value) { return true; }'
    };
    return `$nativeSource = [IO.File]::ReadAllText(${literal(source)})
${Object.entries(replacements).map(([name, replacement]) => {
        const declaration = String.raw`\[DllImport\([^\n]*\] private static extern [^\n]*\b${name}\([^\n]*\);`;
        return `if ([Text.RegularExpressions.Regex]::Matches($nativeSource, ${literal(declaration)}).Count -ne 1) { throw 'Mock boundary not found exactly once: ${name}' }
$nativeSource = [Text.RegularExpressions.Regex]::Replace($nativeSource, ${literal(declaration)}, ${literal(replacement)})`;
    }).join('\n')}
$nativeSource = $nativeSource.Replace('owner.HasExited', 'NativeMock.OwnerExited')
$nativeSource = $nativeSource.Replace('pipe.RunAsClient(delegate { administrator = new WindowsPrincipal(WindowsIdentity.GetCurrent()).IsInRole(WindowsBuiltInRole.Administrator); });', 'administrator = true;')
$nativeSource += @'
namespace WiFiMeter.DownloadControl {
    public static class NativeMock {
        public static volatile bool ReceiveFailure, LoadFailure, OpenFailure, OwnerExited, Stopped;
        public static int Opened, Closed;
        public static Thread Worker;
        public static string ServerError;
        public static IntPtr Load() {
            if (LoadFailure) throw new Win32Exception(126, "Mock DLL unavailable");
            return new IntPtr(1);
        }
        public static IntPtr Open(int layer) {
            if (layer != 0) return new IntPtr(-1);
            if (OpenFailure) throw new Win32Exception(577, "Mock driver signature rejected");
            Stopped = false; Interlocked.Increment(ref Opened); return new IntPtr(1);
        }
        public static bool Receive() {
            while (!Stopped && !ReceiveFailure) Thread.Sleep(5);
            if (ReceiveFailure) throw new IOException("Mock packet receive failure");
            return false;
        }
        public static void Start(string pipe, string path, int owner, string sid) {
            Worker = new Thread(delegate() {
                try { Server.Run(pipe, "mock.dll", path, 80, owner, sid); }
                catch (Exception error) { ServerError = error.Message; }
            });
            Worker.IsBackground = true; Worker.Start();
        }
        public static string Call(string pipe, string action, string path, long rate) {
            Stopwatch clock = Stopwatch.StartNew();
            do {
                try { string result = Server.Request(pipe, action, path, rate, 100); if (result != null) return result; }
                catch (Exception error) { return "ERROR|" + error.Message; }
                if (Worker != null && !Worker.IsAlive) return "NO_DAEMON";
                Thread.Sleep(10);
            } while (clock.ElapsedMilliseconds < 3000);
            return "NO_RESPONSE";
        }
        public static void WaitForCleanup() {
            Stopwatch clock = Stopwatch.StartNew();
            while (Closed == 0 && Worker.IsAlive && clock.ElapsedMilliseconds < 3000) Thread.Sleep(10);
        }
    }
}
'@
Add-Type -TypeDefinition $nativeSource
$pipeName = 'WiFiMeter.DownloadControl.test-' + [guid]::NewGuid().ToString('N')
$appPath = 'C:\\Apps\\limited.exe'
$sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$module = Import-Module -Name ${literal(modulePath)} -Force -PassThru
& $module { param($pipe); $script:TestPipeName = $pipe; function script:Get-MeterDownloadPipeName { return $script:TestPipeName } } $pipeName`;
}

test('the download support script is readable by Windows PowerShell 5.1', () => {
    const bytes = readFileSync(path.join(native, 'DownloadNetworkControl.ps1'));
    assert.equal(bytes.subarray(0, 3).toString('hex'), 'efbbbf');
    assert.equal(bytes.subarray(3).toString('utf8').startsWith('#requires -Version 5.1'), true);
});

test('download limiter compiles on .NET Framework and meters elapsed payload bytes', windows, () => {
    const result = JSON.parse(powershell(`
Add-Type -Path ${literal(source)}
$bucket = New-Object WiFiMeter.DownloadControl.TokenBucket(8, 0)
$first = $bucket.Take(1000, 0.5)
$second = $bucket.Take(1000, 1)
$third = $bucket.Take(1000, 1)
$fourth = $bucket.Take(500, 1.5)
$idleBurst = $bucket.Take(1500, 100)
$excessBurst = $bucket.Take(1, 100)
$tiny = New-Object WiFiMeter.DownloadControl.TokenBucket(1, 0)
[pscustomobject]@{ First=$first; Second=$second; Third=$third; Fourth=$fourth; IdleBurst=$idleBurst; ExcessBurst=$excessBurst; Tiny=$tiny.Take(125,1) } | ConvertTo-Json -Compress
`));
    assert.deepEqual(result, { First: false, Second: true, Third: false, Fourth: true, IdleBurst: true, ExcessBurst: false, Tiny: true });
});

test('IPv4, IPv6 extension headers and UDP identify inbound endpoints without altering packet data', windows, () => {
    const result = JSON.parse(powershell(`
Add-Type -Path ${literal(source)}
$v4 = New-Object byte[] 45
$v4[0]=0x45; $v4[9]=6; $v4[12]=8; $v4[15]=8; $v4[16]=10; $v4[19]=1
$v4[20]=1; $v4[21]=187; $v4[22]=195; $v4[23]=80; $v4[32]=0x50
$before = [Convert]::ToBase64String($v4)
$tcp = [WiFiMeter.DownloadControl.PacketKey]::Parse($v4, $v4.Length)
$v6 = New-Object byte[] 59
$v6[0]=0x60; $v6[6]=0; $v6[23]=2; $v6[39]=1; $v6[40]=17; $v6[41]=0
$v6[48]=0; $v6[49]=53; $v6[50]=195; $v6[51]=80
$udp = [WiFiMeter.DownloadControl.PacketKey]::Parse($v6, $v6.Length)
$index = New-Object WiFiMeter.DownloadControl.EndpointIndex
$index.Add($tcp.Exact, 'C:\\Apps\\limited.exe')
$index.Add($udp.Wildcard, 'C:\\Apps\\udp.exe')
$other = [WiFiMeter.DownloadControl.PacketKey]::Parse($v4, $v4.Length); $other.LocalPort=50001
$tcpOwner=$index.Find($tcp); $udpOwner=$index.Find($udp); $otherOwner=$index.Find($other)
$index.Add($udp.Wildcard, 'C:\\Apps\\another.exe')
$ambiguous=$index.Find($udp)
$v4[6]=0; $v4[7]=1; $fragment = [WiFiMeter.DownloadControl.PacketKey]::Parse($v4, $v4.Length)
[pscustomobject]@{ TcpKey=$tcp.Exact; TcpBytes=$tcp.PayloadBytes; UdpKey=$udp.Exact; UdpBytes=$udp.PayloadBytes; Unchanged=($before -eq [Convert]::ToBase64String($v4[0..5] + @(0,0) + $v4[8..44])); TcpOwner=$tcpOwner; UdpOwner=$udpOwner; OtherOwner=$otherOwner; Ambiguous=$ambiguous; Fragment=$fragment } | ConvertTo-Json -Compress
`));
    assert.equal(result.TcpKey, '6|10.0.0.1|50000|8.0.0.8|443');
    assert.equal(result.TcpBytes, 5);
    assert.equal(result.UdpKey, '17|::1|50000|::2|53');
    assert.equal(result.UdpBytes, 3);
    assert.equal(result.Unchanged, true);
    assert.equal(result.TcpOwner, String.raw`C:\Apps\limited.exe`);
    assert.equal(result.UdpOwner, String.raw`C:\Apps\udp.exe`);
    assert.equal(result.OtherOwner, null);
    assert.equal(result.Ambiguous, null);
    assert.equal(result.Fragment, null);
});

test('actual Windows TCP and UDP owner tables include sockets opened before capture', windows, () => {
    const result = JSON.parse(powershell(`
Add-Type -Path ${literal(source)}
$server = New-Object WiFiMeter.DownloadControl.Server
$flags = [Reflection.BindingFlags]'NonPublic,Instance'
$read = $server.GetType().GetMethod('ReadTable', $flags)
$expected = (Get-Process -Id $PID).Path
$output = @()
foreach ($family in @([Net.Sockets.AddressFamily]::InterNetwork, [Net.Sockets.AddressFamily]::InterNetworkV6)) {
    $ip = if ($family -eq [Net.Sockets.AddressFamily]::InterNetwork) { [Net.IPAddress]::Loopback } else { [Net.IPAddress]::IPv6Loopback }
    $listener = New-Object Net.Sockets.TcpListener($ip,0)
    $client = New-Object Net.Sockets.TcpClient($family)
    $udp = New-Object Net.Sockets.UdpClient($family)
    $peer = $null
    try {
        $listener.Start(); $client.Connect($ip, $listener.LocalEndpoint.Port); $peer=$listener.AcceptTcpClient()
        $udp.Client.Bind((New-Object Net.IPEndPoint($ip,0)))
        $index = New-Object WiFiMeter.DownloadControl.EndpointIndex
        $processes = New-Object 'Collections.Generic.Dictionary[uint32,string]'
        $ipv6 = $family -eq [Net.Sockets.AddressFamily]::InterNetworkV6
        $null=$read.Invoke($server,@($index.PSObject.BaseObject,$true,$ipv6,$processes.PSObject.BaseObject)); $null=$read.Invoke($server,@($index.PSObject.BaseObject,$false,$ipv6,$processes.PSObject.BaseObject))
        $tcpKey=New-Object WiFiMeter.DownloadControl.PacketKey; $tcpKey.Protocol=6; $tcpKey.Local=$ip.ToString(); $tcpKey.Remote=$ip.ToString(); $tcpKey.LocalPort=$client.Client.LocalEndPoint.Port; $tcpKey.RemotePort=$listener.LocalEndpoint.Port
        $udpKey=New-Object WiFiMeter.DownloadControl.PacketKey; $udpKey.Protocol=17; $udpKey.Local=$ip.ToString(); $udpKey.Remote=$ip.ToString(); $udpKey.LocalPort=$udp.Client.LocalEndPoint.Port; $udpKey.RemotePort=53
        $output += [pscustomobject]@{ IPv6=$ipv6; TcpOwner=$index.Find($tcpKey); UdpOwner=$index.Find($udpKey); Expected=$expected }
    } finally { if ($peer) { $peer.Dispose() }; $client.Dispose(); $udp.Dispose(); $listener.Stop() }
}
$output | ConvertTo-Json -Compress
`));
    assert.equal(result.length, 2);
    for (const row of result) {
        assert.equal(row.TcpOwner?.toLowerCase(), row.Expected.toLowerCase());
        assert.equal(row.UdpOwner?.toLowerCase(), row.Expected.toLowerCase());
    }
});

test('the bundled WinDivert DLL compiles capture filters and uses the expected flow address ABI', windows, () => {
    const result = JSON.parse(powershell(`
Add-Type -Path ${literal(source)}
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class DownloadNativeChecks {
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode)] public static extern IntPtr LoadLibraryEx(string path, IntPtr file, uint flags);
    [DllImport("WinDivert.dll", CallingConvention=CallingConvention.Cdecl, CharSet=CharSet.Ansi)] public static extern bool WinDivertHelperCompileFilter(string filter, int layer, IntPtr result, uint length, out IntPtr error, out uint position);
    [DllImport("WinDivert.dll", CallingConvention=CallingConvention.Cdecl, CharSet=CharSet.Ansi)] public static extern bool WinDivertHelperParseIPv6Address(string text, uint[] address);
}
'@
$arch = if ([Environment]::Is64BitProcess) { 'x64' } else { 'x86' }
$dll = Join-Path ${literal(native)} "WinDivert\\$arch\\WinDivert.dll"
if ([DownloadNativeChecks]::LoadLibraryEx($dll,[IntPtr]::Zero,0x900) -eq [IntPtr]::Zero) { throw 'DLL load failed' }
$filterError=[IntPtr]::Zero; $position=[uint32]0
$network=[DownloadNativeChecks]::WinDivertHelperCompileFilter('inbound and !loopback and !impostor and (tcp.PayloadLength > 0 or udp.PayloadLength > 0)',0,[IntPtr]::Zero,0,[ref]$filterError,[ref]$position)
$flow=[DownloadNativeChecks]::WinDivertHelperCompileFilter('tcp or udp',2,[IntPtr]::Zero,0,[ref]$filterError,[ref]$position)
$method=[WiFiMeter.DownloadControl.Server].GetMethod('FlowAddress',[Reflection.BindingFlags]'NonPublic,Static')
$addresses=@()
foreach ($text in @('::ffff:10.2.3.4','2001:db8::1234')) {
    $words=New-Object uint32[] 4
    if (-not [DownloadNativeChecks]::WinDivertHelperParseIPv6Address($text,$words)) { throw 'Address parse failed' }
    $address=New-Object byte[] 80
    for ($i=0; $i -lt 4; $i++) { [Buffer]::BlockCopy([BitConverter]::GetBytes($words[$i]),0,$address,36+$i*4,4) }
    $addresses += $method.Invoke($null,@($address.PSObject.BaseObject,[int]36))
}
[pscustomobject]@{ Network=$network; Flow=$flow; Addresses=$addresses } | ConvertTo-Json -Compress
`));
    assert.deepEqual(result, { Network: true, Flow: true, Addresses: ['10.2.3.4', '2001:db8::1234'] });
});

test('native download actions work independently of unsupported upload QoS', windows, () => {
    const result = JSON.parse(powershell(`
$module=Import-Module -Name ${literal(modulePath)} -Force -PassThru
& $module {
    $script:DownloadCalls=@(); $script:QosCalls=0
    function script:Invoke-MeterDownloadMutation { param($Path,$DownloadKbps,$OwnerPid); $script:DownloadCalls += $DownloadKbps }
    function script:Invoke-MeterNetworkProvider { param($Operation,$Parameters); $script:QosCalls++; if ($Operation -eq 'QosSupport') { return $false }; throw 'unexpected provider operation' }
    Invoke-MeterNetworkMutation -Path 'C:\\Apps\\sample.exe' -Action Throttle -DownloadKbps 100 -OwnerPid $PID
    Invoke-MeterNetworkMutation -Path 'C:\\Apps\\sample.exe' -Action Unthrottle -Direction download
    $beforeUpload=$script:QosCalls
    $uploadFailed=$false
    try { Invoke-MeterNetworkMutation -Path 'C:\\Apps\\sample.exe' -Action Throttle -UploadKbps 100 } catch { $uploadFailed=$true }
    [pscustomobject]@{ Downloads=$script:DownloadCalls; BeforeUpload=$beforeUpload; QosCalls=$script:QosCalls; UploadFailed=$uploadFailed }
} | ConvertTo-Json -Compress
`));
    assert.deepEqual(result, { Downloads: [100, 0], BeforeUpload: 0, QosCalls: 1, UploadFailed: true });
});

test('native verification checks the requested direction and rejects failed download readback', windows, () => {
    const result = JSON.parse(powershell(`
$module=Import-Module -Name ${literal(modulePath)} -Force -PassThru
& $module {
    function script:Get-MeterAppNetworkState { param($Path); return $script:State }
    $process=[pscustomobject]@{ HasExited=$true; ExitCode=0 }; $process | Add-Member ScriptMethod Dispose {}
    $output=@()
    foreach ($case in @('download','upload','failed')) {
        $script:State=[pscustomobject]@{ QosError='unsupported'; ExactPathQosVerified=$false; UploadKbps=$null; DownloadError=$null; DownloadThrottled=$true; DownloadKbps=100 }
        $operation=[pscustomobject]@{ Status='Running'; Process=$process; Path='C:\\Apps\\sample.exe'; Action='Throttle'; UploadKbps=0; DownloadKbps=100; Direction='both'; State=$null; Error=$null; ErrorCode=$null }
        if ($case -eq 'upload') { $script:State.QosError=$null; $script:State.ExactPathQosVerified=$true; $script:State.UploadKbps=100; $script:State.DownloadError='query failure'; $operation.UploadKbps=100; $operation.DownloadKbps=0 }
        if ($case -eq 'failed') { $script:State.DownloadKbps=90 }
        $output+=(Receive-MeterAppNetworkAction $operation).Status
    }
    $output
} | ConvertTo-Json -Compress
`));
    assert.deepEqual(result, ['Succeeded', 'Succeeded', 'Failed']);
});

test('a failed elevated helper reports the download error obtained from its state query', windows, () => {
    const result = JSON.parse(powershell(`
$module=Import-Module -Name ${literal(modulePath)} -Force -PassThru
& $module {
    function script:Get-MeterAppNetworkState { param($Path); return [pscustomobject]@{ DownloadError='Driver signature rejected (Win32 577)'; DownloadThrottled=$null } }
    $process=[pscustomobject]@{ HasExited=$true; ExitCode=1 }; $process | Add-Member ScriptMethod Dispose {}
    $operation=[pscustomobject]@{ Status='Running'; Process=$process; Path='C:\\Apps\\sample.exe'; Action='Throttle'; UploadKbps=0; DownloadKbps=100; Direction='both'; State=$null; Error=$null; ErrorCode=$null }
    Receive-MeterAppNetworkAction $operation | Select-Object Status,Error,ErrorCode,State
} | ConvertTo-Json -Depth 4 -Compress
`));
    assert.equal(result.Status, 'Failed');
    assert.equal(result.ErrorCode, 'HelperFailed');
    assert.match(result.Error, /Driver signature rejected \(Win32 577\)/);
    assert.equal(result.State.DownloadThrottled, null);
});

test('a native packet receive failure stops capture instead of reporting an active limit', windows, () => {
    const result = JSON.parse(powershell(`
${failedReceiveSource()}
$server = New-Object WiFiMeter.DownloadControl.Server
$flags = [Reflection.BindingFlags]'NonPublic,Instance'
$type = $server.GetType()
$type.GetField('running',$flags).SetValue($server,$true)
$type.GetMethod('ReceivePackets',$flags).Invoke($server,@())
[pscustomobject]@{ Running=$type.GetField('running',$flags).GetValue($server); Failure=$type.GetField('failure',$flags).GetValue($server) } | ConvertTo-Json -Compress
`));
    assert.equal(result.Running, false);
    assert.match(result.Failure, /receive/i);
});

test('a native flow receive failure removes stale owners while keeping snapshot capture available', windows, () => {
    const result = JSON.parse(powershell(`
${failedReceiveSource()}
$server = New-Object WiFiMeter.DownloadControl.Server
$flags = [Reflection.BindingFlags]'NonPublic,Instance'
$type = $server.GetType()
$type.GetField('running',$flags).SetValue($server,$true)
$flows = $type.GetField('flows',$flags).GetValue($server)
$flows.Add('6|10.0.0.1|50000|8.8.8.8|443',[uint64]1,'C:\\Apps\\limited.exe')
$type.GetMethod('TrackFlows',$flags).Invoke($server,@())
$owner = $null
$found = $flows.TryFind('6|10.0.0.1|50000|8.8.8.8|443',[ref]$owner)
[pscustomobject]@{ Running=$type.GetField('running',$flags).GetValue($server); Found=$found; Owner=$owner } | ConvertTo-Json -Compress
`));
    assert.deepEqual(result, { Running: true, Found: false, Owner: null });
});

test('a failed daemon keeps the error readable and a new limit restores its configured applications', windows, () => {
    const result = JSON.parse(powershell(`
${mockDaemonSource()}
[WiFiMeter.DownloadControl.NativeMock]::Start($pipeName,$appPath,$PID,$sid)
try {
    $initial = [WiFiMeter.DownloadControl.NativeMock]::Call($pipeName,'READ',$appPath,0)
    $other = [WiFiMeter.DownloadControl.NativeMock]::Call($pipeName,'SET','C:\\Apps\\other.exe',240)
    [WiFiMeter.DownloadControl.NativeMock]::ReceiveFailure = $true
    [WiFiMeter.DownloadControl.NativeMock]::WaitForCleanup()
    $failed = & $module { param($path); Get-MeterDownloadState $path } $appPath
    $unconfigured = [WiFiMeter.DownloadControl.NativeMock]::Call($pipeName,'READ','C:\\Apps\\unconfigured.exe',0)
    [WiFiMeter.DownloadControl.NativeMock]::ReceiveFailure = $false
    $restored = [WiFiMeter.DownloadControl.NativeMock]::Call($pipeName,'SET',$appPath,160)
    $otherRestored = [WiFiMeter.DownloadControl.NativeMock]::Call($pipeName,'READ','C:\\Apps\\other.exe',0)
    $removed = [WiFiMeter.DownloadControl.NativeMock]::Call($pipeName,'SET',$appPath,0)
    $otherRemoved = [WiFiMeter.DownloadControl.NativeMock]::Call($pipeName,'SET','C:\\Apps\\other.exe',0)
    $ended = [WiFiMeter.DownloadControl.NativeMock]::Worker.Join(5000)
    [pscustomobject]@{ Initial=$initial; Other=$other; Failed=$failed; Unconfigured=$unconfigured; Restored=$restored; OtherRestored=$otherRestored; Removed=$removed; OtherRemoved=$otherRemoved; Ended=$ended; Opened=[WiFiMeter.DownloadControl.NativeMock]::Opened; Closed=[WiFiMeter.DownloadControl.NativeMock]::Closed; ServerError=[WiFiMeter.DownloadControl.NativeMock]::ServerError } | ConvertTo-Json -Depth 5 -Compress
} finally { [WiFiMeter.DownloadControl.NativeMock]::OwnerExited=$true; $null=[WiFiMeter.DownloadControl.NativeMock]::Worker.Join(5000) }
`));
    assert.equal(result.Initial, 'OK|80');
    assert.equal(result.Other, 'OK|240');
    assert.equal(result.Failed.Throttled, null);
    assert.match(result.Failed.Error, /Mock packet receive failure/);
    assert.equal(result.Failed.ErrorCode, 'DownloadQueryFailed');
    assert.equal(result.Unconfigured, 'OK|0');
    assert.equal(result.Restored, 'OK|160');
    assert.equal(result.OtherRestored, 'OK|240');
    assert.equal(result.Removed, 'OK|0');
    assert.equal(result.OtherRemoved, 'OK|0');
    assert.equal(result.Ended, true);
    assert.equal(result.Opened, 2);
    assert.equal(result.Closed, 2);
    assert.equal(result.ServerError, null);
});

for (const [boundary, reason, code] of [
    ['LoadFailure', 'Mock DLL unavailable', 126],
    ['OpenFailure', 'Mock driver signature rejected', 577]
]) test(`driver startup errors are readable through the existing state query and can be cleared: ${boundary}`, windows, () => {
    const result = JSON.parse(powershell(`
${mockDaemonSource()}
[WiFiMeter.DownloadControl.NativeMock]::${boundary}=$true
[WiFiMeter.DownloadControl.NativeMock]::Start($pipeName,$appPath,$PID,$sid)
try {
    $response=[WiFiMeter.DownloadControl.NativeMock]::Call($pipeName,'READ',$appPath,0)
    $state=& $module { param($path); Get-MeterDownloadState $path } $appPath
    $removed=[WiFiMeter.DownloadControl.NativeMock]::Call($pipeName,'SET',$appPath,0)
    $ended=[WiFiMeter.DownloadControl.NativeMock]::Worker.Join(5000)
    [pscustomobject]@{ Response=$response; State=$state; Removed=$removed; Ended=$ended; Opened=[WiFiMeter.DownloadControl.NativeMock]::Opened; ServerError=[WiFiMeter.DownloadControl.NativeMock]::ServerError } | ConvertTo-Json -Depth 5 -Compress
} finally { [WiFiMeter.DownloadControl.NativeMock]::OwnerExited=$true; $null=[WiFiMeter.DownloadControl.NativeMock]::Worker.Join(5000) }
`));
    assert.ok(result.Response.includes(reason));
    assert.equal(result.State.Throttled, null);
    assert.ok(result.State.Error.includes(reason));
    assert.ok(result.State.Error.includes(String(code)));
    assert.equal(result.Removed, 'OK|0');
    assert.equal(result.Ended, true);
    assert.equal(result.Opened, 0);
    assert.equal(result.ServerError, null);
});

for (const failedCapture of [false, true]) test(`a daemon still exits when its owner exits: ${failedCapture ? 'failed' : 'healthy'} capture`, windows, () => {
    const result = JSON.parse(powershell(`
${mockDaemonSource()}
[WiFiMeter.DownloadControl.NativeMock]::Start($pipeName,$appPath,$PID,$sid)
try {
    $initial=[WiFiMeter.DownloadControl.NativeMock]::Call($pipeName,'READ',$appPath,0)
    [WiFiMeter.DownloadControl.NativeMock]::ReceiveFailure=$${failedCapture}
    if ([WiFiMeter.DownloadControl.NativeMock]::ReceiveFailure) { [WiFiMeter.DownloadControl.NativeMock]::WaitForCleanup() }
    $failed=[WiFiMeter.DownloadControl.NativeMock]::Call($pipeName,'READ',$appPath,0)
    [WiFiMeter.DownloadControl.NativeMock]::OwnerExited=$true
    $ended=[WiFiMeter.DownloadControl.NativeMock]::Worker.Join(5000)
    [pscustomobject]@{ Initial=$initial; Failed=$failed; Ended=$ended; Closed=[WiFiMeter.DownloadControl.NativeMock]::Closed; ServerError=[WiFiMeter.DownloadControl.NativeMock]::ServerError } | ConvertTo-Json -Compress
} finally { [WiFiMeter.DownloadControl.NativeMock]::OwnerExited=$true; $null=[WiFiMeter.DownloadControl.NativeMock]::Worker.Join(5000) }
`));
    assert.equal(result.Initial, 'OK|80');
    if (failedCapture) assert.match(result.Failed, /Mock packet receive failure/);
    else assert.equal(result.Failed, 'OK|80');
    assert.equal(result.Ended, true);
    assert.equal(result.Closed, 1);
    assert.equal(result.ServerError, null);
});
