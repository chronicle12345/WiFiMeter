import { createDesktopBridge } from './bridge.js';
import { installDialogs } from './dialogs.js';
import { installCloseGuard } from './close-guard.js';

const { core, event, window: windows } = window.__TAURI__;
const bridge = await createDesktopBridge({ invoke: core.invoke, listen: event.listen });
window.addEventListener('unload', () => bridge.dispose(), { once: true });

if (location.pathname.endsWith('/electron/mini/index.html')) {
    window.miniDesktop = bridge.miniDesktop;
    // WebView2 不支持 Electron 的 -webkit-app-region，沿用原来的空白区拖动行为。
    document.querySelector('main').addEventListener('mousedown', event => {
        if (event.button !== 0 || event.target.closest('button')) return;
        windows.getCurrentWindow().startDragging().catch(console.error);
    });
    await import('../electron/mini/renderer.js');
} else {
    const removeCloseGuard = await installCloseGuard({ target: window, listen: event.listen, invoke: core.invoke });
    window.addEventListener('unload', removeCloseGuard, { once: true });
    const removeDialogs = await installDialogs({ listen: event.listen, invoke: core.invoke });
    window.addEventListener('unload', removeDialogs, { once: true });
    window.desktop = bridge.desktop;
    await import('../renderer/app.js');
}
// 页面监听建立后再发送窗口初始状态，避免小窗漏掉配色、形状和实时速率。
await core.invoke('desktop_ready');
