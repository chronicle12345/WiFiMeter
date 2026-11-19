'use strict';

const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const { spawn } = require('node:child_process');
const { promisify } = require('node:util');
const { randomUUID } = require('node:crypto');
const { validateLogSnapshot } = require('./logs.cjs');
const { createWebdavClient } = require('./webdav.cjs');
const { MAX_BACKUP_BYTES } = require('./files.cjs');
const selection = require('./backup-selection.cjs');

const gzip = promisify(zlib.gzip), gunzip = promisify(zlib.gunzip);
const INTERVALS = { hourly: 3600e3, daily: 86400e3, weekly: 7 * 86400e3 };
const CHECK_EVERY = 10 * 60e3;
const DEFAULTS = { url: '', username: '', secret: '', sections: selection.DEFAULT_SECTIONS, days: 90, auto: false, interval: 'daily', keep: 10,
    lastBackupAt: '', lastError: '' };

// Windows protects the password with DPAPI for the current user. The value travels over stdin,
// never on the command line. Other platforms rely on the 0600 mode of the settings file.
function runDpapi(method, input) {
    const powershell = path.win32.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    const script = `Add-Type -AssemblyName System.Security; $in=[Convert]::FromBase64String([Console]::In.ReadToEnd().Trim()); `
        + `[Convert]::ToBase64String([Security.Cryptography.ProtectedData]::${method}($in,$null,'CurrentUser'))`;
    return new Promise((resolve, reject) => {
        const child = spawn(powershell, ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] });
        let output = '';
        child.stdout.on('data', chunk => { output += chunk; });
        child.on('error', reject);
        child.on('close', code => (code === 0 && output.trim() ? resolve(output.trim()) : reject(Error('无法使用系统凭据保护保存密码。'))));
        child.stdin.end(input);
    });
}
const systemSecrets = process.platform === 'win32' ? {
    protect: async text => 'dpapi:' + await runDpapi('Protect', Buffer.from(text, 'utf8').toString('base64')),
    reveal: async stored => Buffer.from(await runDpapi('Unprotect', stored.slice(6)), 'base64').toString('utf8')
} : {
    protect: async text => 'plain:' + Buffer.from(text, 'utf8').toString('base64'),
    reveal: async stored => Buffer.from(stored.slice(6), 'base64').toString('utf8')
};

function validConfig(patch, current) {
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw Error('云备份设置无效。');
    const next = { ...current };
    if (patch.url !== undefined) next.url = String(patch.url).trim().slice(0, 2048);
    if (patch.username !== undefined) next.username = String(patch.username).slice(0, 256);
    if (patch.sections !== undefined) next.sections = selection.normalizeSections(patch.sections);
    if (patch.days !== undefined) { const days = Number(patch.days); if (!Number.isInteger(days) || days < 0 || days > 3650) throw Error('备份天数须为 0 到 3650 的整数。'); next.days = days; }
    if (patch.keep !== undefined) { const keep = Number(patch.keep); if (!Number.isInteger(keep) || keep < 1 || keep > 100) throw Error('保留份数须为 1 到 100 的整数。'); next.keep = keep; }
    if (patch.interval !== undefined) { if (!Object.hasOwn(INTERVALS, patch.interval)) throw Error('不支持的同步间隔。'); next.interval = patch.interval; }
    if (patch.auto !== undefined) next.auto = patch.auto === true;
    if (!next.sections.length) throw Error('请至少选择一项备份内容。');
    return next;
}

/**
 * WebDAV backup of a chosen part of the data.
 * request(method, params) talks to the backend; restore(document) replaces the local data and applies its side effects.
 */
