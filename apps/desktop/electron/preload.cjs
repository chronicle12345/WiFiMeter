const { contextBridge, ipcRenderer } = require('electron');

// 页面只能通过这里访问桌面能力：文件对话框，以及与后端进程通信的请求 / 事件通道。
//
// 应用名在这里再写一遍是有原因的：preload 运行在 sandbox 里，只能 require 'electron'，
// 不能引入 product.cjs。为了避免两处写法不一致，测试会加载本文件并比对
// （tests/product.test.js 的「preload 暴露的产品名与产品身份一致」）。
contextBridge.exposeInMainWorld('desktop', {
    appName: 'WiFiMeter',
    platform: process.platform,
    appControl: {
        chooseProgram: () => ipcRenderer.invoke('app-control:choose'),
        request: payload => ipcRenderer.invoke('app-control:request', payload)
    },
    legacy: {
        status: () => ipcRenderer.invoke('legacy:status'),
        importDirectory: () => ipcRenderer.invoke('legacy:import')
    },
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
