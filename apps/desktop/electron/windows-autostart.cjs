'use strict';

const path = require('node:path');
const { execFileSync } = require('node:child_process');

const runKey = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';
const approvedKey = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\StartupApproved\\Run';
const names = ['WiFiMeter', 'io.wifimeter.demo'];

// 两种桌面宿主共用同一登记名称，并只迁移当前程序的已知旧命令。
function createWindowsAutostart({ executable, args = [], execute = execFileSync }) {
    const quote = value => `"${String(value).replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/g, '$1$1')}"`;
    const argumentText = args.map(quote).join(' ');
    const command = `${quote(executable)}${argumentText ? ' ' + argumentText : ''}`;
    let decoder, unsupportedEncoding;
    const decode = value => {
        if (!Buffer.isBuffer(value)) return String(value || '');
        if (value.every(byte => byte < 128)) return value.toString('utf8');
        if (unsupportedEncoding) throw unsupportedEncoding;
        if (!decoder) {
            const output = execute('chcp.com', [], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
            const codePage = String(output).match(/(\d+)\s*$/)?.[1];
            const encoding = { 65001: 'utf-8', 936: 'gbk', 950: 'big5', 932: 'shift_jis', 949: 'euc-kr', 866: 'ibm866' }[codePage] || `windows-${codePage}`;
            // 不猜测本地代码页，否则中文路径和缺失值错误会被误读。
            try { decoder = new TextDecoder(encoding, { fatal: true }); }
            catch (error) {
                if (error.code === 'ERR_ENCODING_NOT_SUPPORTED') unsupportedEncoding = error;
                throw error;
            }
        }
        return decoder.decode(value);
    };
    const unicodeQuery = (key, name, type) => {
        // CLI 无法可靠解码或错误语言未知时回退；.NET 只读查询区分缺失与拒绝访问。
        const payload = Buffer.from(JSON.stringify({ key, name, type }), 'utf8').toString('base64');
        const script = `$ErrorActionPreference='Stop'
[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
$request=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${payload}')) | ConvertFrom-Json
$registry=[Microsoft.Win32.Registry]::CurrentUser.OpenSubKey($request.key.Substring(5), $false)
try {
    $result=@{found=$false;value=$null}
    if($null -ne $registry -and $registry.GetValueNames() -contains $request.name){
        $kind=$registry.GetValueKind($request.name).ToString()
        if(($request.type -eq 'REG_SZ' -and $kind -ne 'String') -or ($request.type -eq 'REG_BINARY' -and $kind -ne 'Binary')){throw 'Unexpected registry value type.'}
        $value=$registry.GetValue($request.name,$null,[Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
        if($request.type -eq 'REG_BINARY'){$value=[BitConverter]::ToString([byte[]]$value).Replace('-','')}
        $result=@{found=$true;value=$value}
    }
    [Console]::Write(($result | ConvertTo-Json -Compress))
} finally {if($null -ne $registry){$registry.Dispose()}}`;
        const executable = path.win32.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
        const output = execute(executable, ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], {
            encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], timeout: 15000, maxBuffer: 256 * 1024
        });
        const result = JSON.parse(String(output).trim());
        if (!result || typeof result.found !== 'boolean' || (result.found && typeof result.value !== 'string')) throw Error(`无法读取开机启动项：${name}`);
        return result.found ? result.value : null;
    };
    const invalidEncoding = error => ['ERR_ENCODING_NOT_SUPPORTED', 'ERR_ENCODING_INVALID_ENCODED_DATA'].includes(error?.code);
    const query = (key, name, type) => {
        let value;
        try {
            const output = decode(execute('reg.exe', ['query', key, '/v', name], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }));
            value = output.match(new RegExp(`\\b${type}\\s+([^\\r\\n]+)`))?.[1]?.trim();
            if (value === undefined) throw Error(`无法读取开机启动项：${name}`);
        } catch (error) {
            // reg.exe 的缺失值和权限错误都可能返回 1，不能把拒绝访问当成不存在。
            if (invalidEncoding(error)) return unicodeQuery(key, name, type);
            if (error.status === 1) {
                let message;
                try { message = decode(error.stderr); }
                catch (decodeError) {
                    if (invalidEncoding(decodeError)) return unicodeQuery(key, name, type);
                    throw decodeError;
                }
                if (/unable to find|找不到指定的注册表|系统找不到指定/i.test(message)) return null;
                if (!/access is denied|拒绝访问/i.test(message)) return unicodeQuery(key, name, type);
            }
            throw error;
        }
        // 问号可能来自 CLI 的损失替代；读取原值后仍按完整路径和参数判断归属。
        return type === 'REG_SZ' && value.includes('?') ? unicodeQuery(key, name, type) : value;
    };
    const approval = name => {
        const value = query(approvedKey, name, 'REG_BINARY');
        if (value === null) return null;
        if (!/^[\da-f]{24}$/i.test(value)) throw Error(`开机启动状态格式异常：${name}`);
        return Buffer.from(value, 'hex');
    };
    const enabled = value => value === null || [0, 2, 6].includes(value.readUInt32LE(0));
    const loginState = active => ({ openAtLogin: active, executableWillLaunchAtLogin: active });
    const owned = value => {
        if (!value || !executable) return false;
        const match = value.match(/^(?:"([^"]+)"|(\S+))(?:\s+(.*))?$/);
        if (!match || path.win32.normalize(match[1] || match[2]).toLowerCase() !== path.win32.normalize(executable).toLowerCase()) return false;
        const tail = match[3] || '';
        return tail === argumentText || (!args.length && ['--tray', '--background'].includes(tail));
    };
    const entries = () => names.map(name => {
        const value = query(runKey, name, 'REG_SZ');
        return { name, value, owned: owned(value) };
    });
    const mutate = parameters => execute('reg.exe', parameters, { windowsHide: true, stdio: 'pipe' });
    const remove = entry => {
        // 修改前再次确认，避免误删查询之后被外部工具改写的项目。
        if (query(runKey, entry.name, 'REG_SZ') !== entry.value) throw Error(`开机启动项已变化：${entry.name}`);
        mutate(['delete', runKey, '/v', entry.name, '/f']);
        if (query(runKey, entry.name, 'REG_SZ') !== null) throw Error(`未能移除开机启动项：${entry.name}`);
        if (approval(entry.name) !== null) mutate(['delete', approvedKey, '/v', entry.name, '/f']);
    };
    return {
        getLoginItemSettings() {
            const active = entries().some(entry => entry.owned && enabled(approval(entry.name)));
            return loginState(active);
        },
        setLoginItemSettings(options) {
            const current = entries();
            if (!options.openAtLogin) {
                for (const entry of current) if (entry.owned) remove(entry);
                return loginState(false);
            }
            const [canonical, legacy] = current;
            if (canonical.value !== null && !canonical.owned) throw Error('WiFiMeter 启动项已由其他路径或参数使用。');
            const previousApproval = approval(canonical.name);
            const matched = current.filter(entry => entry.owned).map(entry => ({ ...entry, approval: entry === canonical ? previousApproval : approval(entry.name) }));
            let desiredApproval = previousApproval;
            if (typeof options.enabled === 'boolean') {
                desiredApproval = Buffer.alloc(12);
                desiredApproval.writeUInt32LE(options.enabled ? 2 : 3);
            } else if (matched.length) {
                // 合并时保留整体启用状态；全部禁用时迁移禁用记录，避免意外恢复自启动。
                const active = matched.some(entry => enabled(entry.approval));
                if (active !== enabled(previousApproval)) desiredApproval = active ? Buffer.from('020000000000000000000000', 'hex') : matched[0].approval;
            }
            const approvalChanged = desiredApproval !== null && !desiredApproval.equals(previousApproval || Buffer.alloc(0));
            // 每次同步都读取实际状态；无需修改时直接返回本次结果，避免再次启动 reg.exe。
            if (canonical.value === command && !legacy.owned && !approvalChanged) return loginState(enabled(previousApproval));
            if (approvalChanged) {
                mutate(['add', approvedKey, '/v', canonical.name, '/t', 'REG_BINARY', '/d', desiredApproval.toString('hex'), '/f']);
                const applied = approval(canonical.name);
                if (!applied || !applied.equals(desiredApproval)) throw Error('开机启动状态未能写入。');
            }
            if (canonical.value !== command) mutate(['add', runKey, '/v', canonical.name, '/t', 'REG_SZ', '/d', command, '/f']);
            if (query(runKey, canonical.name, 'REG_SZ') !== command || enabled(approval(canonical.name)) !== enabled(desiredApproval)) throw Error('开机启动登记未能生效。');
            // 先建立并核对标准项，失败时保留仍可用的旧登记。
            if (legacy.owned) remove(legacy);
            return loginState(enabled(desiredApproval));
        }
    };
}

module.exports = { createWindowsAutostart };
