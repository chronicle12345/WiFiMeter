'use strict';

const fs = require('node:fs');
const path = require('node:path');

const LEVELS = ['debug', 'info', 'warn', 'error'];
const DEFAULT_LEVEL = 'info';
const MAX_FILE_BYTES = 1024 * 1024;
const MAX_MESSAGE_LENGTH = 2000;
const MAX_READ_ENTRIES = 2000;

const rank = level => LEVELS.indexOf(level);
const validLevel = level => (LEVELS.includes(level) ? level : DEFAULT_LEVEL);

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

    function entries() {
        if (!prepare()) return [];
        const rows = [];
        for (const file of [previous, current]) {
            let text;
            try { text = io.readFileSync(file, 'utf8'); } catch { continue; }
            for (const line of text.split('\n')) {
                if (!line) continue;
                try {
                    const row = JSON.parse(line);
                    if (LEVELS.includes(row.level) && typeof row.time === 'string') rows.push(row);
                } catch { /* A line cut off by a crash is skipped. */ }
            }
        }
        return rows;
    }

    return {
        get level() { prepare(); return level; },
        write,
        setLevel(next) {
            if (!LEVELS.includes(next)) throw Error('Unsupported log level.');
            if (!prepare()) throw Error('The log directory is not writable.');
            level = next;
            io.writeFileSync(settingsFile, JSON.stringify({ level }), { encoding: 'utf8', mode: 0o600 });
            return level;
        },
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

module.exports = { LEVELS, createLogStore, captureConsole, parseLine };
