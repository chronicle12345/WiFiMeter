'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const { randomUUID } = require('node:crypto');

const root = path.resolve(__dirname, '../..');
const helper = path.join(root, 'packaging/windows/repair-uninstall.ps1');
const powershell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe');
const ps = value => "'" + value.replaceAll("'", "''") + "'";

test('missing uninstall repair is connected before the default uninstall command', () => {
    const config = JSON.parse(fs.readFileSync(path.join(root, 'apps/desktop/src-tauri/tauri.conf.json')));
    assert.equal(config.bundle.windows.nsis.template, '../../../packaging/tauri/windows/installer.nsi');
    const template = fs.readFileSync(path.join(root, 'packaging/tauri/windows/installer.nsi'), 'utf8');
    assert.ok(template.indexOf('!insertmacro WiFiMeterRecoverMissingUninstaller') < template.indexOf("ExecWait '$R1' $0", template.indexOf('ReadRegStr $4 SHCTX')));
    assert.match(template, /StrCpy \$INSTDIR \$WiFiMeterRepairDirectory[\s\S]*!insertmacro CheckIfAppIsRunning[\s\S]*Goto reinst_done/);
    const restore = template.slice(template.indexOf('Function RestorePreviousInstallLocation'), template.indexOf('FunctionEnd', template.indexOf('Function RestorePreviousInstallLocation')));
    assert.match(restore, /ReadRegStr \$4[\s\S]*\$4 != ""[\s\S]*\$\{Else\}[\s\S]*WiFiMeterRecoverMissingUninstaller[\s\S]*StrCpy \$INSTDIR \$WiFiMeterRepairDirectory/);
});

test('repair only accepts a missing uninstaller from a matching isolated product installation', { skip: process.platform !== 'win32', timeout: 60000 }, t => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'wifimeter repair & '));
    const product = 'WiFiMeterFixture-' + randomUUID();
    const key = 'Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\' + product;
    const main = path.join(directory, 'WiFiMeter.exe');
    const old = path.join(directory, 'Uninstall.exe');
    const script = `
        $ErrorActionPreference='Stop'
        $key=${ps(key)}; $directory=${ps(directory)}; $product=${ps(product)}
        $registry=[Microsoft.Win32.RegistryKey]::OpenBaseKey('CurrentUser','Registry64')
        try {
            $entry=$registry.CreateSubKey($key)
            try {
                $entry.SetValue('DisplayName',$product); $entry.SetValue('Publisher','WiFiMeter')
                $entry.SetValue('InstallLocation',$directory)
                $entry.SetValue('UninstallString',('"'+${ps(old)}+'" --uninstall'))
            } finally { $entry.Dispose() }
            Add-Type -TypeDefinition ('using System.Reflection; [assembly: AssemblyProduct("'+$product+'")] public class Program { public static void Main() {} }') -OutputAssembly ${ps(main)} -OutputType ConsoleApplication
            function Check([int]$expected, [string]$publisher='WiFiMeter') {
                & ${ps(helper)} -ProductName $product -Publisher $publisher -RegistryView 64
                if($LASTEXITCODE -ne $expected){throw ('Unexpected repair status: '+$LASTEXITCODE+' expected '+$expected)}
            }
            Check 0
            Check 0 'wifimeter'
            $entry=$registry.OpenSubKey($key,$true)
            try { $entry.SetValue('InstallLocation',('"'+$directory+'"')) } finally { $entry.Dispose() }; Check 0
            [IO.File]::WriteAllText(${ps(old)},'public fixture'); Check 2
            [IO.File]::Delete(${ps(old)})
            [IO.Directory]::CreateDirectory(${ps(old)}) | Out-Null; Check 2
            [IO.Directory]::Delete(${ps(old)})
            $entry=$registry.OpenSubKey($key,$true)
            try { $entry.SetValue('Publisher','Different product') } finally { $entry.Dispose() }; Check 2; Check 2 'wifimeter'
            $entry=$registry.OpenSubKey($key,$true)
            try { $entry.SetValue('Publisher','WiFiMeter'); $entry.SetValue('UninstallString',('"'+(Join-Path $directory '..\\uninstall.exe')+'"')) } finally { $entry.Dispose() }; Check 2
            $entry=$registry.OpenSubKey($key,$true)
            try { $entry.SetValue('UninstallString',('"'+${ps(old)}+'" --unknown')) } finally { $entry.Dispose() }; Check 2
            [IO.File]::Delete(${ps(main)}); Check 2
            Write-Output 'isolated repair cases passed'
        } finally { $registry.DeleteSubKeyTree($key,$false); $registry.Dispose() }
    `;
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const result = spawnSync(powershell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { windowsHide: true, encoding: 'utf8', timeout: 55000, stdio: ['ignore', 'pipe', 'pipe'] });
    assert.equal(result.error, undefined, 'Isolated PowerShell fixture failed to complete');
    assert.equal(result.status, 0, 'Isolated repair identity/path cases failed');
    assert.match(result.stdout, /isolated repair cases passed/);
});
