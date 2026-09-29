// 产品身份测试：应用名、App User Model ID 与用户数据目录必须与打包文档一致。
//
// 这三样东西决定“应用把数据写到哪里”，改名或改路径会让老用户的数据看起来消失，
// 因此用测试钉住；同时验证写入 app 对象的行为（不必真的启动 Electron）。

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

import { applyProductIdentity, productIdentityFor, productNameFor } from '../electron/product.cjs';

test('产品名按平台区分，Windows 用 Demo 身份与旧版隔离', () => {
    assert.equal(productNameFor('win32'), 'WiFiMeter Demo');
    assert.equal(productNameFor('linux'), 'WiFiMeter');
    assert.equal(productNameFor('darwin'), 'WiFiMeter');
});

test('Windows 的数据目录与 App User Model ID 固定', () => {
    const identity = productIdentityFor('win32', 'C:\\Users\\someone\\AppData\\Roaming');
    assert.equal(identity.productName, 'WiFiMeter Demo');
    assert.equal(identity.appUserModelId, 'io.wifimeter.demo');
    // 与旧版 WPF 应用的数据目录不同，卸载示例版不会影响旧版数据。
    assert.equal(identity.userDataPath, path.join('C:\\Users\\someone\\AppData\\Roaming', 'WiFiMeter Demo'));
});

test('其他平台沿用 Electron 默认数据目录', () => {
    const identity = productIdentityFor('linux', '/home/someone/.config');
    assert.equal(identity.productName, 'WiFiMeter');
    assert.equal(identity.appUserModelId, null);
    assert.equal(identity.userDataPath, null, '不设置 userData 时 Electron 用默认目录');
});

test('applyProductIdentity 只设置该平台需要的项', () => {
    const windowsCalls = { names: [], appIds: [], paths: [] };
    const windowsApp = {
        setName: value => windowsCalls.names.push(value),
        setAppUserModelId: value => windowsCalls.appIds.push(value),
        setPath: (key, value) => windowsCalls.paths.push([key, value])
    };
    const identity = applyProductIdentity(windowsApp, 'win32', 'C:\\AppData');
    assert.equal(identity.productName, 'WiFiMeter Demo');
    assert.deepEqual(windowsCalls.names, ['WiFiMeter Demo']);
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
