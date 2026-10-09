'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');

const repositoryRoot = path.resolve(__dirname, '../..');

function validateVersion(version) {
    assert.ok(typeof version === 'string' && /^1\.3\.(0|[1-9]\d*)$/.test(version) && !/[\r\n]/.test(version),
        'Tauri 发布版本必须为 1.3.x 正式版本。');
}

function readMetadata(root = repositoryRoot, { refType, refName } = {}) {
    const desktop = JSON.parse(fs.readFileSync(path.join(root, 'apps/desktop/package.json'), 'utf8'));
    const version = desktop.version;
    validateVersion(version);
    for (const file of ['package.json', 'apps/desktop/src-tauri/tauri.conf.json']) {
        assert.equal(JSON.parse(fs.readFileSync(path.join(root, file), 'utf8')).version, version, `${file} 版本不一致。`);
    }
    let inPackage = false, cargoVersion;
    for (const line of fs.readFileSync(path.join(root, 'apps/desktop/src-tauri/Cargo.toml'), 'utf8').split(/\r?\n/)) {
        if (/^\[/.test(line)) inPackage = line.trim() === '[package]';
        if (inPackage) cargoVersion ||= line.match(/^version\s*=\s*"([^"]+)"\s*$/)?.[1];
    }
    assert.equal(cargoVersion, version, 'Cargo.toml 版本不一致。');
    const notesFile = path.join(root, 'docs/releases', `v${version}.md`);
    if (refType === 'tag') {
        assert.equal(refName, `v${version}`, '发布标签必须与 1.3.x package 版本一致。');
        assert.ok(fs.existsSync(notesFile) && fs.lstatSync(notesFile).isFile()
            && fs.readFileSync(notesFile, 'utf8').trim(), '缺少非空的发布说明。');
    }
    return { version, notesFile };
}

function assetNames(version) {
    validateVersion(version);
    const prefix = `WiFiMeter-${version}-windows-x64-Tauri`;
    return [`${prefix}-Setup.exe`, `${prefix}-Portable.zip`, `${prefix}-SHA256SUMS.txt`];
}

async function digest(file) {
    const hash = createHash('sha256');
    for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
    return hash.digest('hex');
}

async function validateAssets(directory, version, { buildTree = false } = {}) {
    const names = assetNames(version);
    if (!buildTree) {
        assert.deepEqual(fs.readdirSync(directory).sort(), [...names].sort(), '发布目录必须恰好包含三个 Windows x64 Tauri 附件。');
    }
    const files = names.map(name => path.resolve(directory, name));
    for (const file of files) {
        assert.ok(fs.existsSync(file) && fs.lstatSync(file).isFile() && fs.statSync(file).size > 0,
            `发布附件缺失、为空或不是普通文件：${path.basename(file)}`);
    }
    assert.ok(fs.statSync(files[2]).size <= 4096, 'SHA-256 校验清单过大。');
    const lines = fs.readFileSync(files[2], 'utf8').replace(/\r?\n$/, '').split(/\r?\n/);
    assert.equal(lines.length, 2, 'SHA-256 校验清单必须恰好包含安装包和便携包。');
    const remaining = new Set(names.slice(0, 2)), hashes = new Map();
    for (const line of lines) {
        const entry = line.match(/^([a-f0-9]{64}) {2}([^\\/:\r\n]+)$/);
        assert.ok(entry && remaining.delete(entry[2]), 'SHA-256 校验清单包含无效、重复或非发布附件。');
        hashes.set(entry[2], entry[1]);
    }
    assert.equal(remaining.size, 0, 'SHA-256 校验清单不完整。');
    for (const file of files.slice(0, 2)) {
        assert.equal(await digest(file), hashes.get(path.basename(file)), `发布附件 SHA-256 不匹配：${path.basename(file)}`);
    }
    return files;
}

async function stageAssets(source, destination, version) {
    const files = await validateAssets(source, version, { buildTree: true });
    assert.ok(!fs.existsSync(destination), '发布暂存目录已存在，不能覆盖。');
    fs.mkdirSync(destination, { recursive: true });
    for (const file of files) fs.copyFileSync(file, path.join(destination, path.basename(file)), fs.constants.COPYFILE_EXCL);
    return validateAssets(destination, version);
}

function output(name, value) {
    assert.ok(process.env.GITHUB_OUTPUT, '缺少 GitHub Actions 输出文件。');
    assert.ok(!/[\r\n]/.test(String(value)), 'GitHub Actions 输出不能包含换行。');
    fs.appendFileSync(process.env.GITHUB_OUTPUT, `${name}=${value}\n`);
}

async function main([command, directory, ...extra]) {
    assert.equal(extra.length, 0, '发布辅助命令参数过多。');
    const metadata = readMetadata(repositoryRoot, { refType: process.env.GITHUB_REF_TYPE, refName: process.env.GITHUB_REF_NAME });
    if (command === 'metadata' && !directory) {
        output('version', metadata.version);
        output('notes_file', metadata.notesFile);
    } else if (command === 'stage' && directory) {
        assert.ok(process.env.RUNNER_TEMP, '缺少 RUNNER_TEMP。');
        const parent = fs.mkdtempSync(path.join(process.env.RUNNER_TEMP, 'wifimeter-tauri-release-'));
        const destination = path.join(parent, 'assets');
        await stageAssets(directory, destination, metadata.version);
        output('directory', destination);
    } else if (command === 'release-files' && directory) {
        assert.equal(process.env.GITHUB_REF_TYPE, 'tag', '发布附件只允许用于标签构建。');
        assert.ok(process.env.RUNNER_TEMP, '缺少 RUNNER_TEMP。');
        const files = await validateAssets(directory, metadata.version);
        const list = path.join(process.env.RUNNER_TEMP, 'tauri-release-files.txt');
        fs.writeFileSync(list, files.join('\n') + '\n');
        output('assets_file', list);
    } else throw Error(`未知发布辅助命令：${command}`);
}

module.exports = { readMetadata, assetNames, validateAssets, stageAssets };
if (require.main === module) main(process.argv.slice(2)).catch(error => { console.error(error.message); process.exitCode = 1; });
