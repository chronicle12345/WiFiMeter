'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { verify, name, commit } = require('./legacy-powershell.cjs');

test('旧版附件必须具有固定来源、独立名称、完整内容和匹配的哈希', t => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'wifimeter-legacy-test-'));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    assert.equal(name, 'WiFiMeter-1.1.1-PowerShell-windows-Portable.zip');
    assert.equal(commit, '2e924647957cc631e33ae099fefb56391e86afc4');
    const payload = Buffer.from('portable fixture');
    const manifest = { tag: 'v1.1.1', commit, version: '1.1.1', runtime: 'PowerShell', name,
        size: payload.length, sha256: crypto.createHash('sha256').update(payload).digest('hex') };
    const save = value => fs.writeFileSync(path.join(directory, 'manifest.json'), JSON.stringify(value));
    fs.writeFileSync(path.join(directory, name), payload);
    save(manifest);
    assert.equal(verify(directory), path.join(directory, name));
    for (const change of [{ commit: '0'.repeat(40) }, { tag: 'v1.2.0' }, { version: '1.2.0' },
        { runtime: 'Electron' }, { name: '../other.zip' }, { size: 0 }, { sha256: '0'.repeat(64) }]) {
        save({ ...manifest, ...change });
        assert.throws(() => verify(directory));
    }
    save(manifest);
    fs.appendFileSync(path.join(directory, name), 'tampered');
    assert.throws(() => verify(directory));
    fs.unlinkSync(path.join(directory, name));
    assert.throws(() => verify(directory));
});

test('发布命令追加实际下载路径，拒绝重复或未验证的附件', t => {
    const { execFileSync } = require('node:child_process');
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'wifimeter-legacy-upload-'));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const file = path.join(directory, name);
    const payload = Buffer.from('portable upload fixture');
    fs.writeFileSync(file, payload);
    fs.writeFileSync(path.join(directory, 'manifest.json'), JSON.stringify({ tag: 'v1.1.1', commit,
        version: '1.1.1', runtime: 'PowerShell', name, size: payload.length,
        sha256: crypto.createHash('sha256').update(payload).digest('hex') }));
    const list = path.join(directory, 'release-files.txt');
    const electronFiles = Array.from({ length: 12 }, (_, i) => `/electron/package-${i}`);
    fs.writeFileSync(list, electronFiles.join('\n') + '\n');
    const run = () => execFileSync(process.execPath, [path.join(__dirname, 'legacy-powershell.cjs'), directory, list], { stdio: 'pipe' });
    run();
    assert.deepEqual(fs.readFileSync(list, 'utf8').trim().split('\n'), [...electronFiles, file]);
    assert.throws(run);
    fs.writeFileSync(list, electronFiles.join('\n') + '\n');
    fs.appendFileSync(file, 'tampered');
    assert.throws(run);
    assert.equal(fs.readFileSync(list, 'utf8'), electronFiles.join('\n') + '\n');
});
