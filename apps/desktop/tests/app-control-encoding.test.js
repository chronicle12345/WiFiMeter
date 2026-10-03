import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const modulePath = fileURLToPath(new URL('../native/windows/AppNetworkControl.psm1', import.meta.url));

test('Windows PowerShell module has one UTF-8 BOM immediately followed by #requires', () => {
    const bytes = readFileSync(modulePath);
    assert.equal(bytes.subarray(0, 3).toString('hex'), 'efbbbf', 'Windows PowerShell 5.1 needs a BOM for Chinese text');
    const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes.subarray(3));
    assert.ok(text.startsWith('#requires -Version 5.1'), 'An extra BOM turns #requires into a command');
    assert.ok(!text.includes('\uFEFF'), 'No embedded BOMs');
});

test('real Windows PowerShell imports the module without executing a BOM-prefixed command', { skip: process.platform !== 'win32' }, () => {
    const script = `
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = New-Object Text.UTF8Encoding($false)
$module = Import-Module -Name '${modulePath.replaceAll("'", "''")}' -Force -PassThru -WarningAction SilentlyContinue -ErrorAction Stop
[pscustomobject]@{ Version = $PSVersionTable.PSVersion.ToString(); Exports = @($module.ExportedFunctions.Keys) } | ConvertTo-Json -Compress
`;
    const stdout = execFileSync(path.win32.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
        ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
        { windowsHide: true, shell: false, encoding: 'utf8', timeout: 30000, stdio: ['ignore', 'pipe', 'pipe'] });
    const result = JSON.parse(stdout);
    assert.match(result.Version, /^5\.1\./);
    assert.deepEqual(result.Exports.sort(), ['Get-MeterAppNetworkState', 'Invoke-MeterAppNetworkAction', 'Receive-MeterAppNetworkAction']);
});
