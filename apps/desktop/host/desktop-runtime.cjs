'use strict';

let desktopRuntime;

// 宿主在加载业务入口前提供原生 API；业务模块无需依赖窗口框架。
function configureDesktopRuntime(api) {
    if (!api || typeof api !== 'object' || !api.app || !api.ipcMain || !api.BrowserWindow) {
        throw new TypeError('桌面宿主 API 不完整。');
    }
    if (desktopRuntime && desktopRuntime !== api) throw Error('桌面宿主已经初始化。');
    desktopRuntime = api;
    return api;
}

function getDesktopRuntime() {
    if (!desktopRuntime) throw Error('桌面宿主尚未初始化。');
    return desktopRuntime;
}

module.exports = { configureDesktopRuntime, getDesktopRuntime };
