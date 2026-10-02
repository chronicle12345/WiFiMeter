const fs = require('node:fs/promises');
const { createWriteStream } = require('node:fs');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');

const REPOSITORY = 'https://github.com/chronicle12345/WiFiMeter';
const API = 'https://api.github.com/repos/chronicle12345/WiFiMeter/releases/latest';
const DAY = 24 * 60 * 60 * 1000;

function parseVersion(value) {
    if (typeof value !== 'string') throw Error('版本号无效。');
    const match = /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/.exec(value);
    if (!match) throw Error('版本号无效。');
    const prerelease = match[4] ? match[4].split('.') : [];
    if (prerelease.some(part => /^\d+$/.test(part) && part.length > 1 && part[0] === '0')) {
        throw Error('版本号无效。');
    }
    return { core: match.slice(1, 4).map(BigInt), prerelease, version: value.replace(/^v/, '') };
}

function compareVersions(left, right) {
    for (let i = 0; i < 3; i++) {
        if (left.core[i] !== right.core[i]) return left.core[i] > right.core[i] ? 1 : -1;
    }
    if (!left.prerelease.length || !right.prerelease.length) {
        return Number(!left.prerelease.length) - Number(!right.prerelease.length);
    }
    for (let i = 0; i < Math.max(left.prerelease.length, right.prerelease.length); i++) {
        const a = left.prerelease[i], b = right.prerelease[i];
        if (a === b) continue;
        if (a === undefined || b === undefined) return a === undefined ? -1 : 1;
        const numericA = /^\d+$/.test(a), numericB = /^\d+$/.test(b);
        if (numericA && numericB) return BigInt(a) > BigInt(b) ? 1 : -1;
        if (numericA !== numericB) return numericA ? -1 : 1;
        return a > b ? 1 : -1;
    }
    return 0;
}

function assetUrlAllowed(value, tag, name) {
    return value === `${REPOSITORY}/releases/download/${encodeURIComponent(tag)}/${encodeURIComponent(name)}`;
}

// 仅在仓库资产下载发生重定向后允许 GitHub 的资产存储域。
function redirectAllowed(value, original) {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || url.port || url.hash) return false;
    if (value === original) return true;
    return ['release-assets.githubusercontent.com', 'objects.githubusercontent.com'].includes(url.hostname)
        && /^\/github-production-release-asset(?:-[0-9a-f]+)?\//.test(url.pathname);
}

/**
 * All methods return Promises. settings()/setCheckOnStartup() return {checkOnStartup}.
 * check() returns {status, state, currentVersion, latestVersion, notes, url, canInstall,
 * checkOnStartup, manual}; state is latest/available/error, with error on failure
 * and skipped=disabled/cached for skipped automatic checks.
 * install() additionally returns state=cancelled/manual/installing/busy.
 * onProgress(fullSnapshot) observes checking/downloading/verifying/preparing/installing
 * and terminal results. progress is {receivedBytes,totalBytes,percent,phase}, or null
 * outside active phases. Only downloading has a percentage, when length is known.
 * Download 100% does not imply verification or installation has completed.
 * Observer exceptions/rejections are ignored. status always mirrors state. confirm({...snapshot, title, message, detail})
 * must return strictly true; missing confirm fails closed.
 * beforeInstall() is awaited after verification, before launchInstaller(file, [], { digest }).
 * launchInstaller(file, argv) resolves once a helper reliably accepts the task.
 * The main process then quits; the helper waits for the app to exit before
 * launching the installer via hidden spawn, using argv and no shell.
 * beforeInstall() must reject if graceful backend shutdown fails.
 * The main process supplies launchInstaller using hidden spawn without a shell,
 * and exposes install only through an explicit user action, never a timer.
 */
