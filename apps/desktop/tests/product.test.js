// 产品身份测试：应用名、App User Model ID 与用户数据目录必须与打包文档一致。
//
// 这三样东西决定“应用把数据写到哪里”，改名或改路径会让老用户的数据看起来消失，
// 因此用测试钉住；同时验证写入 app 对象的行为（不必真的启动 Electron）。

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

import { createRequire } from 'node:module';

import { applyProductIdentity, productIdentityFor, productNameFor } from '../electron/product.cjs';

const require = createRequire(import.meta.url);

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

test('preload 暴露的产品名与产品身份一致', () => {
    // preload 运行在 sandbox 里，不能引入 product.cjs，只能自己再写一遍产品名。
    // 这个测试把两份定义对齐：不一致时页面标题与窗口标题会不一样。
    const captured = {};
    const electronStub = {
        contextBridge: {
            exposeInMainWorld: (name, api) => {
                captured.name = name;
                captured.api = api;
            }
        },
        ipcRenderer: { invoke: () => {}, on: () => {}, removeListener: () => {} }
    };
    const moduleUnderTest = require.resolve('../electron/preload.cjs');
    const originalLoad = require.cache[moduleUnderTest];
    // 用一个最小的 require 拦截把 electron 换成桩：preload 在 sandbox 里只能拿到 electron，
    // 因此这里只需要替换这一个模块。
    const Module = require('node:module');
    const originalResolve = Module._resolveFilename;
    Module._resolveFilename = function (request, ...rest) {
        if (request === 'electron') return 'electron';
        return originalResolve.call(this, request, ...rest);
    };
    require.cache['electron'] = { id: 'electron', filename: 'electron', loaded: true, exports: electronStub };
    try {
        require('../electron/preload.cjs');
    } finally {
        Module._resolveFilename = originalResolve;
        delete require.cache['electron'];
        if (originalLoad) require.cache[moduleUnderTest] = originalLoad;
        else delete require.cache[moduleUnderTest];
    }

    assert.equal(captured.name, 'desktop');
    // preload 与 product.cjs 必须给出同一个名字（这里跑在哪个平台就比哪个平台的值）。
    assert.equal(captured.api.appName, productNameFor(process.platform));
    if (process.platform === 'win32')
        assert.equal(captured.api.appName, 'WiFiMeter Demo');
});
