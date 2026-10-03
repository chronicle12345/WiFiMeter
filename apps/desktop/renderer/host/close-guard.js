// 复用现有 renderer 的 beforeunload 检查，Tauri 的原生退出不经过浏览器导航。
export async function installCloseGuard({ target, listen, invoke }) {
    return listen('window:before-close', ({ payload: id }) => {
        const event = new Event('beforeunload', { cancelable: true });
        target.dispatchEvent(event);
        invoke('desktop_close_reply', { id, dirty: event.defaultPrevented }).catch(console.error);
    });
}
