// 系统级功能的单元测试：用假的 Electron 接口验证自启动文件、托盘开关、窗口关闭与通知。
// 这样不必启动图形界面也能覆盖分支。

import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';

import { createSystemIntegration, autostartFile } from '../electron/system.cjs';
import { createNativeAdapter } from '../tauri/native-adapter.cjs';

for (const requested of [false, true]) test(`autostart regression: rejected ${requested ? 'enable' : 'disable'} reports the actual state and a retryable error`, async () => {
    const actual = !requested;
    const app = {
        setLoginItemSettings() { throw Object.assign(Error('Access is denied.'), { code: 'EACCES' }); },
        getLoginItemSettings: () => ({ openAtLogin: actual })
    };
    const integration = createSystemIntegration({ app, platform: 'win32', getWindow: () => null });
    const result = await integration.applySettings({ autoStart: requested });
    assert.equal(result.autoStart, actual);
    assert.match(result.autoStartError, /Access is denied/);
    app.setLoginItemSettings = () => ({ openAtLogin: requested });
    const retried = await integration.applySettings({ autoStart: requested });
    assert.equal(retried.autoStart, requested);
    assert.equal(retried.autoStartError, undefined);
});

test('autostart regression: unreadable status after a failed disable still reports an explicit error', async () => {
    const integration = createSystemIntegration({ platform: 'win32', getWindow: () => null, app: {
        setLoginItemSettings() { throw Error('Cannot remove startup entry.'); },
        getLoginItemSettings() { throw Error('Cannot read startup entry.'); }
    } });
    const result = await integration.applySettings({ autoStart: false });
    assert.match(result.autoStartError, /Cannot remove startup entry/);
});

