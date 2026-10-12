'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const root = path.resolve(__dirname, '../../..');
const targets = require(path.join(root, 'packaging/targets.cjs'));

function assertUiReport(report) {
    assert.ok(Number.isSafeInteger(report.stats?.expected) && report.stats.expected > 0, 'UI 测试必须实际执行');
    for (const field of ['skipped', 'unexpected', 'flaky']) assert.equal(report.stats[field], 0, `UI ${field} 必须为 0`);
    assert.equal((report.errors || []).length, 0, 'UI 测试不能有全局错误');
}

function output(name, value, file) {
    assert.ok(file, '缺少 GitHub Actions 输出文件');
    assert.ok(!String(value).includes('\n') && !String(value).includes('\r'));
    fs.appendFileSync(file, `${name}=${value}\n`);
}

function nativeEnvironment(platform, arch, { host = process, temporaryDirectory = process.env.RUNNER_TEMP } = {}) {
    assert.equal(host.platform, platform);
    assert.equal(host.arch, arch, 'Node.js 必须使用目标架构');
    targets.validateNativeTarget(platform, arch, host);
    assert.ok(temporaryDirectory, '缺少独立临时目录');
    const paths = targets.buildPaths(platform, arch);
    return {
        BUILD_DIR: paths.backend, OUTPUT_DIR: paths.output,
        WIFIMETER_PACKAGE_ARCH: arch,
        XDG_CACHE_HOME: path.join(temporaryDirectory, 'cache'),
        WIFIMETER_BACKEND: path.join(root, paths.backend, 'app', `wifimeter-backend${platform === 'win32' ? '.exe' : ''}`)
    };
}

function verifyBackend(directory, platform, arch) {
    targets.checkBackend(directory, platform, arch);
    const binary = path.join(directory, `wifimeter-backend${platform === 'win32' ? '.exe' : ''}`);
    const version = execFileSync(binary, ['--version'], { encoding: 'utf8', timeout: 30000, windowsHide: true }).trim();
    const metadata = JSON.parse(fs.readFileSync(path.join(root, 'apps/desktop/package.json'), 'utf8'));
    assert.equal(version.match(/wifimeter-backend\s+(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)/)?.[1], metadata.version, `后端版本不匹配：${version}`);
    console.log(version);
}

function main([command, ...args]) {
    if (command === 'environment') {
        for (const [name, value] of Object.entries(nativeEnvironment(args[0], args[1]))) output(name, value, process.env.GITHUB_ENV);
    } else if (command === 'backend') verifyBackend(args[2], args[0], args[1]);
    else if (command === 'ui-report') assertUiReport(JSON.parse(fs.readFileSync(args[0], 'utf8')));
    else throw new Error(`未知 CI 命令：${command}`);
}

module.exports = { assertUiReport, nativeEnvironment };
if (require.main === module) {
    try { main(process.argv.slice(2)); } catch (error) { console.error(error); process.exitCode = 1; }
}
