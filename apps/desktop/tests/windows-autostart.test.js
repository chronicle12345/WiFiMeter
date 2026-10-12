import test from 'node:test';
import assert from 'node:assert/strict';
import { createNativeAdapter } from '../tauri/native-adapter.cjs';
import { createSystemIntegration } from '../host/system.cjs';

const appExe = 'C:\\Program Files\\WiFiMeter\\WiFiMeter.exe';
const command = `"${appExe}"`;
const runKey = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';
const approvedKey = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\StartupApproved\\Run';
const approvalEnabled = '020000000000000000000000';
const approvalDisabled = '030000000000000000000000';
const names = ['WiFiMeter', 'io.wifimeter.demo'];
const oldCommands = [command, `${command} --tray`, `${command} --background`];
const unrelated = ['OtherApp', '"C:\\Program Files\\Other App\\other.exe"'];
const englishMissing = 'ERROR: The system was unable to find the specified registry key or value.';
const cp936Missing = Buffer.from('b4edcef33a20cfb5cdb3d5d2b2bbb5bdd6b8b6a8b5c4d7a2b2e1b1edcfeebbf2d6b5a1a30d0d0a', 'hex');
const cp936Denied = Buffer.from('b4edcef33a20bedcbef8b7c3cecaa1a30d0d0a', 'hex');

