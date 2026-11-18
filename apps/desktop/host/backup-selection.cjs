'use strict';

// Chooses what a cloud backup contains and how a downloaded one is merged into the local data.
// The backend only knows full backups: selection and merging happen on its backup document.

const CLOUD_TYPE = 'wifimeter-cloud-backup';
const FULL_TYPE = 'wifimeter-backend-backup';

// Each section owns document fields. Dated fields are filtered and merged by their `date`.
const SECTIONS = {
    settings: { fields: ['settings', 'proxyConfig'] },
    networks: { fields: ['networks', 'ledgers', 'totalQuota', 'legacyNetworkMappings'] },
    daily: { dated: ['records'] },
    hourly: { dated: ['hourlyRecords'] },
    apps: { dated: ['appRecords', 'proxyApps', 'proxyObservations'] },
    minutes: { dated: ['minuteRecords', 'appMinuteRecords'] }
};
const USAGE_SECTIONS = ['daily', 'hourly', 'apps', 'minutes'];
const DEFAULT_SECTIONS = ['settings', 'networks', 'daily', 'apps'];

// Usage rows refer to networks by key, so any usage section brings the network list with it.
function normalizeSections(sections) {
    const chosen = new Set((Array.isArray(sections) ? sections : DEFAULT_SECTIONS).filter(name => name === 'logs' || Object.hasOwn(SECTIONS, name)));
    if (USAGE_SECTIONS.some(name => chosen.has(name))) chosen.add('networks');
    return [...Object.keys(SECTIONS), 'logs'].filter(name => chosen.has(name));
}

function dayKey(date) {
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

// `days` counts back from today inclusive; 0 keeps the whole history.
function cutoffDay(days, now = new Date()) {
    if (!(days > 0)) return '';
    const start = new Date(now.getFullYear(), now.getMonth(), now.getDate() - (Math.floor(days) - 1));
    return dayKey(start);
}

function selectBackup(full, { sections, days = 0, device = '', logs = '', now = new Date() } = {}) {
    if (full?.backupType !== FULL_TYPE) throw Error('后端没有返回完整备份。');
    const chosen = normalizeSections(sections), from = cutoffDay(days, now);
    const document = { backupType: CLOUD_TYPE, version: 1, sourceVersion: full.version, device, createdAt: now.toISOString(), sections: chosen, from };
    for (const name of chosen) {
        if (name === 'logs') { document.logs = String(logs); continue; }
        for (const field of SECTIONS[name].fields ?? []) if (full[field] !== undefined) document[field] = full[field];
        for (const field of SECTIONS[name].dated ?? []) {
            if (Array.isArray(full[field])) document[field] = from ? full[field].filter(row => row.date >= from) : full[field];
        }
    }
    return document;
}

function summarize(document) {
    const count = field => (Array.isArray(document[field]) ? document[field].length : 0);
    return { device: document.device || '', createdAt: document.createdAt || '', sections: normalizeSections(document.sections), from: document.from || '',
        networks: count('networks'), days: count('records'), hours: count('hourlyRecords'), apps: count('appRecords') };
}

function validateCloudBackup(document) {
    if (!document || typeof document !== 'object' || document.backupType !== CLOUD_TYPE) throw Error('这不是 WiFiMeter 的云备份文件。');
    if (document.version !== 1) throw Error('这份云备份由更新的版本生成，请先升级 WiFiMeter。');
    if (!Array.isArray(document.sections) || (document.from && !/^\d{4}-\d{2}-\d{2}$/.test(document.from))) throw Error('云备份内容不完整。');
    for (const name of normalizeSections(document.sections)) {
        for (const field of SECTIONS[name]?.dated ?? []) {
            if (document[field] !== undefined && (!Array.isArray(document[field]) || document[field].some(row => typeof row?.date !== 'string'))) throw Error('云备份内容不完整。');
        }
    }
    return document;
}

// Replaces what the cloud backup contains and keeps the rest of the local data:
// whole sections for settings and networks, and rows on or after `from` for dated sections.
function mergeBackup(local, cloud) {
    if (local?.backupType !== FULL_TYPE) throw Error('后端没有返回完整备份。');
    validateCloudBackup(cloud);
    const merged = { ...local }, sections = normalizeSections(cloud.sections), from = cloud.from || '';
    for (const name of sections) {
        if (name === 'logs') continue;
        for (const field of SECTIONS[name].fields ?? []) if (cloud[field] !== undefined) merged[field] = cloud[field];
        for (const field of SECTIONS[name].dated ?? []) {
            if (!Array.isArray(cloud[field])) continue;
            const kept = from && Array.isArray(local[field]) ? local[field].filter(row => row.date < from) : [];
            merged[field] = [...kept, ...cloud[field]];
        }
    }
    // Networks known only on this device stay, so its remaining rows still have their network.
    if (sections.includes('networks') && Array.isArray(local.networks) && Array.isArray(cloud.networks)) {
        const restored = new Set(cloud.networks.map(network => network.key));
        merged.networks = [...cloud.networks, ...local.networks.filter(network => !restored.has(network.key))];
        if (Array.isArray(local.ledgers) && Array.isArray(cloud.ledgers)) {
            merged.ledgers = [...cloud.ledgers, ...local.ledgers.filter(ledger => !restored.has(ledger.networkId))];
        }
    }
    return merged;
}

const FILE_PATTERN = /^wifimeter_(.+)_(\d{8}T\d{6}Z)\.json\.gz$/;
const safeDevice = name => String(name || 'device').replace(/[^\w.-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'device';
const stampOf = date => date.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
const backupFileName = (device, now = new Date()) => `wifimeter_${safeDevice(device)}_${stampOf(now)}.json.gz`;

function parseBackupFileName(name) {
    const match = FILE_PATTERN.exec(name);
    if (!match) return null;
    const [, device, stamp] = match;
    const iso = `${stamp.slice(0, 4)}-${stamp.slice(4, 6)}-${stamp.slice(6, 8)}T${stamp.slice(9, 11)}:${stamp.slice(11, 13)}:${stamp.slice(13, 15)}Z`;
    return Number.isFinite(Date.parse(iso)) ? { device, createdAt: new Date(iso).toISOString() } : null;
}

// This device's backups beyond the newest `keep`, oldest first; other devices' files are never touched.
function expiredBackups(files, device, keep) {
    if (!(keep > 0)) return [];
    const own = files.map(file => ({ ...file, ...parseBackupFileName(file.name) })).filter(file => file.device === safeDevice(device));
    return own.sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(Math.floor(keep)).reverse().map(file => file.name);
}

module.exports = { CLOUD_TYPE, FULL_TYPE, SECTIONS, DEFAULT_SECTIONS, normalizeSections, cutoffDay, selectBackup, summarize,
    validateCloudBackup, mergeBackup, safeDevice, backupFileName, parseBackupFileName, expiredBackups };
