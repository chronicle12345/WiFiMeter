const fs = require('node:fs/promises');
const path = require('node:path');

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
                const result = await dialog.showSaveDialog(getWindow(), {
                    title: '保存 WiFiMeter 数据', defaultPath: filename,
                    filters: [{ name: extension.toUpperCase(), extensions: [extension] }]
                });
                if (result.canceled || !result.filePath) return { canceled: true };
                await io.writeFile(result.filePath, payload.body, 'utf8');
                return { canceled: false };
            } catch (error) {
                return { error: `保存失败：${error.message}` };
            }
        },
        async openBackup() {
            try {
                const result = await dialog.showOpenDialog(getWindow(), {
                    title: '恢复 WiFiMeter 演示备份', properties: ['openFile'],
                    filters: [{ name: 'JSON 备份', extensions: ['json'] }]
                });
                if (result.canceled || !result.filePaths.length) return { canceled: true };
                const file = result.filePaths[0];
                if ((await io.stat(file)).size > 8 * 1024 * 1024) throw Error('备份超过 8 MiB。');
                return { body: await io.readFile(file, 'utf8'), canceled: false };
            } catch (error) {
                return { error: `无法读取备份：${error.message}` };
            }
        }
    };
}
module.exports = { createFileActions };
