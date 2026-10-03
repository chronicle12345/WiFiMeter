import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, copyFile, writeFile, readFile, rm } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';

async function fixture(t) {
    const fixtureRoot = await mkdtemp(path.join(os.tmpdir(), 'wifimeter package entries '));
    t.after(() => rm(fixtureRoot, { recursive: true, force: true }));
    await mkdir(path.join(fixtureRoot, 'packaging'), { recursive: true });
    // 替身只写入 mkdtemp 创建的目录，正式 packaging/tauri.cjs 不参与编辑。
    await writeFile(path.join(fixtureRoot, 'packaging', 'tauri.cjs'), `
        exports.buildDesktop = async platform => {
            const target = platform === 'win32' ? 'windows' : 'linux';
            require('node:fs').appendFileSync(process.env.TEST_LOG, JSON.stringify({ target, args: process.argv.slice(2) }) + '\\n');
            if (process.env.TEST_FAIL === target) process.exitCode = 7;
        };
    `);
    for (const file of ['build-windows.cjs', 'build-linux.cjs', 'build-all.cjs', 'build-windows.sh', 'build-linux.sh', 'build-all.sh', 'targets.cjs', 'build-failure.cjs']) {
        await copyFile(new URL(`../../../packaging/${file}`, import.meta.url), path.join(fixtureRoot, 'packaging', file));
    }
    const log = path.join(fixtureRoot, 'calls.jsonl');
    return {
        run: (entry, args = [], fail = '') => spawnSync(entry.endsWith('.sh') ? path.join(fixtureRoot, 'packaging', entry) : process.execPath,
            entry.endsWith('.sh') ? args : [path.join(fixtureRoot, 'packaging', entry), ...args], {
            cwd: os.tmpdir(), encoding: 'utf8', env: { ...process.env, TEST_LOG: log, TEST_FAIL: fail }
        }),
        calls: async () => (await readFile(log, 'utf8').catch(error => { if (error.code === 'ENOENT') return ''; throw error; })).trim().split('\n').filter(Boolean).map(JSON.parse)
    };
}

test('单端脚本在任意工作目录调用正确构建器，原样传递参数和失败状态', async t => {
    const f = await fixture(t);
    assert.equal(f.run('build-windows.cjs', ['--arch', 'x64', '--formats', 'portable']).status, 0);
    assert.equal(f.run('build-linux.cjs', ['--formats', 'deb'], 'linux').status, 7);
    assert.deepEqual(await f.calls(), [
        { target: 'windows', args: ['--arch', 'x64', '--formats', 'portable'] },
        { target: 'linux', args: ['--formats', 'deb'] }
    ]);
});

test('Shell 入口可直接执行，支持含空格路径、参数转发和失败退出', { skip: process.platform !== 'linux' || process.arch !== 'x64' }, async t => {
    const f = await fixture(t);
    assert.equal(f.run('build-windows.sh', ['--fixture', 'path with spaces']).status, 0);
    assert.equal(f.run('build-linux.sh', ['--formats', 'deb'], 'linux').status, 7);
    assert.equal(f.run('build-all.sh', ['--arch', 'x64']).status, 0);
    assert.equal(f.run('build-all.sh', [], 'windows').status, 7);
    assert.deepEqual(await f.calls(), [
        { target: 'windows', args: ['--fixture', 'path with spaces'] },
        { target: 'linux', args: ['--formats', 'deb'] },
        { target: 'windows', args: ['--arch', 'x64'] },
        { target: 'linux', args: ['--arch', 'x64'] },
        { target: 'windows', args: [] }
    ]);
});

test('两端脚本依次构建，第一端失败后不启动第二端', { skip: process.platform !== 'linux' || process.arch !== 'x64' }, async t => {
    const f = await fixture(t);
    assert.equal(f.run('build-all.cjs', ['--arch', 'x64']).status, 0);
    assert.equal(f.run('build-all.cjs', [], 'windows').status, 7);
    assert.deepEqual((await f.calls()).map(call => call.target), ['windows', 'linux', 'windows']);
});

test('两端脚本在编译前拒绝不兼容格式，不产生半套安装包', async t => {
    const f = await fixture(t);
    assert.notEqual(f.run('build-all.cjs', ['--formats', 'nsis']).status, 0);
    assert.deepEqual(await f.calls(), []);
});
