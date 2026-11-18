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
