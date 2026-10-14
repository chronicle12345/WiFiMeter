(() => {
    'use strict';
    const isMini = location.pathname.endsWith('/mini/index.html');
    const listeners = new Map();
    let visibilityState;
    let miniPinned = true;
    let miniPreferences, miniPreferenceRevision = 0;
    const invoke = (channel, ...args) => window.__TAURI__.core.invoke('desktop_request', { channel, args });
    const subscribe = (channel, handler) => {
        if (typeof handler !== 'function') throw new TypeError('事件处理函数无效。');
        let entries = listeners.get(channel);
        if (!entries) listeners.set(channel, entries = new Set());
        entries.add(handler);
        return () => entries.delete(handler);
    };
    // 启动脚本先于页面模块执行；事件注册完成后再释放第一个业务请求。
    const ready = window.__TAURI__.event.listen('desktop:event', ({ payload: message }) => {
        if (isMini && message.channel === 'window-preferences:changed') {
            miniPreferences = message.payload;
            miniPinned = miniPreferences.miniPinned === true;
            miniPreferenceRevision++;
        }
        if (!isMini && message.channel === 'window:close-request') {
            const confirm = async () => {
                let dirty;
                if (message.payload.automaticUpdate) {
                    try { dirty = await window.wifimeterPrepareUpdate?.() !== true; }
                    catch { dirty = true; }
                } else {
                    const event = new Event('beforeunload', { cancelable: true });
                    window.dispatchEvent(event);
                    dirty = event.defaultPrevented || event.returnValue === false;
                }
                await invoke('window:confirm-close', { id: message.payload.id, dirty });
            };
            confirm().catch(error => console.error(error));
            return;
        }
        if (message.channel === 'window:visibility') visibilityState = message.payload;
        for (const handler of listeners.get(message.channel) || []) {
            try { handler(message.payload); } catch (error) { console.error(error); }
        }
    });
    const request = (channel, ...args) => ready.then(() => {
        const revision = miniPreferenceRevision;
        return invoke(channel, ...args).then(result => {
            if (isMini && ['mini:preferences-read', 'mini:preferences-update'].includes(channel)) {
                if (revision === miniPreferenceRevision) {
                    miniPreferences = result;
                    miniPinned = result?.miniPinned === true;
                }
                return miniPreferences || result;
            }
            return result;
        });
    });
    const freeze = value => {
        for (const child of Object.values(value)) if (child && typeof child === 'object') freeze(child);
        return Object.freeze(value);
    };
    const main = {
        appName: 'WiFiMeter', platform: navigator.userAgent.includes('Windows') ? 'win32' : 'linux',
        windowPreferences: {
            read: () => request('window-preferences:read'),
            update: patch => request('window-preferences:update', patch),
            onChanged: handler => subscribe('window-preferences:changed', handler)
        },
        onVisibility: handler => {
            const receive = state => handler(typeof state === 'boolean' ? state : state.visible, state?.backgroundTest === true);
            const stop = subscribe('window:visibility', receive);
            if (visibilityState !== undefined) receive(visibilityState);
            return stop;
        },
        updates: {
            openLink: url => request('updates:open-link', url),
            status: () => request('updates:status'),
            setCheckOnStartup: value => request('updates:setting', value),
            check: () => request('updates:check'),
            download: () => request('updates:download'),
            install: () => request('updates:install'),
            onStatus: handler => subscribe('updates:status', handler)
        },
        appIcons: { get: input => request('app-icons:get', input) },
        appControl: {
            chooseProgram: () => request('app-control:choose'),
            request: payload => request('app-control:request', payload),
            list: () => request('app-control:list')
        },
        legacy: { status: () => request('legacy:status'), importDirectory: () => request('legacy:import') },
        saveFile: payload => request('files:save', payload),
        openBackup: () => request('files:open-backup'),
        backend: {
            request: (method, params) => request('backend:request', { method, params }),
            onEvent: handler => subscribe('backend:event', handler)
        }
    };
    const mini = {
        openMain: () => request('mini:open-main'), close: () => request('mini:close'),
        preferences: {
            read: () => request('mini:preferences-read'),
            update: patch => request('mini:preferences-update', patch)
        },
        applications: () => request('mini:applications'),
        onLive: handler => subscribe('mini:live', handler),
        onApplications: handler => subscribe('mini:applications', handler),
        onPreferences: handler => subscribe('window-preferences:changed', handler),
        onState: handler => subscribe('mini:state', handler)
    };
    Object.defineProperty(window, isMini ? 'miniDesktop' : 'desktop', {
        value: freeze(isMini ? mini : main), configurable: false, writable: false
    });
    if (isMini) document.addEventListener('pointerdown', event => {
        if (!miniPinned && event.button === 0 && !event.target.closest('button, a, input, select, textarea, [role="alert"]')) {
            invoke('mini:drag').catch(error => console.error(error));
        }
    });
})();
