'use strict';
const { contextBridge, ipcRenderer } = require('electron');
function subscribe(channel, handler) {
    const listener = (_event, value) => handler(value);
    ipcRenderer.on(channel, listener);
    return () => ipcRenderer.removeListener(channel, listener);
}
contextBridge.exposeInMainWorld('miniDesktop', {
    openMain: () => ipcRenderer.invoke('mini:open-main'),
    close: () => ipcRenderer.invoke('mini:close'),
    onLive: handler => subscribe('mini:live', handler),
    onPreferences: handler => subscribe('window-preferences:changed', handler),
    onState: handler => subscribe('mini:state', handler)
});
