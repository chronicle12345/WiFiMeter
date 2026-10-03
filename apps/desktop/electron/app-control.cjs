'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

const actions = Object.freeze({ read: 'Read', block: 'Block', unblock: 'Unblock', throttle: 'Throttle', unthrottle: 'Unthrottle' });
const fail = (code, message) => ({ ok: false, canceled: false, error: { code, message } });

function localExePath(value) {
    if (typeof value !== 'string' || value.endsWith('\\') || !/^[a-z]:\\/i.test(value) || /[:*?"<>|\x00-\x1f/]/.test(value.slice(2))
        || path.win32.extname(value).toLowerCase() !== '.exe'
        || value.slice(3).split('\\').some(part => /[ .]$/.test(part) && part !== '.' && part !== '..')) {
        throw Error('必须提供本地磁盘上的绝对 exe 路径，不能包含通配符或备用数据流。');
    }
    return path.win32.normalize(value);
}

async function executablePath(value, io) {
    // 检查实际目标及 PE 头，拒绝目录、脚本改名和 DLL。不会执行所选程序。
    const resolved = localExePath(await io.realpath(value));
    const file = await io.open(resolved, 'r');
    try {
        const stat = await file.stat();
        if (!stat.isFile() || stat.size < 64) throw Error('所选文件不是 Windows 可执行程序。');
        const dos = Buffer.alloc(64);
        if ((await file.read(dos, 0, 64, 0)).bytesRead !== 64 || dos.toString('ascii', 0, 2) !== 'MZ') throw Error('文件缺少 DOS 头。');
        const offset = dos.readUInt32LE(60);
        if (offset < 64 || offset + 26 > stat.size) throw Error('PE 头位置无效。');
        const pe = Buffer.alloc(26);
        if ((await file.read(pe, 0, 26, offset)).bytesRead !== 26 || pe.readUInt32LE(0) !== 0x4550
            || !(pe.readUInt16LE(22) & 2) || (pe.readUInt16LE(22) & 0x2000)
            || ![0x10b, 0x20b].includes(pe.readUInt16LE(24)) || pe.readUInt16LE(6) === 0
            || pe.readUInt16LE(20) < (pe.readUInt16LE(24) === 0x20b ? 112 : 96)
            || offset + 24 + pe.readUInt16LE(20) + pe.readUInt16LE(6) * 40 > stat.size) {
            throw Error('文件不是有效的 PE 可执行程序。');
        }
        return resolved;
    } finally { await file.close(); }
}

function command(data) {
    const payload = Buffer.from(JSON.stringify(data), 'utf8').toString('base64');
    // 所有外部数据只进入 Base64 JSON；动作、模块调用和等待逻辑都是固定代码。
    const script = `
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = New-Object Text.UTF8Encoding($false)
try {
    $data = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${payload}')) | ConvertFrom-Json
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
`;
    return ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')];
}

/**
 * 主进程 API：chooseProgram() / request({ action, path, uploadKBps })，均返回 Promise。
 * uploadKBps 为十进制 KB/s，须能精确换算成整数 Kbit/s（最小 0.125，最大 125000000）。
 * 返回 { ok, canceled, result?, error? }；result 为 { status, path, state, warning }。
 * state 保留 helper 字段及 null 查询状态，UploadKbps 为 Kbit/s；查询成功不代表联网被阻断。
 * runner(executable, args, options) => Promise<{ stdout, stderr? }>，默认使用 execFile。
 * io、runner、isPackaged 和 resourcesPath 仅供可信主进程配置，不能从 IPC 请求透传。
 * 打包资源：resources/native/windows/AppNetworkControl.psm1，必须在 asar 外。
 * 无定时采样；调用方仅在选择或用户操作时请求，不能接入每秒流量刷新。
 */
function createAppControl({ platform = process.platform, dialog, getWindow = () => undefined,
    runner = promisify(execFile), io = fs, isPackaged = false, resourcesPath = process.resourcesPath } = {}) {
    const modulePath = isPackaged
        ? path.join(resourcesPath, 'native', 'windows', 'AppNetworkControl.psm1')
        : path.join(__dirname, '..', 'native', 'windows', 'AppNetworkControl.psm1');
    const powershell = path.win32.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    const unsupported = () => fail('unsupported', `${platform} 暂不支持按应用阻断联网或上传限速。`);

    async function request(input) {
        if (platform !== 'win32') return unsupported();
        let target;
        let rate = 0;
        try {
            if (!input || typeof input !== 'object' || Array.isArray(input)
                || !Object.hasOwn(actions, input.action)
                || Object.keys(input).some(key => !['action', 'path', 'uploadKBps'].includes(key))) throw Error('应用联网请求无效。');
            target = localExePath(input.path);
            if (input.action === 'throttle') {
                rate = input.uploadKBps * 8;
                if (typeof input.uploadKBps !== 'number' || !Number.isSafeInteger(rate) || rate < 1 || rate > 1000000000) {
                    throw Error('uploadKBps 必须在 0.125 到 125000000 KB/s 之间，并能换算为整数 Kbit/s。');
                }
            } else if (Object.hasOwn(input, 'uploadKBps')) throw Error('仅 throttle 动作允许 uploadKBps。');
        } catch (error) { return fail('invalidRequest', error.message); }
        try { target = await executablePath(target, io); }
        catch (error) { return fail('invalidProgram', error.message); }
        let stdout;
        try {
            ({ stdout } = await runner(powershell, command({ Module: modulePath, Path: target, Action: actions[input.action], UploadKbps: rate }), {
                shell: false, windowsHide: true, encoding: 'utf8', timeout: 180000, maxBuffer: 1024 * 1024
            }));
        } catch (error) {
            return fail(error.killed || error.code === 'ETIMEDOUT' ? 'timeout' : 'runnerFailed',
                `${error.message} 策略操作可能尚未完成，请主动查询状态。`);
        }
        try {
            const response = JSON.parse(stdout.replace(/^\uFEFF/, '').trim());
            if (!response || !['Succeeded', 'Failed', 'Cancelled'].includes(response.Status)
                || (response.Status === 'Succeeded' && (!response.State || typeof response.State !== 'object' || Array.isArray(response.State)))
                || (response.Status !== 'Succeeded' && typeof response.ErrorCode !== 'string')) throw Error('PowerShell 返回的结果格式无效。');
            return {
                ok: response.Status === 'Succeeded', canceled: response.Status === 'Cancelled',
                result: { status: response.Status, path: target, state: response.State ?? null, warning: response.Warning ?? response.State?.Warning ?? null },
                ...(response.Status === 'Succeeded' ? {} : { error: { code: response.ErrorCode, message: response.Error || '应用联网操作未完成。' } })
            };
        } catch (error) { return fail('invalidResponse', error.message); }
    }

    async function chooseProgram() {
        if (platform !== 'win32') return unsupported();
        try {
            const options = { title: '选择需要控制联网的程序', properties: ['openFile'], filters: [{ name: 'Windows 程序', extensions: ['exe'] }] };
            const window = getWindow();
            const selected = await (window ? dialog.showOpenDialog(window, options) : dialog.showOpenDialog(options));
            if (selected.canceled || !selected.filePaths?.length) return { ok: false, canceled: true };
            return request({ action: 'read', path: selected.filePaths[0] });
        } catch (error) { return fail('dialogFailed', error.message); }
    }
    return { chooseProgram, request };
}

module.exports = { createAppControl };
