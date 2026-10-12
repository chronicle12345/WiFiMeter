'use strict';

// A detached Node host survives the application, while Windows PowerShell keeps
// working console streams in its ordinary child process. The launcher evaluates
// this bundled source from the packaged runtime without relying on its location.
const { spawn } = require('node:child_process');
const path = require('node:path');

const encoded = process.argv[1];
if (!encoded || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) {
    throw Error('Missing update helper script.');
}
const env = { ...process.env };
const helper = spawn(path.win32.join(process.env.SystemRoot || 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe'),
    ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded],
    { windowsHide: true, env, stdio: ['pipe', 'pipe', 'pipe'] });

// EOF cancels before GO; after GO the script waits for the application to exit.
process.stdin.pipe(helper.stdin);
helper.stdout.pipe(process.stdout);
helper.stderr.pipe(process.stderr);
process.stdout.on('error', () => {});
process.stderr.on('error', () => {});
helper.stdin.on('error', () => {});
helper.once('error', error => {
    process.stderr.write(`Cannot start Windows PowerShell: ${error.message}\n`);
    process.stdin.destroy();
    process.exitCode = 1;
});
helper.once('exit', code => {
    process.stdin.destroy();
    process.exitCode = code ?? 1;
});
