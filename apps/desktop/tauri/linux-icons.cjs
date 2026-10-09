'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

const MAX_TEXT_BYTES = 64 * 1024, MAX_SOURCE_BYTES = 2 * 1024 * 1024, MAX_PNG_BYTES = 384 * 1024;
const EMPTY_IMAGE = Object.freeze({ isEmpty: () => true, toDataURL: () => '' });
const crcTable = Array.from({ length: 256 }, (_, index) => {
    let value = index;
    for (let bit = 0; bit < 8; bit++) value = (value >>> 1) ^ ((value & 1) ? 0xedb88320 : 0);
    return value >>> 0;
});

function crc32(data) {
    let value = 0xffffffff;
    for (const byte of data) value = (value >>> 8) ^ crcTable[(value ^ byte) & 255];
    return (value ^ 0xffffffff) >>> 0;
}

function validPng(data) {
    if (!Buffer.isBuffer(data) || data.length < 57 || data.length > MAX_PNG_BYTES
        || !data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return false;
    let offset = 8, header = false, pixels = false;
    while (offset + 12 <= data.length) {
        const length = data.readUInt32BE(offset), end = offset + 12 + length;
        if (end > data.length) return false;
        const type = data.toString('ascii', offset + 4, offset + 8);
        if (!/^[A-Za-z]{4}$/.test(type) || data.readUInt32BE(end - 4) !== crc32(data.subarray(offset + 4, end - 4))) return false;
        if (!header) {
            if (type !== 'IHDR' || length !== 13) return false;
            const width = data.readUInt32BE(offset + 8), height = data.readUInt32BE(offset + 12);
            const depths = { 0: [1, 2, 4, 8, 16], 2: [8, 16], 3: [1, 2, 4, 8], 4: [8, 16], 6: [8, 16] };
            if (!width || !height || width > 1024 || height > 1024 || !depths[data[offset + 17]]?.includes(data[offset + 16])
                || data[offset + 18] !== 0 || data[offset + 19] !== 0 || data[offset + 20] > 1) return false;
            header = true;
        } else if (type === 'IHDR') return false;
        if (type === 'IDAT') pixels = true;
        if (type === 'IEND') return length === 0 && pixels && end === data.length;
        offset = end;
    }
    return false;
}

function sections(text) {
    const result = new Map();
    let current;
    for (const line of text.replace(/^\uFEFF/, '').split(/\r?\n/)) {
        const entry = line.trim();
        if (!entry || entry.startsWith('#')) continue;
        if (entry.startsWith('[') && entry.endsWith(']')) {
            current = new Map(); result.set(entry.slice(1, -1), current);
        } else {
            const equal = entry.indexOf('=');
            if (current && equal > 0) current.set(entry.slice(0, equal).trim(), entry.slice(equal + 1).trim());
        }
    }
    return result;
}

function unescapeValue(value = '') {
    return value.replace(/\\([sntr\\])/g, (_match, character) => ({ s: ' ', n: '\n', t: '\t', r: '\r', '\\': '\\' })[character]);
}

// 只解析 Exec 中的程序名，不运行 desktop 文件里的命令。
function executableFromEntry(value = '') {
    const tokens = [];
    let token = '', quoted = false, escaped = false;
    for (const character of unescapeValue(value)) {
        if (escaped) { token += character; escaped = false; }
        else if (character === '\\') escaped = true;
        else if (character === '"') quoted = !quoted;
        else if (/\s/.test(character) && !quoted) { if (token) { tokens.push(token); token = ''; } }
        else token += character;
    }
    if (quoted || escaped) return '';
    if (token) tokens.push(token);
    let index = 0;
    if (path.posix.basename(tokens[0] || '') === 'env') {
        index++;
        while (/^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[index] || '')) index++;
    }
    const executable = tokens[index] || '';
    return executable.includes('%') || /[\0\r\n]/.test(executable) ? '' : executable;
}

const safeName = value => typeof value === 'string' && /^[A-Za-z0-9_.-]{1,255}$/.test(value) && value !== '.' && value !== '..';
const safeDirectory = value => value && value.length <= 512 && !path.isAbsolute(value) && !value.split(/[\\/]/).some(part => !part || part === '..' || part === '.');

