'use strict';

const path = require('node:path');

function executablePath(value, platform) {
    if (typeof value !== 'string' || value.length > 4096 || /[\x00-\x1f]/.test(value)) return '';
    if (platform === 'win32') {
        // 仅接受本地盘符路径，不访问 UNC、设备路径、备用数据流或相对路径。
        if (!/^[a-z]:[\\/]/i.test(value) || /[:*?"<>|]/.test(value.slice(2)) || !/\.exe$/i.test(value)) return '';
        if (value.split(/[\\/]/).some(part => part === '..' || part === '.')) return '';
        return path.win32.normalize(value);
    }
    return value.startsWith('/') && !value.startsWith('//') && !value.split('/').includes('..') ? value : '';
}

function validDate(date) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return false;
    const parsed = new Date(date + 'T00:00:00Z');
    return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === date;
}

function createAppIcons({ request, getFileIcon, platform = process.platform, maxEntries = 256 }) {
    const icons = new Map(), snapshots = new Map();
    let active = 0;
    const remember = (map, key, value, limit) => {
        map.delete(key); map.set(key, value);
        while (map.size > limit) map.delete(map.keys().next().value);
        return value;
    };
    function snapshot(date) {
        const month = date.slice(0, 7);
        const cached = snapshots.get(month);
        if (cached && cached.expires > Date.now()) return cached.promise;
        const params = month ? { from: month + '-01', to: month + '-' + new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5)), 0)).getUTCDate() } : {};
        const promise = Promise.resolve().then(() => request('snapshot', params)).then(data => {
            // 只缓存查验图标所需的应用标识和路径，不保留整份流量快照。
            const known = new Map();
            for (const rows of [data.appProcesses || [], data.appRecords || []]) {
                for (const row of rows) {
                    if (known.size >= 4096) break;
                    const file = executablePath(row.path || row.appPath || row.executablePath || row.appId, platform);
                    if (file) known.set(row.appId, file);
                }
            }
            return known;
        });
        remember(snapshots, month, { promise, expires: Date.now() + 5000 }, 8);
        return promise;
    }
    return {
        async get(input) {
            if (!input || typeof input.appId !== 'string' || !input.appId || input.appId.length > 4096 || /[\x00-\x1f]/.test(input.appId)) return null;
            const date = input.date ?? '';
            if (typeof date !== 'string' || (date && !validDate(date))) return null;
            const key = JSON.stringify([input.appId, date]);
            if (icons.has(key)) return icons.get(key);
            // 限制同时进行的系统图标提取和后端查询。
            if (active >= 8) return null;
            active++;
            const promise = (async () => {
                try {
                    const data = await snapshot(date);
                    const file = data.get(input.appId);
                    if (!file) return null;
                    const image = await getFileIcon(file, { size: 'normal' });
                    if (image.isEmpty()) return null;
                    const url = image.toDataURL();
                    return /^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(url) && url.length <= 512 * 1024 ? url : null;
                } catch { return null; }
                finally { active--; }
            })();
            remember(icons, key, promise, maxEntries);
            // 未知记录可能随后出现；失败结果不长期保存在主进程。
            promise.then(value => { if (!value && icons.get(key) === promise) icons.delete(key); });
            return promise;
        }
    };
}

function registerAppIcons({ ipcMain, trusted, app, request }) {
    const icons = createAppIcons({ request, getFileIcon: (file, options) => app.getFileIcon(file, options) });
    ipcMain.handle('app-icons:get', (event, input) => {
        if (!trusted(event)) throw Error('Unsupported page.');
        return icons.get(input);
    });
}

module.exports = { createAppIcons, registerAppIcons };