for (const executable of ['/home/fixture/My Apps/WiFiMeter.AppImage', '/home/fixture/cash$"tick`\\100%/WiFiMeter.AppImage']) {
    test(`autostart regression: Desktop Entry quoting restores one executable argument for ${executable}`, async () => {
        const require = createRequire(import.meta.url), module = { exports: {} }, files = new Map();
        runInNewContext(readFileSync(new URL('../electron/system.cjs', import.meta.url), 'utf8'), {
            module, process: { env: { APPIMAGE: executable }, execPath: '/usr/bin/node', platform: 'linux' },
            require: name => name === 'node:fs/promises' ? {
                async readFile(file) { if (files.has(file)) return files.get(file); throw Object.assign(Error('missing'), { code: 'ENOENT' }); },
                async mkdir() {}, async writeFile(file, content) { files.set(file, content); },
                async rm() { assert.fail('this regression only enables autostart'); }
            } : require(name)
        });
        const integration = module.exports.createSystemIntegration({ platform: 'linux', app: { getPath: () => 'fixture-home' }, getWindow: () => null });
        assert.equal((await integration.applySettings({ autoStart: true })).autoStart, true);
        const exec = [...files.values()][0].split(/\r?\n/).find(line => line.startsWith('Exec=')).slice(5);
        assert.ok(exec.startsWith('"') && exec.endsWith('"'), '路径必须作为一个带引号参数');
        // Desktop Entry 先解析字符串转义，再取消 Exec 引号，最后处理字面百分号。
        const decoded = exec.replace(/\\(s|n|t|r|\\)/g, (_, value) => ({ s: ' ', n: '\n', t: '\t', r: '\r', '\\': '\\' })[value]);
        const argument = decoded.slice(1, -1).replace(/\\(["`$\\])/g, '$1').replace(/%%/g, '%');
        assert.equal(argument, executable);
    });
}

function createFakes({ trayThrows = false, notificationSupported = true, appOverride, backgroundTest = false } = {}) {
    const home = mkdtempSync(path.join(os.tmpdir(), 'wifimeter-system-'));
    const state = { tray: null, trayCount: 0, destroyed: 0, notifications: [], notificationsShown: 0, notificationSupportChecks: 0, shown: 0, hidden: 0, menu: null };

    class FakeTray {
        constructor() {
            if (trayThrows) throw new Error('没有状态栏');
            state.trayCount += 1;
            state.tray = this;
        }
        setToolTip() {}
        setContextMenu(menu) {
            state.menu = menu;
        }
        on() {}
        destroy() {
            state.destroyed += 1;
        }
    }

    class FakeNotification {
        constructor(options) {
            state.notifications.push(options);
        }
        show() { state.notificationsShown += 1; }
        static isSupported() {
            state.notificationSupportChecks += 1;
            return notificationSupported;
        }
    }

    const window = {
        hidden: false,
        show() {},
        focus() {},
        isMinimized() {
            return false;
        },
        restore() {},
        hide() {
            state.hidden += 1;
        },
        isDestroyed() {
            return false;
        }
    };

    const app = appOverride || {
        getPath: () => home,
        quit() {}
    };

    const integration = createSystemIntegration({
        app,
        Tray: FakeTray,
        Menu: { buildFromTemplate: template => ({ template }) },
        Notification: FakeNotification,
        nativeImage: { createFromPath: () => ({}) },
        getWindow: () => window,
        iconPath: '/tmp/icon.png',
        platform: 'linux',
        backgroundTest,
        logger: () => {}
    });

    return { home, state, integration, app, window };
}

test('开机启动写入并移除自启动文件', async () => {
    const { home, integration } = createFakes();
    const file = autostartFile(home);

    const on = await integration.applySettings({ autoStart: true });
    assert.equal(on.autoStart, true);
    assert.ok(existsSync(file), '应当写出 .desktop 文件');
    const text = readFileSync(file, 'utf8');
    assert.match(text, /\[Desktop Entry\]/);
    assert.match(text, /Exec=.+/);
    assert.match(text, /X-GNOME-Autostart-enabled=true/);

    const off = await integration.applySettings({ autoStart: false });
    assert.equal(off.autoStart, false);
    assert.equal(existsSync(file), false, '关闭后应当删除自启动文件');

    rmSync(home, { recursive: true, force: true });
});

test('Windows 开机启动登记到系统登录项并读回实际状态', async () => {
    const home = mkdtempSync(path.join(os.tmpdir(), 'wifimeter-system-win-'));
    const loginItem = { openAtLogin: false };
    const calls = [];
    const app = {
        isPackaged: true,
        getPath: () => home,
        quit() {},
        setLoginItemSettings(options) {
            calls.push(options);
            loginItem.openAtLogin = options.openAtLogin;
        },
        getLoginItemSettings: () => ({ openAtLogin: loginItem.openAtLogin })
    };

    const integration = createSystemIntegration({
        app,
        Tray: class {},
        Menu: { buildFromTemplate: template => ({ template }) },
        Notification: class {
            static isSupported() {
                return false;
            }
        },
        nativeImage: { createFromPath: () => ({}) },
        getWindow: () => null,
        iconPath: '/tmp/icon.png',
        platform: 'win32',
        logger: () => {}
    });

    const on = await integration.applySettings({ autoStart: true });
    assert.equal(on.autoStart, true);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].openAtLogin, true);
    assert.equal(calls[0].path, process.execPath);
    assert.equal(calls[0].args, undefined, '打包后不应额外传应用目录');

    const off = await integration.applySettings({ autoStart: false });
    assert.equal(off.autoStart, false);
    assert.equal(calls[1].openAtLogin, false);

    rmSync(home, { recursive: true, force: true });

    // 系统拒绝写入（组策略/安全软件）时必须如实回报，而不是假装成功。
    const rejected = createSystemIntegration({
        app: { isPackaged: true, getPath: () => home, quit() {}, setLoginItemSettings() {}, getLoginItemSettings: () => ({ openAtLogin: false }) },
        Tray: class {},
        Menu: { buildFromTemplate: template => ({ template }) },
        Notification: class {
            static isSupported() {
                return false;
            }
        },
        nativeImage: { createFromPath: () => ({}) },
        getWindow: () => null,
        iconPath: '/tmp/icon.png',
        platform: 'win32',
        logger: () => {}
    });
    const result = await rejected.applySettings({ autoStart: true });
    assert.equal(result.autoStart, false, '系统没生效时不能报告已开启');
});

test('Windows 设置同步采用登记方法返回的实际状态，避免重复查询', async () => {
    let getterCalls = 0;
    let actualEnabled = true;
    const integration = createSystemIntegration({
        app: {
            isPackaged: true,
            setLoginItemSettings: () => ({ openAtLogin: actualEnabled, executableWillLaunchAtLogin: actualEnabled }),
            getLoginItemSettings() { getterCalls++; return { openAtLogin: !actualEnabled }; }
        },
        platform: 'win32',
        getWindow: () => null
    });
    assert.equal((await integration.applySettings({ autoStart: true })).autoStart, true);
    actualEnabled = false;
    assert.equal((await integration.applySettings({ notifications: false })).autoStart, false);
    assert.equal(getterCalls, 0);
});

test('Windows 旧宿主登记方法未返回状态时仍查询实际结果', async () => {
    let getterCalls = 0;
    const integration = createSystemIntegration({
        app: {
            isPackaged: true,
            setLoginItemSettings() {},
            getLoginItemSettings() { getterCalls++; return { openAtLogin: false }; }
        },
        platform: 'win32',
        getWindow: () => null
    });
    assert.equal((await integration.applySettings({ autoStart: true })).autoStart, false);
    assert.equal(getterCalls, 1);
});

test('开发态的 Windows 开机启动带上应用目录', async () => {
    const home = mkdtempSync(path.join(os.tmpdir(), 'wifimeter-system-win-dev-'));
    const calls = [];
    const integration = createSystemIntegration({
        app: {
            isPackaged: false,
            getPath: () => home,
            quit() {},
            setLoginItemSettings: options => calls.push(options),
            getLoginItemSettings: () => ({ openAtLogin: true })
        },
        Tray: class {},
        Menu: { buildFromTemplate: template => ({ template }) },
        Notification: class {
            static isSupported() {
                return false;
            }
        },
        nativeImage: { createFromPath: () => ({}) },
        getWindow: () => null,
        iconPath: '/tmp/icon.png',
        platform: 'win32',
        logger: () => {}
    });

    await integration.applySettings({ autoStart: true });
    // 未打包时 execPath 是 electron 本体，登录后要能加载到应用目录。
    assert.ok(Array.isArray(calls[0].args));
    assert.match(calls[0].args[0], /apps[\\/]desktop$/);

    rmSync(home, { recursive: true, force: true });
});

test('系统设置同步保留托盘，退出时销毁，不可用时不影响其他功能', async () => {
    const { home, state, integration } = createFakes();

    await integration.applySettings({ minimizeToTray: true });
    assert.equal(state.trayCount, 1);
    assert.ok(state.menu, '托盘应当带上菜单');

    await integration.applySettings({ minimizeToTray: true });
    assert.equal(state.trayCount, 1, '重复开启不应创建第二个托盘');

    await integration.applySettings({ minimizeToTray: false });
    assert.equal(state.destroyed, 0);
    integration.dispose();
    assert.equal(state.destroyed, 1);

    rmSync(home, { recursive: true, force: true });

    // 没有状态栏的桌面环境：托盘创建失败要降级而不是抛错。
    const broken = createFakes({ trayThrows: true });
    const result = await broken.integration.applySettings({ minimizeToTray: true });
    assert.equal(result.minimizeToTray, false);
    assert.equal(broken.state.trayCount, 0);
    rmSync(broken.home, { recursive: true, force: true });
});

test('关闭窗口时按设置隐藏或放行', async () => {
    const { home, state, integration } = createFakes();
    const event = { prevented: false, preventDefault() { this.prevented = true; } };

    await integration.applySettings({ minimizeToTray: false });
    assert.equal(integration.handleWindowClose(event), false);
    assert.equal(event.prevented, false, '未开启托盘时应当正常关闭');

    await integration.applySettings({ minimizeToTray: true });
    assert.equal(integration.handleWindowClose(event), true);
    assert.equal(event.prevented, true);
    assert.equal(state.hidden, 1, '开启托盘时应当隐藏窗口');

    // 退出流程中不能被拦下。
    integration.beginQuit();
    const quitEvent = { prevented: false, preventDefault() { this.prevented = true; } };
    assert.equal(integration.handleWindowClose(quitEvent), false);
    assert.equal(quitEvent.prevented, false);

    rmSync(home, { recursive: true, force: true });
});

test('canceling a Tauri tray quit preserves hiding to the tray until a confirmed quit', async t => {
    const messages = [];
    const native = createNativeAdapter({ configuration: { userData: 'fixture' }, send: message => messages.push(message) });
    const { home, state, integration } = createFakes({ appOverride: native.app });
    t.after(() => { integration.dispose(); rmdirSync(home); });
    native.app.on('before-quit', () => integration.beginQuit());
    integration.initializeTray();

    state.menu.template.find(item => item.label === '退出').click();
    const canceled = messages.at(-1);
    assert.equal(canceled.method, 'app:confirmQuit');
    await native.receive({ type: 'native-result', id: canceled.id, ok: true, result: false });
    await new Promise(setImmediate);
    assert.equal(integration.quitting, false);
    assert.equal(integration.hideToTray(), true);
    assert.equal(state.hidden, 1);
    assert.equal(messages.some(message => message.type === 'quit'), false);

    state.menu.template.find(item => item.label === '退出').click();
    const confirmed = messages.at(-1);
    assert.equal(confirmed.method, 'app:confirmQuit');
    assert.notEqual(confirmed.id, canceled.id);
    await native.receive({ type: 'native-result', id: confirmed.id, ok: true, result: true });
    await new Promise(setImmediate);
    assert.equal(integration.quitting, true);
    assert.equal(integration.hideToTray(), false);
    assert.equal(messages.filter(message => message.type === 'quit').length, 1);
});

test('额度提醒按设置转成系统通知', async () => {
    const { home, state, integration } = createFakes();

    await integration.applySettings({ notifications: true });
    assert.equal(integration.notify({ kind: 'quotaWarn', ssid: 'Habitat_5G', alias: '家里的 Wi-Fi', percent: 85.4 }), true);
    assert.equal(state.notifications.length, 1);
    assert.match(state.notifications[0].body, /家里的 Wi-Fi/);
    assert.match(state.notifications[0].body, /85%/);

    // 断开结果不同，文案不同。
    integration.notify({ kind: 'quotaDisconnect', ssid: 'Habitat_5G', outcome: 0, percent: 100 });
    assert.match(state.notifications[1].body, /已断开/);
    integration.notify({ kind: 'quotaDisconnect', ssid: 'Habitat_5G', outcome: 5, detail: 'not authorized', percent: 100 });
    assert.match(state.notifications[2].body, /未能断开/);
    assert.match(state.notifications[2].body, /not authorized/);

    await integration.applySettings({ notifications: false });
    assert.equal(integration.notify({ kind: 'quotaWarn', ssid: 'x', percent: 90 }), false);
    assert.equal(state.notifications.length, 3, '关闭提醒后不应再发通知');
    assert.equal(state.notificationsShown, 3, '正常运行时应实际显示额度通知');

    rmSync(home, { recursive: true, force: true });
});

test('后台测试即使开启额度提醒也不调用系统通知接口', async t => {
    const { home, state, integration } = createFakes({ backgroundTest: true });
    t.after(() => { integration.dispose(); rmSync(home, { recursive: true, force: true }); });
    await integration.applySettings({ notifications: true });
    const results = ['quotaWarn', 'quotaLimit', 'quotaDisconnect'].map(kind =>
        integration.notify({ kind, ssid: 'Fixture Wi-Fi', percent: 100, outcome: 0 }));
    assert.equal(state.notificationsShown, 0, '后台测试不能显示额度通知');
    assert.equal(state.notifications.length, 0, '后台测试不能创建系统通知');
    assert.equal(state.notificationSupportChecks, 0, '后台测试无需访问系统通知支持状态');
    assert.deepEqual(results, [false, false, false]);
});

test('相同设置不重写自启动文件，外部修改后仍能恢复', async t => {
    const { home, integration } = createFakes();
    t.after(() => rmSync(home, { recursive: true, force: true }));
    const { utimesSync, statSync, writeFileSync } = await import('node:fs');
    const file = autostartFile(home);
    await integration.applySettings({ autoStart: true });
    const expected = readFileSync(file, 'utf8');
    const oldTime = new Date('2000-01-01T00:00:00Z');
    utimesSync(file, oldTime, oldTime);
    for (let n = 0; n < 20; n++) {
        const result = await integration.applySettings({ autoStart: true, notifications: n % 2 === 0 });
        assert.equal(result.autoStart, true);
    }
    assert.equal(statSync(file).mtimeMs, oldTime.getTime(), '无关设置变化不应触发重复写入');
    writeFileSync(file, '[Desktop Entry]\nExec=outdated\n');
    await integration.applySettings({ autoStart: true });
    assert.equal(readFileSync(file, 'utf8'), expected);
    rmSync(file);
    await integration.applySettings({ autoStart: true });
    assert.equal(readFileSync(file, 'utf8'), expected);
});

test('language changes update an existing tray and quota notifications', async t => {
    const { home, state, integration } = createFakes();
    t.after(() => { integration.dispose(); rmSync(home, { recursive: true, force: true }); });
    await integration.applySettings({ language: 'en', minimizeToTray: true });
    assert.equal(state.menu.template[0].label, 'Open WiFiMeter');
    integration.notify({ kind: 'quotaWarn', ssid: 'Example', percent: 85 });
    assert.match(state.notifications.at(-1).body, /85% of its quota/);
    await integration.applySettings({ language: 'zh-CN', minimizeToTray: true });
    assert.equal(state.menu.template[0].label, '打开 WiFiMeter');
    assert.equal(state.trayCount, 1);
});

test('unavailable tray never hides a window that cannot be reopened from the tray', async t => {
    const { home, state, integration } = createFakes({ trayThrows: true });
    t.after(() => { integration.dispose(); rmSync(home, { recursive: true, force: true }); });
    await integration.applySettings({ minimizeToTray: true });
    const event = { prevented: false, preventDefault() { this.prevented = true; } };
    assert.equal(integration.handleWindowClose(event), false);
    assert.equal(event.prevented, false);
    assert.equal(state.hidden, 0);
});

test('limit notification reports reaching the quota without inventing a failed disconnect', async t => {
    const { home, state, integration } = createFakes();
    t.after(() => { integration.dispose(); rmSync(home, { recursive: true, force: true }); });
    await integration.applySettings({ language: 'zh-CN' });
    integration.notify({ kind: 'quotaLimit', scope: 'total', percent: 100 });
    assert.equal(state.notifications[0].body, 'Wi-Fi 总额度 已达到额度上限。');
    assert.doesNotMatch(state.notifications[0].body, /未能断开/);
});

test('启动创建默认托盘，旧设置及语言同步不移除或重复创建图标', async t => {
    const { home, state, integration } = createFakes();
    t.after(() => { integration.dispose(); rmSync(home, { recursive: true, force: true }); });
    integration.initializeTray();
    assert.equal(state.trayCount, 1);
    assert.equal(state.hidden, 0);
    const result = await integration.applySettings({ minimizeToTray: false, language: 'en' });
    assert.equal(result.minimizeToTray, true);
    assert.equal(state.destroyed, 0);
    assert.equal(state.trayCount, 1);
    assert.equal(state.menu.template[0].label, 'Open WiFiMeter');
});
