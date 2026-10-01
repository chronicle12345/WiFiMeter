import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm, open } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createFileActions, MAX_BACKUP_BYTES, assertBackupSize } from '../electron/files.cjs';

test('desktop save and restore round trip UTF-8 content', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'wifimeter-files-'));
    try {
        const file = path.join(dir, 'backup.json');
        const dialogs = {
            showSaveDialog: async () => ({ filePath: file }),
            showOpenDialog: async () => ({ filePaths: [file] })
        };
        const actions = createFileActions(dialogs, () => null);
        const body = '{"name":"家里的 Wi-Fi"}';
        assert.deepEqual(await actions.saveFile({ filename: 'backup.json', body }), { canceled: false });
        assert.equal(await readFile(file, 'utf8'), body);
        assert.equal((await actions.openBackup()).body, body);
        const large = JSON.stringify({ original: '测'.repeat(3 * 1024 * 1024), bytes: '9007199254740993' });
        assert.ok(Buffer.byteLength(large) > 8 * 1024 * 1024);
        assert.deepEqual(await actions.saveFile({ filename: 'backup.json', body: large }), { canceled: false });
        assert.equal((await actions.openBackup()).body, large);
        // 稀疏文件覆盖真实 stat 边界，无需在内存分配 512 MiB。
        const handle = await open(file, 'w');
        try { await handle.truncate(MAX_BACKUP_BYTES + 1); } finally { await handle.close(); }
        assert.match((await actions.openBackup()).error, /512 MiB/);
    } finally { await rm(dir, { recursive: true, force: true }); }
});

test('cancel performs no IO and reports canceled', async () => {
    const dialogs = { showSaveDialog: async () => ({ canceled: true }), showOpenDialog: async () => ({ canceled: true }) };
    const actions = createFileActions(dialogs, () => null, { writeFile() { throw Error('should not write'); } });
    assert.deepEqual(await actions.saveFile({ filename: 'test.csv', body: 'x' }), { canceled: true });
    assert.deepEqual(await actions.openBackup(), { canceled: true });
});

test('write/read failures and unsupported file types return actionable errors', async () => {
    const dialogs = { showSaveDialog: async () => ({ filePath: '/missing/test.csv' }), showOpenDialog: async () => ({ filePaths: ['/missing/test.json'] }) };
    const actions = createFileActions(dialogs, () => null);
    assert.match((await actions.saveFile({ filename: 'test.csv', body: 'x' })).error, /保存失败/);
    assert.match((await actions.openBackup()).error, /无法读取备份/);
    assert.match((await actions.saveFile({ filename: 'run.sh', body: 'x' })).error, /仅支持/);
});


test('backup budget has an inclusive shared boundary for export and restore', () => {
    assert.equal(MAX_BACKUP_BYTES, 512 * 1024 * 1024);
    assert.doesNotThrow(() => assertBackupSize(MAX_BACKUP_BYTES));
    assert.throws(() => assertBackupSize(MAX_BACKUP_BYTES + 1), /512 MiB/);
});

// Real filesystem with failures injected at the commit boundaries.
for (const stage of ['write', 'sync', 'close', 'rename']) {
    test(`failed ${stage} preserves the previous backup and removes temporary files`, async t => {
        const fs = await import('node:fs/promises');
        const dir = await mkdtemp(path.join(os.tmpdir(), 'wifimeter-atomic-'));
        t.after(() => rm(dir, { recursive: true, force: true }));
        const file = path.join(dir, 'backup.json');
        const original = '{"records":["only recovery copy"]}';
        await writeFile(file, original);
        const fail = () => { throw Object.assign(Error(`injected ${stage}`), { code: stage === 'rename' ? 'EPERM' : 'EIO' }); };
        const io = {
            ...fs,
            async writeFile(target, body) {
                if (stage === 'write') { await fs.writeFile(target, body.slice(0, 5)); fail(); }
                return fs.writeFile(target, body);
            },
            async open(target, flags, mode) {
                const handle = await fs.open(target, flags, mode);
                return {
                    async writeFile(body, encoding) {
                        if (stage === 'write') { await handle.writeFile(body.slice(0, 5), encoding); fail(); }
                        await handle.writeFile(body, encoding);
                    },
                    async sync() { if (stage === 'sync') fail(); await handle.sync(); },
                    async close() { await handle.close(); if (stage === 'close') fail(); }
                };
            },
            async rename(from, to) { if (stage === 'rename') fail(); return fs.rename(from, to); }
        };
        const actions = createFileActions({ showSaveDialog: async () => ({ filePath: file }) }, () => null, io);
        const result = await actions.saveFile({ filename: 'backup.json', body: '{"records":["replacement"]}' });
        assert.match(result.error ?? '', new RegExp(`injected ${stage}`));
        assert.equal(await readFile(file, 'utf8'), original);
        assert.deepEqual(await fs.readdir(dir), ['backup.json']);
    });
}

