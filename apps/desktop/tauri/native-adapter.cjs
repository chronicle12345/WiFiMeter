'use strict';

// 桌面业务通过这个适配器调用 Tauri 原生窗口和系统功能。
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { execFileSync, execFile } = require('node:child_process');
const { promisify } = require('node:util');
const packagedAutostart = path.join(__dirname, 'host/windows-autostart.cjs');
const { createWindowsAutostart } = require(fs.existsSync(packagedAutostart)
    ? packagedAutostart : path.join(__dirname, '../host/windows-autostart.cjs'));

function createNativeAdapter({ send, configuration = {}, execute = execFileSync, executeAsync = promisify(execFile) }) {
    let nextId = 1, stopped = false;
    const pending = new Map(), windows = new Map(), handlers = new Map();
    let tray, quitting = false, exitConfirmed = false, exitFlight = null, quitRequested = false, quitStarted = false;
    let displays = configuration.displays || [{ bounds: { x: 0, y: 0, width: 1920, height: 1080 }, workArea: { x: 0, y: 0, width: 1920, height: 1040 } }];
    let cursor = { x: -10000, y: -10000 };
    const diagnostic = error => console.error('[native]', error.message);
    function call(method, params = {}) {
        if (stopped) return Promise.reject(Error('桌面宿主已断开。'));
        const id = nextId++;
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => { pending.delete(id); reject(Error(`桌面操作超时：${method}`)); }, method.startsWith('dialog:') ? 300000 : 30000);
            pending.set(id, { resolve, reject, timer });
            try { send({ type: 'native', id, method, params }); }
            catch (error) { clearTimeout(timer); pending.delete(id); reject(error); }
        });
    }
    const fire = (method, params) => { call(method, params).catch(diagnostic); };
    const preventable = () => ({ defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } });
    const app = new EventEmitter();
    const home = process.env.USERPROFILE || process.env.HOME || configuration.userData;
    const paths = { home, appData: process.env.APPDATA || process.env.XDG_CONFIG_HOME || path.join(home, '.config'),
        userData: configuration.userData, documents: path.join(home, 'Documents') };
    app.isPackaged = configuration.isPackaged === true;
    app.setName = value => { app.name = value; };
    app.setAppUserModelId = () => {};
    app.getPath = name => paths[name] || configuration.userData;
    app.setPath = (name, value) => { paths[name] = value; };
    app.getVersion = () => configuration.version || '1.3.0';
    app.requestSingleInstanceLock = () => true; // Rust 的 single-instance 插件先获得互斥锁。
    app.whenReady = () => Promise.resolve();
    app.disableHardwareAcceleration = () => {};
    app.commandLine = { appendSwitch() {} };
    app.confirmExit = () => {
        if (stopped || exitConfirmed) return Promise.resolve(true);
        if (!exitFlight) exitFlight = call('app:confirmQuit').then(accepted => {
            if (accepted === true) exitConfirmed = true;
            return accepted === true;
        }).finally(() => { exitFlight = null; });
        return exitFlight;
    };
    app.prepareUpdateExit = async () => {
        if (stopped) return false;
        const saved = await call('app:prepareUpdateQuit');
        if (saved === true) exitConfirmed = true;
        return saved === true;
    };
    const finishQuit = () => {
        const event = preventable();
        app.emit('before-quit', event);
        if (!event.defaultPrevented && !quitting) { quitting = true; send({ type: 'quit' }); }
    };
    app.finishQuit = finishQuit;
    app.cancelQuit = () => { quitStarted = false; exitConfirmed = false; };
    app.quit = () => {
        if (quitStarted) return;
        if (!stopped && !exitConfirmed) {
            if (quitRequested) return;
            quitRequested = true;
            app.confirmExit().then(accepted => { quitRequested = false; if (accepted) app.quit(); })
                .catch(error => { quitRequested = false; diagnostic(error); });
            return;
        }
        quitStarted = true;
        finishQuit();
    };
    // 使用真正的桌面可执行文件，不能登记 Node 辅助进程或附带开发参数。
    Object.assign(app, createWindowsAutostart({ executable: configuration.appExe, execute }));
    const linuxIcons = (configuration.platform || process.platform) === 'linux'
        ? require('./linux-icons.cjs').createLinuxFileIcons({ executeAsync }) : null;
    app.getFileIcon = async file => {
        if (linuxIcons) return linuxIcons.get(file);
        const encoded = Buffer.from(file, 'utf8').toString('base64');
        const script = `$ErrorActionPreference='Stop'; Add-Type -AssemblyName System.Drawing; $p=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encoded}')); $i=[Drawing.Icon]::ExtractAssociatedIcon($p); if($i){try{$b=$i.ToBitmap(); $m=New-Object IO.MemoryStream; try{$b.Save($m,[Drawing.Imaging.ImageFormat]::Png); [Console]::Write([Convert]::ToBase64String($m.ToArray()))}finally{$b.Dispose();$m.Dispose()}}finally{$i.Dispose()}}`;
        const executable = path.win32.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
        const { stdout } = await executeAsync(executable, ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { encoding: 'utf8', windowsHide: true, timeout: 15000, maxBuffer: 512 * 1024 });
        const data = stdout.trim();
        return { isEmpty: () => !/^[A-Za-z0-9+/=]+$/.test(data), toDataURL: () => 'data:image/png;base64,' + data };
    };

    class BrowserWindow extends EventEmitter {
        constructor(options) {
            super();
            this.label = windows.has('main') ? 'mini' : 'main';
            this.options = options;
            this.bounds = { x: options.x || 0, y: options.y || 0, width: options.width, height: options.height };
            this.visible = options.show !== false;
            this.minimized = false;
            this.destroyed = false;
            this.webContents = new EventEmitter();
            Object.assign(this.webContents, {
                mainFrame: { url: '' }, isDestroyed: () => this.destroyed,
                send: (channel, payload) => send({ type: 'event', window: this.label, channel, payload }),
                setWindowOpenHandler() {}, session: { setPermissionRequestHandler() {} }
            });
            windows.set(this.label, this);
        }
        async loadFile(file) {
            this.webContents.mainFrame.url = pathToFileURL(file).href;
            const trace = process.env.WIFIMETER_BACKGROUND_TEST === '1';
            if (trace) console.error(`[startup] ${this.label} window:create requested`);
            await call('window:create', { label: this.label, options: this.options });
            if (trace) console.error(`[startup] ${this.label} window:load requested`);
            await call('window:load', { label: this.label, page: this.label });
            if (trace) console.error(`[startup] ${this.label} window:load completed`);
        }
        isDestroyed() { return this.destroyed; }
        isVisible() { return this.visible; }
        isMinimized() { return this.minimized; }
        getBounds() { return { ...this.bounds }; }
        setBounds(bounds) { this.bounds = { ...this.bounds, ...bounds }; fire('window:setBounds', { label: this.label, ...this.bounds }); }
        show() { this.visible = true; fire('window:show', { label: this.label }); this.emit('show'); }
        showInactive() { this.show(); }
        hide() { this.visible = false; fire('window:hide', { label: this.label }); this.emit('hide'); }
        focus() { fire('window:focus', { label: this.label }); }
        setFocusable(value) { fire('window:setFocusable', { label: this.label, focusable: value }); }
        restore() { this.minimized = false; fire('window:restore', { label: this.label }); this.emit('restore'); }
        destroy() {
            if (this.destroyed) return;
            this.destroyed = true;
            fire('window:destroy', { label: this.label });
            windows.delete(this.label);
            this.emit('closed');
        }
    }
    class Tray extends EventEmitter {
        constructor() { super(); tray = this; }
        setToolTip(value) { fire('tray:tooltip', { value }); }
        setContextMenu(items) {
            this.items = items;
            fire('tray:menu', { items: items.map((item, i) => ({ id: String(i), label: item.label || '', separator: item.type === 'separator' })) });
        }
        destroy() { if (tray === this) tray = null; }
    }
    class Notification {
        constructor(options) { this.options = options; }
        static isSupported() { return true; }
        show() { fire('notification:show', this.options); }
    }
    const dialogOptions = args => args[args.length - 1];
    const dialog = {
        showOpenDialog: (...args) => call('dialog:open', { options: dialogOptions(args) }),
        showSaveDialog: (...args) => call('dialog:save', { options: dialogOptions(args) }),
        showMessageBox: (...args) => call('dialog:message', { options: dialogOptions(args) }),
        showErrorBox: (title, message) => fire('dialog:message', { options: { title, message, type: 'error', buttons: ['确定 / OK'] } }),
        showMessageBoxSync() { throw Error('同步对话框应由 Tauri 的页面关闭确认处理。'); }
    };
    const screen = new EventEmitter();
    screen.getPrimaryDisplay = () => displays[0];
    screen.getDisplayMatching = bounds => displays.find(display => {
        const area = display.bounds;
        return bounds.x + bounds.width / 2 >= area.x && bounds.x + bounds.width / 2 < area.x + area.width
            && bounds.y + bounds.height / 2 >= area.y && bounds.y + bounds.height / 2 < area.y + area.height;
    }) || displays[0];
    screen.getCursorScreenPoint = () => cursor;
    const ipcMain = { handle: (channel, handler) => handlers.set(channel, handler), removeHandler: channel => handlers.delete(channel) };
    const miniChannels = new Set(['mini:open-main', 'mini:close', 'mini:preferences-read', 'mini:preferences-update', 'mini:applications']);
    const mainChannels = new Set(['backend:request', 'files:save', 'files:open-backup', 'window-preferences:read', 'window-preferences:update',
        'app-icons:get', 'app-control:choose', 'app-control:request', 'app-control:list', 'legacy:status', 'legacy:import', 'updates:open-link',
        'updates:status', 'updates:setting', 'updates:check', 'updates:install']);
    async function receive(message) {
        if (message.type === 'native-result') {
            const entry = pending.get(message.id);
            if (!entry) return;
            pending.delete(message.id); clearTimeout(entry.timer);
            if (message.ok) entry.resolve(message.result);
            else entry.reject(Error(message.error?.message || message.error || '桌面操作失败。'));
        } else if (message.type === 'request') {
            try {
                const window = windows.get(message.window);
                const allowed = message.window === 'main' ? mainChannels : message.window === 'mini' ? miniChannels : new Set();
                if (!window || window.destroyed || !allowed.has(message.channel) || !handlers.has(message.channel) || !Array.isArray(message.args)) throw Error('不支持的页面请求。');
                const event = { sender: window.webContents, senderFrame: window.webContents.mainFrame };
                const result = await handlers.get(message.channel)(event, ...message.args);
                send({ type: 'response', id: message.id, ok: true, result: result ?? null });
            } catch (error) { send({ type: 'response', id: message.id, ok: false, error: { code: error.code || 'unavailable', message: error.message } }); }
        } else if (message.type === 'window-event') {
            const window = windows.get(message.window);
            if (!window) return;
            const wasVisible = window.visible, wasMinimized = window.minimized;
            if (message.bounds) window.bounds = { ...window.bounds, ...message.bounds };
            if (typeof message.visible === 'boolean') window.visible = message.visible;
            if (typeof message.minimized === 'boolean') window.minimized = message.minimized;
            if (message.event === 'visibility') {
                if (wasVisible !== window.visible) window.emit(window.visible ? 'show' : 'hide');
                if (wasMinimized !== window.minimized) window.emit(window.minimized ? 'minimize' : 'restore');
            } else if (message.event === 'did-finish-load') window.webContents.emit(message.event);
            else if (message.event === 'close') {
                const event = preventable();
                window.emit('close', event);
                if (!event.defaultPrevented) app.quit();
            } else if (message.event === 'second-instance') app.emit('second-instance');
            else window.emit(message.event);
        } else if (message.type === 'tray-event') {
            if (message.event === 'click') tray?.emit('click');
            else if (message.event === 'menu') tray?.items?.[Number(message.id)]?.click?.();
        } else if (message.type === 'screen') {
            if (message.cursor) cursor = message.cursor;
            if (message.displays?.length) {
                const changed = JSON.stringify(displays) !== JSON.stringify(message.displays);
                displays = message.displays;
                if (changed) screen.emit('display-metrics-changed');
            }
        } else if (message.type === 'shutdown') app.quit();
    }
    function disconnect() {
        stopped = true;
        for (const entry of pending.values()) { clearTimeout(entry.timer); entry.reject(Error('桌面宿主已断开。')); }
        pending.clear();
        app.quit();
    }
    return { receive, disconnect, app, api: { app, BrowserWindow, dialog, ipcMain, Tray, Notification, screen,
        Menu: { setApplicationMenu() {}, buildFromTemplate: items => items }, nativeImage: { createFromPath: file => ({ file }) },
        shell: { openExternal: url => call('shell:open', { url }) } } };
}

module.exports = { createNativeAdapter };
