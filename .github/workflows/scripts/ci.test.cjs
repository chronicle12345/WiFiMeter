'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { expectedElectronVersion, validateTag, assertUiReport, expectedFiles, digest, releaseFiles, matrices } = require('./ci.cjs');

test('标签与 metadata 相符，禁止其他版本系列或路径', () => {
    validateTag('1.2.8', 'v1.2.8');
    for (const tag of ['v1.2.7', 'v1.3.0', '../v1.2.8', 'v1.2.8\n']) assert.throws(() => validateTag('1.2.8', tag));
});

test('UI 跳过、未执行、失败和重试后成功均不能放行', () => {
    const passed = { stats: { expected: 10, skipped: 0, unexpected: 0, flaky: 0 }, errors: [] };
    assertUiReport(passed);
    for (const field of ['skipped', 'unexpected', 'flaky']) assert.throws(() => assertUiReport({ ...passed, stats: { ...passed.stats, [field]: 1 } }));
    assert.throws(() => assertUiReport({ stats: { ...passed.stats, expected: 0 } }));
    assert.throws(() => assertUiReport({ ...passed, errors: [{}] }));
});

test('发布必须具备五组矩阵、正确版本、全部格式和匹配的文件哈希', async t => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'wifimeter-ci-manifest-'));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const version = '1.2.8';
    for (const [platform, arch] of matrices) {
        const folder = path.join(directory, `${platform}-${arch}`);
        fs.mkdirSync(folder);
        const files = [];
        for (const name of expectedFiles(platform, arch, version)) {
            const file = path.join(folder, name);
            fs.writeFileSync(file, 'verified fixture');
            files.push({ name, size: fs.statSync(file).size, sha256: await digest(file) });
        }
        fs.writeFileSync(path.join(folder, 'manifest.json'), JSON.stringify({ platform, arch, version, electronVersion: expectedElectronVersion(platform, arch), files }));
    }
    assert.equal((await releaseFiles(directory, version)).length, 12);
    await assert.rejects(releaseFiles(directory, '1.2.9'));
    const file = path.join(directory, 'linux-arm64', expectedFiles('linux', 'arm64', version)[0]);
    fs.writeFileSync(file, 'tampered fixture');
    await assert.rejects(releaseFiles(directory, version));
    fs.rmSync(path.join(directory, 'linux-arm64'), { recursive: true });
    await assert.rejects(releaseFiles(directory, version), /缺少矩阵/);
});

test('ia32 runtime 必须为兼容分支且实际进程架构匹配', () => {
    const { expectedElectronVersion, assertElectronRuntime } = require('./ci.cjs');
    assert.equal(expectedElectronVersion('win32', 'ia32'), '43.7.7');
    assert.equal(expectedElectronVersion('win32', 'x64'), '44.4.5');
    assert.equal(expectedElectronVersion('win32', 'arm64'), '44.4.5');
    assertElectronRuntime({ platform: 'win32', arch: 'ia32', electron: '43.7.7' }, 'win32', 'ia32');
    assert.throws(() => assertElectronRuntime({ platform: 'win32', arch: 'x64', electron: '43.7.7' }, 'win32', 'ia32'));
    assert.throws(() => assertElectronRuntime({ platform: 'win32', arch: 'ia32', electron: '44.4.5' }, 'win32', 'ia32'));
    assert.throws(() => assertElectronRuntime({ platform: 'win32', arch: 'arm64', electron: '43.7.7' }, 'win32', 'arm64'));
});