test('concurrent saves expose only complete backups and commit after sync and close', async t => {
    const fs = await import('node:fs/promises');
    const dir = await mkdtemp(path.join(os.tmpdir(), 'wifimeter-atomic-'));
    t.after(() => rm(dir, { recursive: true, force: true }));
    const file = path.join(dir, 'backup.json');
    const original = '{"original":true}';
    await writeFile(file, original);
    let release, ready;
    const gate = new Promise(resolve => { release = resolve; });
    const prepared = new Promise(resolve => { ready = resolve; });
    let count = 0;
    const handles = new Map();
    async function written() { if (++count === 2) ready(); await gate; }
    const io = {
        ...fs,
        async writeFile(target, body, encoding) { await fs.writeFile(target, body, encoding); await written(); },
        async open(target, flags, mode) {
            assert.equal(path.dirname(target), dir);
            assert.notEqual(target, file);
            assert.equal(flags, 'wx');
            const handle = await fs.open(target, flags, mode);
            const state = { synced: false, closed: false }; handles.set(target, state);
            return {
                async writeFile(body, encoding) { await handle.writeFile(body, encoding); await written(); },
                async sync() { await handle.sync(); state.synced = true; },
                async close() { await handle.close(); state.closed = true; }
            };
        },
        async rename(from, to) {
            assert.deepEqual(handles.get(from), { synced: true, closed: true });
            await fs.rename(from, to);
        }
    };
    const actions = createFileActions({ showSaveDialog: async () => ({ filePath: file }) }, () => null, io);
    const bodies = [JSON.stringify({ value: 'a'.repeat(500000) }), JSON.stringify({ value: 'b'.repeat(700000) })];
    const saves = bodies.map(body => actions.saveFile({ filename: 'backup.json', body }));
    await prepared;
    try { assert.equal(await readFile(file, 'utf8'), original); }
    finally { release(); await Promise.all(saves); }
    const results = await Promise.all(saves);
    assert.ok(results.some(result => result.canceled === false));
    for (const result of results) {
        if (result.error && process.platform === 'win32') assert.match(result.error, /EPERM|EACCES|EBUSY/);
        else assert.deepEqual(result, { canceled: false });
    }
    assert.equal(handles.size, 2);
    assert.ok(bodies.includes(await readFile(file, 'utf8')));
    assert.deepEqual(await fs.readdir(dir), ['backup.json']);
});

test('a Windows-locked destination is preserved and the failed save leaves no temporary file', { skip: process.platform !== 'win32' }, async t => {
    const fs = await import('node:fs/promises');
    const { spawn } = await import('node:child_process');
    const dir = await mkdtemp(path.join(os.tmpdir(), 'wifimeter-locked-'));
    const file = path.join(dir, 'backup.json');
    const original = '{"recovery":"keep me"}';
    await writeFile(file, original);
    const powershell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe');
    const script = `$ErrorActionPreference='Stop'; $file=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${Buffer.from(file).toString('base64')}')); $h=[IO.File]::Open($file,'Open','Read','Read'); try { [Console]::Out.WriteLine('locked'); [Console]::Out.Flush(); if ([Console]::In.ReadLine() -ne 'release') { throw 'Missing lock release command' } } finally { $h.Dispose() }`;
    const child = spawn(powershell, ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '', processError, closed = false;
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', chunk => { stderr += chunk; });
    // Keep spawn/stdin failures available to every wait, including cleanup.
    child.on('error', error => { processError = error; });
    child.stdin.on('error', error => { processError = error; });
    const exited = new Promise(resolve => child.once('close', (code, signal) => {
        closed = true;
        resolve({ code, signal });
    }));
    const diagnostic = message => Error(`${message}; exit=${child.exitCode}; signal=${child.signalCode}; error=${processError?.message ?? 'none'}; stderr=${stderr || '(empty)'}; stdout=${stdout || '(empty)'}`);
    const ready = new Promise(resolve => child.stdout.on('data', chunk => {
        stdout += chunk;
        // Pipe data can split a line across chunks. Only acknowledge a complete line.
        if (stdout.split(/\r?\n/).slice(0, -1).includes('locked')) resolve();
    }));
    async function bounded(promise, milliseconds, message) {
        let timer;
        try {
            return await Promise.race([
                promise,
                new Promise((_, reject) => { timer = setTimeout(() => reject(diagnostic(message)), milliseconds); })
            ]);
        } finally { clearTimeout(timer); }
    }
    t.after(async () => {
        try {
            if (!closed) child.kill();
            await bounded(exited, 10000, 'File-lock process did not close after termination');
        } finally { await rm(dir, { recursive: true, force: true }); }
    });
    // CI runs test files concurrently, including other PowerShell processes.
    // Allow cold startup, but fail immediately if the helper closes before its handshake.
    await bounded(Promise.race([
        ready,
        exited.then(() => { throw diagnostic('File-lock process closed before handshake'); })
    ]), 30000, 'File-lock startup timeout');
    assert.equal(closed, false, diagnostic('File-lock process closed after handshake').message);
    // Verify the real sharing lock independently of saveFile's error handling.
    await assert.rejects(async () => {
        const handle = await open(file, 'r+');
        await handle.close();
    }, { code: /^(EPERM|EACCES|EBUSY)$/ });
    const actions = createFileActions({ showSaveDialog: async () => ({ filePath: file }) }, () => null);
    assert.match((await actions.saveFile({ filename: 'backup.json', body: '{"replacement":true}' })).error, /EPERM|EACCES|EBUSY/);
    assert.equal(await readFile(file, 'utf8'), original);
    assert.deepEqual(await fs.readdir(dir), ['backup.json']);
    assert.equal(closed, false, diagnostic('File-lock process closed before release').message);
    child.stdin.end('release\n');
    const result = await bounded(exited, 10000, 'File-lock release timeout');
    assert.equal(result.code, 0, diagnostic('File-lock process failed').message);
    assert.equal(processError, undefined, diagnostic('File-lock communication failed').message);
    // Confirm release permits the same save that failed while the handle was open.
    assert.deepEqual(await actions.saveFile({ filename: 'backup.json', body: '{"replacement":true}' }), { canceled: false });
    assert.equal(await readFile(file, 'utf8'), '{"replacement":true}');
    assert.deepEqual(await fs.readdir(dir), ['backup.json']);
});
