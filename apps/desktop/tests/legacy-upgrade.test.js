import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm, access } from 'node:fs/promises';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { once } from 'node:events';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
const execute = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const powershell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe');
const helper = path.join(root, 'packaging/windows/stop-legacy.ps1');

test('upgrade helper waits for the legacy collector to save without killing it', { skip: process.platform !== 'win32', timeout: 90000 }, async t => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'wifimeter-upgrade-'));
    let child, exited;
    let output = '', errors = '';
    t.after(async () => {
        if (child && child.exitCode === null) child.kill();
        if (exited) await exited;
        await rm(directory, { recursive: true, force: true });
    });
    const run = () => execute(powershell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', helper, '-DataDirectory', directory, '-TimeoutSeconds', '30'], { windowsHide: true, timeout: 60000 });
    await run();
    await assert.rejects(access(path.join(directory, 'stop.request')));
    await writeFile(path.join(directory, 'stop.request'), '{"LaunchId":"stale"}');
    // The fixture only saves after seeing its own launch token, never because a timer expires.
    // Its lifetime is controlled by the test, so runner startup delays cannot make it exit early.
    const script = `$ErrorActionPreference='Stop'; $d=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${Buffer.from(directory).toString('base64')}')); $lock=[IO.File]::Open((Join-Path $d 'collector.lock'),'OpenOrCreate','ReadWrite','None'); try { [IO.File]::WriteAllText((Join-Path $d 'status.json'),' {"LaunchId":"11111111111111111111111111111111"}'); $stale=[IO.File]::ReadAllText((Join-Path $d 'stop.request'))|ConvertFrom-Json; if($stale.LaunchId -ne 'stale'){throw 'Expected stale fixture request'}; [Console]::Out.WriteLine('STALE_IGNORED'); [Console]::Out.WriteLine('READY'); [Console]::Out.Flush(); while($true) { if(Test-Path (Join-Path $d 'stop.request')) { $r=$null; try {$r=[IO.File]::ReadAllText((Join-Path $d 'stop.request'))|ConvertFrom-Json}catch{}; if($null -ne $r -and $r.LaunchId -eq '11111111111111111111111111111111'){break} }; Start-Sleep -Milliseconds 50 }; [Console]::Out.WriteLine('STOP_RECEIVED'); [Console]::Out.Flush(); [IO.File]::WriteAllText((Join-Path $d 'state.json'),'saved-final-sample'); [Console]::Out.WriteLine('SAVED'); [Console]::Out.Flush() }finally{$lock.Dispose()}`;
    child = spawn(powershell, ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    exited = new Promise((resolve, reject) => { child.once('close', code => resolve(code)); child.once('error', reject); });
    exited.catch(() => {});
    child.stdout.on('data', chunk => { output += chunk.toString(); });
    child.stderr.on('data', chunk => { errors += chunk.toString(); });
    const ready = new Promise((resolve, reject) => {
        const timer = setTimeout(() => { cleanup(); reject(Error(`Fixture readiness timeout; stdout=${output}; stderr=${errors}`)); }, 30000);
        const check = () => { if (/^READY\r?$/m.test(output)) { cleanup(); resolve(); } };
        const earlyExit = code => { cleanup(); reject(Error(`Fixture exited before readiness: ${code}; ${errors}`)); };
        const failed = error => { cleanup(); reject(error); };
        const cleanup = () => { clearTimeout(timer); child.stdout.removeListener('data', check); child.removeListener('exit', earlyExit); child.removeListener('error', failed); };
        child.stdout.on('data', check); child.once('exit', earlyExit); child.once('error', failed); check();
    });
    await ready;
    assert.match(output, /STALE_IGNORED/);
    try { await run(); } catch (error) { throw Error(`${error.message}\nFixture stdout: ${output}\nFixture stderr: ${errors}`); }
    let timer;
    const exitCode = await Promise.race([exited, new Promise((_, reject) => {
        timer = setTimeout(() => reject(Error(`Fixture exit timeout; stdout=${output}; stderr=${errors}`)), 10000);
    })]).finally(() => clearTimeout(timer));
    assert.equal(exitCode, 0, errors);
    assert.equal(child.killed, false);
    assert.match(output, /STOP_RECEIVED[\s\S]*SAVED/);
    assert.equal(JSON.parse((await readFile(path.join(directory, 'stop.request'), 'utf8')).replace(/^\uFEFF/, '')).LaunchId, '11111111111111111111111111111111');
    assert.equal(await readFile(path.join(directory, 'state.json'), 'utf8'), 'saved-final-sample');
});

