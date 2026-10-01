'use strict';

// 对比 Git 基线与工作区；只使用合成 IPC 消息和临时自启动目录。
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { execFileSync } = require('node:child_process');
const { performance } = require('node:perf_hooks');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const revision = process.argv[2] || 'c87496f';

function load(file, baseline, overrides = {}) {
    const filename = path.join(root, file);
    const source = baseline ? execFileSync('git', ['show', `${revision}:${file}`], { cwd: root, encoding: 'utf8' }) : fs.readFileSync(filename, 'utf8');
    const localRequire = createRequire(filename);
    const module = { exports: {} };
    vm.runInNewContext(source, { module, exports: module.exports,
        require: name => overrides[name] || localRequire(name),
        process, __dirname: path.dirname(filename), setTimeout, clearTimeout }, { filename });
    return module.exports;
}

function measureIpc(baseline) {
    const { BackendClient } = load('apps/desktop/electron/backend.cjs', baseline);
    const wire = JSON.stringify({ event: 'snapshot', text: 'x'.repeat(4 * 1024 * 1024) }) + '\n';
    const times = [];
    const heaps = [];
    for (let run = 0; run < 5; run++) {
        const client = new BackendClient({ executable: '', databasePath: ':memory:' });
        let received = 0;
        client.on('event', message => { assert.equal(message.text.length, 4 * 1024 * 1024); received++; });
        global.gc?.();
        const initialHeap = process.memoryUsage().heapUsed;
        let peakHeap = initialHeap;
        const start = performance.now();
        for (let offset = 0; offset < wire.length; offset += 4096) {
            client.consume(wire.slice(offset, offset + 4096));
            peakHeap = Math.max(peakHeap, process.memoryUsage().heapUsed);
        }
        times.push(performance.now() - start);
        heaps.push((peakHeap - initialHeap) / 1024 / 1024);
        assert.equal(received, 1);
    }
    const median = values => values.sort((a, b) => a - b)[2];
    return { medianMs: +median(times).toFixed(2), sampledHeapGrowthMiB: +median(heaps).toFixed(2) };
}

async function measureAutostart(baseline) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'wifimeter-benchmark-'));
    const calls = { mkdir: 0, writeFile: 0, readFile: 0 };
    const counted = { ...fsp };
    for (const name of Object.keys(calls)) counted[name] = (...args) => { calls[name]++; return fsp[name](...args); };
    try {
        const { createSystemIntegration } = load('apps/desktop/electron/system.cjs', baseline, { 'node:fs/promises': counted });
        const integration = createSystemIntegration({ app: { getPath: () => directory }, platform: 'linux' });
        for (let i = 0; i < 21; i++) await integration.applySettings({ autoStart: true, notifications: i % 2 === 0 });
        return calls;
    } finally {
        // directory 由 mkdtemp 直接生成，始终位于系统临时目录中。
        fs.rmSync(directory, { recursive: true, force: true });
    }
}

(async () => {
    console.log(JSON.stringify({ node: process.version, platform: process.platform, arch: process.arch, baseline: revision,
        workload: '4 MiB JSON / 4 KiB chunks, 5 runs; 21 settings applications',
        before: { ipc: measureIpc(true), autostart: await measureAutostart(true) },
        after: { ipc: measureIpc(false), autostart: await measureAutostart(false) }
    }, null, 2));
})().catch(error => { console.error(error); process.exitCode = 1; });
