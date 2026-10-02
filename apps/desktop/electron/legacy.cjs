'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { assertBackupSize } = require('./files.cjs');

function legacyDirectory({ platform = process.platform, env = process.env } = {}) {
    if (env.WIFIMETER_LEGACY_DIRECTORY) return path.resolve(env.WIFIMETER_LEGACY_DIRECTORY);
    if (env.WIFIMETER_USER_DATA || platform !== 'win32' || !env.LOCALAPPDATA) return null;
    return path.join(env.LOCALAPPDATA, 'WiFiMeter', 'data');
}
function digest(value) { return createHash('sha256').update(value).digest('hex'); }
async function readJson(file, optional = false) {
    let raw;
    try {
        const stat = await fs.stat(file);
        if (!stat.isFile() || stat.size > 128 * 1024 * 1024) throw Error('Legacy JSON file exceeds the supported size.');
        raw = await fs.readFile(file, 'utf8');
    } catch (error) { if (optional && error.code === 'ENOENT') return ''; throw error; }
    // Parse only to check syntax. The original text goes to C++ so 64-bit numbers are never rounded.
    try { JSON.parse(raw.replace(/^\uFEFF/, '')); } catch { throw Object.assign(Error(`Invalid legacy JSON: ${path.basename(file)}`), { code: 'LegacyJsonSyntax', raw }); }
    return raw;
}
// 仅缺失或语法损坏时尝试备份；后端语义校验、重叠错误不触发换数据集。
async function readStateCandidate(directory) {
    let primaryError;
    try {
        const raw = await readJson(path.join(directory, 'state.json'));
        return { raw, sourceFile: 'state.json', primaryRaw: raw };
    } catch (error) {
        if (error.code !== 'ENOENT' && error.code !== 'LegacyJsonSyntax') throw error;
        primaryError = error;
    }
    try {
        const raw = await readJson(path.join(directory, 'state.json.bak'));
        return { raw, sourceFile: 'state.json.bak', primaryRaw: primaryError.raw ?? null };
    } catch (error) {
        if (error.code === 'ENOENT') {
            if (primaryError.code === 'ENOENT') return null;
            throw primaryError;
        }
        throw error;
    }
}
async function importLegacyDirectory({ directory, userData, request, allowInitialSettings = false, overlapPolicy = 'reject' }) {
    if (overlapPolicy !== 'reject' && overlapPolicy !== 'keep-existing') throw TypeError('overlapPolicy must be reject or keep-existing.');
    if (!directory) return { found: false };
    let lock;
    try {
        try { lock = await fs.open(path.join(directory, 'collector.lock'), 'r'); }
        catch (error) {
            if (error.code !== 'ENOENT') throw Error('Stop the previous WiFiMeter collector before importing its data.');
        }
        const candidate = await readStateCandidate(directory);
        if (!candidate) return { found: false };
        const stateJson = candidate.raw;
        const settingsJson = await readJson(path.join(directory, 'settings.json'), true);
        const appUsageJson = await readJson(path.join(directory, 'app-usage.json'), true);
        const resolved = path.resolve(directory);
        const sourceId = digest(process.platform === 'win32' ? resolved.toLowerCase() : resolved);
        const identity = digest(stateJson + '\0' + settingsJson + '\0' + appUsageJson);
        const status = await request('migrationStatus', { sourceId });
        const initializeSettings = typeof status.canInitializeSettings === 'boolean' ? status.canInitializeSettings : allowInitialSettings;
        // main 仅在用户明确确认后传入 keep-existing；这里不自动切换策略。
        const payload = { stateJson, sourceId, overlapPolicy, ...(settingsJson ? { settingsJson } : {}), ...(appUsageJson ? { appUsageJson } : {}), ...(initializeSettings ? { allowInitialSettings: true } : {}) };
        if (status.status === 'completed') {
            const previous = await request('importLegacy', payload);
            return { found: true, ...previous, imported: false, alreadyImported: true, sourceFile: candidate.sourceFile };
        }
        const { backup } = await request('backup');
        if (!backup || typeof backup !== 'object') throw Error('No recovery backup was returned by the backend.');
        const backupJson = JSON.stringify(backup);
        assertBackupSize(Buffer.byteLength(backupJson, 'utf8'));
        const parent = path.join(userData, 'migration-backups');
        await fs.mkdir(parent, { recursive: true, mode: 0o700 });
        const archive = await fs.mkdtemp(path.join(parent, identity.slice(0, 16) + '-'));
        await fs.writeFile(path.join(archive, 'sqlite-before.json'), backupJson, { flag: 'wx', mode: 0o600 });
        if (candidate.primaryRaw !== null) await fs.writeFile(path.join(archive, 'state.json'), candidate.primaryRaw, { flag: 'wx', mode: 0o600 });
        if (candidate.sourceFile === 'state.json.bak') await fs.writeFile(path.join(archive, 'state.json.bak'), stateJson, { flag: 'wx', mode: 0o600 });
        if (settingsJson) await fs.writeFile(path.join(archive, 'settings.json'), settingsJson, { flag: 'wx', mode: 0o600 });
        if (appUsageJson) await fs.writeFile(path.join(archive, 'app-usage.json'), appUsageJson, { flag: 'wx', mode: 0o600 });
        // Retain other legacy records verbatim; the old directory itself is never modified.
        for (const file of ['state.json.bak', 'proxy-clients.json', 'app-usage-profiles.json']) {
            if (file === 'state.json.bak' && candidate.sourceFile === file) continue;
            const raw = await fs.readFile(path.join(directory, file)).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
            if (raw) await fs.writeFile(path.join(archive, file), raw, { flag: 'wx', mode: 0o600 });
        }
        const checked = await readStateCandidate(directory);
        if (!checked || checked.sourceFile !== candidate.sourceFile || checked.raw !== stateJson || checked.primaryRaw !== candidate.primaryRaw || await readJson(path.join(directory, 'settings.json'), true) !== settingsJson || await readJson(path.join(directory, 'app-usage.json'), true) !== appUsageJson) {
            throw Error('Legacy data changed during import preparation. Stop the previous collector and retry.');
        }
        const result = await request('importLegacy', payload);
        return { found: true, ...result, imported: result.status === 'completed' && !result.alreadyImported || result.imported === true, sourceFile: candidate.sourceFile, backupDirectory: archive };
    } finally { await lock?.close(); }
}
module.exports = { legacyDirectory, importLegacyDirectory };
