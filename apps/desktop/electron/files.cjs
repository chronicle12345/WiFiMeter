const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

const MAX_BACKUP_BYTES = 512 * 1024 * 1024;
function assertBackupSize(bytes) {
    if (bytes > MAX_BACKUP_BYTES) throw Error('备份超过 512 MiB，未写入或读取文件。');
}

function createFileActions(dialog, getWindow, io = fs) {
    return {
        async saveFile(payload) {
            try {
                if (!payload || typeof payload.filename !== 'string' || typeof payload.body !== 'string') {
                    throw Error('文件内容无效。');
                }
                const filename = path.basename(payload.filename);
                const extension = path.extname(filename).slice(1);
                if (!['csv', 'json'].includes(extension)) throw Error('仅支持 CSV 和 JSON 文件。');
                if (extension === 'json') assertBackupSize(Buffer.byteLength(payload.body, 'utf8'));
                const result = await dialog.showSaveDialog(getWindow(), {
                    title: '保存 WiFiMeter 数据', defaultPath: filename,
                    filters: [{ name: extension.toUpperCase(), extensions: [extension] }]
                });
                if (result.canceled || !result.filePath) return { canceled: true };
                const temporary = path.join(path.dirname(result.filePath), '.wifimeter-' + randomUUID() + '.tmp');
                let handle;
                let ownsTemporary = false;
                try {
                    handle = await io.open(temporary, 'wx', 0o600);
                    ownsTemporary = true;
                    await handle.writeFile(payload.body, 'utf8');
                    await handle.sync();
                    await handle.close();
                    handle = null;
                    // Windows 上目标被占用时 rename 会失败；绝不先删除原备份。
                    await io.rename(temporary, result.filePath);
                    ownsTemporary = false;
                } finally {
                    if (handle) await handle.close().catch(() => {});
                    if (ownsTemporary) await io.unlink(temporary);
                }
                return { canceled: false };
            } catch (error) {
                return { error: `保存失败：${error.message}` };
            }
        },
        async openBackup() {
            try {
                const result = await dialog.showOpenDialog(getWindow(), {
                    title: '恢复 WiFiMeter 备份', properties: ['openFile'],
                    filters: [{ name: 'JSON 备份', extensions: ['json'] }]
                });
                if (result.canceled || !result.filePaths.length) return { canceled: true };
                const file = result.filePaths[0];
                assertBackupSize((await io.stat(file)).size);
                const body = await io.readFile(file, 'utf8');
                assertBackupSize(Buffer.byteLength(body, 'utf8'));
                return { body, canceled: false };
            } catch (error) {
                return { error: `无法读取备份：${error.message}` };
            }
        }
    };
}
module.exports = { createFileActions, MAX_BACKUP_BYTES, assertBackupSize };
