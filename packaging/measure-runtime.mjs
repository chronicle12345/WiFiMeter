// Measure an isolated release process tree without WebDriver/CDP. No real profile is opened.
import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { once } from 'node:events';
import { readFile, readdir, writeFile, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { createHarness } from '../apps/desktop/tests/support/backend-harness.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const execute = promisify(execFile);
const windows = process.platform === 'win32';
assert.ok(windows || process.platform === 'linux');
const executable = process.env.WIFIMETER_EXECUTABLE || path.join(root, windows
    ? 'dist/windows/win-unpacked/WiFiMeter.exe' : 'dist/linux/linux-unpacked/bin/wifimeter');

async function windowsMemory(pid) {
    const script = `
        $all = @(Get-CimInstance Win32_Process)
        $byId = @{}
        foreach ($p in $all) { $byId[[int]$p.ProcessId] = $p }
        $ids = @(${pid})
        do {
            $before = $ids.Count
            $ids += @($all | Where-Object {
                $ids -contains $_.ParentProcessId -and $ids -notcontains $_.ProcessId -and
                $_.CreationDate -ge $byId[[int]$_.ParentProcessId].CreationDate
            } | ForEach-Object { [int]$_.ProcessId })
        } while ($ids.Count -gt $before)
        @($all | Where-Object { $ids -contains $_.ProcessId } | ForEach-Object {
            $p = Get-Process -Id $_.ProcessId -ErrorAction SilentlyContinue
            if ($p) { @{ name=$_.Name; pid=$_.ProcessId; workingSetBytes=$p.WorkingSet64; privateCommitBytes=$p.PrivateMemorySize64 } }
        }) | ConvertTo-Json -Compress
    `;
    const { stdout } = await execute('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { windowsHide: true });
    return JSON.parse(stdout);
}

async function linuxMemory(pid) {
    const rows = [];
    for (const id of (await readdir('/proc')).filter(name => /^\d+$/.test(name))) {
        try {
            const stat = await readFile(`/proc/${id}/stat`, 'utf8');
            const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
            rows.push({ pid: Number(id), parent: Number(fields[1]), started: Number(fields[19]), name: stat.slice(stat.indexOf('(') + 1, stat.lastIndexOf(')')) });
        } catch (error) { if (error.code !== 'ENOENT' && error.code !== 'ESRCH') throw error; }
    }
    const selected = new Map(rows.filter(row => row.pid === pid).map(row => [row.pid, row]));
    let before;
    do {
        before = selected.size;
        for (const row of rows) if (selected.has(row.parent) && row.started >= selected.get(row.parent).started) selected.set(row.pid, row);
    } while (before !== selected.size);
    const processes = [];
    for (const row of selected.values()) {
        try {
            const memory = Object.fromEntries([...(await readFile(`/proc/${row.pid}/smaps_rollup`, 'utf8')).matchAll(/^(\w+):\s+(\d+) kB$/gm)].map(([, key, value]) => [key, Number(value) * 1024]));
            processes.push({ name: row.name, pid: row.pid, rssBytes: memory.Rss, pssBytes: memory.Pss, privateRssBytes: memory.Private_Clean + memory.Private_Dirty });
        } catch (error) { if (error.code !== 'ENOENT' && error.code !== 'ESRCH') throw error; }
    }
    return processes;
}

const harness = await createHarness();
await writeFile(path.join(harness.directory, 'window-preferences.json'), JSON.stringify({ closeAction: 'exit', miniWindow: false }));
const env = { ...process.env, ...harness.env };
for (const key of ['WIFIMETER_BACKEND', 'WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS', 'WEBKIT_INSPECTOR_SERVER']) delete env[key];
const child = spawn(executable, [], { env, stdio: ['ignore', 'ignore', 'pipe'] });
const exited = once(child, 'exit');
let log = '';
let measuredProcesses = [];
child.stderr.on('data', chunk => { log += chunk; });
try {
    await delay(10000);
    const samples = [];
    for (let i = 0; i < 3; i++) {
        assert.equal(child.exitCode, null, log);
        const processes = await (windows ? windowsMemory(child.pid) : linuxMemory(child.pid));
        measuredProcesses = processes;
        assert.ok(processes.some(item => item.name.startsWith('wifimeter-back')), 'Bundled collector must be running');
        const totals = {};
        for (const key of windows ? ['workingSetBytes', 'privateCommitBytes'] : ['rssBytes', 'pssBytes', 'privateRssBytes']) {
            totals[key.replace('Bytes', 'MiB')] = processes.reduce((sum, item) => sum + item[key], 0) / 1048576;
        }
        samples.push({ ...totals, processes });
        if (i < 2) await delay(2000);
    }
    const result = { platform: process.platform, scope: 'Release main window + system WebView + bundled collector; one-network fixture totaling 3.6 GB traffic; no WebDriver/CDP; three samples after 10 seconds', samples };
    const output = process.env.WIFIMETER_METRICS || path.join(root, 'artifacts', `runtime-${process.platform}.json`);
    await mkdir(path.dirname(output), { recursive: true });
    await writeFile(output, JSON.stringify(result, null, 2) + '\n');
    console.log(JSON.stringify(result, null, 2));
} finally {
    if (child.exitCode === null) {
        if (windows) await execute('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(root, 'apps/desktop/tests/e2e/test-window.ps1'), '-ProcessId', String(child.pid), '-Action', 'close'], { windowsHide: true });
        else {
            // A local runtime wrapper may own the child PID; stop the measured app within that tree.
            const application = measuredProcesses.find(item => item.name.toLowerCase() === 'wifimeter');
            if (application) process.kill(application.pid, 'SIGTERM');
            else child.kill('SIGTERM');
        }
    }
    await exited;
    // WebView2 子进程可能在主窗口退出后短暂持有配置文件。
    await rm(harness.directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
}