function fixture(t, entries = [], { rejectAdd = false, ignoreAdd = false, rejectApprovalAdd = false, ignoreApprovalAdd = false,
    approvals = [], missingError = englishMissing, queryError = null, bufferQueries = false,
    executable: actualExecutable = appExe, codePage = 936, fallback = false, fallbackError = null, queryOutput = null } = {}) {
    const command = `"${actualExecutable}"`;
    const registry = new Map(entries);
    const approval = new Map(approvals);
    const calls = [], boundaryErrors = [], codePageReads = [], fallbackReads = [];
    const execute = (executable, args, options) => {
        // 严格限定外部命令边界，替身不得放行其他键、值名称或系统命令。
        try {
            assert.equal(options.windowsHide, true);
            assert.notEqual(options.shell, true);
            assert.ok(options.stdio === 'pipe' || JSON.stringify(options.stdio) === '["ignore","pipe","pipe"]');
            if (executable === 'chcp.com') {
                assert.ok(bufferQueries || Buffer.isBuffer(missingError) || Buffer.isBuffer(queryError?.stderr));
                assert.deepEqual(args, []);
                codePageReads.push({ executable, args });
                return Buffer.from(`Active code page: ${codePage}\r\n`);
            }
            if (executable.toLowerCase().endsWith('\\powershell.exe')) {
                assert.ok(fallback, '正常中英文读取不得增加 PowerShell 子进程');
                assert.deepEqual(args.slice(0, 4), ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand']);
                assert.equal(args.length, 5);
                assert.equal(options.encoding, 'utf8');
                const script = Buffer.from(args[4], 'base64').toString('utf16le');
                assert.doesNotMatch(script, /SetValue|DeleteValue|CreateSubKey|Remove-Item|Set-Item/i);
                assert.match(script, /OpenSubKey\([^,]+,\s*\$false\)/);
                assert.match(script, /OutputEncoding/);
                const encoded = script.match(/FromBase64String\('([A-Za-z0-9+/=]+)'\)/)?.[1];
                assert.ok(encoded);
                const request = JSON.parse(Buffer.from(encoded, 'base64').toString('utf8'));
                assert.ok([runKey, approvedKey].includes(request.key));
                assert.ok(names.includes(request.name));
                assert.equal(request.type, request.key === runKey ? 'REG_SZ' : 'REG_BINARY');
                fallbackReads.push(request);
                if (fallbackError) throw fallbackError;
                const values = request.key === runKey ? registry : approval;
                return JSON.stringify({ found: values.has(request.name), value: values.get(request.name) ?? null });
            }
            assert.equal(executable, 'reg.exe');
            assert.ok([runKey, approvedKey].includes(args[1]));
            const operation = args[0];
            assert.ok(['query', 'add', 'delete'].includes(operation));
            assert.equal(args[2], '/v');
            const name = args[3];
            assert.ok(names.includes(name));
            if (operation === 'query') {
                assert.deepEqual(args, ['query', args[1], '/v', name]);
            } else if (operation === 'add') {
                if (args[1] === runKey) {
                    assert.deepEqual(args, ['add', runKey, '/v', name, '/t', 'REG_SZ', '/d', command, '/f']);
                } else {
                    assert.deepEqual(args.slice(0, 7), ['add', approvedKey, '/v', name, '/t', 'REG_BINARY', '/d']);
                    assert.match(args[7], /^[0-9a-f]{24}$/i);
                    assert.deepEqual(args.slice(8), ['/f']);
                }
                assert.equal(name, 'WiFiMeter');
            } else {
                assert.deepEqual(args, ['delete', args[1], '/v', name, '/f']);
            }
        } catch (error) {
            if (error !== fallbackError) boundaryErrors.push(error);
            throw error;
        }
        const [operation, key, , name] = args;
        const store = key === runKey ? registry : approval;
        calls.push({ operation, key, name, value: store.get(name) });
        if (operation === 'query') {
            if (queryError?.key === key && queryError?.name === name) throw Object.assign(Error('Registry query failed.'), { status: 1, stderr: queryError.stderr });
            if (!store.has(name)) throw Object.assign(Error('Registry value does not exist.'), { status: 1, stderr: missingError });
            const output = `\r\n${key}\r\n    ${name}    ${key === runKey ? 'REG_SZ' : 'REG_BINARY'}    ${store.get(name)}\r\n`;
            if (queryOutput) return queryOutput(output, { key, name });
            return bufferQueries ? Buffer.from(output) : output;
        }
        if (operation === 'add') {
            if (rejectAdd || (key === approvedKey && rejectApprovalAdd)) throw Object.assign(Error('ERROR: Access is denied.'), { status: 1, stderr: 'ERROR: Access is denied.' });
            if (!ignoreAdd && !(key === approvedKey && ignoreApprovalAdd)) store.set(name, args[7]);
        } else {
            if (!store.delete(name)) throw Object.assign(Error('Registry value does not exist.'), { status: 1 });
        }
        return 'The operation completed successfully.\r\n';
    };
    const native = createNativeAdapter({
        configuration: { platform: 'win32', appExe: actualExecutable, isPackaged: true, userData: 'fixture' },
        send() { assert.fail('自启动操作不得调用原生窗口、对话框或通知'); },
        execute,
        executeAsync() { assert.fail('自启动操作不得启动其他外部进程'); }
    });
    t.after(() => assert.deepEqual(boundaryErrors, [], '系统命令必须符合注册表替身限定的边界'));
    const mutations = () => calls.filter(call => call.operation !== 'query');
    return { app: native.app, registry, approval, calls, mutations, codePageReads, fallbackReads };
}

for (const name of names) {
    for (const value of oldCommands) {
        test(`读取 ${name} 的 ${value} 登记时识别为已开启`, t => {
            const { app, mutations } = fixture(t, [[name, value], unrelated]);
            assert.deepEqual(app.getLoginItemSettings(), { openAtLogin: true, executableWillLaunchAtLogin: true });
            assert.deepEqual(mutations(), []);
        });
    }
}

for (const current of oldCommands) {
    for (const legacy of oldCommands) {
        test(`开启自启动合并 ${current} 与 ${legacy} 为唯一标准登记`, t => {
            const { app, registry, calls, mutations } = fixture(t, [['WiFiMeter', current], ['io.wifimeter.demo', legacy], unrelated]);
            app.setLoginItemSettings({ openAtLogin: true });
            assert.deepEqual(registry, new Map([['WiFiMeter', command], unrelated]));
            assert.deepEqual(app.getLoginItemSettings(), { openAtLogin: true, executableWillLaunchAtLogin: true });
            const addIndex = calls.findIndex(call => call.operation === 'add');
            const deleteIndex = calls.findIndex(call => call.operation === 'delete');
            assert.ok(deleteIndex >= 0);
            if (current === command) {
                assert.equal(addIndex, -1, '已有标准登记时不得再次写入');
            } else {
                assert.ok(addIndex >= 0 && addIndex < deleteIndex, '清理旧项前必须建立标准登记');
                assert.ok(calls.slice(addIndex + 1, deleteIndex).some(call => call.operation === 'query' && call.name === 'WiFiMeter' && call.value === command),
                    '清理旧项前必须确认标准登记写入成功');
            }
            const completedMutations = mutations().length;
            app.setLoginItemSettings({ openAtLogin: true });
            assert.equal(mutations().length, completedMutations, '重复开启不得重复写入或清理');
        });
    }
}

for (const legacy of oldCommands) {
    test(`仅有旧名称 ${legacy} 时开启自启动迁移为标准登记`, t => {
        const { app, registry, calls, mutations } = fixture(t, [['io.wifimeter.demo', legacy], unrelated]);
        app.setLoginItemSettings({ openAtLogin: true });
        assert.deepEqual(registry, new Map([unrelated, ['WiFiMeter', command]]));
        assert.deepEqual(mutations().map(call => [call.operation, call.name]), [['add', 'WiFiMeter'], ['delete', 'io.wifimeter.demo']]);
        const addIndex = calls.findIndex(call => call.operation === 'add');
        const deleteIndex = calls.findIndex(call => call.operation === 'delete');
        assert.ok(calls.slice(addIndex + 1, deleteIndex).some(call => call.operation === 'query' && call.name === 'WiFiMeter' && call.value === command),
            '清理唯一旧项前必须确认新登记可用');
        assert.equal(app.getLoginItemSettings().openAtLogin, true);
    });
}

for (const current of oldCommands) {
    for (const legacy of oldCommands) {
        test(`关闭自启动移除 ${current} 与 ${legacy} 两种本程序登记`, t => {
            const { app, registry, mutations } = fixture(t, [['WiFiMeter', current], ['io.wifimeter.demo', legacy], unrelated]);
            app.setLoginItemSettings({ openAtLogin: false });
            assert.deepEqual(registry, new Map([unrelated]));
            assert.deepEqual(app.getLoginItemSettings(), { openAtLogin: false, executableWillLaunchAtLogin: false });
            assert.deepEqual(mutations().map(call => [call.operation, call.name]).sort(), [['delete', 'WiFiMeter'], ['delete', 'io.wifimeter.demo']]);
            const completedMutations = mutations().length;
            app.setLoginItemSettings({ openAtLogin: false });
            assert.equal(mutations().length, completedMutations, '重复关闭不得再次删除登记');
        });
    }
}

const foreignCommands = [
    '"C:\\Program Files\\Other App\\other.exe"',
    '"C:\\Program Files\\WiFiMeter Other\\WiFiMeter.exe" --tray',
    `${command} --inspect`,
    `${command} --tray --unknown`,
    `${command} --background=1`
];

for (const value of foreignCommands) {
    test(`读取和关闭保留其他路径或未知参数：${value}`, t => {
        const original = [['WiFiMeter', value], ['io.wifimeter.demo', value], unrelated];
        const { app, registry, mutations } = fixture(t, original);
        assert.deepEqual(app.getLoginItemSettings(), { openAtLogin: false, executableWillLaunchAtLogin: false });
        app.setLoginItemSettings({ openAtLogin: false });
        assert.deepEqual(registry, new Map(original));
        assert.deepEqual(mutations(), []);
    });

    test(`标准名称已被其他路径或未知参数使用时报告失败并保留登记：${value}`, t => {
        const original = [['WiFiMeter', value], ['io.wifimeter.demo', `${command} --tray`], unrelated];
        const { app, registry, mutations } = fixture(t, original);
        assert.throws(() => app.setLoginItemSettings({ openAtLogin: true }));
        assert.deepEqual(registry, new Map(original));
        assert.deepEqual(mutations(), []);
    });

    test(`开启自启动时保留旧名称下其他路径或未知参数：${value}`, t => {
        const { app, registry } = fixture(t, [['io.wifimeter.demo', value], unrelated]);
        app.setLoginItemSettings({ openAtLogin: true });
        assert.deepEqual(registry, new Map([['io.wifimeter.demo', value], unrelated, ['WiFiMeter', command]]));
        assert.equal(app.getLoginItemSettings().openAtLogin, true);
    });

    test(`关闭自启动只移除本程序登记，保留另一名称下未知登记：${value}`, t => {
        const { app, registry, mutations } = fixture(t, [['WiFiMeter', value], ['io.wifimeter.demo', `${command} --background`], unrelated]);
        app.setLoginItemSettings({ openAtLogin: false });
        assert.deepEqual(registry, new Map([['WiFiMeter', value], unrelated]));
        assert.deepEqual(mutations().map(call => [call.operation, call.name]), [['delete', 'io.wifimeter.demo']]);
    });
}

for (const failure of ['rejectAdd', 'ignoreAdd']) {
    test(`标准登记${failure === 'rejectAdd' ? '写入遭系统拒绝' : '验证未生效'}时保留旧项并报告失败`, t => {
        const original = [['io.wifimeter.demo', `${command} --background`], unrelated];
        const { app, registry, mutations } = fixture(t, original, { [failure]: true });
        assert.throws(() => app.setLoginItemSettings({ openAtLogin: true }));
        assert.deepEqual(registry, new Map(original));
        assert.deepEqual(mutations().map(call => call.operation), ['add'], '写入失败不得先清理可用旧项');
        assert.equal(app.getLoginItemSettings().openAtLogin, true, '失败后原有启动登记仍可用');
    });

    for (const current of oldCommands.slice(1)) {
        test(`已有 ${current} 时标准登记${failure === 'rejectAdd' ? '写入遭系统拒绝' : '验证未生效'}保留全部旧项`, t => {
            const original = [['WiFiMeter', current], ['io.wifimeter.demo', `${command} --tray`], unrelated];
            const { app, registry, mutations } = fixture(t, original, { [failure]: true });
            assert.throws(() => app.setLoginItemSettings({ openAtLogin: true }));
            assert.deepEqual(registry, new Map(original));
            assert.deepEqual(mutations().map(call => call.operation), ['add']);
            assert.equal(app.getLoginItemSettings().openAtLogin, true);
        });
    }
}

test('无启动登记时正常开启和关闭，多次切换不重复 add 或 delete', t => {
    const { app, registry, mutations } = fixture(t, [unrelated]);
    assert.equal(app.getLoginItemSettings().openAtLogin, false);
    app.setLoginItemSettings({ openAtLogin: false });
    assert.deepEqual(mutations(), []);
    app.setLoginItemSettings({ openAtLogin: true });
    app.setLoginItemSettings({ openAtLogin: true });
    assert.deepEqual(registry, new Map([unrelated, ['WiFiMeter', command]]));
    assert.deepEqual(mutations().map(call => call.operation), ['add']);
    app.setLoginItemSettings({ openAtLogin: false });
    app.setLoginItemSettings({ openAtLogin: false });
    assert.deepEqual(registry, new Map([unrelated]));
    assert.deepEqual(mutations().map(call => call.operation), ['add', 'delete']);
});

for (const name of names) {
    test(`StartupApproved 禁用 ${name} 时读取为未开启且不修改登记`, t => {
        const original = [[name, command], unrelated];
        const { app, registry, approval, mutations } = fixture(t, original, { approvals: [[name, approvalDisabled]] });
        assert.deepEqual(app.getLoginItemSettings(), { openAtLogin: false, executableWillLaunchAtLogin: false });
        assert.deepEqual(registry, new Map(original));
        assert.deepEqual(approval, new Map([[name, approvalDisabled]]));
        assert.deepEqual(mutations(), []);
    });

    test(`StartupApproved 允许 ${name} 时读取为已开启`, t => {
        const { app, mutations } = fixture(t, [[name, command]], { approvals: [[name, approvalEnabled]] });
        assert.deepEqual(app.getLoginItemSettings(), { openAtLogin: true, executableWillLaunchAtLogin: true });
        assert.deepEqual(mutations(), []);
    });
}

for (const legacy of oldCommands) {
    test(`设置同步迁移被禁用的旧项 ${legacy} 时保留用户禁用选择`, t => {
        const { app, registry, approval } = fixture(t, [['io.wifimeter.demo', legacy], unrelated], {
            approvals: [['io.wifimeter.demo', approvalDisabled]]
        });
        app.setLoginItemSettings({ openAtLogin: true });
        assert.deepEqual(registry, new Map([unrelated, ['WiFiMeter', command]]));
        assert.match(approval.get('WiFiMeter'), /^03[0-9a-f]{22}$/i);
        assert.deepEqual(app.getLoginItemSettings(), { openAtLogin: false, executableWillLaunchAtLogin: false });
    });
}

for (const current of oldCommands) {
    test(`设置同步已有被禁用的 ${current} 时保留批准状态`, t => {
        const { app, registry, approval } = fixture(t, [['WiFiMeter', current], unrelated], {
            approvals: [['WiFiMeter', approvalDisabled]]
        });
        app.setLoginItemSettings({ openAtLogin: true });
        assert.deepEqual(registry, new Map([['WiFiMeter', command], unrelated]));
        assert.deepEqual(approval, new Map([['WiFiMeter', approvalDisabled]]));
        assert.deepEqual(app.getLoginItemSettings(), { openAtLogin: false, executableWillLaunchAtLogin: false });
    });
}

test('显式 enabled 选项可以恢复或禁用已有登记的 Windows 批准状态', t => {
    const { app, registry, approval } = fixture(t, [['WiFiMeter', command]], { approvals: [['WiFiMeter', approvalDisabled]] });
    app.setLoginItemSettings({ openAtLogin: true, enabled: true });
    assert.equal(app.getLoginItemSettings().openAtLogin, true);
    assert.ok(!approval.has('WiFiMeter') || /^02[0-9a-f]{22}$/i.test(approval.get('WiFiMeter')));
    app.setLoginItemSettings({ openAtLogin: true, enabled: false });
    assert.equal(app.getLoginItemSettings().openAtLogin, false);
    assert.match(approval.get('WiFiMeter'), /^03[0-9a-f]{22}$/i);
    assert.deepEqual(registry, new Map([['WiFiMeter', command]]));
});

for (const failure of ['rejectApprovalAdd', 'ignoreApprovalAdd']) {
    test(`迁移禁用旧项时批准记录${failure === 'rejectApprovalAdd' ? '写入被拒绝' : '验证未生效'}保留旧 Run`, t => {
        const original = [['io.wifimeter.demo', `${command} --tray`], unrelated];
        const originalApproval = [['io.wifimeter.demo', approvalDisabled]];
        const { app, registry, approval, mutations } = fixture(t, original, { approvals: originalApproval, [failure]: true });
        assert.throws(() => app.setLoginItemSettings({ openAtLogin: true }));
        assert.deepEqual(registry, new Map(original));
        assert.deepEqual(approval, new Map(originalApproval));
        assert.deepEqual(mutations().filter(call => call.key === runKey), [], '批准记录未验证成功不得建立或清理 Run 登记');
        assert.deepEqual(app.getLoginItemSettings(), { openAtLogin: false, executableWillLaunchAtLogin: false });
    });
}

test('标准登记被禁用但旧名称仍启用时合并后保留唯一可启动登记', t => {
    const { app, registry, approval } = fixture(t, [['WiFiMeter', command], ['io.wifimeter.demo', `${command} --background`], unrelated], {
        approvals: [['WiFiMeter', approvalDisabled], ['io.wifimeter.demo', approvalEnabled]]
    });
    assert.equal(app.getLoginItemSettings().openAtLogin, true);
    app.setLoginItemSettings({ openAtLogin: true });
    assert.deepEqual(registry, new Map([['WiFiMeter', command], unrelated]));
    assert.ok(!approval.has('WiFiMeter') || /^02[0-9a-f]{22}$/i.test(approval.get('WiFiMeter')));
    assert.deepEqual(app.getLoginItemSettings(), { openAtLogin: true, executableWillLaunchAtLogin: true });
});

test('CP936 的 reg.exe 缺失值错误 Buffer 按系统代码页处理，可以正常开启自启动', t => {
    const { app, registry, codePageReads } = fixture(t, [unrelated], { missingError: cp936Missing, bufferQueries: true });
    assert.equal(app.getLoginItemSettings().openAtLogin, false);
    app.setLoginItemSettings({ openAtLogin: true });
    assert.deepEqual(registry, new Map([unrelated, ['WiFiMeter', command]]));
    assert.deepEqual(app.getLoginItemSettings(), { openAtLogin: true, executableWillLaunchAtLogin: true });
    assert.ok(codePageReads.length > 0, '非 ASCII 错误 Buffer 必须查询系统代码页');
});

test('CP936 的 reg.exe 拒绝访问错误 Buffer 必须报错且不得覆盖已有登记', t => {
    const original = [['WiFiMeter', '"C:\\Program Files\\Other App\\other.exe"'], ['io.wifimeter.demo', `${command} --tray`], unrelated];
    const { app, registry, mutations } = fixture(t, original, {
        queryError: { key: runKey, name: 'WiFiMeter', stderr: cp936Denied }, bufferQueries: true
    });
    assert.throws(() => app.setLoginItemSettings({ openAtLogin: true }));
    assert.deepEqual(registry, new Map(original));
    assert.deepEqual(mutations(), []);
});

for (const codePage of [437, 850]) test(`不支持的 OEM ${codePage} 使用只读 Unicode 查询，非 ASCII 路径能迁移`, t => {
    const executable = 'C:\\Users\\José\\WiFiMeter.exe';
    const canonical = `"${executable}"`;
    const { app, registry, approval, codePageReads, fallbackReads } = fixture(t, [
        ['io.wifimeter.demo', `${canonical} --tray`]
    ], { executable, codePage, bufferQueries: true, fallback: true,
        approvals: [['io.wifimeter.demo', approvalDisabled]] });
    assert.equal(app.getLoginItemSettings().openAtLogin, false);
    assert.equal(app.setLoginItemSettings({ openAtLogin: true }).openAtLogin, false);
    assert.deepEqual(registry, new Map([['WiFiMeter', canonical]]));
    assert.equal(approval.get('WiFiMeter'), approvalDisabled);
    assert.equal(codePageReads.length, 1, '不支持的代码页也只查询一次');
    assert.ok(fallbackReads.length > 0);
});

test('未知语言的缺失值通过只读查询确认，首次开启不被误判为权限错误', t => {
    const { app, registry, fallbackReads } = fixture(t, [], { fallback: true,
        missingError: 'FEHLER: Der angegebene Registrierungsschlüssel bzw. Wert wurde nicht gefunden.' });
    assert.equal(app.setLoginItemSettings({ openAtLogin: true }).openAtLogin, true);
    assert.deepEqual(registry, new Map([['WiFiMeter', command]]));
    assert.ok(fallbackReads.length > 0);
});

test('未知语言的拒绝访问在只读回退中仍报错，不能当作缺失值覆盖', t => {
    const original = [['WiFiMeter', '"C:\\Other\\WiFiMeter.exe"']];
    const denied = Object.assign(Error('Registry read denied.'), { status: 1, stderr: 'Access is denied.' });
    const { app, registry, mutations, fallbackReads } = fixture(t, original, { fallback: true,
        queryError: { key: runKey, name: 'WiFiMeter', stderr: 'FEHLER: Zugriff verweigert.' }, fallbackError: denied });
    assert.throws(() => app.setLoginItemSettings({ openAtLogin: true }), /Registry read denied/);
    assert.deepEqual(registry, new Map(original));
    assert.deepEqual(mutations(), []);
    assert.equal(fallbackReads.length, 1);
});

for (const channel of ['stdout', 'stderr']) test(`CLI 输出恢复：无效 UTF-8 ${channel} 通过只读 Unicode 查询恢复`, t => {
    const settings = { codePage: 65001, bufferQueries: true, fallback: true };
    if (channel === 'stdout') settings.queryOutput = output => Buffer.concat([Buffer.from(output), Buffer.from([0xff])]);
    else settings.queryError = { key: runKey, name: 'WiFiMeter', stderr: Buffer.from([0xff]) };
    const { app, registry, mutations, fallbackReads } = fixture(t, [['WiFiMeter', command]], settings);
    assert.equal(app.getLoginItemSettings().openAtLogin, true);
    assert.deepEqual(registry, new Map([['WiFiMeter', command]]));
    assert.deepEqual(mutations(), []);
    assert.equal(fallbackReads.length, 1);
});

test('CLI 输出恢复：替身将不可表示路径替换为问号时核对原值后识别本程序', t => {
    const executable = 'C:\\Users\\A😀\\WiFiMeter.exe';
    const canonical = `"${executable}"`;
    const { app, registry, codePageReads, fallbackReads } = fixture(t, [['WiFiMeter', canonical]], {
        executable, fallback: true, queryOutput: output => Buffer.from(output.replaceAll('😀', '?'))
    });
    assert.equal(app.getLoginItemSettings().openAtLogin, true);
    app.setLoginItemSettings({ openAtLogin: false });
    assert.equal(registry.size, 0);
    assert.equal(codePageReads.length, 0, 'ASCII 问号替代输出无需查询代码页');
    assert.ok(fallbackReads.length > 0);
});

test('CLI 输出恢复：核对含真实问号的 URI 参数后仍保留未知命令', t => {
    const original = [['WiFiMeter', `${command} --url https://example.test/?mode=fixture`]];
    const { app, registry, mutations, fallbackReads } = fixture(t, original, { fallback: true });
    assert.equal(app.getLoginItemSettings().openAtLogin, false);
    app.setLoginItemSettings({ openAtLogin: false });
    assert.throws(() => app.setLoginItemSettings({ openAtLogin: true }), /其他路径或参数/);
    assert.deepEqual(registry, new Map(original));
    assert.deepEqual(mutations(), []);
    assert.ok(fallbackReads.length > 0);
});

test('规范登记未变时设置同步仅查询两项 Run 和一次批准状态', async t => {
    const { app, calls, mutations } = fixture(t, [['WiFiMeter', command]], {
        approvals: [['WiFiMeter', approvalEnabled]]
    });
    const integration = createSystemIntegration({ app, platform: 'win32', getWindow: () => null });
    const result = await integration.applySettings({ autoStart: true });
    assert.equal(result.autoStart, true);
    assert.equal(calls.length, 3, '本次读取已确认状态后不得再次查询');
    assert.deepEqual(mutations(), []);
});

test('两次设置同步之间 Windows 禁用启动项时重新读取并保留禁用选择', async t => {
    const { app, approval, calls, mutations } = fixture(t, [['WiFiMeter', command]], {
        approvals: [['WiFiMeter', approvalEnabled]]
    });
    const integration = createSystemIntegration({ app, platform: 'win32', getWindow: () => null });
    assert.equal((await integration.applySettings({ autoStart: true })).autoStart, true);
    const firstQueryCount = calls.length;
    approval.set('WiFiMeter', approvalDisabled);
    const result = await integration.applySettings({ notifications: false });
    assert.equal(result.autoStart, false, '不得使用上次同步的启用状态');
    assert.equal(calls.length - firstQueryCount, 3, '每次同步都重新读取实际登记和批准状态');
    assert.equal(approval.get('WiFiMeter'), approvalDisabled);
    assert.deepEqual(mutations(), []);
});
