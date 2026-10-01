import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
let createAppControl;
try { ({ createAppControl } = require('../electron/app-control.cjs')); } catch (error) { if (error.code !== 'MODULE_NOT_FOUND') throw error; }
const program = String.raw`C:\Program Files\Example\app.exe`;
function peImage() {
    const bytes = Buffer.alloc(512);
    bytes.write('MZ'); bytes.writeUInt32LE(128, 60); bytes.write('PE\0\0', 128);
    bytes.writeUInt16LE(0x8664, 132); bytes.writeUInt16LE(1, 134);
    bytes.writeUInt16LE(240, 148); bytes.writeUInt16LE(2, 150); bytes.writeUInt16LE(0x20b, 152);
    return bytes;
}
function harness(overrides = {}) {
    const calls = [];
    const image = overrides.image ?? peImage();
    const io = {
        realpath: async p => p,
        open: async () => ({
            stat: async () => ({ isFile: () => true, size: image.length }),
            read: async (buffer, offset, length, position) => { const n = image.copy(buffer, offset, position, position + length); return { bytesRead: n }; },
            close: async () => {}
        })
    };
    const runner = async (...args) => { calls.push(args); return { stdout: JSON.stringify({ Status: 'Succeeded', Path: program, State: { Path: program, Blocked: null, FirewallErrorCode: 'FirewallQueryFailed', Throttled: false }, Warning: 'scope warning' }) }; };
    return { calls, control: createAppControl({ platform: 'win32', io, runner, ...overrides }) };
}
function decode(call) {
    const [exe, args, options] = call;
    assert.match(exe, /System32[\\/]WindowsPowerShell[\\/]v1\.0[\\/]powershell\.exe$/i);
    assert.equal(options.shell, false); assert.equal(options.windowsHide, true);
    assert.ok(options.timeout > 120000);
    assert.deepEqual(args.slice(0, -1), ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand']);
    const script = Buffer.from(args.at(-1), 'base64').toString('utf16le');
    const encoded = script.match(/FromBase64String\('([A-Za-z0-9+/=]+)'\)/)[1];
    return { script, data: JSON.parse(Buffer.from(encoded, 'base64').toString('utf8')) };
}
test('exports factory', () => assert.equal(typeof createAppControl, 'function'));
test('unsupported platforms never launch or open a picker', async () => {
    for (const platform of ['linux', 'darwin']) {
        const { control, calls } = harness({ platform, dialog: { showOpenDialog: () => assert.fail('picker') } });
        assert.equal((await control.chooseProgram()).error.code, 'unsupported');
        for (const action of ['read', 'block', 'unblock', 'throttle', 'unthrottle']) assert.equal((await control.request({ action, path: program, uploadKBps: 1 })).error.code, 'unsupported');
        assert.equal(calls.length, 0);
    }
});
test('actions use fixed commands and decimal KB/s conversion without background work', async () => {
    const { control, calls } = harness();
    assert.equal(calls.length, 0);
    for (const action of ['read', 'block', 'unblock', 'throttle', 'unthrottle']) {
        const response = await control.request({ action, path: program, ...(action === 'throttle' ? { uploadKBps: 12.5 } : {}) });
        assert.equal(response.ok, true);
        const { script, data } = decode(calls.at(-1));
        assert.equal(data.Action, action === 'read' ? 'Read' : action[0].toUpperCase() + action.slice(1));
        assert.equal(data.UploadKbps, action === 'throttle' ? 100 : 0);
        assert.match(script, /Get-MeterAppNetworkState/); assert.match(script, /Receive-MeterAppNetworkAction/);
        assert.equal(response.result.state.Blocked, null);
    }
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.equal(calls.length, 5);
});
test('hostile but valid filename remains data, never script text', async () => {
    const path = String.raw`C:\中文 空格\x'; Write-Output INJECTED; #.exe`;
    const { control, calls } = harness();
    await control.request({ action: 'block', path });
    const { script, data } = decode(calls[0]);
    assert.equal(data.Path, path); assert.equal(script.includes('INJECTED'), false);
});
test('rejects invalid parameters before launching', async () => {
    const { control, calls } = harness();
    const bad = [null, [], {}, { action: 'Block', path: program }, { action: 'read', path: program, script: 'evil' }];
    for (const path of ['app.exe', 'C:app.exe', 'C:\\x.ps1', 'C:\\x.exe:evil.exe', '\\\\host\\x.exe', 'C:/x.exe', 'C:\\bad.\\x.exe', 'C:\\x*.exe', 'C:\\x\n.exe', 'C:\\x.exe\\']) bad.push({ action: 'read', path });
    for (const uploadKBps of [undefined, null, '1', 0, -1, NaN, Infinity, 0.01, 125000001]) bad.push({ action: 'throttle', path: program, uploadKBps });
    bad.push({ action: 'read', path: program, uploadKBps: 1 });
    for (const input of bad) assert.equal((await control.request(input)).error?.code, 'invalidRequest', JSON.stringify(input));
    assert.equal(calls.length, 0);
});
test('rejects renamed scripts, DLLs, directories and missing files', async () => {
    const dll = peImage(); dll.writeUInt16LE(0x2002, 150);
    for (const image of [Buffer.from('Write-Host malicious'), dll, Buffer.from('MZ')]) {
        const { control, calls } = harness({ image });
        assert.equal((await control.request({ action: 'read', path: program })).error.code, 'invalidProgram');
        assert.equal(calls.length, 0);
    }
    const { control, calls } = harness({ io: { realpath: async () => { throw Error('not found'); } } });
    assert.equal((await control.request({ action: 'read', path: program })).error.code, 'invalidProgram');
    assert.equal(calls.length, 0);
});
test('picker cancel does not launch; selection validates and reads once', async () => {
    let canceled = true;
    const window = {};
    const { control, calls } = harness({ getWindow: () => window, dialog: { showOpenDialog: async (owner, options) => {
        assert.equal(owner, window); assert.deepEqual(options.filters[0].extensions, ['exe']);
        return { canceled, filePaths: canceled ? [] : [program] };
    } } });
    assert.equal((await control.chooseProgram()).canceled, true); assert.equal(calls.length, 0);
    canceled = false;
    assert.equal((await control.chooseProgram()).result.path, program); assert.equal(calls.length, 1);
});
test('UAC cancellation, failed verification and partial state survive protocol', async () => {
    for (const [Status, ErrorCode] of [['Cancelled', 'UacCancelled'], ['Failed', 'VerificationFailed'], ['Failed', 'HelperTimeout']]) {
        const State = { Blocked: null, FirewallError: 'access denied', Throttled: true };
        const { control } = harness({ runner: async () => ({ stdout: JSON.stringify({ Status, ErrorCode, Error: 'detail', State, Path: program }) }) });
        const response = await control.request({ action: 'block', path: program });
        assert.equal(response.ok, false); assert.equal(response.canceled, Status === 'Cancelled');
        assert.equal(response.error.code, ErrorCode); assert.deepEqual(response.result.state, State);
    }
});
test('malformed output and runner failures are explicit, never success', async () => {
    for (const stdout of ['', 'noise\n{}', '{}', 'null', '{"Status":"Running"}', '{"Status":"Succeeded"}']) {
        const { control } = harness({ runner: async () => ({ stdout }) });
        assert.equal((await control.request({ action: 'read', path: program })).error.code, 'invalidResponse');
    }
    for (const killed of [false, true]) {
        const { control } = harness({ runner: async () => { throw Object.assign(Error('failed'), { killed }); } });
        assert.equal((await control.request({ action: 'block', path: program })).error.code, killed ? 'timeout' : 'runnerFailed');
    }
});
