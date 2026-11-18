'use strict';

const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const { spawn } = require('node:child_process');
const { promisify } = require('node:util');
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
function createCloudBackup({ userData, request, restore, logs = () => '', device = os.hostname(), io = fs, secrets = systemSecrets,
    createClient = createWebdavClient, now = () => new Date(), timers = globalThis, logger = () => {}, onChange = () => {} }) {
    const file = path.join(userData, 'cloud-backup.json');
    const restorePoint = path.join(userData, 'before-cloud-restore.json.gz');
    let config = null, busy = '', timer = null;

    async function load() {
        if (config) return config;
        try { config = { ...DEFAULTS, ...JSON.parse(await io.readFile(file, 'utf8')) }; }
        catch { config = { ...DEFAULTS }; }
        config.sections = selection.normalizeSections(config.sections);
        return config;
    }
    async function save(next) {
        config = next;
        await io.writeFile(file, JSON.stringify(config), { encoding: 'utf8', mode: 0o600 });
    }
    const publicState = () => {
        const { secret, ...rest } = config;
        return { ...rest, hasPassword: Boolean(secret), device: selection.safeDevice(device), busy };
    };
    async function client() {
        await load();
        if (!config.url) throw Error('请先填写 WebDAV 地址。');
        return createClient({ url: config.url, username: config.username, password: config.secret ? await secrets.reveal(config.secret) : '' });
    }
    // One operation at a time; a second request reports what is already running.
    async function exclusive(name, work) {
        await load();
        if (busy) throw Error('另一项云备份操作正在进行。');
        busy = name; onChange(publicState());
        try { return await work(); }
        finally { busy = ''; onChange(publicState()); }
    }
    async function packed() {
        const { backup } = await request('backup');
        const document = selection.selectBackup(backup, { sections: config.sections, days: config.days, device: selection.safeDevice(device),
            logs: config.sections.includes('logs') ? logs() : '', now: now() });
        const bytes = await gzip(Buffer.from(JSON.stringify(document), 'utf8'));
        if (bytes.length > MAX_BACKUP_BYTES) throw Error('备份超过 512 MiB，未上传。');
        return { document, bytes };
    }
    async function listFiles(remote) {
        const own = selection.safeDevice(device);
        return (await remote.list()).map(entry => ({ ...entry, ...selection.parseBackupFileName(entry.name) }))
            .filter(entry => entry.device).map(entry => ({ ...entry, own: entry.device === own }))
            .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    }
    async function backupNow() {
        const remote = await client();
        try {
            const { document, bytes } = await packed();
            await remote.ensureDirectory();
            const name = selection.backupFileName(device, now());
            await remote.upload(name, bytes);
            for (const expired of selection.expiredBackups(await remote.list(), device, config.keep)) await remote.remove(expired);
            await save({ ...config, lastBackupAt: now().toISOString(), lastError: '' });
            logger('info', `已上传云备份 ${name}（${bytes.length} 字节）`);
            return { name, size: bytes.length, ...selection.summarize(document) };
        } catch (error) {
            await save({ ...config, lastError: error.message }).catch(() => {});
            logger('error', `云备份失败：${error.message}`);
            throw error;
        }
    }
    async function autoBackup() {
        await load();
        if (!config.auto || !config.url || busy) return;
        const last = Date.parse(config.lastBackupAt);
        if (Number.isFinite(last) && now().getTime() - last < INTERVALS[config.interval]) return;
        await exclusive('backup', backupNow).catch(() => { /* Recorded in lastError and the log; the next check retries. */ });
    }

    return {
        async status() { await load(); return publicState(); },
        // `password` undefined keeps the saved one; an empty string removes it.
        async configure(patch = {}) {
            await load();
            const next = validConfig(patch, config);
            if (next.url) createClient({ url: next.url });
            if (patch.password !== undefined) next.secret = patch.password ? await secrets.protect(String(patch.password)) : '';
            await save(next);
            onChange(publicState());
            return publicState();
        },
        test: () => exclusive('test', async () => {
            const remote = await client();
            await remote.ensureDirectory();
            return { backups: (await listFiles(remote)).length };
        }),
        estimate: () => exclusive('estimate', async () => { await load(); const { document, bytes } = await packed(); return { size: bytes.length, ...selection.summarize(document) }; }),
        backup: () => exclusive('backup', backupNow),
        list: () => exclusive('list', async () => listFiles(await client())),
        remove: name => exclusive('remove', async () => {
            if (!selection.parseBackupFileName(name)) throw Error('不是 WiFiMeter 的备份文件。');
            await (await client()).remove(name);
        }),
        // Replaces what the chosen backup contains, after saving the current data as a local restore point.
        restore: name => exclusive('restore', async () => {
            if (!selection.parseBackupFileName(name)) throw Error('不是 WiFiMeter 的备份文件。');
            const remote = await client();
            const cloud = selection.validateCloudBackup(JSON.parse((await gunzip(await remote.download(name, MAX_BACKUP_BYTES))).toString('utf8')));
            const { backup } = await request('backup');
            await io.writeFile(restorePoint, await gzip(Buffer.from(JSON.stringify(backup), 'utf8')), { mode: 0o600 });
            await restore(selection.mergeBackup(backup, cloud));
            logger('info', `已从云备份 ${name} 恢复`);
            return { ...selection.summarize(cloud), restorePoint };
        }),
        start() {
            if (timer) return;
            timer = timers.setInterval(() => { autoBackup().catch(() => {}); }, CHECK_EVERY);
            timer.unref?.();
            autoBackup().catch(() => {});
        },
        stop() { if (timer) timers.clearInterval(timer); timer = null; },
        autoBackup
    };
}

module.exports = { createCloudBackup, INTERVALS };
