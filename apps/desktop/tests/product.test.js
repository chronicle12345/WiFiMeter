// 产品身份测试：应用名、App User Model ID 与用户数据目录必须与打包文档一致。
//
// 这三项决定应用的数据存放位置，改名或改路径会让老用户的数据看起来消失，
// 因此通过测试保持一致，并验证写入 app 对象的行为（无需启动原生窗口）。

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

import { tauriBridge } from './helpers/tauri-bridge.js';

import { applyProductIdentity, productIdentityFor, productNameFor } from '../host/product.cjs';


test('各平台产品名统一为 WiFiMeter', () => {
    assert.equal(productNameFor('win32'), 'WiFiMeter');
    assert.equal(productNameFor('linux'), 'WiFiMeter');
    assert.equal(productNameFor('darwin'), 'WiFiMeter');
});

test('Windows 的数据目录与 App User Model ID 固定', () => {
    const identity = productIdentityFor('win32', 'C:\\Users\\someone\\AppData\\Roaming');
    assert.equal(identity.productName, 'WiFiMeter');
    assert.equal(identity.appUserModelId, 'io.wifimeter.demo');
    // 与旧版 WPF 应用的数据目录不同，卸载示例版不会影响旧版数据。
    assert.equal(identity.userDataPath, path.join('C:\\Users\\someone\\AppData\\Roaming', 'WiFiMeter Demo'));
});

test('其他平台沿用宿主的数据目录', () => {
    const identity = productIdentityFor('linux', '/home/someone/.config');
    assert.equal(identity.productName, 'WiFiMeter');
    assert.equal(identity.appUserModelId, null);
    assert.equal(identity.userDataPath, null, '不设置 userData 时使用宿主默认目录');
});

test('applyProductIdentity 只设置该平台需要的项', () => {
    const windowsCalls = { names: [], appIds: [], paths: [] };
    const windowsApp = {
        setName: value => windowsCalls.names.push(value),
        setAppUserModelId: value => windowsCalls.appIds.push(value),
        setPath: (key, value) => windowsCalls.paths.push([key, value])
    };
    const identity = applyProductIdentity(windowsApp, 'win32', 'C:\\AppData');
    assert.equal(identity.productName, 'WiFiMeter');
    assert.deepEqual(windowsCalls.names, ['WiFiMeter']);
    assert.deepEqual(windowsCalls.appIds, ['io.wifimeter.demo']);
    assert.deepEqual(windowsCalls.paths, [['userData', path.join('C:\\AppData', 'WiFiMeter Demo')]]);

    const linuxCalls = { names: [], appIds: [], paths: [] };
    const linuxApp = {
        setName: value => linuxCalls.names.push(value),
        setAppUserModelId: value => linuxCalls.appIds.push(value),
        setPath: (key, value) => linuxCalls.paths.push([key, value])
    };
    applyProductIdentity(linuxApp, 'linux', '/home/someone/.config');
    assert.deepEqual(linuxCalls.names, ['WiFiMeter']);
    assert.deepEqual(linuxCalls.appIds, [], '非 Windows 不设置 App User Model ID');
    assert.deepEqual(linuxCalls.paths, [], '非 Windows 不改数据目录');
});

test('Tauri 页面暴露的产品名与产品身份一致', () => {
    for (const platform of ['win32', 'linux']) {
        const { api } = tauriBridge({ platform });
        assert.equal(api.appName, productNameFor(platform));
        assert.equal(api.platform, platform);
        assert.equal(Object.isFrozen(api), true);
        assert.equal(Object.isFrozen(api.backend), true);
    }
});