// Load the real helper's functions, replacing only the read-only process inventory.
// No fixture ever enumerates or stops the user's applications.
async function runGuardFixture(script) {
    const load = `[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${Buffer.from(helper).toString('base64')}'))`;
    const source = `$ErrorActionPreference='Stop'; $ProgressPreference='SilentlyContinue'; [Console]::OutputEncoding=[Text.UTF8Encoding]::new(); $tokens=$null; $errors=$null; $ast=[Management.Automation.Language.Parser]::ParseFile((${load}),[ref]$tokens,[ref]$errors); if($errors.Count){throw $errors[0]}; $definitions=$ast.FindAll({param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst]},$false); . ([scriptblock]::Create(($definitions.Extent.Text -join [Environment]::NewLine))); ${script}`;
    return execute(powershell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(source, 'utf16le').toString('base64')], { windowsHide: true });
}

test('installer replaces the default process terminator at the final selected-directory check', async () => {
    const nsis = await readFile(path.join(root, 'packaging/windows/installer.nsh'), 'utf8');
    assert.match(nsis, /!macro customCheckAppRunning\b/);
    const definition = '!define WIFIMETER_LEGACY_HELPER "${__FILEDIR__}\\stop-legacy.ps1"';
    assert.ok(nsis.indexOf(definition) >= 0 && nsis.indexOf(definition) < nsis.indexOf('!macro customCheckAppRunning'), 'Resolve the helper at include time, before macro expansion');
    const macro = nsis.slice(nsis.indexOf('!macro customCheckAppRunning'), nsis.indexOf('!macroend'));
    assert.ok(macro.includes('"${WIFIMETER_LEGACY_HELPER}"'));
    assert.ok(!macro.includes('${__FILEDIR__}'), 'Installer and uninstaller call sites must not determine the helper path');
    assert.match(nsis, /-InstallDirectory "\$INSTDIR(?:\\\.)?"/);
    assert.match(nsis, /\bAbort\b/);
    assert.doesNotMatch(nsis, /(?:Stop-Process|taskkill|_CHECK_APP_RUNNING|KILL_PROCESS)/i);
});

test('final guard distinguishes exact install paths and rejects unreadable or Electron instances', { skip: process.platform !== 'win32' }, async () => {
    await runGuardFixture(`
        $script:rows = @()
        function Get-WiFiMeterProcesses { return $script:rows }
        $install = 'C:\\Fixture App'
        function Assert-Blocked($rows) {
            $script:rows = $rows
            try { Invoke-InstallGuard -InstallDirectory $install -TimeoutSeconds 1; throw 'GUARD_ACCEPTED' }
            catch { if ($_.Exception.Message -eq 'GUARD_ACCEPTED') { throw }; if ($_.Exception.Message -notmatch 'Close|exit|退出') { throw } }
        }
        Invoke-InstallGuard -InstallDirectory $install -TimeoutSeconds 1
        $script:rows = @([pscustomobject]@{ ExecutablePath='C:\\Fixture App Other\\WiFiMeter.exe'; CommandLine=$null; ProcessId=201 })
        Invoke-InstallGuard -InstallDirectory $install -TimeoutSeconds 1
        Assert-Blocked @([pscustomobject]@{ ExecutablePath=$null; CommandLine=$null; ProcessId=202 })
        Assert-Blocked @([pscustomobject]@{ ExecutablePath='C:\\Fixture App\\WiFiMeter.exe'; CommandLine=$null; ProcessId=203 })
        Assert-Blocked @([pscustomobject]@{ ExecutablePath='C:\\Fixture App\\WiFiMeter.exe'; CommandLine='"C:\\Fixture App\\WiFiMeter.exe"'; ProcessId=204 })
        Assert-Blocked @([pscustomobject]@{ ExecutablePath='C:\\Fixture App\\WiFiMeter.exe'; CommandLine='"C:\\Fixture App\\WiFiMeter.exe" --type=renderer'; ProcessId=205 })
        function Get-WiFiMeterProcesses { throw 'CIM access denied' }
        try { Invoke-InstallGuard -InstallDirectory $install -TimeoutSeconds 1; throw 'GUARD_ACCEPTED' }
        catch { if ($_.Exception.Message -eq 'GUARD_ACCEPTED') { throw } }
        Write-Output 'guard cases passed'
    `).then(result => assert.match(result.stdout, /guard cases passed/));
});

