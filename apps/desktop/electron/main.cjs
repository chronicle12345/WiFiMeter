const { app, BrowserWindow, dialog, ipcMain, Menu, Tray, Notification, nativeImage, shell } = require('electron');
const path = require('node:path');
const { existsSync } = require('node:fs');
const { pathToFileURL } = require('node:url');
const { createFileActions } = require('./files.cjs');
const { BackendClient, resolveExecutable } = require('./backend.cjs');
const { createSystemIntegration } = require('./system.cjs');
const { applyProductIdentity } = require('./product.cjs');
const { legacyDirectory, importLegacyDirectory } = require('./legacy.cjs');
const { createAppControl } = require('./app-control.cjs');
const { createUpdateService } = require('./updates.cjs');
const { launchUpdateHandoff } = require('./update-handoff.cjs');

const pagePath = path.join(__dirname, '../renderer/index.html');
const pageURL = pathToFileURL(pagePath).href;
let window;
let backend;
let system;
let quitting = false;
let installingUpdate = false;
let startup;
let migrationStatus = { found: false };
let migrationBusy = false;
let lastAutoStartPreference = false;
let preserveUnmatchedLoginItem = false;

// 产品身份（应用名、App User Model ID、用户数据目录）在 product.cjs 里，
// 并与打包文档保持一致；改名或改路径都会让老用户的数据看起来消失，因此那里有测试。
const productName = applyProductIdentity(app, process.platform, app.getPath('appData')).productName;
// Tests use an isolated profile and never modify the user's demo records.
if (process.env.WIFIMETER_USER_DATA) app.setPath('userData', process.env.WIFIMETER_USER_DATA);
// Explicit fixture mode isolates operating-system settings as well as the database.
if (process.env.WIFIMETER_TEST_ISOLATION === '1') {
    app.setPath('home', process.env.WIFIMETER_TEST_HOME || app.getPath('userData'));
    if (process.platform === 'win32') {
        let loginEnabled = false;
        app.setLoginItemSettings = options => { loginEnabled = Boolean(options.openAtLogin); };
        app.getLoginItemSettings = () => ({ openAtLogin: loginEnabled, executableWillLaunchAtLogin: loginEnabled });
    }
}

