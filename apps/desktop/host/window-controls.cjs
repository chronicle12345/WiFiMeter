'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { randomUUID } = require('node:crypto');

const { miniSize, snapBounds, collapsedBounds, isNear } = require('./mini-geometry.cjs');
const { miniRange, miniApplicationRows, miniFilteredLive } = require('./mini-usage.cjs');

const DEFAULTS = { miniWindow: false, closeAction: 'tray', theme: 'system',
    miniShape: 'bar', miniPalette: 'dark', miniSnap: true, miniAutoHide: true,
    miniPinned: false, miniExcludeProxy: false, miniExpanded: false, miniRange: '5m', miniCustomMinutes: 15 };
const SHAPES = ['bar', 'square', 'circle'];
const PALETTES = ['indigo', 'dark', 'light'];
const THEMES = ['light', 'dark', 'system'];
const ACTIONS = ['ask', 'tray', 'exit'];

// 桌面宿主由调用方注入，测试不会加载原生窗口或更改登录启动项。
function createWindowControls({ BrowserWindow, screen, ipcMain, dialog, userData, getWindow,
    hideToTray, requestQuit, isQuitting = () => false, platform = process.platform,
    logger = () => {}, fileSystem = fs, backgroundTest = process.env.WIFIMETER_BACKGROUND_TEST === '1',
    timers = { setInterval, clearInterval, now: Date.now }, requestMiniSnapshot = null }) {
    const file = path.join(userData, 'window-preferences.json');
    const miniFile = path.join(__dirname, 'mini', 'index.html');
    const miniURL = pathToFileURL(miniFile).href;
    const mainURL = pathToFileURL(path.join(__dirname, '../renderer/index.html')).href;
    let preferences = { ...DEFAULTS };
    let mini = null, loaded = false, lastLive = null, disposed = false, closeFlight = null;
    let miniSnapshot = null, miniFlight = null, miniRefreshedAt = 0, miniRevision = 0, miniSnapshotRevision = -1;

    async function applicationUsage(force = false) {
        const previousSnapshot = miniSnapshot;
        const canQuery = () => !disposed && mini && !mini.isDestroyed() && preferences.miniExpanded
            && !['offline', 'starting'].includes(lastLive?.collector);
        if (canQuery() && requestMiniSnapshot && (force || !miniSnapshot || timers.now() - miniRefreshedAt >= 5000)) {
            do {
                if (!miniFlight) {
                    const revision = miniRevision, range = miniRange(preferences, timers.now());
                    const { minutes, ...query } = range;
                    const flight = { revision, promise: null };
                    flight.promise = Promise.resolve().then(() => requestMiniSnapshot({ ...query, includeMinutes: true }))
                        .then(result => { if (!disposed && revision === miniRevision) { miniSnapshot = result; miniSnapshotRevision = revision; miniRefreshedAt = timers.now(); } })
                        .finally(() => { if (miniFlight === flight) miniFlight = null; });
                    miniFlight = flight;
                }
                const flight = miniFlight;
                try { await flight.promise; }
                catch (error) {
                    // 旧时段失败后继续读取当前选择；当前时段的失败仍交给页面提示。
                    if (flight.revision === miniRevision) throw error;
                }
            } while (canQuery() && miniSnapshotRevision !== miniRevision);
        }
        const range = miniRange(preferences, timers.now());
        const model = miniApplicationRows(miniSnapshot, lastLive, range, preferences);
        if (mini && !mini.isDestroyed() && loaded && preferences.miniExpanded) {
            if (lastLive && previousSnapshot !== miniSnapshot) mini.webContents.send('mini:live', miniFilteredLive(lastLive, miniSnapshot));
            mini.webContents.send('mini:applications', model);
        }
        return model;
    }

    let hoverTimer = null, expanded = null, edge = null, collapsed = false, moving = false;
    let applyingBounds = false, lastActivity = 0;

    function stopHover() {
        if (hoverTimer !== null) timers.clearInterval(hoverTimer);
        hoverTimer = null;
    }

    function sendPreferences() {
        if (mini && loaded) mini.webContents.send('window-preferences:changed', { ...preferences });
    }

    function setBounds(bounds) {
        if (!mini || mini.isDestroyed()) return;
        const current = mini.getBounds();
        if (Object.keys(bounds).every(key => bounds[key] === current[key])) return;
        applyingBounds = true;
        try { mini.setBounds(bounds, false); } finally { applyingBounds = false; }
    }

    function setCollapsed(value) {
        collapsed = value;
        if (mini && loaded) mini.webContents.send('mini:state', { collapsed, edge });
        if (expanded) setBounds(value ? collapsedBounds(expanded, edge) : expanded);
    }

    function workArea(bounds) {
        return (screen.getDisplayMatching ? screen.getDisplayMatching(bounds) : screen.getPrimaryDisplay()).workArea;
    }

    function placeMini({ resize = false, snap = true } = {}) {
        if (!mini || backgroundTest) return;
        const current = collapsed && expanded ? expanded : mini.getBounds();
        const desired = resize ? { ...current, ...miniSize(preferences.miniShape, preferences.miniExpanded) } : current;
        const area = workArea(current);
        // 改形状时保留吸附侧，尤其是右侧和底部。
        if (resize && !preferences.miniPinned && edge === 'right') desired.x = area.x + area.width - desired.width;
        if (resize && !preferences.miniPinned && edge === 'bottom') desired.y = area.y + area.height - desired.height;
        const result = snapBounds(desired, area, snap && preferences.miniSnap && !preferences.miniPinned);
        expanded = result.bounds;
        edge = result.edge;
        lastActivity = timers.now();
        setCollapsed(false);
    }

    function syncHover() {
        const enabled = mini && !mini.isDestroyed() && preferences.miniSnap && preferences.miniAutoHide && !preferences.miniPinned && !backgroundTest;
        if (!enabled) { stopHover(); if (collapsed) setCollapsed(false); return; }
        if (hoverTimer !== null) return;
        hoverTimer = timers.setInterval(() => {
            if (!loaded || moving || !['left', 'right'].includes(edge) || !expanded) return;
            const bounds = collapsed ? collapsedBounds(expanded, edge) : expanded;
            if (isNear(screen.getCursorScreenPoint(), bounds)) {
                lastActivity = timers.now();
                if (collapsed) setCollapsed(false);
            } else if (!collapsed && timers.now() - lastActivity >= 1200) setCollapsed(true);
        }, 100);
        hoverTimer?.unref?.();
    }

    function onDisplaysChanged() {
        if (!mini || backgroundTest) return;
        placeMini({ resize: true });
    }
    for (const event of ['display-added', 'display-removed', 'display-metrics-changed']) screen.on?.(event, onDisplaysChanged);

    function destroyMini() {
        stopHover();
        expanded = null; edge = null; collapsed = false; moving = false;
        const window = mini;
        mini = null;
        loaded = false;
        if (window && !window.isDestroyed()) window.destroy();
    }

    function syncMini() {
        if (disposed) return;
        if (!preferences.miniWindow || platform !== 'win32') { destroyMini(); return; }
        if (mini && !mini.isDestroyed()) { sendPreferences(); syncHover(); return; }
        const area = screen.getPrimaryDisplay().workArea;
        const { width, height } = miniSize(preferences.miniShape, preferences.miniExpanded), margin = 12;
        const window = new BrowserWindow({
            width, height, x: Math.max(area.x, area.x + area.width - width - margin),
            y: Math.max(area.y, area.y + area.height - height - margin),
            ...(backgroundTest ? { x: -32000, y: -32000 } : {}),
            title: 'WiFiMeter', frame: false, resizable: false, maximizable: false,
            minimizable: false, skipTaskbar: true, alwaysOnTop: true, show: false,
            transparent: true, backgroundColor: '#00000000', hasShadow: false, focusable: !backgroundTest && preferences.miniExpanded
        });
        mini = window;
        expanded = window.getBounds();
        lastActivity = timers.now();
        syncHover();
        window.on('will-move', event => {
            if (applyingBounds) return;
            if (preferences.miniPinned) { event?.preventDefault?.(); return; }
            moving = true; lastActivity = timers.now();
        });
        window.on('moved', () => {
            if (applyingBounds || mini !== window || backgroundTest) return;
            // setBounds 也可能异步产生 moved，忽略我们已设置的最终位置。
            const actual = window.getBounds(), expected = collapsed ? collapsedBounds(expanded, edge) : expanded;
            if (!moving && expected && Object.keys(actual).every(key => actual[key] === expected[key])) return;
            if (preferences.miniPinned) { moving = false; if (expected) setBounds(expected); return; }
            moving = false; placeMini();
        });
        window.webContents.on('did-finish-load', () => {
            if (disposed || mini !== window) return;
            placeMini();
            loaded = true;
            sendPreferences();
            if (lastLive) window.webContents.send('mini:live', miniFilteredLive(lastLive, miniSnapshot));
            if (preferences.miniExpanded) applicationUsage().catch(error => logger(`小窗应用查询失败：${error.message}`));
            if (!backgroundTest) window.showInactive();
        });
        window.on('close', event => {
            if (disposed || isQuitting()) return;
            event.preventDefault();
            update({ miniWindow: false }).catch(error => logger(`关闭小窗失败：${error.message}`));
        });
        window.on('closed', () => { if (mini === window) { stopHover(); mini = null; loaded = false; expanded = null; edge = null; collapsed = false; } });
        window.loadFile(miniFile).catch(error => {
            if (mini === window) destroyMini();
            logger(`加载小窗失败：${error.message}`);
        });
    }

    const ready = (async () => {
        try {
            const saved = JSON.parse(await fileSystem.readFile(file, 'utf8'));
            if (typeof saved?.miniWindow === 'boolean') preferences.miniWindow = saved.miniWindow;
            if (ACTIONS.includes(saved?.closeAction)) preferences.closeAction = saved.closeAction;
            if (THEMES.includes(saved?.theme)) preferences.theme = saved.theme;
            if (SHAPES.includes(saved?.miniShape)) preferences.miniShape = saved.miniShape;
            if (PALETTES.includes(saved?.miniPalette)) preferences.miniPalette = saved.miniPalette;
            for (const key of ['miniSnap', 'miniAutoHide', 'miniPinned', 'miniExcludeProxy', 'miniExpanded']) if (typeof saved?.[key] === 'boolean') preferences[key] = saved[key];
            if (['1m', '5m', '1h', 'custom'].includes(saved?.miniRange)) preferences.miniRange = saved.miniRange;
            if (Number.isInteger(saved?.miniCustomMinutes) && saved.miniCustomMinutes >= 1 && saved.miniCustomMinutes <= 10080) preferences.miniCustomMinutes = saved.miniCustomMinutes;
        } catch (error) {
            if (error.code !== 'ENOENT') logger(`读取窗口偏好失败：${error.message}`);
        }
        syncMini();
    })();
    let queue = ready;

    async function persist(next) {
        await fileSystem.mkdir(userData, { recursive: true });
        const temporary = `${file}.${randomUUID()}.tmp`;
        try {
            await fileSystem.writeFile(temporary, JSON.stringify(next, null, 2) + '\n', { flag: 'wx' });
            await fileSystem.rename(temporary, file);
        } finally {
            await fileSystem.rm(temporary, { force: true });
        }
    }

    function update(patch) {
        if (!patch || typeof patch !== 'object' || Array.isArray(patch)
            || Object.keys(patch).some(key => !Object.hasOwn(DEFAULTS, key))
            || (Object.hasOwn(patch, 'miniWindow') && typeof patch.miniWindow !== 'boolean')
            || (Object.hasOwn(patch, 'closeAction') && !ACTIONS.includes(patch.closeAction))
            || (Object.hasOwn(patch, 'theme') && !THEMES.includes(patch.theme))
            || (Object.hasOwn(patch, 'miniShape') && !SHAPES.includes(patch.miniShape))
            || (Object.hasOwn(patch, 'miniPalette') && !PALETTES.includes(patch.miniPalette))
            || ['miniSnap', 'miniAutoHide', 'miniPinned', 'miniExcludeProxy', 'miniExpanded'].some(key => Object.hasOwn(patch, key) && typeof patch[key] !== 'boolean')
            || (Object.hasOwn(patch, 'miniRange') && !['1m', '5m', '1h', 'custom'].includes(patch.miniRange))
            || (Object.hasOwn(patch, 'miniCustomMinutes') && (!Number.isInteger(patch.miniCustomMinutes) || patch.miniCustomMinutes < 1 || patch.miniCustomMinutes > 10080))) {
            return Promise.reject(new TypeError('窗口偏好无效。'));
        }
        const changes = { ...patch };
        const operation = queue.then(async () => {
            if (disposed) throw Error('窗口控制器已关闭。');
            const next = { ...preferences, ...changes };
            await persist(next);
            const previous = preferences;
            preferences = next;
            mini?.setFocusable?.(!backgroundTest && next.miniExpanded);
            if (mini && (previous.miniShape !== next.miniShape || previous.miniSnap !== next.miniSnap || previous.miniPinned !== next.miniPinned || previous.miniExpanded !== next.miniExpanded)) {
                moving = false;
                if (backgroundTest) setBounds({ ...mini.getBounds(), ...miniSize(next.miniShape, next.miniExpanded) });
                else placeMini({ resize: true });
            }
            syncMini();
            if (previous.miniRange !== next.miniRange || previous.miniCustomMinutes !== next.miniCustomMinutes) {
                miniSnapshot = null; miniRefreshedAt = 0; miniRevision++;
            }
            if (next.miniExpanded) applicationUsage(true).catch(error => logger(`小窗应用查询失败：${error.message}`));
            const window = getWindow();
            if (window && !window.isDestroyed() && !window.webContents.isDestroyed()
                && window.webContents.mainFrame.url.split(/[?#]/)[0] === mainURL) {
                window.webContents.send('window-preferences:changed', { ...preferences });
            }
            return { ...preferences };
        });
        queue = operation.catch(() => {});
        return operation;
    }

    async function read() { await queue; return { ...preferences }; }

    function trustedMini(event) {
        if (!mini || mini.isDestroyed() || event.sender !== mini.webContents
            || event.senderFrame !== mini.webContents.mainFrame
            || event.senderFrame.url.split(/[?#]/)[0] !== miniURL) throw Error('不支持的页面请求。');
    }
    const handlers = {
        'mini:open-main': event => {
            trustedMini(event);
            if (backgroundTest) return;
            const window = getWindow();
            if (!window || window.isDestroyed()) return;
            if (window.isMinimized()) window.restore();
            window.show(); window.focus();
        },
        'mini:close': event => { trustedMini(event); return update({ miniWindow: false }); }
    };
    handlers['mini:preferences-read'] = event => { trustedMini(event); return read(); };
    handlers['mini:preferences-update'] = (event, patch) => {
        trustedMini(event);
        if (!patch || Object.keys(patch).some(key => !['miniAutoHide', 'miniPinned', 'miniExcludeProxy', 'miniExpanded', 'miniRange', 'miniCustomMinutes'].includes(key))) throw Error('小窗设置无效。');
        return update(patch);
    };
    handlers['mini:applications'] = event => { trustedMini(event); return applicationUsage(); };
    for (const [channel, handler] of Object.entries(handlers)) ipcMain.handle(channel, handler);

    function onMainClose(event) {
        if (disposed || isQuitting()) return Promise.resolve(false);
        event.preventDefault();
        if (closeFlight) return closeFlight;
        closeFlight = (async () => {
            await queue;
            if (disposed || isQuitting()) return false;
            let action = preferences.closeAction, remember = false;
            if (action === 'ask') {
                const window = getWindow();
                if (!window || window.isDestroyed()) return false;
                const choice = await dialog.showMessageBox(window, {
                    type: 'question', title: '关闭 WiFiMeter', message: '关闭窗口后如何处理？',
                    buttons: ['取消', '最小化到托盘', '退出应用'], defaultId: 0, cancelId: 0,
                    checkboxLabel: '记住我的选择', checkboxChecked: false, noLink: true
                });
                action = { 1: 'tray', 2: 'exit' }[choice.response];
                remember = choice.checkboxChecked === true;
            }
            if (!action || disposed || isQuitting()) return false;
            if (action === 'tray') {
                if (!await hideToTray()) return false;
                if (remember && !disposed) await update({ closeAction: 'tray' });
                return true;
            }
            if (remember) await update({ closeAction: 'exit' });
            if (disposed || isQuitting()) return false;
            await requestQuit();
            return true;
        })().catch(error => { logger(`关闭窗口失败：${error.message}`); return false; })
            .finally(() => { closeFlight = null; });
        return closeFlight;
    }

    return {
        read, update, onMainClose,
        publishLive(event) {
            if (disposed) return;
            if (event?.event === 'collectorStatus') {
                lastLive = { ...lastLive, event: 'live', collector: event.collector, updatedAt: event.updatedAt,
                    collectorMessage: event.message || '', appCollection: { ...lastLive?.appCollection, ...event.appCollection },
                    appProcesses: [], connections: (lastLive?.connections || []).map(connection => ({ ...connection, rxPerSecond: 0, txPerSecond: 0 })) };
                if (mini && !mini.isDestroyed() && loaded) {
                    mini.webContents.send('mini:live', miniFilteredLive(lastLive, miniSnapshot));
                    if (preferences.miniExpanded) mini.webContents.send('mini:applications', miniApplicationRows(miniSnapshot, lastLive, miniRange(preferences, timers.now()), preferences));
                }
                return;
            }
            if (event?.event !== 'live') return;
            lastLive = event;
            if (mini && !mini.isDestroyed() && loaded) mini.webContents.send('mini:live', miniFilteredLive(event, miniSnapshot));
            if (mini && loaded && preferences.miniExpanded) applicationUsage().catch(error => {
                logger(`小窗应用查询失败：${error.message}`);
                if (!disposed && mini && loaded) mini.webContents.send('mini:applications', { rows: [], status: 'error', detail: error.message, range: miniRange(preferences, timers.now()), miniExcludeProxy: preferences.miniExcludeProxy });
            });
        },
        dispose() {
            if (disposed) return;
            disposed = true;
            for (const channel of Object.keys(handlers)) ipcMain.removeHandler(channel);
            for (const event of ['display-added', 'display-removed', 'display-metrics-changed']) screen.removeListener?.(event, onDisplaysChanged);
            destroyMini(); lastLive = null;
        }
    };
}

module.exports = { createWindowControls };
