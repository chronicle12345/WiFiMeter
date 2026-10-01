'use strict';

const { spawn } = require('node:child_process');
const { createReadStream } = require('node:fs');
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
    if($authorized){
        Add-Type -AssemblyName System.Windows.Forms
        [System.Windows.Forms.MessageBox]::Show("无法启动更新，请关闭并重新打开 WiFiMeter 后重试。\nUpdate could not start. Close and reopen WiFiMeter, then try again.", 'WiFiMeter 软件更新 / Update') | Out-Null
    }
    exit 1
} finally {if($file){$file.Dispose()}}`;
    const helper = spawn(path.win32.join(process.env.SystemRoot || 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe'),
        ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
        { detached: true, windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] });
    await new Promise((resolve, reject) => {
        let settled = false, output = '', authorized = false;
        const finish = error => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            helper.removeListener('exit', onExit);
            helper.stdout.removeListener('data', onData);
            helper.stdout.removeListener('end', onEnd);
            if (!helper.stdin.writableEnded) helper.stdin.end();
            helper.stdout.destroy();
            helper.unref();
            if (error) reject(error); else resolve();
        };
        const onExit = code => finish(Error(`Update helper exited before handoff (code=${code}).`));
        const onEnd = () => { if (!authorized) finish(Error('Update helper closed before READY.')); };
        const onData = chunk => {
            output += chunk.toString('utf8');
            if (output.length > 128) return finish(Error('Invalid update helper response.'));
            if (!output.includes('\n')) return;
            if (output !== 'READY\r\n' && output !== 'READY\n') return finish(Error('Invalid update helper response.'));
            if (authorized) return;
            authorized = true;
            helper.stdin.end('GO\n', error => finish(error));
        };
        const timer = setTimeout(() => finish(Error('Update helper READY timed out.')), timeout);
        helper.once('exit', onExit);
        // Keep error handlers for late stream/process errors after cancellation.
        helper.on('error', finish);
        helper.stdin.on('error', finish);
        helper.stdout.on('error', finish);
        helper.stdout.on('end', onEnd);
        helper.stdout.on('data', onData);
    });
}

module.exports = { launchUpdateHandoff };
