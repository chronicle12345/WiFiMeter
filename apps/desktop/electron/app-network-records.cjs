'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const clone = value => JSON.parse(JSON.stringify(value));
const restricted = state => ['Blocked', 'Throttled', 'DownloadThrottled'].some(field => state[field] === true);
const cleared = state => ['Blocked', 'Throttled', 'DownloadThrottled'].every(field => state[field] === false)
    && !state.FirewallError && !state.FirewallErrorCode && !state.QosError && !state.QosErrorCode && !state.DownloadError && !state.DownloadErrorCode;

// 仅保存主进程已取得的结果。读取列表不查询系统策略，也不会恢复下载限制。
function createAppNetworkRecords({ userDataDir, validatePath, io = fs } = {}) {
    const filePath = userDataDir ? path.join(userDataDir, 'app-network-records.json') : null;
    let records = null, queue = Promise.resolve();
    const serial = work => {
        const result = queue.then(work);
        queue = result.catch(() => {});
        return result;
    };

    async function load() {
        if (records) return;
        if (!filePath) { records = []; return; }
        let parsed;
        try { parsed = JSON.parse(await io.readFile(filePath, 'utf8')); }
        catch (error) { if (error.code === 'ENOENT') { records = []; return; } throw error; }
        if (parsed?.version !== 1 || !Array.isArray(parsed.records)) throw Error('应用限制记录格式无效。');
        const keys = new Set();
        for (const record of parsed.records) {
            if (!record || typeof record.path !== 'string' || validatePath(record.path) !== record.path
                || typeof record.name !== 'string' || typeof record.savedAt !== 'string' || !Number.isFinite(Date.parse(record.savedAt))
                || !record.state || typeof record.state !== 'object' || Array.isArray(record.state)
                || (record.operationError && (typeof record.operationError.code !== 'string' || typeof record.operationError.message !== 'string'))
                || keys.has(record.path.toLowerCase())) throw Error('应用限制记录格式无效。');
            for (const field of ['Blocked', 'Throttled', 'DownloadThrottled']) {
                if (record.state[field] != null && typeof record.state[field] !== 'boolean') throw Error('应用限制记录状态无效。');
            }
            keys.add(record.path.toLowerCase());
        }
        records = parsed.records;
    }

    async function save(next) {
        if (filePath) {
            const temporary = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
            try {
                await io.mkdir(userDataDir, { recursive: true });
                await io.writeFile(temporary, JSON.stringify({ version: 1, records: next }, null, 2), { encoding: 'utf8', mode: 0o600 });
                await io.rename(temporary, filePath);
            } catch (error) { await io.unlink(temporary).catch(() => {}); throw error; }
        }
        records = next;
    }

    return {
        list: () => serial(async () => { await load(); return clone(records).sort((a, b) => b.savedAt.localeCompare(a.savedAt)); }),
        remember: (program, state, { succeeded = true, mutation = false, operationError } = {}) => serial(async () => {
            await load();
            const index = records.findIndex(record => record.path.toLowerCase() === program.toLowerCase());
            // 主动查询也能补记旧版已设置的路径专属规则；无明确限制时不新增记录。
            if (index === -1 && ((!succeeded && !mutation) || !restricted(state))) return;
            const next = records.slice();
            if (succeeded && cleared(state)) {
                if (index === -1) return;
                next.splice(index, 1);
            } else {
                const record = { path: program, name: index < 0 ? path.win32.basename(program) : records[index].name,
                    state: clone(state), savedAt: new Date().toISOString(),
                    ...(!succeeded && operationError ? { operationError: clone(operationError) } : {}) };
                if (index < 0) next.push(record);
                else next[index] = record;
            }
            await save(next);
        })
    };
}

module.exports = { createAppNetworkRecords };
