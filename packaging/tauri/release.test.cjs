'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');

const helper = require('./release.cjs');
const version = '1.3.0';
const matrices = [
    ['win32', 'x64', ['WiFiMeter-1.3.0-windows-x64-Tauri-Setup.exe']],
    ['win32', 'ia32', ['WiFiMeter-1.3.0-windows-ia32-Tauri-Setup.exe']],
    ['win32', 'arm64', ['WiFiMeter-1.3.0-windows-arm64-Tauri-Setup.exe']],
    ['linux', 'x64', ['WiFiMeter-1.3.0-linux-x64-Tauri.deb', 'WiFiMeter-1.3.0-linux-x64-Tauri.rpm', 'WiFiMeter-1.3.0-linux-x64-Tauri.AppImage']],
    ['linux', 'arm64', ['WiFiMeter-1.3.0-linux-arm64-Tauri.deb', 'WiFiMeter-1.3.0-linux-arm64-Tauri.rpm', 'WiFiMeter-1.3.0-linux-arm64-Tauri.AppImage']]
];

function checksumName(platform, arch) {
    return `WiFiMeter-${version}-${platform === 'win32' ? 'windows' : 'linux'}-${arch}-Tauri-SHA256SUMS.txt`;
}

function artifactName(platform, arch) {
    return `tauri-release-${platform === 'win32' ? 'windows' : 'linux'}-${arch}`;
}

function temporary(t) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'wifimeter-tauri-release-test-'));
    t.after(() => {
        assert.equal(path.dirname(directory), path.resolve(os.tmpdir()));
        assert.ok(path.basename(directory).startsWith('wifimeter-tauri-release-test-'));
        fs.rmSync(directory, { recursive: true, force: true });
    });
    return directory;
}

function write(file, contents) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, contents);
}

function metadataFixture(t) {
    const root = temporary(t);
    for (const file of ['package.json', 'apps/desktop/package.json', 'apps/desktop/src-tauri/tauri.conf.json']) {
        write(path.join(root, file), JSON.stringify({ version }));
    }
    write(path.join(root, 'apps/desktop/src-tauri/Cargo.toml'), '[package]\nname = "wifimeter"\nversion = "1.3.0"\n\n[dependencies]\nserde = "1"\n');
    write(path.join(root, 'docs/releases/v1.3.0.md'), '# WiFiMeter 1.3.0\n\n## 中文\n\n发布说明。\n\n## English\n\nRelease notes.\n');
    return root;
}

function assetFixture(t, platform = 'win32', arch = 'x64', directory = temporary(t)) {
    fs.mkdirSync(directory, { recursive: true });
    const expected = matrices.find(([p, a]) => p === platform && a === arch)[2];
    const lines = [];
    for (const name of expected) {
        const content = Buffer.from(`Verified ${name}\n`);
        write(path.join(directory, name), content);
        lines.push(`${createHash('sha256').update(content).digest('hex')}  ${name}`);
    }
    write(path.join(directory, checksumName(platform, arch)), lines.join('\n') + '\n');
    return directory;
}

function releaseFixture(t) {
    const directory = temporary(t);
    for (const [platform, arch] of matrices) assetFixture(t, platform, arch, path.join(directory, artifactName(platform, arch)));
    return directory;
}

test('release metadata requires one matching version across all desktop manifests', t => {
    const root = metadataFixture(t);
    const result = helper.readMetadata(root, { refType: 'tag', refName: 'v1.3.0' });
    assert.equal(result.version, version);
    assert.equal(result.notesFile, path.join(root, 'docs/releases/v1.3.0.md'));
    for (const file of ['package.json', 'apps/desktop/package.json', 'apps/desktop/src-tauri/tauri.conf.json']) {
        const absolute = path.join(root, file), original = fs.readFileSync(absolute);
        write(absolute, JSON.stringify({ version: '1.3.1' }));
        assert.throws(() => helper.readMetadata(root), /版本/);
        write(absolute, original);
    }
    write(path.join(root, 'apps/desktop/src-tauri/Cargo.toml'), '[package]\nversion = "1.3.1"\n');
    assert.throws(() => helper.readMetadata(root), /版本/);
});

test('release tags must match the v1.3 package version and have nonempty notes', t => {
    const root = metadataFixture(t);
    for (const refName of ['v1.3.1', 'v1.2.9', '../v1.3.0', 'v1.3.0\n', 'v1.3.0-beta']) {
        assert.throws(() => helper.readMetadata(root, { refType: 'tag', refName }), /标签/);
    }
    write(path.join(root, 'docs/releases/v1.3.0.md'), ' \n');
    assert.throws(() => helper.readMetadata(root, { refType: 'tag', refName: 'v1.3.0' }), /发布说明/);
    assert.equal(helper.readMetadata(root, { refType: 'branch', refName: 'main' }).version, version);
});

test('release tags reject missing or empty Chinese and English sections', t => {
    const root = metadataFixture(t);
    const notes = path.join(root, 'docs/releases/v1.3.0.md');
    for (const body of [
        '# WiFiMeter\n\n仅中文说明。', '# WiFiMeter\n\nEnglish only.',
        '## 中文\n\n说明。\n\n## English\n',
        '## 中文\n\n## English\n\nRelease notes.',
        '## 中文\n\n说明。\n\n## English\n\n## Validation\n\nPassed.'
    ]) {
        write(notes, body);
        assert.throws(() => helper.readMetadata(root, { refType: 'tag', refName: 'v1.3.0' }), /中英文/);
    }
});

