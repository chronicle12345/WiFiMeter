'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { assertUiReport, nativeEnvironment } = require('./ci.cjs');

test('UI 跳过、未执行、失败和重试后成功均不能放行', () => {
    const passed = { stats: { expected: 10, skipped: 0, unexpected: 0, flaky: 0 }, errors: [] };
    assertUiReport(passed);
    for (const field of ['skipped', 'unexpected', 'flaky']) assert.throws(() => assertUiReport({ ...passed, stats: { ...passed.stats, [field]: 1 } }));
    for (const expected of [0, -1, undefined, '10', 0.5]) assert.throws(() => assertUiReport({ stats: { ...passed.stats, expected } }));
    assert.throws(() => assertUiReport({ ...passed, errors: [{}] }));
});

test('原生矩阵必须启动匹配架构的 Node，环境只输出当前 Tauri 和后端路径', () => {
    for (const [platform, arches] of [['win32', ['x64', 'ia32', 'arm64']], ['linux', ['x64', 'arm64']]]) {
        for (const arch of arches) {
            const options = { host: { platform, arch }, temporaryDirectory: path.resolve('temporary') };
            const environment = nativeEnvironment(platform, arch, options);
            assert.equal(environment.WIFIMETER_PACKAGE_ARCH, arch);
            assert.match(environment.WIFIMETER_BACKEND, /wifimeter-backend(?:\.exe)?$/);
            assert.equal(Object.keys(environment).some(name => name.startsWith('ELECTRON') || name === 'UNPACKED_DIR'), false);
            assert.throws(() => nativeEnvironment(platform, arch, { ...options, host: { platform, arch: 'wrong' } }));
            assert.throws(() => nativeEnvironment(platform, arch, { ...options, host: { platform: 'darwin', arch } }));
        }
    }
    assert.throws(() => nativeEnvironment('linux', 'ia32', { host: { platform: 'linux', arch: 'ia32' }, temporaryDirectory: 'temporary' }));
});