if (process.env.WIFIMETER_SOFTWARE_RENDERING === '1') app.disableHardwareAcceleration();
const primaryInstance = app.requestSingleInstanceLock();
if (!primaryInstance) app.quit();
app.on('second-instance', () => {
    if (window && !window.isDestroyed()) { window.show(); if (window.isMinimized()) window.restore(); window.focus(); }
});
if (primaryInstance) app.whenReady().then(async () => {
    Menu.setApplicationMenu(null);
    window = new BrowserWindow({
        width: 1280, height: 900, minWidth: 900, minHeight: 650,
        title: productName, backgroundColor: '#f4f7fc',
        icon: path.join(__dirname, '../assets/icon.png'),
        webPreferences: {
            preload: path.join(__dirname, 'preload.cjs'),
            contextIsolation: true, sandbox: true, nodeIntegration: false, spellcheck: false
        }
    });
    const sendVisibility = () => window.webContents.send('window:visibility', window.isVisible() && !window.isMinimized());
    for (const event of ['hide', 'show', 'minimize', 'restore']) window.on(event, sendVisibility);
    window.webContents.on('did-finish-load', sendVisibility);
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    // 开启“关闭窗口时最小化到托盘”后，关闭窗口只隐藏，采集继续。
    window.on('close', event => system?.handleWindowClose(event));
    window.webContents.on('will-navigate', event => event.preventDefault());
    window.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    window.webContents.on('will-prevent-unload', event => {
        const choice = dialog.showMessageBoxSync(window, {
            type: 'question', title: `退出 ${productName}`,
            message: '有尚未保存的设置，仍然退出？',
            buttons: ['继续编辑', '放弃更改并退出'], defaultId: 0, cancelId: 0
        });
        if (choice === 1) event.preventDefault();
    });
    const files = createFileActions(dialog, () => window);
    for (const [channel, handler] of [['files:save', files.saveFile], ['files:open-backup', files.openBackup]]) {
        ipcMain.handle(channel, (event, payload) => {
            if (event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame
                || event.senderFrame.url.split(/[?#]/)[0] !== pageURL) throw Error('不支持的页面请求。');
            return handler(payload);
        });
    }

    // 后端进程由主进程拉起并按需重启；数据库放在用户数据目录，与演示版的存储键区分开。
    const firstDatabaseUse = !existsSync(path.join(app.getPath('userData'), 'wifimeter.db'));
    backend = new BackendClient({
        executable: resolveExecutable({ repositoryRoot: path.join(__dirname, '../../..'), resourcesPath: process.resourcesPath, platform: process.platform }),
        databasePath: path.join(app.getPath('userData'), 'wifimeter.db'),
        args: ['--paused'],
        logger: message => console.log(`[backend] ${message}`)
    });
    system = createSystemIntegration({
        app, Tray, Menu, Notification, nativeImage,
        getWindow: () => window,
        iconPath: path.join(__dirname, '../assets/icon.png'),
        logger: message => console.log(`[system] ${message}`)
    });

    // 只读查询当前可执行文件的登录启动状态，不扫描或删除其他路径的旧启动项。
    async function inheritLegacyLoginItem(result) {
        if (process.platform !== 'win32' || process.env.WIFIMETER_USER_DATA || !result.found || !result.settingsApplied) return;
        try {
            const current = app.getLoginItemSettings({ path: process.execPath });
            if (current.openAtLogin) {
                await backend.request('updateSettings', { settings: { autoStart: true } });
                return;
            }
            preserveUnmatchedLoginItem = true;
            result.warnings = [...(result.warnings || []), '未确认当前路径的登录启动项，原旧启动项保持不变；其他 portable 路径不会自动迁移或删除。'];
        } catch (error) {
            preserveUnmatchedLoginItem = true;
            result.warnings = [...(result.warnings || []), '无法确认旧登录启动项，已保留原项：' + error.message];
        }
    }

    backend.on('event', message => {
        if (window && !window.isDestroyed()) window.webContents.send('backend:event', message);
        if (message.event === 'alert') system.notify(message);
    });
    backend.on('exit', ({ unexpected }) => {
        if (unexpected) console.error('[backend] 进程意外退出，下一次请求会重新拉起。');
    });
    backend.start();

    startup = (async () => {
        try {
            migrationStatus = await importLegacyDirectory({ directory: legacyDirectory(), allowInitialSettings: firstDatabaseUse, userData: app.getPath('userData'), request: (method, params) => backend.request(method, params, { timeout: ['backup', 'importLegacy', 'restore'].includes(method) ? 300000 : 15000 }) });
            await inheritLegacyLoginItem(migrationStatus);
            await backend.request('setPaused', { paused: false });
        } catch (error) {
            migrationStatus = { found: true, error: error.message };
            preserveUnmatchedLoginItem = process.platform === 'win32';
            // A failed migration stays paused so new samples cannot overlap the old history.
        }
    })();

    // 启动时按已保存的偏好同步一次系统状态（开机启动文件、托盘）。
    startup.then(() => backend.request('hello')).then(result => {
        lastAutoStartPreference = Boolean(result.settings?.autoStart);
        if (migrationStatus.error || preserveUnmatchedLoginItem || (process.platform === 'win32' && process.env.WIFIMETER_USER_DATA && process.env.WIFIMETER_TEST_ISOLATION !== '1')) return;
        return system.applySettings(result.settings ?? {});
    }).catch(error => console.log(`[system] 同步设置失败：${error.message}`));

    const trusted = event => event.sender === window.webContents && event.senderFrame === window.webContents.mainFrame
        && event.senderFrame.url.split(/[?#]/)[0] === pageURL;

    // 失败以结果信封返回而不是抛出：Electron 跨进程只保留错误消息，会丢掉错误码，
    // 而界面需要靠错误码决定提示文案。
    ipcMain.handle('backend:request', async (event, payload) => {
        if (!trusted(event)) throw Error('不支持的页面请求。');
        const method = typeof payload?.method === 'string' ? payload.method : '';
        if (!method) return { ok: false, error: { code: 'badRequest', message: '缺少方法名。' } };
        try {
            await startup;
            if (installingUpdate) throw Error('The application is stopping for an update.');
            if (migrationBusy && !['hello', 'snapshot', 'exportUsage', 'backup', 'migrationStatus'].includes(method)) throw Error('Migration is running; changes are temporarily unavailable. / 正在迁移，暂时不能修改数据或恢复采集。');
            if (migrationStatus.error && method === 'setPaused' && payload.params?.paused === false) throw Error(migrationStatus.error);
            const result = await backend.request(method, payload.params ?? {}, { timeout: ['backup', 'restore'].includes(method) ? 300000 : 15000 });
            // 设置改动后立刻作用于系统，并把实际生效的结果回给页面。
            if (method === 'updateSettings' && result?.settings) {
                const explicitAutoStart = Object.prototype.hasOwnProperty.call(payload.params?.settings ?? {}, 'autoStart') && Boolean(payload.params.settings.autoStart) !== lastAutoStartPreference;
                lastAutoStartPreference = Boolean(result.settings.autoStart);
                if (!(process.platform === 'win32' && process.env.WIFIMETER_USER_DATA && process.env.WIFIMETER_TEST_ISOLATION !== '1') && (!preserveUnmatchedLoginItem || explicitAutoStart)) {
                    if (explicitAutoStart) preserveUnmatchedLoginItem = false;
                    result.system = await system.applySettings(result.settings);
                }
            }
            return { ok: true, result };
        } catch (error) {
            return { ok: false, error: { code: error.code ?? 'unavailable', message: error.message } };
        }
    });

    const controls = createAppControl({ platform: process.platform, dialog, getWindow: () => window, isPackaged: app.isPackaged, resourcesPath: process.resourcesPath });
    ipcMain.handle('app-control:choose', event => { if (!trusted(event)) throw Error('Unsupported page.'); return controls.chooseProgram(); });
    ipcMain.handle('app-control:request', (event, payload) => { if (!trusted(event)) throw Error('Unsupported page.'); return controls.request(payload); });
    ipcMain.handle('legacy:status', async event => { if (!trusted(event)) throw Error('Unsupported page.'); await startup; return migrationStatus; });
    ipcMain.handle('legacy:import', async event => {
        if (!trusted(event)) throw Error('Unsupported page.');
        await startup;
        if (installingUpdate) return { error: '正在更新或恢复采集，暂时不能导入数据。' };
        if (migrationBusy) return { error: 'An import is already running.' };
        migrationBusy = true;
        try {
            const choice = await dialog.showOpenDialog(window, { properties: ['openDirectory'], title: 'Import WiFiMeter 1.x data / 导入旧版数据' });
            if (choice.canceled || !choice.filePaths.length) return { canceled: true };
            await backend.request('setPaused', { paused: true });
            migrationStatus = await importLegacyDirectory({ directory: choice.filePaths[0], userData: app.getPath('userData'), request: (method, params) => backend.request(method, params, { timeout: ['backup', 'importLegacy', 'restore'].includes(method) ? 300000 : 15000 }) });
            if (!migrationStatus.found) throw Error('No state.json or state.json.bak was found in the selected directory.');
            await inheritLegacyLoginItem(migrationStatus);
            return migrationStatus;
        } catch (error) {
            await backend.request('setPaused', { paused: true }).catch(pauseError => console.error('[migration] Pause failed:', pauseError.message));
            migrationStatus = { found: true, error: error.message }; return migrationStatus;
        }
        finally { migrationBusy = false; }
    });
    let updateState = { currentVersion: app.getVersion(), checkOnStartup: true };
    let updateRecovery = null;
    let updateRequestBusy = false;
    async function recoverAfterUpdateFailure(result) {
        if (!updateRecovery) return result;
        try {
            await backend.waitForShutdown({ timeout: 30000 });
            if (updateRecovery.pauseRequested) {
                if (updateRecovery.appsEnabled) await backend.request('setAppCollection', { enabled: true });
                await backend.request('setPaused', { paused: updateRecovery.paused });
            }
            updateRecovery = null;
            installingUpdate = false;
            return { ...result, recoveryRequired: false };
        } catch (error) {
            // 保留保护状态和原偏好；稍后重试更新时先重新尝试恢复。
            return { ...result, state: 'error', status: 'error', recoveryRequired: true,
                error: `更新取消，恢复失败：${error.message} 数据操作保持暂停，请稍后点击恢复采集重试。` };
        }
    }
    const updateService = createUpdateService({
        currentVersion: app.getVersion(), platform: process.platform, arch: process.arch,
        userData: app.getPath('userData'),
        openExternal: url => shell.openExternal(url),
        confirm: async details => {
            const choice = await dialog.showMessageBox(window, {
                type: 'question', title: 'WiFiMeter update / 软件更新',
                message: `WiFiMeter ${details.latestVersion}`,
                detail: details.canInstall ? 'Download, verify and install this update? The application will save and exit.\n是否下载、校验并安装更新？程序将先保存并退出。'
                    : 'Open the official release page to choose a package?\n是否打开官方发布页选择更新包？',
                buttons: ['Continue / 继续', 'Cancel / 取消'], defaultId: 1, cancelId: 1
            });
            return choice.response === 0;
        },
        beforeInstall: async () => {
            await startup;
            if (migrationBusy || migrationStatus.error) throw Error('Resolve migration before updating.');
            installingUpdate = true;
            updateRecovery = { paused: null, pauseRequested: false };
            const original = await backend.request('hello');
            if (typeof original.paused !== 'boolean') throw Error('无法确认原采集状态，更新取消。');
            updateRecovery.paused = original.paused;
            updateRecovery.appsEnabled = original.appCollection?.enabled === true;
            updateRecovery.pauseRequested = true;
            await backend.request('setPaused', { paused: true });
            await backend.stopGracefully({ timeout: 30000 });
            if (backend.running) throw Error('The collector has not exited.');
        },
        launchInstaller: async (file, _argv, { digest }) => {
            await launchUpdateHandoff(file, { digest, userData: app.getPath('userData') });
            backend = null; quitting = true; system?.beginQuit(); app.quit();
        }
    });
    const updateResult = value => {
        updateState = { ...updateState, ...value };
        if (window && !window.isDestroyed()) window.webContents.send('updates:status', updateState);
        return updateState;
    };
    ipcMain.handle('updates:status', async event => { if (!trusted(event)) throw Error('Unsupported page.'); return updateResult(await updateService.settings()); });
    ipcMain.handle('updates:setting', async (event, value) => { if (!trusted(event)) throw Error('Unsupported page.'); return updateResult(await updateService.setCheckOnStartup(value)); });
    ipcMain.handle('updates:check', async event => { if (!trusted(event)) throw Error('Unsupported page.'); return updateResult(await updateService.check()); });
    ipcMain.handle('updates:install', async event => {
        if (!trusted(event)) throw Error('Unsupported page.');
        if (updateRequestBusy) return { ...updateState, state: 'busy', status: 'busy' };
        updateRequestBusy = true;
        try {
            if (updateRecovery) return updateResult(await recoverAfterUpdateFailure({ state: 'recovered', status: 'recovered', error: '' }));
            const result = await updateService.install();
            return updateResult(result.state === 'installing' || result.state === 'busy'
                ? result : await recoverAfterUpdateFailure(result));
        } finally { updateRequestBusy = false; }
    });
    await window.loadFile(pagePath);
    await startup;
    if (app.isPackaged && !process.env.WIFIMETER_USER_DATA && !process.env.WIFIMETER_TEST_ISOLATION) {
        updateService.check({ automatic: true }).then(updateResult).catch(error => updateResult({ state: 'error', error: error.message }));
    }
    if (migrationStatus.error) dialog.showErrorBox('WiFiMeter data import / 数据导入', migrationStatus.error + '\nCollection is paused. Original files are unchanged. / 统计已暂停，原文件未修改。');
});
app.on('window-all-closed', () => app.quit());

// 退出前先让后端收尾（提交数据库、结束未完成的空档），避免计数差丢在退出瞬间。
app.on('before-quit', event => {
    if (installingUpdate && !quitting) { event.preventDefault(); return; }
    system?.beginQuit();
    if (quitting || !backend) return;
    event.preventDefault();
    quitting = true;
    backend.stop().catch(error => console.error(`[backend] 停止失败：${error.message}`))
        .finally(() => {
            backend = null;
            system?.dispose();
            app.quit();
        });
});
