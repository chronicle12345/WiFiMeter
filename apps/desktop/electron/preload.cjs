const { contextBridge, ipcRenderer } = require('electron');

// 页面只能通过这里访问桌面能力：文件对话框，以及与后端进程通信的请求 / 事件通道。
contextBridge.exposeInMainWorld('desktop', {
    appName: process.platform === 'win32' ? 'WiFiMeter Demo' : 'WiFiMeter',
    saveFile: payload => ipcRenderer.invoke('files:save', payload),
    openBackup: () => ipcRenderer.invoke('files:open-backup'),
    backend: {
        // 失败以 { ok: false, error } 返回而不是抛出，这样错误码能完整传到页面。
        request: (method, params) => ipcRenderer.invoke('backend:request', { method, params }),
        // 返回取消订阅函数，页面重新挂载时不会重复监听。
        onEvent: handler => {
            const listener = (_event, message) => handler(message);
            ipcRenderer.on('backend:event', listener);
            return () => ipcRenderer.removeListener('backend:event', listener);
        }
    }
});
