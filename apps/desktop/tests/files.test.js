import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createFileActions } from '../electron/files.cjs';

test('desktop save and restore round trip UTF-8 content', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'wifimeter-files-'));
    try {
        const file = path.join(dir, 'backup.json');
        const dialogs = {
            showSaveDialog: async () => ({ filePath: file }),
            showOpenDialog: async () => ({ filePaths: [file] })
        };
        const actions = createFileActions(dialogs, () => null);
        const body = '{"name":"家里的 Wi-Fi"}';
        assert.deepEqual(await actions.saveFile({ filename: 'backup.json', body }), { canceled: false });
        assert.equal(await readFile(file, 'utf8'), body);
        assert.equal((await actions.openBackup()).body, body);
        await writeFile(file, Buffer.alloc(8 * 1024 * 1024 + 1));
        assert.match((await actions.openBackup()).error, /8 MiB/);
    } finally { await rm(dir, { recursive: true, force: true }); }
});

test('cancel performs no IO and reports canceled', async () => {
    const dialogs = { showSaveDialog: async () => ({ canceled: true }), showOpenDialog: async () => ({ canceled: true }) };
    const actions = createFileActions(dialogs, () => null, { writeFile() { throw Error('should not write'); } });
    assert.deepEqual(await actions.saveFile({ filename: 'test.csv', body: 'x' }), { canceled: true });
    assert.deepEqual(await actions.openBackup(), { canceled: true });
});

test('write/read failures and unsupported file types return actionable errors', async () => {
    const dialogs = { showSaveDialog: async () => ({ filePath: '/missing/test.csv' }), showOpenDialog: async () => ({ filePaths: ['/missing/test.json'] }) };
    const actions = createFileActions(dialogs, () => null);
    assert.match((await actions.saveFile({ filename: 'test.csv', body: 'x' })).error, /保存失败/);
    assert.match((await actions.openBackup()).error, /无法读取备份/);
    assert.match((await actions.saveFile({ filename: 'run.sh', body: 'x' })).error, /仅支持/);
});
