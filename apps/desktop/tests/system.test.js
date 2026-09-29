// 系统级功能的单元测试：用假的 Electron 接口验证自启动文件、托盘开关、窗口关闭与通知。
// 这样不必启动图形界面也能覆盖分支。

import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createSystemIntegration, autostartFile } from '../electron/system.cjs';

function createFakes({ trayThrows = false, notificationSupported = true } = {}) {
    const home = mkdtempSync(path.join(os.tmpdir(), 'wifimeter-system-'));
    const state = { tray: null, trayCount: 0, destroyed: 0, notifications: [], shown: 0, hidden: 0, menu: null };

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
        show() {}
        static isSupported() {
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

    const app = {
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

test('托盘按设置创建与销毁，不可用时不影响其他功能', async () => {
    const { home, state, integration } = createFakes();

    await integration.applySettings({ minimizeToTray: true });
    assert.equal(state.trayCount, 1);
    assert.ok(state.menu, '托盘应当带上菜单');

    await integration.applySettings({ minimizeToTray: true });
    assert.equal(state.trayCount, 1, '重复开启不应创建第二个托盘');

    await integration.applySettings({ minimizeToTray: false });
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

    rmSync(home, { recursive: true, force: true });
});
