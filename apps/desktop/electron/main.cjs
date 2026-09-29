const { app, BrowserWindow, dialog, ipcMain, Menu } = require('electron');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { createFileActions } = require('./files.cjs');

const pagePath = path.join(__dirname, '../renderer/index.html');
const pageURL = pathToFileURL(pagePath).href;
let window;

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
    await window.loadFile(pagePath);
});
app.on('window-all-closed', () => app.quit());
