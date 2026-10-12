'use strict';

// 用真实文件、子进程和本地 HTTP 流验证业务依赖，避免只检查函数名称。
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const tls = require('node:tls');
const http = require('node:http');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { pipeline } = require('node:stream/promises');
const { createWriteStream } = require('node:fs');

async function check() {
    assert.equal(process.features.tls, true);
    assert.ok(tls.rootCertificates.length > 100, '必须保留 Node 的公开 TLS 根证书。');
    assert.deepEqual(Intl.Collator.supportedLocalesOf(['en-US', 'zh-CN', 'zh-TW']), ['en-US', 'zh-CN', 'zh-TW']);
    assert.deepEqual(['张', '阿', '波'].sort((left, right) => left.localeCompare(right, 'zh-CN')), ['阿', '波', '张']);
    assert.equal(crypto.createHash('sha256').update('abc').digest('hex'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    assert.match(crypto.randomUUID(), /^[a-f0-9-]{36}$/);
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'wifimeter-node-runtime-'));
    let server;
    try {
        const temporary = path.join(directory, 'preferences.tmp'), saved = path.join(directory, 'preferences.json');
        const handle = await fs.open(temporary, 'wx');
        await handle.writeFile(JSON.stringify({ name: '无线网络', bytes: '18446744073709551615' }));
        await handle.sync();
        await handle.close();
        await fs.rename(temporary, saved);
        assert.equal(JSON.parse(await fs.readFile(saved, 'utf8')).bytes, '18446744073709551615');
        const child = await promisify(execFile)(process.execPath, ['-e', 'process.stdout.write(JSON.stringify({ok:true,text:process.argv[1]}))', '中文'], { encoding: 'utf8', windowsHide: true });
        assert.deepEqual(JSON.parse(child.stdout), { ok: true, text: '中文' });
        server = http.createServer((_request, response) => { response.writeHead(200, { 'content-type': 'application/json' }); response.end('{"text":"无线网络"}'); });
        await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
        const response = await fetch(`http://127.0.0.1:${server.address().port}/`, { signal: AbortSignal.timeout(10000) });
        await pipeline(response.body, createWriteStream(path.join(directory, 'download.json'), { flags: 'wx' }));
        assert.equal(JSON.parse(await fs.readFile(path.join(directory, 'download.json'), 'utf8')).text, '无线网络');
        process.stdout.write(`Node ${process.versions.node} runtime checks passed (${process.platform}/${process.arch}).\n`);
    } finally {
        if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
        assert.equal(path.dirname(directory), path.resolve(os.tmpdir()));
        assert.ok(path.basename(directory).startsWith('wifimeter-node-runtime-'));
        await fs.rm(directory, { recursive: true, force: true });
    }
}
check().catch(error => { console.error(error); process.exitCode = 1; });