test('legacy command lines are parsed as arguments, never evaluated as shell text', { skip: process.platform !== 'win32' }, async () => {
    await runGuardFixture(`
        $exe = 'C:\\Fixture App\\WiFiMeter.exe'
        $directory = 'C:\\Data space & $literal; (test)'
        $parsed = Get-LegacyDataDirectory -CommandLine ('"' + $exe + '" --background --data-directory "' + $directory + '"') -ExecutablePath $exe
        if ($parsed -cne $directory) { throw 'Directory changed during parsing' }
        foreach ($line in @(
            ('"' + $exe + '" --background --data-directory relative'),
            ('"' + $exe + '" --background --data-directory "C:\\A" --data-directory "C:\\B"'),
            ('"' + $exe + '" --background --data-directory'),
            ('"' + $exe + '" --background --data-directory "C:\\A" --unknown'),
            ('"C:\\other.exe" --background --data-directory "C:\\A"')
        )) {
            try { Get-LegacyDataDirectory -CommandLine $line -ExecutablePath $exe; throw 'PARSER_ACCEPTED' }
            catch { if ($_.Exception.Message -eq 'PARSER_ACCEPTED') { throw } }
        }
        Write-Output 'argument cases passed'
    `).then(result => assert.match(result.stdout, /argument cases passed/));
});

async function collectorFixture(t, { ignoreStop = false, finalError = '', exitDelay = 0 } = {}) {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'wifimeter-guard space & '));
    let child;
    let exited;
    t.after(async () => {
        if (child && child.exitCode === null) child.kill();
        if (exited) await exited;
        await rm(directory, { recursive: true, force: true });
    });
    const encoded = Buffer.from(directory).toString('base64');
    const script = `$ErrorActionPreference='Stop'; $d=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encoded}')); $lock=[IO.File]::Open((Join-Path $d 'collector.lock'),'OpenOrCreate','ReadWrite','None'); try {
        $status=@{ LaunchId='22222222222222222222222222222222'; ProcessId=$PID; ProcessStartTicks=(Get-Process -Id $PID).StartTime.ToUniversalTime().Ticks.ToString(); Running=$true; Error='' }
        [IO.File]::WriteAllText((Join-Path $d 'status.json'),($status|ConvertTo-Json -Compress))
        $deadline=[DateTime]::UtcNow.AddSeconds(20)
        do {
            if (${ignoreStop ? '$false' : '$true'} -and [IO.File]::Exists((Join-Path $d 'stop.request'))) {
                try { $r=[IO.File]::ReadAllText((Join-Path $d 'stop.request'))|ConvertFrom-Json; if($r.LaunchId -ceq $status.LaunchId){break} } catch {}
            }
            Start-Sleep -Milliseconds 25
        } while([DateTime]::UtcNow -lt $deadline)
        [IO.File]::WriteAllText((Join-Path $d 'state.json'),'saved-final-sample')
        $status.Running=$false; $status.Error='${finalError}'
        [IO.File]::WriteAllText((Join-Path $d 'status.json'),($status|ConvertTo-Json -Compress))
    } finally { $lock.Dispose() }
    Start-Sleep -Milliseconds ${exitDelay}`;
    child = spawn(powershell, ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { windowsHide: true, stdio: 'ignore' });
    exited = once(child, 'exit');
    let status;
    const deadline = Date.now() + 5000;
    while (!status) {
        try { status = JSON.parse(await readFile(path.join(directory, 'status.json'), 'utf8')); }
        catch { if (Date.now() >= deadline) throw Error('Isolated collector startup timeout'); await new Promise(resolve => setTimeout(resolve, 25)); }
    }
    const setup = `
        $install='C:\\Guard Test'
        $data=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encoded}'))
        $script:fixture=[pscustomobject]@{ ExecutablePath='C:\\Guard Test\\WiFiMeter.exe'; CommandLine=('"C:\\Guard Test\\WiFiMeter.exe" --background --data-directory "'+$data+'"'); ProcessId=${status.ProcessId}; CreationDate=[DateTime]::new([long]'${status.ProcessStartTicks}',[DateTimeKind]::Utc) }
        $script:queries=0
        function Get-WiFiMeterProcesses {
            $script:queries++
            try { $p=[Diagnostics.Process]::GetProcessById(${status.ProcessId}) } catch [ArgumentException] { return }
            try { if(-not $p.HasExited){ return $script:fixture } } finally { $p.Dispose() }
        }
    `;
    return { directory, child, exited, setup };
}

