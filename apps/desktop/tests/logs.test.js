import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const { createLogStore, captureConsole, parseLine } = createRequire(import.meta.url)('../host/logs.cjs');

// In-memory file system with just the calls the log store makes.
function memoryIo() {
    const files = new Map();
    return {
        files,
        mkdirSync() {},
        readFileSync(file) { if (!files.has(file)) throw Error('ENOENT'); return files.get(file); },
        writeFileSync(file, text) { files.set(file, text); },
        appendFileSync(file, text) { files.set(file, (files.get(file) || '') + text); },
        statSync(file) { if (!files.has(file)) throw Error('ENOENT'); return { size: Buffer.byteLength(files.get(file)) }; },
        renameSync(from, to) { if (!files.has(from)) throw Error('ENOENT'); files.set(to, files.get(from)); files.delete(from); },
        unlinkSync(file) { files.delete(file); },
        truncateSync(file) { if (!files.has(file)) throw Error('ENOENT'); files.set(file, ''); }
    };
}
const store = (io, options = {}) => createLogStore({ directory: '/logs', io, now: () => new Date('2026-11-18T00:00:00Z'), ...options });

test('entries below the recording level are dropped and the level survives a restart', () => {
    const io = memoryIo(), logs = store(io);
    assert.equal(logs.level, 'info');
    assert.equal(logs.write('debug', 'app', 'hidden'), false);
    assert.equal(logs.write('info', 'app', 'shown'), true);
    assert.equal(logs.write('verbose', 'app', 'unknown level'), false);
    assert.equal(logs.setLevel('debug'), 'debug');
    assert.equal(logs.write('debug', 'app', 'now recorded'), true);
    assert.throws(() => logs.setLevel('trace'), /Unsupported/);
    assert.equal(store(io).level, 'debug');
    assert.deepEqual(logs.read().entries.map(row => row.message), ['now recorded', 'shown']);
});

test('reading filters by minimum level and search, newest first, within the limit', () => {
    const logs = store(memoryIo());
    logs.write('info', 'backend', 'started');
    logs.write('warn', 'backup', 'WebDAV slow');
    logs.write('error', 'backup', 'WebDAV failed');
    assert.deepEqual(logs.read({ minimum: 'warn' }).entries.map(row => row.level), ['error', 'warn']);
    assert.deepEqual(logs.read({ search: 'webdav', limit: 1 }), { level: 'info', total: 2,
        entries: [{ time: '2026-11-18T00:00:00.000Z', level: 'error', source: 'backup', message: 'WebDAV failed' }] });
    assert.equal(logs.read({ search: 'BACKEND' }).total, 1);
    assert.match(logs.text(), /^2026-11-18T00:00:00\.000Z INFO  \[backend\] started\n.*WARN .*\n.*ERROR \[backup\] WebDAV failed$/);
});

test('the current file rotates at the size limit and only one previous file is kept', () => {
    const io = memoryIo(), logs = store(io, { maxBytes: 200 });
    for (let index = 0; index < 12; index++) logs.write('info', 'app', `entry ${index}`);
    assert.equal(io.files.size, 2);
    for (const text of io.files.values()) assert.ok(Buffer.byteLength(text) <= 200);
    const messages = logs.read().entries.map(row => row.message);
    assert.equal(messages[0], 'entry 11');
    assert.ok(messages.length < 12);
    logs.clear();
    assert.equal(logs.read().total, 0);
    assert.equal(logs.write('info', 'app', 'after clear'), true);
});

