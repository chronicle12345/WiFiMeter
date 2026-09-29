const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('desktop', {
    appName: process.platform === 'win32' ? 'WiFiMeter Demo' : 'WiFiMeter',
    saveFile: payload => ipcRenderer.invoke('files:save', payload),
    openBackup: () => ipcRenderer.invoke('files:open-backup')
});
