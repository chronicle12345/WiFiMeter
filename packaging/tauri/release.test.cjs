'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');

const helper = require('./release.cjs');
const version = '1.3.0';
const expected = [
    'WiFiMeter-1.3.0-windows-x64-Tauri-Setup.exe',
    'WiFiMeter-1.3.0-windows-x64-Tauri-Portable.zip',
    'WiFiMeter-1.3.0-windows-x64-Tauri-SHA256SUMS.txt'
];

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
    write(path.join(root, 'docs/releases/v1.3.0.md'), '# WiFiMeter 1.3.0\nRelease notes.\n');
    return root;
}

function assetFixture(t) {
    const directory = temporary(t);
    const lines = [];
    for (const name of expected.slice(0, 2)) {
        const content = Buffer.from(`Verified ${name}\n`);
        write(path.join(directory, name), content);
        lines.push(`${createHash('sha256').update(content).digest('hex')}  ${name}`);
    }
    write(path.join(directory, expected[2]), lines.join('\n') + '\n');
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

test('release file list contains exactly the x64 Tauri installer, portable zip and checksums', async t => {
    const directory = assetFixture(t);
    assert.deepEqual(await helper.validateAssets(directory, version), expected.map(name => path.join(directory, name)));
    await assert.rejects(helper.validateAssets(directory, '1.3.1'), /附件/);
    write(path.join(directory, 'WiFiMeter-1.3.0-windows-arm64-Tauri-Setup.exe'), 'wrong architecture');
    await assert.rejects(helper.validateAssets(directory, version), /附件/);
});

test('release rejects files changed after the build checksum was recorded', async t => {
    const directory = assetFixture(t);
    write(path.join(directory, expected[0]), 'modified installer');
    await assert.rejects(helper.validateAssets(directory, version), /SHA-256/);
});

test('release rejects missing, empty and non-file attachments', async t => {
    for (const kind of ['missing', 'empty', 'directory']) {
        const directory = assetFixture(t), file = path.join(directory, expected[1]);
        fs.unlinkSync(file);
        if (kind === 'empty') write(file, '');
        if (kind === 'directory') fs.mkdirSync(file);
        await assert.rejects(helper.validateAssets(directory, version), /附件/);
    }
});

test('checksum manifests cannot omit, duplicate or substitute an attachment', async t => {
    for (const kind of ['missing', 'duplicate', 'extra', 'traversal', 'electron', 'invalid-hash']) {
        const directory = assetFixture(t), manifest = path.join(directory, expected[2]);
        const lines = fs.readFileSync(manifest, 'utf8').trimEnd().split('\n');
        const content = {
            missing: lines[0], duplicate: `${lines[0]}\n${lines[0]}`,
            extra: `${lines.join('\n')}\n${lines[0]}`,
            traversal: `${lines[0]}\n${lines[1].replace(expected[1], '../' + expected[1])}`,
            electron: `${lines[0]}\n${lines[1].replace(expected[1], 'WiFiMeter-1.3.0-windows-x64-Portable.exe')}`,
            'invalid-hash': `${lines[0]}\n${lines[1].replace(/^[a-f0-9]+/, 'bad-digest')}`
        }[kind];
        write(manifest, content + '\n');
        await assert.rejects(helper.validateAssets(directory, version), /校验清单/);
    }
});

test('staging copies only validated release files from a build output tree', async t => {
    const source = assetFixture(t), destination = path.join(temporary(t), 'release');
    write(path.join(source, 'tauri-portable/resources/runtime/host.cjs'), '// build directory');
    write(path.join(source, 'WiFiMeter-1.2.9-windows-x64-Setup.exe'), 'old Electron installer');
    await helper.stageAssets(source, destination, version);
    assert.deepEqual(fs.readdirSync(destination).sort(), [...expected].sort());
    assert.deepEqual(await helper.validateAssets(destination, version), expected.map(name => path.join(destination, name)));
    await assert.rejects(helper.stageAssets(source, destination, version), /已存在/);
});
