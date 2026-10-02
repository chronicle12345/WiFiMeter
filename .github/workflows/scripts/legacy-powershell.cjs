'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const commit = '2e924647957cc631e33ae099fefb56391e86afc4';
const name = 'WiFiMeter-1.1.1-PowerShell-windows-Portable.zip';

function verify(directory) {
    const manifest = JSON.parse(fs.readFileSync(path.join(directory, 'manifest.json'), 'utf8').replace(/^\uFEFF/, ''));
    for (const [key, value] of Object.entries({ tag: 'v1.1.1', commit, version: '1.1.1', runtime: 'PowerShell', name })) {
        assert.equal(manifest[key], value, `旧版附件 ${key} 不匹配`);
    }
    const file = path.resolve(directory, name);
    const bytes = fs.readFileSync(file);
    assert.ok(bytes.length > 0, '旧版附件为空');
    assert.equal(bytes.length, manifest.size);
    assert.equal(crypto.createHash('sha256').update(bytes).digest('hex'), manifest.sha256);
    return file;
}

// 单独追加附件，不改变 Electron 的矩阵、版本或命名校验。
if (require.main === module) {
    const [directory, list] = process.argv.slice(2);
    const file = verify(directory);
    assert.ok(!/[\r\n]/.test(file));
    const existing = fs.readFileSync(list, 'utf8');
    assert.ok(existing.endsWith('\n'), '安装包列表必须以换行结尾');
    assert.ok(!existing.split('\n').includes(file), '附件重复');
    fs.appendFileSync(list, file + '\n');
    console.log(`Verified 1.1.1 / PowerShell: ${file}`);
}
module.exports = { verify, name, commit };