function createLinuxFileIcons({ env = process.env, io = fs, executeAsync = promisify(execFile), temporaryRoot = os.tmpdir(), maxDesktopEntries = 2048 } = {}) {
    const home = env.HOME || os.homedir();
    const absolute = value => typeof value === 'string' && path.isAbsolute(value) && !value.includes('\0');
    const dataHome = absolute(env.XDG_DATA_HOME) ? env.XDG_DATA_HOME : path.join(home, '.local', 'share');
    const dataDirs = (env.XDG_DATA_DIRS || '/usr/local/share:/usr/share').split(path.delimiter).filter(absolute).slice(0, 8);
    const applicationRoots = [...new Set([dataHome, ...dataDirs])].map(directory => path.join(directory, 'applications'));
    const iconRoots = [...new Set([path.join(home, '.icons'), path.join(dataHome, 'icons'), ...dataDirs.map(directory => path.join(directory, 'icons'))])];
    const pixmapRoots = [...new Set([dataHome, ...dataDirs])].map(directory => path.join(directory, 'pixmaps'));
    const scanLimit = Math.max(1, Math.min(4096, Number(maxDesktopEntries) || 2048));
    const cache = new Map();
    let desktopCache, desktopExpires = 0, themeCache;

    async function readFile(file, limit) {
        try {
            const info = await io.stat(file);
            if (!info.isFile() || info.size > limit) return null;
            const data = await io.readFile(file);
            return data.length <= limit ? data : null;
        } catch { return null; }
    }

    async function scanApplications() {
        const entries = [], seen = new Set();
        let files = 0, visited = 0, directories = 0;
        async function visit(root, relative = '', depth = 0) {
            if (files >= scanLimit || visited >= 8192 || directories++ >= 256) return;
            let directory;
            try { directory = await io.opendir(path.join(root, relative)); } catch { return; }
            try {
                for await (const entry of directory) {
                    if (++visited > 8192 || files >= scanLimit) break;
                    const name = path.join(relative, entry.name);
                    if (entry.isDirectory() && depth < 2) await visit(root, name, depth + 1);
                    else if ((entry.isFile() || entry.isSymbolicLink()) && entry.name.endsWith('.desktop')) {
                        files++;
                        const id = name.replace(/[\\/]/g, '-');
                        if (seen.has(id)) continue;
                        seen.add(id);
                        const data = await readFile(path.join(root, name), MAX_TEXT_BYTES);
                        if (!data) continue;
                        const values = sections(data.toString('utf8')).get('Desktop Entry');
                        if (!values || values.get('Type') !== 'Application' || values.get('Hidden') === 'true') continue;
                        const executable = executableFromEntry(values.get('Exec'));
                        const icon = unescapeValue(values.get('Icon'));
                        if (executable && icon && icon.length <= 4096 && !/[\0\r\n]/.test(icon)) {
                            const resolved = path.posix.isAbsolute(executable)
                                ? await io.realpath(executable).catch(() => executable) : executable;
                            entries.push({ executable, resolved, icon });
                        }
                    }
                }
            } catch { /* 目录变化时保留已读到的条目。 */ }
        }
        for (const root of applicationRoots) await visit(root);
        return entries;
    }

    function applications() {
        if (!desktopCache || Date.now() >= desktopExpires) {
            desktopExpires = Date.now() + 60000;
            desktopCache = scanApplications();
        }
        return desktopCache;
    }

    async function themeName() {
        if (safeName(env.GTK_ICON_THEME)) return env.GTK_ICON_THEME;
        const configHome = absolute(env.XDG_CONFIG_HOME) ? env.XDG_CONFIG_HOME : path.join(home, '.config');
        for (const version of ['gtk-3.0', 'gtk-4.0']) {
            const data = await readFile(path.join(configHome, version, 'settings.ini'), MAX_TEXT_BYTES);
            const value = data && sections(data.toString('utf8')).get('Settings')?.get('gtk-icon-theme-name');
            if (safeName(value)) return value;
        }
        try {
            const { stdout } = await executeAsync('gsettings', ['get', 'org.gnome.desktop.interface', 'icon-theme'], { shell: false, encoding: 'utf8', timeout: 1500, maxBuffer: 4096 });
            const value = stdout.trim().replace(/^'(.*)'$/, '$1');
            if (safeName(value)) return value;
        } catch { /* 无桌面环境时使用标准的 hicolor 主题。 */ }
        return 'hicolor';
    }

    async function themeDirectories(theme) {
        for (const root of iconRoots) {
            const data = await readFile(path.join(root, theme, 'index.theme'), MAX_TEXT_BYTES);
            if (!data) continue;
            const metadata = sections(data.toString('utf8')), header = metadata.get('Icon Theme');
            if (!header) continue;
            const names = `${header.get('Directories') || ''},${header.get('ScaledDirectories') || ''}`.split(',').map(value => value.trim()).filter(safeDirectory).slice(0, 256);
            names.sort((a, b) => {
                const size = name => Number(metadata.get(name)?.get('Size')) * (Number(metadata.get(name)?.get('Scale')) || 1);
                return Math.abs((size(a) || 64) - 64) - Math.abs((size(b) || 64) - 64);
            });
            return { names, inherits: (header.get('Inherits') || '').split(',').map(value => value.trim()).filter(safeName).slice(0, 16) };
        }
        return { names: [], inherits: [] };
    }

    async function themedIcon(name) {
        if (!safeName(name)) return null;
        themeCache ||= themeName();
        const visited = new Set();
        let candidates = 0, candidateLimit = 4096;
        const extensions = /\.(png|svg|xpm)$/i.test(name) ? [''] : ['.png', '.svg', '.xpm'];
        async function find(theme) {
            if (!safeName(theme) || visited.has(theme) || visited.size >= 16) return null;
            visited.add(theme);
            const metadata = await themeDirectories(theme);
            for (const directory of metadata.names) {
                for (const root of iconRoots) {
                    for (const extension of extensions) {
                        if (++candidates > candidateLimit) return null;
                        const file = path.join(root, theme, directory, name + extension);
                        const data = await readFile(file, MAX_SOURCE_BYTES);
                        if (data) return { file, data };
                    }
                }
            }
            for (const inherited of metadata.inherits) {
                const result = await find(inherited);
                if (result) return result;
            }
            return null;
        }
        const current = await find(await themeCache);
        if (current) return current;
        // hicolor 必须作为最终的主题回退，即使继承列表达到了上限。
        if (!visited.has('hicolor')) {
            visited.delete([...visited].at(-1));
            candidateLimit += 512;
            const fallback = await find('hicolor');
            if (fallback) return fallback;
        }
        for (const root of [...iconRoots, ...pixmapRoots]) {
            for (const extension of extensions) {
                const file = path.join(root, name + extension), data = await readFile(file, MAX_SOURCE_BYTES);
                if (data) return { file, data };
            }
        }
        return null;
    }

    async function image(source) {
        if (!source) return EMPTY_IMAGE;
        let data = source.data;
        const extension = path.extname(source.file).toLowerCase();
        if (extension !== '.png') {
            if (!['.svg', '.xpm'].includes(extension)) return EMPTY_IMAGE;
            let directory;
            try {
                directory = await io.mkdtemp(path.join(temporaryRoot, 'wifimeter-icon-'));
                const output = path.join(directory, 'icon.png');
                await executeAsync('gdk-pixbuf-thumbnailer', ['--size', '64', source.file, output], { shell: false, timeout: 5000, maxBuffer: 64 * 1024, windowsHide: true });
                data = await readFile(output, MAX_PNG_BYTES);
            } catch { return EMPTY_IMAGE; }
            finally { if (directory) await io.rm(directory, { recursive: true, force: true }).catch(() => {}); }
        }
        if (!validPng(data)) return EMPTY_IMAGE;
        const url = 'data:image/png;base64,' + data.toString('base64');
        return Object.freeze({ isEmpty: () => false, toDataURL: () => url });
    }

    async function resolve(file) {
        const entries = await applications();
        const resolved = await io.realpath(file).catch(() => file);
        const exact = entries.find(entry => entry.executable === file || entry.resolved === resolved);
        const entry = exact || entries.find(candidate => !candidate.executable.includes('/') && candidate.executable === path.posix.basename(file));
        if (!entry) return EMPTY_IMAGE;
        const source = absolute(entry.icon) ? { file: entry.icon, data: await readFile(entry.icon, MAX_SOURCE_BYTES) } : await themedIcon(entry.icon);
        return source?.data ? image(source) : EMPTY_IMAGE;
    }

    return { async get(file) {
        if (typeof file !== 'string' || file.length > 4096 || !path.posix.isAbsolute(file) || /[\0\r\n]/.test(file) || file.split('/').includes('..')) return EMPTY_IMAGE;
        file = path.posix.normalize(file);
        const existing = cache.get(file);
        if (existing && existing.expires > Date.now()) { cache.delete(file); cache.set(file, existing); return existing.promise; }
        const entry = { expires: Infinity, promise: null };
        entry.promise = resolve(file).catch(() => EMPTY_IMAGE).then(result => { entry.expires = Date.now() + (result.isEmpty() ? 10000 : 300000); return result; });
        cache.set(file, entry);
        if (cache.size > 256) cache.delete(cache.keys().next().value);
        return entry.promise;
    } };
}


module.exports = { createLinuxFileIcons, validPng };
