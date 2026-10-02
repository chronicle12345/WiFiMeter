'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const root = path.resolve(__dirname, '../../..');
const targets = require(path.join(root, 'packaging/targets.cjs'));
const matrices = [['win32', 'x64'], ['win32', 'ia32'], ['win32', 'arm64'], ['linux', 'x64'], ['linux', 'arm64']];

function metadata() {
    const data = JSON.parse(fs.readFileSync(path.join(root, 'apps/desktop/package.json'), 'utf8'));
    assert.match(data.version, /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/, '版本必须来自有效的 package metadata');
    return data;
}

function expectedElectronVersion(platform, arch) {
    return platform === 'win32' && arch === 'ia32' ? '43.7.7' : metadata().devDependencies.electron;
}

function assertElectronRuntime(runtime, platform, arch) {
    assert.equal(runtime.platform, platform, '打包 runtime 平台不匹配');
    assert.equal(runtime.arch, arch, '必须实际启动目标架构的打包 runtime');
    assert.equal(runtime.electron, expectedElectronVersion(platform, arch), '打包 Electron 版本不匹配');
}

function validateTag(version, tag) {
    assert.match(tag, /^v1\.2\.\d+(?:-[0-9A-Za-z.-]+)?$/, '只发布 v1.2.* 标签');
    assert.equal(tag, `v${version}`, '标签必须匹配 package metadata');
}

function assertUiReport(report) {
    assert.ok(report.stats?.expected > 0, 'UI 测试必须实际执行');
    for (const field of ['skipped', 'unexpected', 'flaky']) assert.equal(report.stats[field], 0, `UI ${field} 必须为 0`);
    assert.equal((report.errors || []).length, 0, 'UI 测试不能有全局错误');
}

function expectedFiles(platform, arch, version) {
    assert.ok(matrices.some(([p, a]) => p === platform && a === arch), '不支持的发布矩阵');
    if (platform === 'win32') return [`WiFiMeter-${version}-windows-${arch}-Setup.exe`, `WiFiMeter-${version}-windows-${arch}-Portable.exe`];
    return [`WiFiMeter-${version}-linux-${arch === 'x64' ? 'amd64' : arch}.deb`, `WiFiMeter-${version}-linux-${arch === 'x64' ? 'x86_64' : 'aarch64'}.rpm`, `WiFiMeter-${version}-linux-${arch === 'x64' ? 'x86_64' : 'arm64'}.AppImage`];
}

function output(name, value, file = process.env.GITHUB_OUTPUT) {
    assert.ok(file, '缺少 GitHub Actions 输出文件');
    assert.ok(!String(value).includes('\n') && !String(value).includes('\r'));
    fs.appendFileSync(file, `${name}=${value}\n`);
}

function verifyBackend(directory, platform, arch) {
    targets.checkBackend(directory, platform, arch);
    const binary = path.join(directory, `wifimeter-backend${platform === 'win32' ? '.exe' : ''}`);
    const version = execFileSync(binary, ['--version'], { encoding: 'utf8', timeout: 30000 }).trim();
    assert.equal(version.match(/wifimeter-backend\s+(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)/)?.[1], metadata().version, `后端版本不匹配：${version}`);
    console.log(version);
}

function verifyDirectory(directory, platform, arch) {
    targets.checkPackaged(directory, platform, arch);
    verifyBackend(path.join(directory, 'resources'), platform, arch);
    if (platform === 'win32') {
        assert.deepEqual(fs.readFileSync(path.join(directory, 'resources/native/windows/AppNetworkControl.psm1')),
            fs.readFileSync(path.join(root, 'apps/desktop/native/windows/AppNetworkControl.psm1')));
    } else {
        for (const resource of ['wifimeter-app-capture.bpf.o', 'licenses/libbpf.BSD-2-Clause', 'licenses/wifimeter-app-capture.GPL-2.0']) {
            assert.ok(fs.statSync(path.join(directory, 'resources', resource)).size > 0, `缺少 ${resource}`);
        }
    }
}

async function digest(file) {
    const hash = crypto.createHash('sha256');
    for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
    return hash.digest('hex');
}

