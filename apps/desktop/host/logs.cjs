'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

const LEVELS = ['debug', 'info', 'warn', 'error'];
const DEFAULT_LEVEL = 'info';
const MAX_FILE_BYTES = 1024 * 1024;
const MAX_MESSAGE_LENGTH = 2000;
const MAX_READ_ENTRIES = 2000;
const MAX_SNAPSHOT_BYTES = 2 * MAX_FILE_BYTES + 1024;
const MAX_SNAPSHOT_ENTRIES = 40000;

const rank = level => LEVELS.indexOf(level);
const validLevel = level => (LEVELS.includes(level) ? level : DEFAULT_LEVEL);

function validateLogLevel(level) {
    if (!LEVELS.includes(level)) throw Error('Unsupported log level.');
    return level;
}

function validateEntry(row) {
    if (!row || typeof row !== 'object' || Array.isArray(row)
        || Object.keys(row).some(key => !['time', 'level', 'source', 'message'].includes(key))
        || typeof row.time !== 'string' || row.time.length > 40 || !Number.isFinite(Date.parse(row.time))
        || new Date(row.time).toISOString() !== row.time || !LEVELS.includes(row.level)
        || typeof row.source !== 'string' || !row.source.length || row.source.length > 32 || /[\x00-\x1f\x7f]/.test(row.source)
        || typeof row.message !== 'string' || row.message.length > MAX_MESSAGE_LENGTH) throw Error('云备份日志无效。');
    return { time: row.time, level: row.level, source: row.source, message: row.message };
}

// Version-1 cloud archives used the human-readable export, including multiline messages.
function validateLogSnapshot(value, now = new Date()) {
    if (typeof value === 'string') {
        if (Buffer.byteLength(value, 'utf8') > 2 * MAX_FILE_BYTES) throw Error('云备份日志超过大小或条数上限。');
        const rows = [];
        for (const line of value.split('\n')) {
            const match = /^(\S+) +(DEBUG|INFO|WARN|ERROR) +\[([^\]\r\n]{1,32})\] ([\s\S]*)$/.exec(line);
            if (match) rows.push({ time: match[1], level: match[2].toLowerCase(), source: match[3], message: match[4] });
            else if (rows.length) rows[rows.length - 1].message += '\n' + line;
            else if (line) rows.push({ time: now.toISOString(), level: 'info', source: 'backup', message: line });
        }
        value = { version: 1, entries: rows };
    }
    if (!value || typeof value !== 'object' || Array.isArray(value) || value.version !== 1 || !Array.isArray(value.entries)
        || Object.keys(value).some(key => !['version', 'entries'].includes(key))) throw Error('云备份日志无效。');
    if (value.entries.length > MAX_SNAPSHOT_ENTRIES) throw Error('云备份日志超过大小或条数上限。');
    const snapshot = { version: 1, entries: value.entries.map(validateEntry) };
    if (Buffer.byteLength(JSON.stringify(snapshot), 'utf8') > MAX_SNAPSHOT_BYTES) throw Error('云备份日志超过大小或条数上限。');
    return snapshot;
}

// Console lines already carry a "[source] message" prefix; keep that as the entry's source.
function parseLine(text) {
    const match = /^\[([\w-]{1,32})\]\s*/.exec(text);
    return match ? { source: match[1], message: text.slice(match[0].length) } : { source: 'app', message: text };
}

function formatArgument(value) {
    if (value instanceof Error) return value.stack || value.message;
    if (typeof value === 'string') return value;
    try { return JSON.stringify(value); } catch { return String(value); }
}