function createCloudBackup({ userData, request, restore, logs = () => '', hostSettings = null, logStore = null,
    withRestore = work => work(), device = os.hostname(), io = fs, secrets = systemSecrets,
    createClient = createWebdavClient, now = () => new Date(), timers = globalThis, logger = () => {}, onChange = () => {},
    maxBackupBytes = MAX_BACKUP_BYTES }) {
    const file = path.join(userData, 'cloud-backup.json');
    const restorePoint = path.join(userData, 'before-cloud-restore.json.gz');
    let config = null, loading = null, busy = '', timer = null, active = null, stopped = false, autoGeneration = 0;
    let configureQueue = Promise.resolve();

    async function load() {
        if (config) return config;
        if (!loading) loading = (async () => {
            try {
                const saved = JSON.parse(await io.readFile(file, 'utf8'));
                config = validConfig(saved, { ...DEFAULTS });
                config.secret = typeof saved.secret === 'string' && saved.secret.length <= 65536 ? saved.secret : '';
                config.lastBackupAt = typeof saved.lastBackupAt === 'string' ? saved.lastBackupAt : '';
                config.lastError = typeof saved.lastError === 'string' ? saved.lastError.slice(0, 8192) : '';
            } catch { config = { ...DEFAULTS, sections: [...DEFAULTS.sections] }; }
            return config;
        })();
        return loading;
    }
    async function replaceFile(target, body) {
        const temporary = target + '.' + randomUUID() + '.tmp';
        await io.mkdir(userData, { recursive: true });
        try {
            await io.writeFile(temporary, body, { flag: 'wx', mode: 0o600 });
            await io.rename(temporary, target);
        } finally { await io.unlink(temporary).catch(() => {}); }
    }
    async function save(next) {
        await replaceFile(file, JSON.stringify(next));
        config = next;
    }
    const publicState = () => {
        const { secret, ...rest } = config;
        return { ...rest, sections: [...rest.sections], hasPassword: Boolean(secret), device: selection.safeDevice(device), busy };
    };
    const notify = () => { try { onChange(publicState()); } catch { /* An unavailable page does not invalidate an operation. */ } };
    const log = (level, message) => { try { logger(level, message); } catch { /* Logging is not a data operation. */ } };
    async function client() {
        await load();
        if (!config.url) throw Error('请先填写 WebDAV 地址。');
        return createClient({ url: config.url, username: config.username, password: config.secret ? await secrets.reveal(config.secret) : '' });
    }
    // Credentials and selection stay stable for the lifetime of every operation, including configure.
    async function exclusive(name, work, { configuration = false } = {}) {
        if (!configuration) await configureQueue;
        await load();
        if (busy) throw Error('另一项云备份操作正在进行。');
        busy = name; notify();
        const operation = Promise.resolve().then(work);
        active = operation;
        try { return await operation; }
        finally { if (active === operation) active = null; busy = ''; notify(); }
    }
    async function encode(document) {
        const body = Buffer.from(JSON.stringify(document), 'utf8');
        if (body.length > maxBackupBytes) throw Error('备份超过 512 MiB，未写入或读取文件。');
        const bytes = await gzip(body);
        if (bytes.length > maxBackupBytes) throw Error('备份超过 512 MiB，未上传。');
        return bytes;
    }
    async function packed() {
        const { backup } = await request('backup');
        const document = selection.selectBackup(backup, { sections: config.sections, days: config.days, device: selection.safeDevice(device),
            logs: config.sections.includes('logs') ? (logStore ? await logStore.snapshot() : logs()) : '',
            hostSettings: config.sections.includes('settings') ? await hostSettings?.snapshot() : undefined, now: now() });
        return { document, bytes: await encode(document) };
    }
    async function listFiles(remote) {
        const own = selection.safeDevice(device);
        return (await remote.list()).map(entry => ({ ...entry, ...selection.parseBackupFileName(entry.name) }))
            .filter(entry => entry.device).map(entry => ({ ...entry, own: entry.device === own }))
            .sort(selection.compareBackups);
    }
    async function backupNow(isCurrent = () => true) {
        const remote = await client();
        try {
            const { document, bytes } = await packed();
            if (!isCurrent()) return { canceled: true };
            await remote.ensureDirectory();
            if (!isCurrent()) return { canceled: true };
            const name = selection.backupFileName(device, now());
            await remote.upload(name, bytes);
            for (const expired of selection.expiredBackups(await remote.list(), device, config.keep)) await remote.remove(expired);
            await save({ ...config, lastBackupAt: now().toISOString(), lastError: '' });
            log('info', '已上传云备份 ' + name + '（' + bytes.length + ' 字节）');
            return { name, size: bytes.length, ...selection.summarize(document) };
        } catch (error) {
            await save({ ...config, lastError: error.message }).catch(() => {});
            log('error', '云备份失败：' + error.message);
            throw error;
        }
    }
    function automaticDue(generation) {
        if (stopped || generation !== autoGeneration || !config.auto || !config.url) return false;
        const last = Date.parse(config.lastBackupAt);
        return !Number.isFinite(last) || now().getTime() - last >= INTERVALS[config.interval];
    }
    async function autoBackup() {
        const generation = autoGeneration;
        await load();
        if (busy || !automaticDue(generation)) return;
        await exclusive('backup', () => automaticDue(generation) ? backupNow(() => automaticDue(generation)) : { canceled: true })
            .catch(() => { /* The next check retries failures. */ });
    }
    async function validateHost(value) {
        if (value === undefined) return undefined;
        if (!value || typeof value !== 'object' || Array.isArray(value)
            || Object.keys(value).some(key => !['windowPreferences', 'logLevel', 'appNetworkRecords'].includes(key))) throw Error('云备份桌面设置无效。');
        if (!hostSettings?.validate || !hostSettings?.restore || !hostSettings?.snapshot) throw Error('当前版本无法恢复这份备份的桌面设置。');
        return await hostSettings.validate(value) ?? value;
    }
    async function validateLogs(value) {
        if (value === undefined) return undefined;
        const snapshot = validateLogSnapshot(value, now());
        if (!logStore?.restore || !logStore?.snapshot) throw Error('当前版本无法恢复这份备份的日志。');
        return logStore.validate ? await logStore.validate(snapshot) : snapshot;
    }
    async function restoreCloud(name) {
        if (!selection.parseBackupFileName(name)) throw Error('不是 WiFiMeter 的备份文件。');
        const remote = await client(), compressed = await remote.download(name, maxBackupBytes);
        if (compressed.length > maxBackupBytes) throw Error('WebDAV 备份文件过大。');
        let body;
        try { body = await gunzip(compressed, { maxOutputLength: maxBackupBytes }); }
        catch (error) {
            if (error.code === 'ERR_BUFFER_TOO_LARGE') throw Error('备份解压后超过 512 MiB，未恢复。', { cause: error });
            throw error;
        }
        const cloud = selection.validateCloudBackup(JSON.parse(body.toString('utf8')));
        return restoreDocument(cloud, { fromCloud: true, name });
    }
    async function withPausedCollection(work) {
        const original = await request('hello');
        if (typeof original?.paused !== 'boolean') throw Error('无法确认原采集状态，未恢复备份。');
        try {
            const frozen = await request('setPaused', { paused: true });
            if (frozen?.paused !== true) throw Error('无法暂停采集，未恢复备份。');
            return await work();
        } catch (error) {
            // Incomplete data recovery must stay paused. Successful recovery or a pre-mutation failure can resume the original state.
            if (error.code === 'cloudRestoreFailed' && error.rollbackErrors?.length) throw error;
            try {
                const resumed = await request('setPaused', { paused: original.paused });
                if (resumed?.paused !== original.paused) throw Error('采集状态确认失败。');
            } catch (recovery) {
                const message = error.message + ' 原采集状态未能恢复：' + recovery.message
                    + (error.restorePoint ? '。本地恢复点：' + error.restorePoint : '');
                const reported = Object.assign(Error(message, { cause: error }), {
                    code: 'cloudRestoreFailed', restorePoint: error.restorePoint,
                    rollbackErrors: [...(error.rollbackErrors ?? []), recovery.message]
                });
                await save({ ...config, lastError: message }).catch(() => {});
                log('error', message);
                throw reported;
            }
            throw error;
        }
    }

    async function restoreDocument(document, { fromCloud = false, name = '' } = {}) {
        if (fromCloud) selection.validateCloudBackup(document);
        else if (!document || typeof document !== 'object' || Array.isArray(document) || document.backupType !== selection.FULL_TYPE) throw Error('这不是 WiFiMeter 的完整备份文件。');
        // All host-owned input is validated before the backend can replace any data.
        const hostPatch = await validateHost(document.hostSettings), logPatch = await validateLogs(document.logs);
        return withRestore(() => withPausedCollection(async () => {
            const { backup } = await request('backup');
            const currentHost = await hostSettings?.snapshot(), currentLogs = logStore ? await logStore.snapshot() : undefined;
            const point = { ...backup, ...(currentHost === undefined ? {} : { hostSettings: currentHost }), ...(currentLogs === undefined ? {} : { logs: currentLogs }) };
            const merged = fromCloud ? selection.mergeBackup(backup, document) : document;
            const { hostSettings: _host, logs: _logs, ...backendBackup } = merged;
            await replaceFile(restorePoint, await encode(point));
            let hostAttempted = false, logsAttempted = false, result;
            try {
                result = await restore(backendBackup);
                if (hostPatch !== undefined) { hostAttempted = true; await hostSettings.restore(hostPatch); }
                if (logPatch !== undefined) { logsAttempted = true; await logStore.restore(logPatch); }
            } catch (error) {
                const failures = [];
                // C++ invalidParams is a non-committing rejection. Re-restoring would discard its retained pending samples.
                const rejectedBeforeMutation = error.code === 'invalidParams' && !hostAttempted && !logsAttempted;
                if (!rejectedBeforeMutation) { try { await restore(backup); } catch (rollback) { failures.push(rollback.message); } }
                if (hostAttempted) { try { await hostSettings.restore(currentHost); } catch (rollback) { failures.push(rollback.message); } }
                if (logsAttempted) { try { await logStore.restore(currentLogs); } catch (rollback) { failures.push(rollback.message); } }
                const message = failures.length
                    ? '云备份恢复失败，回滚未完成：' + error.message + '；' + failures.join('；') + '。本地恢复点：' + restorePoint
                    : rejectedBeforeMutation ? '云备份内容无效，原数据已保留：' + error.message
                        : '云备份恢复失败，已恢复原数据：' + error.message;
                const reported = Object.assign(Error(message, { cause: error }), { code: 'cloudRestoreFailed', restorePoint, rollbackErrors: failures });
                await save({ ...config, lastError: message }).catch(() => {});
                log('error', message);
                throw reported;
            }
            log('info', fromCloud ? '已从云备份 ' + name + ' 恢复' : '已从本地备份恢复');
            return fromCloud ? { ...selection.summarize(document), restorePoint } : { ...result, restorePoint };
        }));
    }

    return {
        async status() { await load(); return publicState(); },
        // Undefined password keeps the saved one; an empty string removes it.
        configure(patch = {}) {
            if (busy && busy !== 'configure') return Promise.reject(Error('另一项云备份操作正在进行。'));
            const captured = patch && typeof patch === 'object' && !Array.isArray(patch)
                ? { ...patch, ...(Array.isArray(patch.sections) ? { sections: [...patch.sections] } : {}) } : patch;
            const operation = configureQueue.then(() => exclusive('configure', async () => {
                const next = validConfig(captured, config);
                if (next.url) createClient({ url: next.url });
                if (captured.password !== undefined) next.secret = captured.password ? await secrets.protect(String(captured.password)) : '';
                await save(next);
                return { ...publicState(), busy: '' };
            }, { configuration: true }));
            configureQueue = operation.catch(() => {});
            return operation;
        },
        test: () => exclusive('test', async () => {
            const remote = await client();
            await remote.ensureDirectory();
            return { backups: (await listFiles(remote)).length };
        }),
        estimate: () => exclusive('estimate', async () => { const { document, bytes } = await packed(); return { size: bytes.length, ...selection.summarize(document) }; }),
        backup: () => exclusive('backup', backupNow),
        list: () => exclusive('list', async () => listFiles(await client())),
        remove: name => exclusive('remove', async () => {
            if (!selection.parseBackupFileName(name)) throw Error('不是 WiFiMeter 的备份文件。');
            await (await client()).remove(name);
        }),
        restore: name => exclusive('restore', () => restoreCloud(name)),
        restoreDocument: document => exclusive('restore', () => restoreDocument(document)),
        start() {
            if (timer) return;
            stopped = false; autoGeneration++;
            timer = timers.setInterval(() => { autoBackup().catch(() => {}); }, CHECK_EVERY);
            timer.unref?.();
            autoBackup().catch(() => {});
        },
        stop() { stopped = true; autoGeneration++; if (timer) timers.clearInterval(timer); timer = null; },
        async waitForIdle() {
            let tail;
            do { tail = configureQueue; await tail; if (active) await active.catch(() => {}); }
            while (tail !== configureQueue || active);
        },
        autoBackup
    };
}

module.exports = { createCloudBackup, INTERVALS };
