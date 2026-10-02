import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { productIdentityFor } from '../electron/product.cjs';

const read = file => JSON.parse(readFileSync(new URL(file, import.meta.url), 'utf8'));

test('Tauri 配置沿用 Windows 产品身份和版本，主窗口由原生宿主创建', () => {
    const config = read('../src-tauri/tauri.conf.json');
    const identity = productIdentityFor('win32', 'C:\\AppData');
    assert.equal(config.productName, identity.productName);
    assert.equal(config.identifier, identity.appUserModelId);
    assert.equal(config.version, '../package.json');
    assert.equal(config.build.frontendDist, '../dist/tauri');
    assert.equal(config.app.withGlobalTauri, true);
    assert.deepEqual(config.app.windows, []);
});

test('页面只开放本地 IPC，前端权限不提供任意文件或 shell 访问', () => {
    const { app } = read('../src-tauri/tauri.conf.json');
    const directives = Object.fromEntries(app.security.csp.split(';').map(directive => {
        const [name, ...values] = directive.trim().split(/\s+/);
        return [name, values];
    }));
    assert.deepEqual(directives['connect-src'], ['ipc:', 'http://ipc.localhost']);
    assert.deepEqual(directives['script-src'], ["'self'"]);
    assert.deepEqual(directives['object-src'], ["'none'"]);
    const desktop = read('../src-tauri/capabilities/desktop.json');
    const mini = read('../src-tauri/capabilities/mini.json');
    assert.deepEqual(desktop.windows, ['main', 'mini']);
    assert.deepEqual(desktop.permissions, ['core:event:allow-listen', 'core:event:allow-unlisten']);
    assert.deepEqual(mini.windows, ['mini']);
    assert.deepEqual(mini.permissions, ['core:window:allow-start-dragging']);
    assert.equal(desktop.remote, undefined);
    assert.equal(mini.remote, undefined);
});
