const { app, BrowserWindow, dialog, ipcMain, Menu, Tray, Notification, nativeImage } = require('electron');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { createFileActions } = require('./files.cjs');
const { BackendClient, resolveExecutable } = require('./backend.cjs');
const { createSystemIntegration } = require('./system.cjs');

const pagePath = path.join(__dirname, '../renderer/index.html');
const pageURL = pathToFileURL(pagePath).href;
let window;
let backend;
let system;
let quitting = false;

const isWindows = process.platform === 'win32';
const productName = isWindows ? 'WiFiMeter Demo' : 'WiFiMeter';
app.setName(productName);
if (isWindows) {
    app.setAppUserModelId('io.wifimeter.demo');
    app.setPath('userData', path.join(app.getPath('appData'), 'WiFiMeter Demo'));
}
// Tests use an isolated profile and never modify the user's demo records.
if (process.env.WIFIMETER_USER_DATA) app.setPath('userData', process.env.WIFIMETER_USER_DATA);

app.whenReady().then(async () => {
    Menu.setApplicationMenu(null);
    window = new BrowserWindow({
        width: 1280, height: 900, minWidth: 900, minHeight: 650,
        title: productName, backgroundColor: '#f4f7fc',
        icon: path.join(__dirname, '../assets/icon.png'),
        webPreferences: {
            preload: path.join(__dirname, 'preload.cjs'),
            contextIsolation: true, sandbox: true, nodeIntegration: false
        }
    });
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
    backend = new BackendClient({
        executable: resolveExecutable({ repositoryRoot: path.join(__dirname, '../../..'), resourcesPath: process.resourcesPath }),
        databasePath: path.join(app.getPath('userData'), 'wifimeter.db'),
        logger: message => console.log(`[backend] ${message}`)
    });
    system = createSystemIntegration({
        app, Tray, Menu, Notification, nativeImage,
        getWindow: () => window,
        iconPath: path.join(__dirname, '../assets/icon.png'),
        logger: message => console.log(`[system] ${message}`)
    });

    backend.on('event', message => {
        if (window && !window.isDestroyed()) window.webContents.send('backend:event', message);
        if (message.event === 'alert') system.notify(message);
    });
    backend.on('exit', ({ unexpected }) => {
        if (unexpected) console.error('[backend] 进程意外退出，下一次请求会重新拉起。');
    });
    backend.start();

    // 启动时按已保存的偏好同步一次系统状态（开机启动文件、托盘）。
    backend.request('hello').then(result => system.applySettings(result.settings ?? {})).catch(error => console.log(`[system] 同步设置失败：${error.message}`));

    const trusted = event => event.sender === window.webContents && event.senderFrame === window.webContents.mainFrame
        && event.senderFrame.url.split(/[?#]/)[0] === pageURL;

    // 失败以结果信封返回而不是抛出：Electron 跨进程只保留错误消息，会丢掉错误码，
    // 而界面需要靠错误码决定提示文案。
    ipcMain.handle('backend:request', async (event, payload) => {
        if (!trusted(event)) throw Error('不支持的页面请求。');
        const method = typeof payload?.method === 'string' ? payload.method : '';
        if (!method) return { ok: false, error: { code: 'badRequest', message: '缺少方法名。' } };
        try {
            const result = await backend.request(method, payload.params ?? {});
            // 设置改动后立刻作用于系统，并把实际生效的结果回给页面。
            if (method === 'updateSettings' && result?.settings) {
                result.system = await system.applySettings(result.settings);
            }
            return { ok: true, result };
        } catch (error) {
            return { ok: false, error: { code: error.code ?? 'unavailable', message: error.message } };
        }
    });

    await window.loadFile(pagePath);
});
app.on('window-all-closed', () => app.quit());

// 退出前先让后端收尾（提交数据库、结束未完成的空档），避免计数差丢在退出瞬间。
app.on('before-quit', event => {
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