test('each supported architecture validates installers and keeps checksums out of the public file list', async t => {
    for (const [platform, arch, expected] of matrices) {
        const directory = assetFixture(t, platform, arch);
        assert.deepEqual(helper.assetNames(version, platform, arch), expected);
        assert.deepEqual(await helper.validateAssets(directory, version, { platform, arch }), expected.map(name => path.join(directory, name)));
        await assert.rejects(helper.validateAssets(directory, '1.3.1', { platform, arch }), /附件/);
    }
    for (const [platform, arch] of [['win32', 'x86'], ['linux', 'ia32'], ['darwin', 'arm64']]) {
        assert.throws(() => helper.assetNames(version, platform, arch), /矩阵/);
    }
});

test('release staging rejects extra portable packages, unrelated checksum files and wrong architecture installers', async t => {
    for (const extra of ['WiFiMeter-1.3.0-windows-x64-Tauri-Portable.zip', 'SHA256SUMS.txt', 'WiFiMeter-1.3.0-windows-arm64-Tauri-Setup.exe']) {
        const directory = assetFixture(t);
        write(path.join(directory, extra), 'unexpected release asset');
        await assert.rejects(helper.validateAssets(directory, version), /附件/);
    }
});

test('release rejects files changed after the build checksum was recorded', async t => {
    const directory = assetFixture(t);
    write(path.join(directory, matrices[0][2][0]), 'modified installer');
    await assert.rejects(helper.validateAssets(directory, version), /SHA-256/);
});

test('release rejects missing, empty and non-file attachments', async t => {
    for (const kind of ['missing', 'empty', 'directory']) {
        const directory = assetFixture(t), file = path.join(directory, matrices[0][2][0]);
        fs.unlinkSync(file);
        if (kind === 'empty') write(file, '');
        if (kind === 'directory') fs.mkdirSync(file);
        await assert.rejects(helper.validateAssets(directory, version), /附件/);
    }
});

test('checksum manifests cannot omit, duplicate or substitute an attachment', async t => {
    const expected = matrices[3][2];
    for (const kind of ['missing', 'duplicate', 'extra', 'traversal', 'electron', 'invalid-hash']) {
        const directory = assetFixture(t, 'linux', 'x64'), manifest = path.join(directory, checksumName('linux', 'x64'));
        const lines = fs.readFileSync(manifest, 'utf8').trimEnd().split('\n');
        const content = {
            missing: lines[0], duplicate: `${lines[0]}\n${lines[0]}\n${lines[2]}`,
            extra: `${lines.join('\n')}\n${lines[0]}`,
            traversal: `${lines[0]}\n${lines[1].replace(expected[1], '../' + expected[1])}\n${lines[2]}`,
            electron: `${lines[0]}\n${lines[1].replace(expected[1], 'WiFiMeter-1.3.0-windows-x64-Portable.exe')}\n${lines[2]}`,
            'invalid-hash': `${lines[0]}\n${lines[1].replace(/^[a-f0-9]+/, 'bad-digest')}\n${lines[2]}`
        }[kind];
        write(manifest, content + '\n');
        await assert.rejects(helper.validateAssets(directory, version, { platform: 'linux', arch: 'x64' }), /校验清单/);
    }
});

test('staging copies only validated release files from a build output tree', async t => {
    const expected = [...matrices[0][2], checksumName('win32', 'x64')];
    const source = assetFixture(t), destination = path.join(temporary(t), 'release');
    write(path.join(source, 'tauri-portable/resources/runtime/host.cjs'), '// build directory');
    write(path.join(source, 'WiFiMeter-1.2.9-windows-x64-Setup.exe'), 'old Electron installer');
    await helper.stageAssets(source, destination, version);
    assert.deepEqual(fs.readdirSync(destination).sort(), [...expected].sort());
    assert.deepEqual(await helper.validateAssets(destination, version), matrices[0][2].map(name => path.join(destination, name)));
    await assert.rejects(helper.stageAssets(source, destination, version), /已存在/);
});

test('publishing requires all five matrices and returns only the nine installers', async t => {
    const directory = releaseFixture(t);
    const files = await helper.releaseFiles(directory, version);
    const expected = matrices.flatMap(([platform, arch, names]) => names.map(name => path.join(directory, artifactName(platform, arch), name)));
    assert.deepEqual(files, expected);
    assert.equal(files.length, 9);
    assert.ok(files.every(file => !/Portable|SHA256SUMS|\.txt$/.test(file)));
});

test('publishing rejects a missing matrix or an unexpected artifact directory', async t => {
    for (const kind of ['missing', 'extra']) {
        const directory = releaseFixture(t);
        if (kind === 'missing') fs.renameSync(path.join(directory, artifactName('linux', 'arm64')), path.join(temporary(t), 'held'));
        else fs.mkdirSync(path.join(directory, 'tauri-release-linux-ia32'));
        await assert.rejects(helper.releaseFiles(directory, version), /矩阵/);
    }
});

test('publishing detects modified installers across every architecture', async t => {
    for (const [platform, arch, names] of matrices) {
        const directory = releaseFixture(t);
        write(path.join(directory, artifactName(platform, arch), names[0]), 'changed after staging');
        await assert.rejects(helper.releaseFiles(directory, version), /SHA-256/);
    }
});
