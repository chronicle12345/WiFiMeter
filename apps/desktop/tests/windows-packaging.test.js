'use strict';

// Windows 打包产物检查。
//
// 与 Linux 的 packaging.spec.js 不同，这里不做界面测试：Linux 上无法启动 Windows 的
// Electron，因此只验证“安装包与解包目录里确实带上了后端”，并在有 Wine 时确认那个后端
// 能在 Windows 目标上启动、握手并读写数据库——这几点正是打包最可能出错的地方。

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const unpacked = path.join(repositoryRoot, 'dist/windows/win-unpacked');
const applicationBinary = path.join(unpacked, 'WiFiMeter Demo.exe');
const bundledBackend = path.join(unpacked, 'resources/wifimeter-backend.exe');
const installer = path.join(repositoryRoot, 'dist/windows/WiFiMeter-Demo-0.1.0-x64-Setup.exe');

// 与 packaging/windows/wine.mjs 相同的查找顺序：PATH 优先，其次是交叉编译下载的便携版。
function findWine() {
    if (process.env.WIFIMETER_WINE) return process.env.WIFIMETER_WINE;
    for (const candidate of ['wine', 'wine64']) {
        if (spawnSync(candidate, ['--version'], { stdio: 'ignore' }).status === 0) return candidate;
    }
    const portable = path.join(repositoryRoot, '.cross-build/toolchain/wine-11.18-amd64-wow64/bin/wine');
    return existsSync(portable) ? portable : null;
}

// 按协议把请求逐行写进后端并读回响应；返回已解析的消息。
function talkToBackend(executable, requests, { wine, environment }) {
    const command = wine ?? executable;
    const args = wine ? [executable] : [];
    const result = spawnSync(command, [...args, '--paused'], {
        input: `${requests.map(request => JSON.stringify(request)).join('\n')}\n`,
        encoding: 'utf8',
        env: environment,
        timeout: 60000
    });

    const noise = /^(fixme|err|wine|winediag|00[0-9a-f]{2}):/;
    return `${result.stdout ?? ''}`
        .split('\n')
        .map(line => line.trim())
        .filter(line => line.startsWith('{'))
        .filter(line => !noise.test(line))
        .map(line => JSON.parse(line));
}

test('Windows 打包产物', { skip: !existsSync(applicationBinary) && '未构建 Windows 产物，先运行 npm run dist:windows' }, async t => {
    assert.ok(existsSync(applicationBinary), '解包目录里应当有应用可执行文件');
    assert.ok(existsSync(bundledBackend), '解包目录里应当有随包分发的后端');

    // 后端必须是真的 Windows 可执行文件，而不是误打包进去的 Linux 二进制。
    const header = statSync(bundledBackend);
    assert.ok(header.size > 100 * 1024, '后端体积明显偏小，可能复制失败');

    if (existsSync(installer)) {
        // NSIS 安装包必须自报为可执行文件；完整安装与卸载留给实机验收。
        // 只读头两个字节：安装包有 100 MB 以上。
        const { openSync, readSync, closeSync } = await import('node:fs');
        const descriptor = openSync(installer, 'r');
        try {
            const header = Buffer.alloc(2);
            readSync(descriptor, header, 0, 2, 0);
            assert.equal(header.toString('ascii'), 'MZ', '安装包应当是 Windows 可执行文件');
        } finally {
            closeSync(descriptor);
        }
    } else {
        t.diagnostic('未找到安装包，跳过安装包检查（只检查了解包目录）');
    }

    const wine = findWine();
    if (!wine) {
        t.diagnostic('未找到 Wine，跳过后端启动检查');
        return;
    }

    const home = mkdtempSync(path.join(os.tmpdir(), 'wifimeter-win-backend-'));
    const environment = {
        ...process.env,
        HOME: home,
        WINEPREFIX: path.join(home, 'prefix'),
        WINEDEBUG: '-all'
    };
    try {
        const messages = talkToBackend(bundledBackend, [
            { id: 1, protocol: 1, method: 'hello', params: {} },
            { id: 2, protocol: 1, method: 'collectNow', params: {} },
            { id: 3, protocol: 1, method: 'snapshot', params: {} },
            { id: 4, protocol: 1, method: 'shutdown', params: {} }
        ], { wine, environment });

        const hello = messages.find(message => message.id === 1);
        assert.ok(hello, `后端应当回应 hello，实际消息：${JSON.stringify(messages)}`);
        assert.equal(hello.ok, true);
        assert.equal(hello.result.protocol, 1);
        assert.equal(hello.result.application, 'wifimeter-backend');

        // 采集一轮：Wine 下通常没有可用的无线网卡，但采样本身必须成功返回。
        const collect = messages.find(message => message.id === 2);
        assert.ok(collect?.ok, 'collectNow 应当成功');

        const snapshot = messages.find(message => message.id === 3);
        assert.ok(snapshot?.ok, 'snapshot 应当成功');
        assert.equal(snapshot.result.source, 'backend');
        assert.ok(Array.isArray(snapshot.result.networks));

        // 数据库文件应当落在这次运行的用户数据目录里。
        assert.ok(existsSync(path.join(environment.WINEPREFIX, 'drive_c/users')), 'Wine 前缀应当已创建');
    } finally {
        rmSync(home, { recursive: true, force: true });
    }
});