test('final guard handshakes the custom directory and waits beyond lock release for process exit', { skip: process.platform !== 'win32' }, async t => {
    const fixture = await collectorFixture(t, { exitDelay: 900 });
    const result = await runGuardFixture(fixture.setup + `
        Invoke-InstallGuard -InstallDirectory $install -TimeoutSeconds 5
        if($script:queries -lt 3){throw 'Did not wait for process exit'}
        Write-Output 'saved and exited'
    `);
    assert.match(result.stdout, /saved and exited/);
    assert.equal((await fixture.exited)[0], 0);
    assert.equal(await readFile(path.join(fixture.directory, 'state.json'), 'utf8'), 'saved-final-sample');
});

for (const mismatch of ['pid', 'start']) {
    test(`guard refuses a stale ${mismatch} without sending a stop request`, { skip: process.platform !== 'win32' }, async t => {
        const fixture = await collectorFixture(t);
        const result = await runGuardFixture(fixture.setup + `
            ${mismatch === 'pid' ? '$script:fixture.ProcessId++' : '$script:fixture.CreationDate=$script:fixture.CreationDate.AddSeconds(-1)'}
            try { Invoke-InstallGuard -InstallDirectory $install -TimeoutSeconds 1; throw 'GUARD_ACCEPTED' }
            catch { if($_.Exception.Message -eq 'GUARD_ACCEPTED'){throw}; Write-Output $_.Exception.Message }
        `);
        assert.match(result.stdout, /identity could not be confirmed/);
        await assert.rejects(access(path.join(fixture.directory, 'stop.request')), { code: 'ENOENT' });
        assert.equal(fixture.child.exitCode, null);
    });
}

test('collector timeout aborts without terminating the isolated process', { skip: process.platform !== 'win32' }, async t => {
    const fixture = await collectorFixture(t, { ignoreStop: true });
    const result = await runGuardFixture(fixture.setup + `
        try { Invoke-InstallGuard -InstallDirectory $install -TimeoutSeconds 1; throw 'GUARD_ACCEPTED' }
        catch { if($_.Exception.Message -eq 'GUARD_ACCEPTED'){throw}; Write-Output $_.Exception.Message }
    `);
    assert.match(result.stdout, /not finished saving/);
    assert.equal(fixture.child.exitCode, null);
    assert.equal(JSON.parse((await readFile(path.join(fixture.directory, 'stop.request'), 'utf8')).replace(/^\uFEFF/, '')).LaunchId, '22222222222222222222222222222222');
});

test('a reported save failure aborts even when the collector releases its lock', { skip: process.platform !== 'win32' }, async t => {
    const fixture = await collectorFixture(t, { finalError: 'disk full' });
    const result = await runGuardFixture(fixture.setup + `
        try { Invoke-InstallGuard -InstallDirectory $install -TimeoutSeconds 3; throw 'GUARD_ACCEPTED' }
        catch { if($_.Exception.Message -eq 'GUARD_ACCEPTED'){throw}; Write-Output $_.Exception.Message }
    `);
    assert.match(result.stdout, /successful save was not confirmed/);
});

test('the final inventory rejects an instance started after the initial check', { skip: process.platform !== 'win32' }, async () => {
    const result = await runGuardFixture(`
        $script:queries=0
        function Get-WiFiMeterProcesses {
            $script:queries++
            if($script:queries -gt 1){[pscustomobject]@{ExecutablePath='C:\\Fixture\\WiFiMeter.exe'; CommandLine='"C:\\Fixture\\WiFiMeter.exe"'; ProcessId=999}}
        }
        try { Invoke-InstallGuard -InstallDirectory 'C:\\Fixture' -TimeoutSeconds 1; throw 'GUARD_ACCEPTED' }
        catch { if($_.Exception.Message -eq 'GUARD_ACCEPTED'){throw}; Write-Output $_.Exception.Message }
    `);
    assert.match(result.stdout, /still running/);
});