function createUpdateService({ currentVersion, platform, arch, userData,
    fetch: fetchImpl = globalThis.fetch, openExternal, launchInstaller, beforeInstall, confirm, onProgress } = {}) {
    const current = parseVersion(currentVersion);
    const preferencesPath = path.join(userData, 'update-preferences.json');
    let preferences;
    let preferenceFailure = false;
    let selectedAsset = null;
    let installing = false;
    let checking = false;
    let queue = Promise.resolve();
    let snapshot = { state: 'unchecked', currentVersion, latestVersion: null, notes: '',
        url: `${REPOSITORY}/releases/latest`, canInstall: false, checkOnStartup: true, manual: false, progress: null };

    function serial(operation) {
        const result = queue.then(operation);
        queue = result.catch(() => {});
        return result;
    }

    async function loadPreferences() {
        if (preferences) return;
        try {
            const saved = JSON.parse(await fs.readFile(preferencesPath, 'utf8'));
            if (!saved || typeof saved.checkOnStartup !== 'boolean'
                || (saved.lastAutomaticAt !== undefined
                    && (!Number.isFinite(saved.lastAutomaticAt) || saved.lastAutomaticAt < 0))) {
                throw Error('invalid preferences');
            }
            preferences = { checkOnStartup: saved.checkOnStartup, lastAutomaticAt: saved.lastAutomaticAt ?? 0 };
            preferenceFailure = false;
        } catch (error) {
            // 仅首次使用且文件不存在时启用默认值；损坏或不可读的配置不覆盖。
            if (error.code === 'ENOENT' && !preferenceFailure) {
                preferences = { checkOnStartup: true, lastAutomaticAt: 0 };
                return;
            }
            preferenceFailure = true;
            throw Error('无法读取更新偏好设置，请修复 update-preferences.json 后重试。');
        }
    }

    async function savePreferences(next) {
        const temporary = `${preferencesPath}.${randomUUID()}.tmp`;
        let handle;
        try {
            await fs.mkdir(userData, { recursive: true });
            handle = await fs.open(temporary, 'wx', 0o600);
            await handle.writeFile(JSON.stringify(next, null, 2) + '\n', 'utf8');
            await handle.sync();
            await handle.close();
            handle = null;
            await fs.rename(temporary, preferencesPath);
            preferences = next;
            preferenceFailure = false;
        } catch {
            preferences = undefined;
            preferenceFailure = true;
            throw Error('无法保存更新偏好设置，请修复 update-preferences.json 后重试。');
        } finally {
            if (handle) await handle.close();
            await fs.unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; });
        }
    }

    function result(extra = {}) {
        const value = { ...snapshot, checkOnStartup: preferenceFailure ? false : (preferences?.checkOnStartup ?? true), ...extra };
        return { ...value, status: value.state };
    }

    // Observers receive complete snapshots; UI failures must not interrupt an update.
    function publish(extra = {}) {
        snapshot = { ...snapshot, ...extra };
        const value = result();
        try { Promise.resolve(onProgress?.({ ...value, progress: value.progress && { ...value.progress } })).catch(() => {}); }
        catch { /* A closed renderer must not abort the download. */ }
        return value;
    }

    function phase(state, progress = {}) {
        return publish({ state, error: undefined, progress: {
            receivedBytes: snapshot.progress?.receivedBytes ?? 0,
            totalBytes: snapshot.progress?.totalBytes ?? null,
            ...progress, percent: null, phase: state
        } });
    }

    async function request(url, signal) {
        return fetchImpl(url, { redirect: 'manual', signal, credentials: 'omit',
            headers: { Accept: url === API ? 'application/vnd.github+json' : 'application/octet-stream' } });
    }

    async function checkNow({ automatic = false } = {}) {
        try {
            await loadPreferences();
            if (automatic && !preferences.checkOnStartup) return result({ skipped: 'disabled' });
            const now = Date.now();
            if (automatic && preferences.lastAutomaticAt && now - preferences.lastAutomaticAt < DAY) {
                return result({ skipped: 'cached' });
            }
            // 失败的自动请求也计入限频；仅保存设置和时间，不保存请求、token 或签名 URL。
            if (automatic) await savePreferences({ ...preferences, lastAutomaticAt: now });
            selectedAsset = null;
            phase('checking', { receivedBytes: 0, totalBytes: null });
            const response = await request(API, AbortSignal.timeout(30_000));
            if (!response.ok || response.redirected) throw Error('release request failed');
            const release = await response.json();
            const latest = parseVersion(release.tag_name);
            if (release.draft || release.prerelease || latest.prerelease.length) throw Error('not stable');
            const newer = compareVersions(latest, current) > 0;
            const url = `${REPOSITORY}/releases/tag/${encodeURIComponent(release.tag_name)}`;
            if (newer && platform === 'win32' && ['x64', 'ia32', 'arm64'].includes(arch)) {
                const names = [`WiFiMeter-${latest.version}-windows-${arch}-Setup.exe`, `WiFiMeter-${latest.version}-${arch}-Setup.exe`];
                const assets = Array.isArray(release.assets) ? release.assets : [];
                const name = names.find(name => assets.some(asset => asset.name === name)) || names[0];
                const matches = assets.filter(asset =>
                    asset.name === name && /^sha256:[a-fA-F0-9]{64}$/.test(asset.digest || '')
                    && assetUrlAllowed(asset.browser_download_url, release.tag_name, name));
                if (matches.length === 1) selectedAsset = { name, url: matches[0].browser_download_url,
                    digest: matches[0].digest.slice(7).toLowerCase() };
            }
            snapshot = { state: newer ? 'available' : 'latest', currentVersion,
                latestVersion: latest.version, notes: typeof release.body === 'string' ? release.body : '',
                url, canInstall: Boolean(selectedAsset), manual: newer && !selectedAsset,
                checkOnStartup: preferences.checkOnStartup, progress: null };
            return publish();
        } catch {
            selectedAsset = null;
            snapshot = { ...snapshot, state: 'error', canInstall: false, manual: false, progress: null,
                error: preferenceFailure ? '无法读写更新偏好设置，请修复 update-preferences.json 后重试。'
                    : '检查更新失败，请检查网络连接后重试。' };
            return publish();
        }
    }

    async function download(asset) {
        phase('downloading', { receivedBytes: 0, totalBytes: null });
        const directory = path.join(userData, 'updates');
        await fs.mkdir(directory, { recursive: true });
        const destination = path.join(directory, `${randomUUID()}-${asset.name}`);
        const temporary = `${destination}.tmp`;
        const signal = AbortSignal.timeout(10 * 60_000);
        let url = asset.url;
        try {
            let response;
            for (let redirects = 0; redirects <= 5; redirects++) {
                response = await request(url, signal);
                if (response.redirected) throw Error('unexpected redirect');
                if (![301, 302, 303, 307, 308].includes(response.status)) break;
                const location = response.headers.get('location');
                await response.body?.cancel();
                if (!location || redirects === 5) throw Error('invalid redirect');
                url = new URL(location, url).href;
                if (!redirectAllowed(url, asset.url)) throw Error('untrusted asset URL');
            }
            if (!response.ok || !response.body) throw Error('download failed');
            const length = response.headers.get('content-length');
            const parsedLength = length && /^\d+$/.test(length) ? Number(length) : null;
            const totalBytes = Number.isSafeInteger(parsedLength) && parsedLength > 0 ? parsedLength : null;
            let receivedBytes = 0;
            let lastProgressAt = 0;
            function downloadProgress(force = false) {
                const now = Date.now();
                if (!force && now - lastProgressAt < 100) return;
                lastProgressAt = now;
                publish({ state: 'downloading', progress: { receivedBytes, totalBytes,
                    percent: totalBytes === null ? null : Math.min(100, receivedBytes / totalBytes * 100),
                    phase: 'downloading' } });
            }
            downloadProgress(true);
            const hash = createHash('sha256');
            const hashing = new Transform({ transform(chunk, encoding, callback) {
                hash.update(chunk);
                receivedBytes += chunk.length;
                downloadProgress();
                callback(null, chunk);
            } });
            await pipeline(response.body, hashing, createWriteStream(temporary, { flags: 'wx', mode: 0o600 }), { signal });
            downloadProgress(true);
            phase('verifying');
            if (hash.digest('hex') !== asset.digest) throw Error('digest mismatch');
            await fs.rename(temporary, destination);
            return destination;
        } finally {
            await fs.unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; });
        }
    }

    return {
        settings: () => serial(async () => {
            await loadPreferences();
            return { checkOnStartup: preferences.checkOnStartup };
        }),
        setCheckOnStartup: value => serial(async () => {
            if (typeof value !== 'boolean') throw TypeError('checkOnStartup 必须为布尔值。');
            await loadPreferences();
            await savePreferences({ ...preferences, checkOnStartup: value });
            return { checkOnStartup: value };
        }),
        async check(options) {
            if (installing || checking) return result({ state: 'busy' });
            checking = true;
            try { return await serial(() => checkNow(options)); }
            finally { checking = false; }
        },
        async install() {
            if (installing || checking) return result({ state: 'busy' });
            installing = true;
            let file;
            try {
                // 与在途检查排队，捕获确认对应的版本，避免确认期间被其他检查替换。
                const target = await serial(async () => {
                    if (snapshot.state !== 'available') await checkNow();
                    return { status: result(), asset: selectedAsset && { ...selectedAsset } };
                });
                const status = target.status;
                if (status.state !== 'available') return status;
                const message = {
                    ...status,
                    title: target.asset ? '安装 WiFiMeter 更新' : '打开 WiFiMeter 更新页面',
                    message: target.asset ? `是否安装 WiFiMeter ${status.latestVersion}？`
                        : `是否打开 WiFiMeter ${status.latestVersion} 的官方发布页？`,
                    detail: target.asset ? '下载并校验成功后将停止采样，退出应用，再启动安装程序。'
                        : '请在官方发布页选择适合当前系统和安装方式的软件包。'
                };
                if (!confirm || await confirm(message) !== true) {
                    return publish({ state: 'cancelled', progress: null, error: undefined });
                }
                if (!target.asset) {
                    if (!openExternal) throw Error('missing openExternal');
                    await openExternal(status.url);
                    return publish({ state: 'manual', manual: true, progress: null, error: undefined });
                }
                if (!launchInstaller || !beforeInstall) throw Error('missing install hooks');
                file = await download(target.asset);
                phase('preparing');
                await beforeInstall();
                phase('installing');
                await launchInstaller(file, [], { digest: target.asset.digest });
                file = null; // 成功启动后保留安装包，避免安装器尚未读取时被删除。
                return result();
            } catch {
                return publish({ state: 'error', progress: null, error: '安装更新失败，下载或 SHA-256 校验未完成，或安装程序无法启动。' });
            } finally {
                installing = false;
                if (file) await fs.unlink(file).catch(() => {});
            }
        }
    };
}

module.exports = { createUpdateService };