async function stage(platform, arch) {
    const version = metadata().version;
    const directory = path.join(process.env.RUNNER_TEMP, `release-${platform}-${arch}`);
    fs.mkdirSync(directory, { recursive: true });
    const manifest = { platform, arch, version, electronVersion: expectedElectronVersion(platform, arch), files: [] };
    for (const name of expectedFiles(platform, arch, version)) {
        const source = path.join(root, targets.buildPaths(platform, arch).output, name);
        const size = fs.statSync(source).size;
        assert.ok(size > 0, `产物为空：${name}`);
        const destination = path.join(directory, name);
        fs.copyFileSync(source, destination);
        manifest.files.push({ name, size, sha256: await digest(destination) });
    }
    fs.writeFileSync(path.join(directory, 'manifest.json'), JSON.stringify(manifest, null, 2));
    output('directory', directory);
}

async function releaseFiles(directory, version) {
    const remaining = new Set(matrices.map(([platform, arch]) => `${platform}-${arch}`));
    const files = [];
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        assert.ok(entry.isDirectory(), '下载目录只能包含矩阵产物目录');
        const folder = path.join(directory, entry.name);
        const manifest = JSON.parse(fs.readFileSync(path.join(folder, 'manifest.json'), 'utf8'));
        assert.equal(manifest.version, version);
        assert.equal(manifest.electronVersion, expectedElectronVersion(manifest.platform, manifest.arch));
        assert.ok(remaining.delete(`${manifest.platform}-${manifest.arch}`), '重复或未知矩阵产物');
        assert.deepEqual(manifest.files.map(file => file.name).sort(), expectedFiles(manifest.platform, manifest.arch, version).sort());
        for (const file of manifest.files) {
            const absolute = path.join(folder, file.name);
            assert.equal(fs.statSync(absolute).size, file.size);
            assert.equal(await digest(absolute), file.sha256, `产物校验失败：${file.name}`);
            files.push(absolute);
        }
    }
    assert.equal(remaining.size, 0, `缺少矩阵产物：${[...remaining].join(', ')}`);
    return files;
}

async function main([command, ...args]) {
    if (command === 'metadata') {
        const { version } = metadata();
        if (process.env.GITHUB_REF_TYPE === 'tag') {
            validateTag(version, process.env.GITHUB_REF_NAME);
            assert.ok(fs.statSync(path.join(root, 'docs/releases', `${process.env.GITHUB_REF_NAME}.md`)).size > 0, '缺少发布说明');
        }
        output('version', version);
    } else if (command === 'environment') {
        const [platform, arch] = args;
        assert.equal(process.platform, platform);
        assert.equal(process.arch, arch, 'Node.js 必须使用目标架构');
        const paths = targets.buildPaths(platform, arch);
        for (const [key, value] of Object.entries({ BUILD_DIR: paths.backend, OUTPUT_DIR: paths.output,
            UNPACKED_DIR: path.join(root, paths.output, paths.unpacked), WIFIMETER_PACKAGE_ARCH: arch,
            ELECTRON_CACHE: path.join(process.env.RUNNER_TEMP, 'electron-cache'),
            ELECTRON_BUILDER_CACHE: path.join(process.env.RUNNER_TEMP, 'electron-builder-cache'),
            XDG_CACHE_HOME: path.join(process.env.RUNNER_TEMP, 'cache'),
            WIFIMETER_BACKEND: path.join(root, paths.backend, 'app', `wifimeter-backend${platform === 'win32' ? '.exe' : ''}`) })) {
            output(key, value, process.env.GITHUB_ENV);
        }
    } else if (command === 'backend') verifyBackend(args[2], args[0], args[1]);
    else if (command === 'directory') verifyDirectory(args[2], args[0], args[1]);
    else if (command === 'ui-report') assertUiReport(JSON.parse(fs.readFileSync(args[0], 'utf8')));
    else if (command === 'stage') await stage(...args);
    else if (command === 'release-files') {
        validateTag(metadata().version, process.env.GITHUB_REF_NAME);
        const files = await releaseFiles(args[0], metadata().version);
        const list = path.join(process.env.RUNNER_TEMP, 'release-files.txt');
        fs.writeFileSync(list, files.join('\n') + '\n');
        output('assets_file', list);
    } else throw new Error(`未知 CI 命令：${command}`);
}

module.exports = { expectedElectronVersion, assertElectronRuntime, validateTag, assertUiReport, expectedFiles, digest, releaseFiles, matrices };
if (require.main === module) main(process.argv.slice(2)).catch(error => { console.error(error); process.exitCode = 1; });
