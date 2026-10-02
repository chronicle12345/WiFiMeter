'use strict';

const { spawn } = require('node:child_process');
const { createReadStream, readFileSync } = require('node:fs');
const { createHash } = require('node:crypto');
const path = require('node:path');

// Only main's verified-download hook calls this module. No URL, shell command,
// executable host or script is accepted from IPC or from the installer arguments.
async function launchUpdateHandoff(file, { userData, digest, timeout = 15000 } = {}) {
    const target = path.win32.resolve(file);
    const downloads = path.win32.resolve(userData, 'updates');
    if (path.win32.dirname(target).toLowerCase() !== downloads.toLowerCase()
        || path.win32.extname(target).toLowerCase() !== '.exe') {
        throw Error('Installer must be a verified executable in the update directory.');
    }
    if (!/^[a-f0-9]{64}$/.test(digest || '')) throw Error('Missing verified installer digest.');
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(target)) hash.update(chunk);
    if (hash.digest('hex') !== digest) {
        throw Error('Installer changed after download verification.');
    }
    const encodedPath = Buffer.from(target, 'utf8').toString('base64');
    // Lock the same file while waiting: allow reads, deny replacement/deletion.
    // EOF without GO cancels a helper that became ready after the parent's timeout.
    const script = `$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
$target=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encodedPath}'))
$file=$null
$authorized=$false
try {
    $p=Get-Process -Id ${process.pid} -ErrorAction Stop
    $null=$p.Handle
    $file=[IO.File]::Open($target,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read)
    $sha=[Security.Cryptography.SHA256]::Create()
    try {$hash=([BitConverter]::ToString($sha.ComputeHash($file))).Replace('-','').ToLowerInvariant()} finally {$sha.Dispose()}
    if($hash -ne '${digest}'){throw 'Installer changed before handoff'}
    [Console]::Out.WriteLine('READY')
    [Console]::Out.Flush()
    if([Console]::In.ReadLine() -ne 'GO'){exit 1}
    $authorized=$true
    if(-not $p.WaitForExit(60000)){throw 'WiFiMeter did not exit within 60 seconds'}
    Start-Process -FilePath $target -WindowStyle Hidden
} catch {
    [Console]::Error.WriteLine($_.Exception.Message)
    if($authorized){
        Add-Type -AssemblyName System.Windows.Forms
        [System.Windows.Forms.MessageBox]::Show("无法启动更新，请关闭并重新打开 WiFiMeter 后重试。\nUpdate could not start. Close and reopen WiFiMeter, then try again.", 'WiFiMeter 软件更新 / Update') | Out-Null
    }
    exit 1
} finally {if($file){$file.Dispose()}}`;
    const bridge = readFileSync(path.join(__dirname, 'update-bridge.cjs'), 'utf8');
    const helper = spawn(process.execPath,
        ['-e', bridge, Buffer.from(script, 'utf16le').toString('base64')],
        { detached: true, windowsHide: true, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, stdio: ['pipe', 'pipe', 'pipe'] });
    await new Promise((resolve, reject) => {
        let settled = false, output = '', diagnostic = '', authorized = false;
        const finish = error => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            helper.removeListener('exit', onExit);
            helper.stdout.removeListener('data', onData);
            helper.stdout.removeListener('end', onEnd);
            if (!helper.stdin.writableEnded) helper.stdin.end();
            helper.stdout.destroy();
            helper.stderr.destroy();
            helper.unref();
            if (error) {
                if (diagnostic.trim()) {
                    error.diagnostic = diagnostic.trim().replace(/\s+/g, ' ').slice(0, 512);
                    error.message += ` ${error.diagnostic}`;
                }
                reject(error);
            } else resolve();
        };
        const failure = (code, message) => Object.assign(Error(message), { code });
        const onExit = code => finish(failure('HANDOFF_EXITED_BEFORE_READY', `Update helper exited before handoff (code=${code}).`));
        const onEnd = () => { if (!authorized) finish(failure('HANDOFF_CLOSED_BEFORE_READY', 'Update helper closed before READY.')); };
        const onData = chunk => {
            output += chunk.toString('utf8');
            if (output.length > 128) return finish(failure('HANDOFF_INVALID_RESPONSE', 'Invalid update helper response.'));
            if (!output.includes('\n')) return;
            if (output !== 'READY\r\n' && output !== 'READY\n') return finish(failure('HANDOFF_INVALID_RESPONSE', 'Invalid update helper response.'));
            if (authorized) return;
            authorized = true;
            helper.stdin.end('GO\n', error => finish(error));
        };
        const timer = setTimeout(() => finish(failure('HANDOFF_READY_TIMEOUT', 'Update helper READY timed out.')), timeout);
        helper.once('exit', onExit);
        // Keep error handlers for late stream/process errors after cancellation.
        helper.on('error', finish);
        helper.stdin.on('error', finish);
        helper.stdout.on('error', finish);
        helper.stderr.on('error', finish);
        helper.stderr.on('data', chunk => { diagnostic += chunk.toString('utf8').slice(0, Math.max(0, 4096 - diagnostic.length)); });
        helper.stdout.on('end', onEnd);
        helper.stdout.on('data', onData);
    });
}

module.exports = { launchUpdateHandoff };
