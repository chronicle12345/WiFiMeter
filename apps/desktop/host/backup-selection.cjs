'use strict';

const { randomBytes } = require('node:crypto');

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

function selectBackup(full, { sections, days = 0, device = '', logs = '', hostSettings, now = new Date() } = {}) {
    if (full?.backupType !== FULL_TYPE) throw Error('后端没有返回完整备份。');
    const chosen = normalizeSections(sections), from = cutoffDay(days, now);
    const document = { backupType: CLOUD_TYPE, version: 1, sourceVersion: full.version, device, createdAt: now.toISOString(), sections: chosen, from };
    for (const name of chosen) {
        if (name === 'logs') { document.logs = logs; continue; }
        for (const field of SECTIONS[name].fields ?? []) if (full[field] !== undefined) document[field] = full[field];
    }
    for (const field of datedFields(chosen)) {
        if (Array.isArray(full[field])) document[field] = from ? full[field].filter(row => row.date >= from) : full[field];
    }
    if (chosen.includes('settings') && hostSettings !== undefined) document.hostSettings = hostSettings;
    return document;
}

function summarize(document) {
    const count = field => (Array.isArray(document[field]) ? document[field].length : 0);
    return { device: document.device || '', createdAt: document.createdAt || '', sections: normalizeSections(document.sections), from: document.from || '',
        networks: count('networks'), days: count('records'), hours: count('hourlyRecords'), apps: count('appRecords') };
}

function datedFields(sections) {
    const fields = new Set(sections.flatMap(name => SECTIONS[name]?.dated ?? []));
    // Both sections replace the same attribution evidence; process it exactly once.
    if (sections.includes('apps') || sections.includes('minutes')) fields.add('proxyMinuteWeights');
    return [...fields];
}

function validDay(value) {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
    const date = new Date(value + 'T00:00:00Z');
    return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function validateWeights(rows) {
    const keys = new Set(), maximum = 9223372036854775807n;
    const integer = value => typeof value === 'string' && /^(0|[1-9]\d*)$/.test(value) && value.length <= 19 && BigInt(value) <= maximum;
    const identity = value => typeof value === 'string' && value.length > 0 && value !== 'unknown' && value !== 'proxy/unattributed' && !value.includes('\0');
    const nocase = value => value.replace(/[A-Z]/g, character => character.toLowerCase());
    for (const row of rows) {
        if (!row || typeof row !== 'object' || Array.isArray(row)
            || Object.keys(row).some(key => !['date', 'hour', 'minute', 'proxyAppId', 'appId', 'name', 'connections', 'rxBytes', 'txBytes'].includes(key))
            || !validDay(row.date) || !integer(row.hour) || Number(row.hour) > 23 || !integer(row.minute) || Number(row.minute) > 59
            || !identity(row.proxyAppId) || !identity(row.appId) || typeof row.name !== 'string'
            || !integer(row.connections) || row.connections === '0' || !integer(row.rxBytes) || !integer(row.txBytes)) throw Error('云备份内容不完整。');
        const key = JSON.stringify([row.date, row.hour, row.minute, nocase(row.proxyAppId), nocase(row.appId)]);
        if (keys.has(key)) throw Error('云备份内容不完整。');
        keys.add(key);
    }
}

function validateCloudBackup(document) {
    if (!document || typeof document !== 'object' || Array.isArray(document) || document.backupType !== CLOUD_TYPE) throw Error('这不是 WiFiMeter 的云备份文件。');
    if (document.version !== 1) throw Error('这份云备份由更新的版本生成，请先升级 WiFiMeter。');
    if (!Array.isArray(document.sections) || !document.sections.length
        || document.sections.some(name => name !== 'logs' && !Object.hasOwn(SECTIONS, name))
        || (document.from !== undefined && document.from !== '' && !validDay(document.from))) throw Error('云备份内容不完整。');
    const sections = normalizeSections(document.sections);
    if ((document.hostSettings !== undefined && !sections.includes('settings')) || (document.logs !== undefined && !sections.includes('logs'))
        || (document.proxyMinuteWeights !== undefined && !sections.includes('apps') && !sections.includes('minutes'))) throw Error('云备份内容不完整。');
    if (document.hostSettings !== undefined && (!document.hostSettings || typeof document.hostSettings !== 'object' || Array.isArray(document.hostSettings)
        || Object.keys(document.hostSettings).some(key => !['windowPreferences', 'logLevel', 'appNetworkRecords'].includes(key)))) throw Error('云备份桌面设置无效。');
    for (const field of datedFields(sections)) {
        if (document[field] !== undefined && (!Array.isArray(document[field]) || document[field].some(row => !validDay(row?.date)
            || (document.from && row.date < document.from)))) throw Error('云备份内容不完整。');
    }
    if (document.proxyMinuteWeights !== undefined) validateWeights(document.proxyMinuteWeights);
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
    }
    for (const field of datedFields(sections)) {
        // Old archives have no minute evidence for restored app/minute history. Keeping covered local evidence would misattribute it.
        if (!Array.isArray(cloud[field]) && field !== 'proxyMinuteWeights') continue;
        const kept = from && Array.isArray(local[field]) ? local[field].filter(row => row.date < from) : [];
        merged[field] = [...kept, ...(cloud[field] ?? [])];
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

const FILE_PATTERN = /^wifimeter_([\w.-]{1,40})_(\d{8}T\d{6}Z)(?:_([0-9a-z]{8}[0-9a-f]{8}))?\.json\.gz$/;
const safeDevice = name => String(name || 'device').replace(/[^\w.-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'device';
const stampOf = date => date.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
let fileSequence = 0;
const backupFileName = (device, now = new Date()) => {
    // The sequence orders same-second backups in this process; random bytes avoid collisions across restarts.
    const unique = (++fileSequence).toString(36).padStart(8, '0') + randomBytes(4).toString('hex');
    return `wifimeter_${safeDevice(device)}_${stampOf(now)}_${unique}.json.gz`;
};

function parseBackupFileName(name) {
    const match = FILE_PATTERN.exec(name);
    if (!match) return null;
    const [, device, stamp] = match;
    const iso = `${stamp.slice(0, 4)}-${stamp.slice(4, 6)}-${stamp.slice(6, 8)}T${stamp.slice(9, 11)}:${stamp.slice(11, 13)}:${stamp.slice(13, 15)}Z`;
    const date = new Date(iso);
    return Number.isFinite(date.getTime()) && stampOf(date) === stamp && safeDevice(device) === device ? { device, createdAt: date.toISOString() } : null;
}

function compareBackups(a, b) {
    return b.createdAt.localeCompare(a.createdAt) || (a.name === b.name ? 0 : a.name < b.name ? 1 : -1);
}

// This device's backups beyond the newest `keep`, oldest first; other devices' files are never touched.
function expiredBackups(files, device, keep) {
    if (!(keep > 0)) return [];
    const own = files.map(file => ({ ...file, ...parseBackupFileName(file.name) })).filter(file => file.device === safeDevice(device));
    return own.sort(compareBackups).slice(Math.floor(keep)).reverse().map(file => file.name);
}

module.exports = { CLOUD_TYPE, FULL_TYPE, SECTIONS, DEFAULT_SECTIONS, normalizeSections, cutoffDay, selectBackup, summarize,
    validateCloudBackup, mergeBackup, safeDevice, backupFileName, parseBackupFileName, compareBackups, expiredBackups };
