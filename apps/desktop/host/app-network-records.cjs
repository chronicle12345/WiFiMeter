'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const MAX_RECORDS = 5000;
const MAX_SNAPSHOT_BYTES = 4 * 1024 * 1024;
const clone = value => JSON.parse(JSON.stringify(value));
const restricted = state => ['Blocked', 'InboundBlocked', 'OutboundBlocked', 'Throttled', 'DownloadThrottled'].some(field => state[field] === true)
    || (Number.isFinite(state.FirewallRuleCount) && state.FirewallRuleCount > 0);
// 旧版缺少方向和规则数量字段仍可解除；新版返回 null 时保留未知状态。
const cleared = state => ['Blocked', 'Throttled', 'DownloadThrottled'].every(field => state[field] === false)
    && ['InboundBlocked', 'OutboundBlocked'].every(field => !Object.hasOwn(state, field) || state[field] === false)
    && (!Object.hasOwn(state, 'FirewallRuleCount') || state.FirewallRuleCount === 0)
    && !state.FirewallError && !state.FirewallErrorCode && !state.QosError && !state.QosErrorCode && !state.DownloadError && !state.DownloadErrorCode;

function validateRecordSnapshot(snapshot, validatePath) {
    if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot) || snapshot.version !== 1 || !Array.isArray(snapshot.records)
        || Object.keys(snapshot).some(key => !['version', 'records'].includes(key))) throw Error('应用限制记录格式无效。');
    if (snapshot.records.length > MAX_RECORDS) throw Error('应用限制记录超过大小或条数上限。');
    const keys = new Set();
    const booleans = ['Blocked', 'InboundBlocked', 'OutboundBlocked', 'Throttled', 'DownloadThrottled', 'QosSupported', 'ExactPathQosVerified', 'DownloadSupported'];
    const numbers = ['FirewallRuleCount', 'UploadKbps', 'DownloadKbps'];
    const strings = ['Path', 'FirewallError', 'FirewallErrorCode', 'QosError', 'QosErrorCode', 'DownloadError', 'DownloadErrorCode', 'Scope', 'Warning'];
    for (const record of snapshot.records) {
        if (!record || typeof record !== 'object' || Array.isArray(record)
            || Object.keys(record).some(key => !['path', 'name', 'savedAt', 'state', 'operationError'].includes(key))
            || typeof record.path !== 'string' || record.path.length > 4096 || validatePath(record.path) !== record.path
            || typeof record.name !== 'string' || record.name.length > 1024 || typeof record.savedAt !== 'string' || record.savedAt.length > 40
            || !Number.isFinite(Date.parse(record.savedAt)) || new Date(record.savedAt).toISOString() !== record.savedAt
            || !record.state || typeof record.state !== 'object' || Array.isArray(record.state)
            || keys.has(record.path.toLowerCase())) throw Error('应用限制记录格式无效。');
        for (const [field, value] of Object.entries(record.state)) {
            if ((!booleans.includes(field) && !numbers.includes(field) && !strings.includes(field))
                || (value != null && booleans.includes(field) && typeof value !== 'boolean')
                || (value != null && numbers.includes(field) && (typeof value !== 'number' || !Number.isFinite(value) || value < 0
                    || (field === 'FirewallRuleCount' && !Number.isSafeInteger(value)) || (field !== 'FirewallRuleCount' && value > 1000000000)))
                || (value != null && strings.includes(field) && (typeof value !== 'string' || value.length > 8192))) throw Error('应用限制记录状态无效。');
        }
        if (record.operationError != null && (!record.operationError || typeof record.operationError !== 'object' || Array.isArray(record.operationError)
            || Object.keys(record.operationError).some(key => !['code', 'message'].includes(key))
            || typeof record.operationError.code !== 'string' || record.operationError.code.length > 128
            || typeof record.operationError.message !== 'string' || record.operationError.message.length > 8192)) throw Error('应用限制记录格式无效。');
        keys.add(record.path.toLowerCase());
    }
    const body = JSON.stringify(snapshot);
    if (Buffer.byteLength(body, 'utf8') > MAX_SNAPSHOT_BYTES) throw Error('应用限制记录超过大小或条数上限。');
    return JSON.parse(body);
}

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
        parsed = validateRecordSnapshot(parsed, validatePath);
        records = parsed.records;
    }

    async function save(next) {
        next = validateRecordSnapshot({ version: 1, records: next }, validatePath).records;
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
        snapshot: () => serial(async () => { await load(); return validateRecordSnapshot({ version: 1, records }, validatePath); }),
        validate: snapshot => validateRecordSnapshot(snapshot, validatePath),
        restore: snapshot => serial(async () => { const next = validateRecordSnapshot(snapshot, validatePath); await save(next.records); }),
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

module.exports = { createAppNetworkRecords, validateRecordSnapshot, MAX_RECORDS, MAX_SNAPSHOT_BYTES };