test('long messages are cut, broken lines are skipped and an unwritable directory never throws', () => {
    const io = memoryIo(), logs = store(io);
    logs.write('error', 'app', 'x'.repeat(5000));
    io.appendFileSync('/logs/wifimeter.log'.replace(/\//g, process.platform === 'win32' ? '\\' : '/'), '{"time":"cut');
    assert.equal(logs.read().entries[0].message.length, 2000);
    const broken = createLogStore({ directory: '/logs', io: { ...io, mkdirSync() { throw Error('EACCES'); } } });
    assert.equal(broken.write('error', 'app', 'lost'), false);
    assert.deepEqual(broken.read().entries, []);
    assert.throws(() => broken.setLevel('warn'), /not writable/);
});

test('console capture keeps terminal output, maps levels and records forwarded calls once', () => {
    const logs = store(memoryIo()), printed = [];
    const target = { debug() {}, info() {}, warn(...args) { printed.push(args); }, error(...args) { printed.push(args); }, log() {} };
    captureConsole(logs, target);
    // The Tauri host forwards console.log to console.error.
    const captured = target.error; target.log = (...args) => captured(...args);
    captureConsole(logs, { ...target, debug() {}, info() {}, warn() {}, error() {}, log() {} });
    target.error('[backend] 停止失败：boom');
    target.warn('plain', { code: 7 }, Error('bad'));
    assert.equal(printed.length, 2);
    const [warning, failure] = logs.read().entries;
    assert.deepEqual([failure.level, failure.source, failure.message], ['error', 'backend', '停止失败：boom']);
    assert.equal(warning.level, 'warn');
    assert.equal(warning.source, 'app');
    assert.match(warning.message, /^plain \{"code":7\} Error: bad/);
    assert.deepEqual(parseLine('[window-controls] moved'), { source: 'window-controls', message: 'moved' });
});


test('structured snapshots replace saved logs and survive restart without changing the recording level', () => {
    const io = memoryIo(), logs = store(io);
    logs.setLevel('warn'); logs.write('warn', 'app', 'original warning');
    const snapshot = { version: 1, entries: [
        { time: '2026-11-17T23:00:00.000Z', level: 'debug', source: 'backend', message: 'restored hidden debug' },
        { time: '2026-11-18T00:00:00.000Z', level: 'error', source: 'backup', message: 'restored error' }
    ] };
    assert.equal(typeof logs.restore, 'function');
    logs.restore(snapshot);
    assert.deepEqual(logs.snapshot(), snapshot);
    assert.deepEqual(store(io).snapshot(), snapshot);
    assert.equal(logs.level, 'warn');
    snapshot.entries[0].message = 'external mutation';
    assert.equal(logs.read().entries[1].message, 'restored hidden debug');
});

test('legacy cloud log text restores timestamps, levels, sources and multiline messages', () => {
    const logs = store(memoryIo());
    assert.equal(typeof logs.restore, 'function');
    logs.restore('2026-11-17T23:00:00.000Z INFO  [app] old line\n2026-11-18T00:00:00.000Z ERROR [backend] failure\nstack continuation');
    assert.deepEqual(logs.read().entries.map(row => [row.level, row.source, row.message]), [
        ['error', 'backend', 'failure\nstack continuation'], ['info', 'app', 'old line']
    ]);
});

test('malformed or excessive imported logs leave both files unchanged', () => {
    const io = memoryIo(), logs = store(io);
    logs.write('warn', 'app', 'local');
    const before = [...io.files];
    assert.equal(typeof logs.restore, 'function');
    const entry = { time: '2026-11-18T00:00:00.000Z', level: 'info', source: 'backup', message: 'imported' };
    for (const invalid of [null, [], { version: 2, entries: [] }, { version: 1, entries: [{ ...entry, time: 'yesterday' }] },
        { version: 1, entries: [{ ...entry, source: '../path\n' }] }, { version: 1, entries: [{ ...entry, message: 'x'.repeat(2001) }] },
        { version: 1, entries: [{ ...entry, path: '../arbitrary-file' }] }, 'x'.repeat(2 * 1024 * 1024 + 1)]) {
        assert.throws(() => logs.restore(invalid));
        assert.deepEqual([...io.files], before);
    }
});

test('log replacement rolls both files back when the second atomic rename fails', () => {
    const io = memoryIo(), initial = store(io, { maxBytes: 200 });
    for (let n = 0; n < 3; n++) initial.write('warn', 'app', 'local ' + n);
    const before = initial.read().entries;
    let renames = 0;
    const logs = store({ ...io, renameSync(from, to) { if (++renames === 2) throw Error('rename blocked'); io.renameSync(from, to); } }, { maxBytes: 200 });
    assert.equal(typeof logs.restore, 'function');
    assert.throws(() => logs.restore({ version: 1, entries: [{ time: '2026-11-18T00:00:00.000Z', level: 'info', source: 'backup', message: 'replacement' }] }), /rename blocked/);
    assert.deepEqual(logs.read().entries, before);
    assert.deepEqual(store(io, { maxBytes: 200 }).read().entries, before);
});

test('failed log-level persistence keeps the effective and persisted level unchanged', () => {
    const io = memoryIo(), initial = store(io);
    initial.setLevel('warn');
    const logs = store({ ...io, writeFileSync() { throw Error('disk full'); } });
    assert.throws(() => logs.setLevel('debug'), /disk full/);
    assert.equal(logs.level, 'warn');
    assert.equal(store(io).level, 'warn');
});


test('a complete log snapshot reports unreadable retained files instead of silently backing up an empty log', () => {
    const io = memoryIo(), initial = store(io);
    initial.write('warn', 'app', 'must remain recoverable');
    const current = [...io.files.keys()].find(file => file.endsWith('wifimeter.log'));
    const logs = store({ ...io, readFileSync(file) { if (file === current) throw Object.assign(Error('retained log locked'), { code: 'EACCES' }); return io.readFileSync(file); } });
    assert.deepEqual(logs.read().entries, []);
    assert.throws(() => logs.snapshot(), /retained log locked/);
    assert.equal(initial.read().entries[0].message, 'must remain recoverable');
});


test('legacy Windows CRLF messages retain their original time, level, source and line endings', () => {
    const logs = store(memoryIo());
    logs.restore('2026-11-17T23:00:00.000Z ERROR [backend] failure\r\nstack continuation');
    assert.deepEqual(logs.snapshot(), { version: 1, entries: [{ time: '2026-11-17T23:00:00.000Z', level: 'error', source: 'backend', message: 'failure\r\nstack continuation' }] });
});