// JSON-lines log in the user data directory. One previous file is kept when the current one
// reaches the size limit, so the two files together stay under about 2 MiB.
function createLogStore({ directory, io = fs, now = () => new Date(), maxBytes = MAX_FILE_BYTES }) {
    const current = path.join(directory, 'wifimeter.log');
    const previous = path.join(directory, 'wifimeter.previous.log');
    const settingsFile = path.join(directory, 'settings.json');
    let level = DEFAULT_LEVEL, size = 0, ready = false, failed = false;

    function prepare() {
        if (ready || failed) return ready;
        try {
            io.mkdirSync(directory, { recursive: true });
            try { level = validLevel(JSON.parse(io.readFileSync(settingsFile, 'utf8')).level); } catch { /* First run or unreadable settings keep the default level. */ }
            try { size = io.statSync(current).size; } catch { size = 0; }
            ready = true;
        } catch { failed = true; }
        return ready;
    }

    function rotate() {
        // rename replaces the previous file, so no explicit deletion is needed.
        try { io.renameSync(current, previous); } catch { /* A locked file keeps growing until the next attempt. */ }
        size = 0;
    }

    function write(entryLevel, source, message) {
        if (!LEVELS.includes(entryLevel) || !prepare() || rank(entryLevel) < rank(level)) return false;
        const line = JSON.stringify({ time: now().toISOString(), level: entryLevel, source: String(source || 'app').slice(0, 32),
            message: String(message ?? '').slice(0, MAX_MESSAGE_LENGTH) }) + '\n';
        const bytes = Buffer.byteLength(line, 'utf8');
        if (size + bytes > maxBytes) rotate();
        try { io.appendFileSync(current, line, { encoding: 'utf8', mode: 0o600 }); size += bytes; return true; }
        catch { return false; }
    }

    function entries(strict = false) {
        if (!prepare()) return [];
        const rows = [];
        for (const file of [previous, current]) {
            let text;
            try { text = io.readFileSync(file, 'utf8'); }
            catch (error) { if (strict && error.code !== 'ENOENT' && error.message !== 'ENOENT') throw error; continue; }
            for (const line of text.split('\n')) {
                if (!line) continue;
                try {
                    const row = JSON.parse(line);
                    rows.push(validateEntry(row));
                } catch { /* A line cut off by a crash is skipped. */ }
            }
        }
        return rows;
    }

    function replaceFile(file, body) {
        const temporary = file + '.' + randomUUID() + '.tmp';
        try {
            io.writeFileSync(temporary, body, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
            io.renameSync(temporary, file);
        } finally {
            try { io.unlinkSync(temporary); } catch { /* A completed rename already removed the temporary file. */ }
        }
    }

    function restore(snapshot) {
        const { entries: rows } = validateLogSnapshot(snapshot, now());
        if (!prepare()) throw Error('The log directory is not writable.');
        const before = [previous, current].map(file => {
            try { return io.readFileSync(file, 'utf8'); }
            catch (error) { if (error.code === 'ENOENT' || error.message === 'ENOENT') return null; throw error; }
        });
        const lines = rows.map(row => JSON.stringify(row) + '\n');
        let split = lines.length, currentSize = 0;
        while (split > 0 && currentSize + Buffer.byteLength(lines[split - 1], 'utf8') <= maxBytes) {
            currentSize += Buffer.byteLength(lines[--split], 'utf8');
        }
        // A message stays in one file; the previous file can exceed its usual limit by one entry.
        const replacement = [lines.slice(0, split).join(''), lines.slice(split).join('')];
        try {
            replaceFile(previous, replacement[0]);
            replaceFile(current, replacement[1]);
        } catch (error) {
            const failures = [];
            for (const [index, file] of [previous, current].entries()) {
                try {
                    if (before[index] === null) {
                        try { io.unlinkSync(file); }
                        catch (missing) { if (missing.code !== 'ENOENT' && missing.message !== 'ENOENT') throw missing; }
                    } else replaceFile(file, before[index]);
                } catch (rollback) { failures.push(rollback.message); }
            }
            if (failures.length) throw Error('日志恢复失败，回滚未完成：' + error.message + '；' + failures.join('；'), { cause: error });
            throw error;
        }
        size = Buffer.byteLength(replacement[1], 'utf8');
    }

    return {
        get level() { prepare(); return level; },
        write,
        setLevel(next) {
            validateLogLevel(next);
            if (!prepare()) throw Error('The log directory is not writable.');
            replaceFile(settingsFile, JSON.stringify({ level: next }));
            level = next;
            return level;
        },
        snapshot() { if (!prepare()) throw Error('The log directory is not writable.'); return validateLogSnapshot({ version: 1, entries: entries(true) }); },
        validate: value => validateLogSnapshot(value, now()),
        restore,
        // Newest first; `minimum` filters what is shown without changing what is recorded.
        read({ minimum = 'debug', search = '', limit = 500 } = {}) {
            const floor = rank(validLevel(minimum)), needle = String(search || '').trim().toLowerCase();
            const count = Math.max(1, Math.min(Number(limit) || 500, MAX_READ_ENTRIES));
            const matched = entries().filter(row => rank(row.level) >= floor
                && (!needle || `${row.source} ${row.message}`.toLowerCase().includes(needle)));
            return { level, total: matched.length, entries: matched.slice(-count).reverse() };
        },
        text() {
            return entries().map(row => `${row.time} ${row.level.toUpperCase().padEnd(5)} [${row.source}] ${row.message}`).join('\n');
        },
        clear() {
            if (!prepare()) return;
            for (const file of [previous, current]) {
                try { io.truncateSync(file, 0); } catch { /* A missing file is already empty. */ }
            }
            size = 0;
        }
    };
}

// Routes existing console output into the store without changing what the terminal shows.
function captureConsole(store, target = console) {
    const levels = { debug: 'debug', log: 'info', info: 'info', warn: 'warn', error: 'error' };
    // The Tauri host forwards console.log to console.error; record only the outermost call.
    let active = false;
    for (const [method, level] of Object.entries(levels)) {
        const original = target[method].bind(target);
        target[method] = (...args) => {
            if (active) { original(...args); return; }
            active = true;
            try { original(...args); } finally { active = false; }
            const { source, message } = parseLine(args.map(formatArgument).join(' '));
            store.write(level, source, message);
        };
    }
}

module.exports = { LEVELS, MAX_SNAPSHOT_BYTES, MAX_SNAPSHOT_ENTRIES, validateLogLevel, validateLogSnapshot, createLogStore, captureConsole, parseLine };
