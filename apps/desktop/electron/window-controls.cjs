'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { randomUUID } = require('node:crypto');

const { miniSize, snapBounds, collapsedBounds, isNear } = require('./mini-geometry.cjs');

const DEFAULTS = { miniWindow: false, closeAction: 'tray', theme: 'system',
    miniShape: 'bar', miniPalette: 'dark', miniSnap: true, miniAutoHide: true };
const SHAPES = ['bar', 'square', 'circle'];
const PALETTES = ['indigo', 'dark', 'light'];
const THEMES = ['light', 'dark', 'system'];
const ACTIONS = ['ask', 'tray', 'exit'];

// Electron 由调用方注入，测试不会加载 Electron 或更改登录启动项。
function createWindowControls({ BrowserWindow, screen, ipcMain, dialog, userData, getWindow,
    hideToTray, requestQuit, isQuitting = () => false, platform = process.platform,
    logger = () => {}, fileSystem = fs, backgroundTest = process.env.WIFIMETER_BACKGROUND_TEST === '1',
    timers = { setInterval, clearInterval, now: Date.now } }) {
    const file = path.join(userData, 'window-preferences.json');
    const miniFile = path.join(__dirname, 'mini', 'index.html');
    const miniURL = pathToFileURL(miniFile).href;
    const mainURL = pathToFileURL(path.join(__dirname, '../renderer/index.html')).href;
    let preferences = { ...DEFAULTS };
    let mini = null, loaded = false, lastLive = null, disposed = false, closeFlight = null;

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
        const desired = resize ? { ...current, ...miniSize(preferences.miniShape) } : current;
        const area = workArea(current);
        // 改形状时保留吸附侧，尤其是右侧和底部。
        if (resize && edge === 'right') desired.x = area.x + area.width - desired.width;
        if (resize && edge === 'bottom') desired.y = area.y + area.height - desired.height;
        const result = snapBounds(desired, area, snap && preferences.miniSnap);
        expanded = result.bounds;
        edge = result.edge;
        lastActivity = timers.now();
        setCollapsed(false);
    }

    function syncHover() {
        const enabled = mini && !mini.isDestroyed() && preferences.miniSnap && preferences.miniAutoHide && !backgroundTest;
        if (!enabled) { stopHover(); if (collapsed) setCollapsed(false); return; }
        if (hoverTimer !== null) return;
        hoverTimer = timers.setInterval(() => {
            if (!loaded || moving || !edge || !expanded) return;
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
        const { width, height } = miniSize(preferences.miniShape), margin = 12;
        const window = new BrowserWindow({
            width, height, x: Math.max(area.x, area.x + area.width - width - margin),
            y: Math.max(area.y, area.y + area.height - height - margin),
            ...(backgroundTest ? { x: -32000, y: -32000 } : {}),
            title: 'WiFiMeter', frame: false, resizable: false, maximizable: false,
            minimizable: false, skipTaskbar: true, alwaysOnTop: true, show: false,
            transparent: true, backgroundColor: '#00000000', hasShadow: false, focusable: false,
            webPreferences: { preload: path.join(__dirname, 'mini', 'preload.cjs'),
                contextIsolation: true, sandbox: true, nodeIntegration: false, spellcheck: false }
        });
        mini = window;
        expanded = window.getBounds();
        lastActivity = timers.now();
        syncHover();
        window.on('will-move', () => { if (!applyingBounds) { moving = true; lastActivity = timers.now(); } });
        window.on('moved', () => {
            if (applyingBounds || mini !== window || backgroundTest) return;
            // setBounds 也可能异步产生 moved，忽略我们已设置的最终位置。
            const actual = window.getBounds(), expected = collapsed ? collapsedBounds(expanded, edge) : expanded;
            if (!moving && expected && Object.keys(actual).every(key => actual[key] === expected[key])) return;
            moving = false; placeMini();
        });
        window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
        window.webContents.on('will-navigate', event => event.preventDefault());
        window.webContents.on('did-finish-load', () => {
            if (disposed || mini !== window) return;
            placeMini();
            loaded = true;
            sendPreferences();
            if (lastLive) window.webContents.send('mini:live', lastLive);
            window.showInactive();
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
            for (const key of ['miniSnap', 'miniAutoHide']) if (typeof saved?.[key] === 'boolean') preferences[key] = saved[key];
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
            || ['miniSnap', 'miniAutoHide'].some(key => Object.hasOwn(patch, key) && typeof patch[key] !== 'boolean')) {
            return Promise.reject(new TypeError('窗口偏好无效。'));
        }
        const changes = { ...patch };
        const operation = queue.then(async () => {
            if (disposed) throw Error('窗口控制器已关闭。');
            const next = { ...preferences, ...changes };
            await persist(next);
            const previous = preferences;
            preferences = next;
            if (mini && (previous.miniShape !== next.miniShape || previous.miniSnap !== next.miniSnap)) {
                if (backgroundTest) setBounds({ ...mini.getBounds(), ...miniSize(next.miniShape) });
                else placeMini({ resize: true });
            }
            syncMini();
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
            const window = getWindow();
            if (!window || window.isDestroyed()) return;
            if (window.isMinimized()) window.restore();
            window.show(); window.focus();
        },
        'mini:close': event => { trustedMini(event); return update({ miniWindow: false }); }
    };
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
            if (disposed || event?.event !== 'live') return;
            lastLive = event;
            if (mini && !mini.isDestroyed() && loaded) mini.webContents.send('mini:live', event);
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
