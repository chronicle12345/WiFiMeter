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

function fixtureFailure(result, directory) {
    let stderr = String(result.stderr || '');
    const privatePaths = [directory, root, process.env.USERPROFILE, os.tmpdir(), process.env.TEMP, process.env.TMP].filter(Boolean).sort((a, b) => b.length - a.length);
    for (const privatePath of privatePaths) {
        for (const variant of [privatePath, privatePath.replaceAll('\\', '/')]) {
            stderr = stderr.replace(new RegExp(variant.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'), '<private-path>');
        }
    }
    return `Isolated PowerShell fixture failed: status=${result.status}, signal=${result.signal || 'none'}, spawn=${result.error?.code || 'none'}\n${stderr.slice(0, 8192) || '(no stderr)'}`;
}

function diagnosticHelperSource() {
    return fs.readFileSync(helper, 'utf8').split('\n').map((line, index) => {
        const rejection = `throw 'repair predicate at helper line ${index + 1}'`;
        if (line.trim().startsWith('return [Diagnostics.FileVersionInfo]')) {
            return `if (-not (${line.trim().slice('return '.length)})) { ${rejection} }; return $true`;
        }
        return line.replaceAll('return $false', rejection);
    }).join('\n').replace('catch { exit 2 }', "catch { [Console]::Error.WriteLine(('repair diagnostic: '+$_.Exception.GetType().FullName+'; '+$_.FullyQualifiedErrorId+'; '+$_.Exception.Message+'; '+$_.ScriptStackTrace)); exit 2 }");
}

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
        $ProgressPreference='SilentlyContinue'
        [Console]::OutputEncoding=[Text.UTF8Encoding]::new()
        $key=${ps(key)}; $directory=${ps(directory)}; $product=${ps(product)}
        $phase='registry-open'; $repairCase=0
        try {
            $registry=[Microsoft.Win32.RegistryKey]::OpenBaseKey('CurrentUser','Registry64')
            try {
                $phase='registry-create'
                $entry=$registry.CreateSubKey($key)
                try {
                    $entry.SetValue('DisplayName',$product); $entry.SetValue('Publisher','WiFiMeter')
                    $entry.SetValue('InstallLocation',$directory)
                    $entry.SetValue('UninstallString',('"'+${ps(old)}+'" --uninstall'))
                } finally { $entry.Dispose() }
                $phase='compile-fixture'
                Add-Type -TypeDefinition ('using System.Reflection; [assembly: AssemblyProduct("'+$product+'")] public class Program { public static void Main() {} }') -OutputAssembly ${ps(main)} -OutputType ConsoleApplication
                function Check([int]$expected, [string]$publisher='WiFiMeter') {
                    $script:repairCase++; $script:phase='repair-case-'+$script:repairCase
                    & ${ps(helper)} -ProductName $product -Publisher $publisher -RegistryView 64
                    $actual=$LASTEXITCODE
                    if($actual -ne $expected){
                        if($expected -eq 0){
                            try {
                                [Console]::Error.WriteLine(('fixture ProductName='+[Diagnostics.FileVersionInfo]::GetVersionInfo(${ps(main)}).ProductName+'; expected='+$product))
                                $diagnostic=Join-Path $directory 'diagnostic-repair-uninstall.ps1'
                                [IO.File]::WriteAllText($diagnostic,${ps(diagnosticHelperSource())},[Text.UTF8Encoding]::new($true))
                                & $diagnostic -ProductName $product -Publisher $publisher -RegistryView 64
                                [Console]::Error.WriteLine(('repair diagnostic status='+$LASTEXITCODE))
                            } catch { [Console]::Error.WriteLine(('repair diagnostic failed: '+$_.Exception.GetType().FullName+'; '+$_.Exception.Message)) }
                        }
                        throw ('Unexpected repair status: '+$actual+' expected '+$expected)
                    }
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
        } catch {
            [Console]::Error.WriteLine(('fixture phase='+$phase+'; '+$_.Exception.GetType().FullName+'; '+$_.FullyQualifiedErrorId+'; '+$_.Exception.Message))
            exit 1
        }
    `;
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const result = spawnSync(powershell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { windowsHide: true, encoding: 'utf8', timeout: 55000, stdio: ['ignore', 'pipe', 'pipe'] });
    const failure = fixtureFailure(result, directory);
    assert.ok(!result.error, failure);
    assert.equal(result.status, 0, failure);
    assert.match(result.stdout, /isolated repair cases passed/);
});
