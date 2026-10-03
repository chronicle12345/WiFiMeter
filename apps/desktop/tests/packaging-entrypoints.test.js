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
        const target = process.argv[2] === 'win32' ? 'windows' : 'linux';
        require('node:fs').appendFileSync(process.env.TEST_LOG, JSON.stringify({ target, args: process.argv.slice(3) }) + '\\n');
        if (process.env.TEST_FAIL === target) process.exitCode = 7;
    `);
    for (const file of ['build-windows.sh', 'build-linux.sh', 'build-all.sh', 'targets.cjs']) {
        await copyFile(new URL(`../../../packaging/${file}`, import.meta.url), path.join(fixtureRoot, 'packaging', file));
    }
    const log = path.join(fixtureRoot, 'calls.jsonl');
    return {
        run: (entry, args = [], fail = '') => spawnSync(path.join(fixtureRoot, 'packaging', entry), args, {
            cwd: os.tmpdir(), encoding: 'utf8', env: { ...process.env, TEST_LOG: log, TEST_FAIL: fail }
        }),
        calls: async () => (await readFile(log, 'utf8').catch(error => { if (error.code === 'ENOENT') return ''; throw error; })).trim().split('\n').filter(Boolean).map(JSON.parse)
    };
}

test('单端 Shell 入口在任意目录正确转发参数，支持空格路径并保留失败状态', { skip: process.platform !== 'linux' }, async t => {
    const f = await fixture(t);
    assert.equal(f.run('build-windows.sh', ['--arch', 'x64', '--formats', 'portable']).status, 0);
    assert.equal(f.run('build-linux.sh', ['--fixture', 'path with spaces'], 'linux').status, 7);
    assert.deepEqual(await f.calls(), [
        { target: 'windows', args: ['--arch', 'x64', '--formats', 'portable'] },
        { target: 'linux', args: ['--fixture', 'path with spaces'] }
    ]);
});

test('双端 Shell 入口依次构建并传递参数，任一端失败均返回失败', { skip: process.platform !== 'linux' || process.arch !== 'x64' }, async t => {
    const f = await fixture(t);
    assert.equal(f.run('build-all.sh', ['--arch', 'x64']).status, 0);
    assert.equal(f.run('build-all.sh', [], 'windows').status, 7);
    assert.equal(f.run('build-all.sh', ['--skip-rebuild'], 'linux').status, 7);
    assert.deepEqual(await f.calls(), [
        { target: 'windows', args: ['--arch', 'x64'] },
        { target: 'linux', args: ['--arch', 'x64'] },
        { target: 'windows', args: [] },
        { target: 'windows', args: ['--skip-rebuild'] },
        { target: 'linux', args: ['--skip-rebuild'] }
    ]);
});

test('两端脚本在编译前拒绝不兼容格式，不产生半套安装包', { skip: process.platform !== 'linux' || process.arch !== 'x64' }, async t => {
    const f = await fixture(t);
    assert.notEqual(f.run('build-all.sh', ['--formats', 'nsis']).status, 0);
    assert.deepEqual(await f.calls(), []);
});
