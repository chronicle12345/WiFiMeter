// 保持 preload 暴露的接口不变；Tauri 的异步监听在页面启动前注册完成。
export async function createDesktopBridge({ invoke, listen }) {
    const channels = [
        'window-preferences:changed', 'window:visibility', 'updates:status',
        'backend:event', 'mini:live', 'mini:state'
    ];
    const handlers = new Map(channels.map(channel => [channel, new Set()]));
    let disposed = false;
    const registrations = await Promise.allSettled(channels.map(channel =>
        listen(channel, event => {
            if (disposed) return;
            for (const handler of [...handlers.get(channel)]) handler(event.payload);
        })
    ));
    const removers = registrations.filter(result => result.status === 'fulfilled').map(result => result.value);
    const failed = registrations.find(result => result.status === 'rejected');
    if (failed) {
        disposed = true;
        removers.forEach(remove => remove());
        throw failed.reason;
    }

    const request = (channel, payload = null) => invoke('desktop_request', { channel, payload });
    const subscribe = (channel, handler) => {
        if (disposed) return () => {};
        // 每次订阅独立，可重复注册同一个回调并分别取消。
        const listener = value => handler(value);
        handlers.get(channel).add(listener);
        return () => handlers.get(channel).delete(listener);
    };
    const desktop = {
        appName: 'WiFiMeter',
        platform: 'win32',
        windowPreferences: {
            read: () => request('window-preferences:read'),
            update: patch => request('window-preferences:update', patch),
            onChanged: handler => subscribe('window-preferences:changed', handler)
        },
        onVisibility: handler => subscribe('window:visibility', handler),
        updates: {
            openLink: url => request('updates:open-link', url),
            status: () => request('updates:status'),
            setCheckOnStartup: value => request('updates:setting', value),
            check: () => request('updates:check'),
            install: () => request('updates:install'),
            onStatus: handler => subscribe('updates:status', handler)
        },
        appIcons: { get: input => request('app-icons:get', input) },
        appControl: {
            chooseProgram: () => request('app-control:choose'),
            request: payload => request('app-control:request', payload)
        },
        legacy: {
            status: () => request('legacy:status'),
            importDirectory: () => request('legacy:import')
        },
        saveFile: payload => request('files:save', payload),
        openBackup: () => request('files:open-backup'),
        backend: {
            request: (method, params) => request('backend:request', { method, params }),
            onEvent: handler => subscribe('backend:event', handler)
        }
    };
    const miniDesktop = {
        openMain: () => request('mini:open-main'),
        close: () => request('mini:close'),
        onLive: handler => subscribe('mini:live', handler),
        onPreferences: handler => subscribe('window-preferences:changed', handler),
        onState: handler => subscribe('mini:state', handler)
    };
    return {
        desktop, miniDesktop,
        dispose() {
            if (disposed) return;
            disposed = true;
            handlers.forEach(listeners => listeners.clear());
            removers.forEach(remove => remove());
        }
    };
}
