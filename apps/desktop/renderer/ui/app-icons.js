// 图片异步解码完成后只更新对应头像，不触发列表、表单或抽屉重绘。
export function createAppIconLoader({ request, createImage = () => new Image(), maxEntries = 256 }) {
    const cache = new Map(), requests = new Map(), pending = new WeakMap();
    let stopped = false, active = 0;
    const queue = [];
    const matches = (avatar, input) => avatar.isConnected && avatar.dataset.appIcon === input.appId
        && (avatar.dataset.appIconDate || '') === input.date;
    function complete(entry, url, cancelled = false) {
        if (requests.get(entry.key) === entry) requests.delete(entry.key);
        entry.subscribers.clear();
        if (!cancelled && !stopped) {
            entry.expires = url ? Infinity : Date.now() + 10000;
            cache.delete(entry.key); cache.set(entry.key, entry);
            while (cache.size > maxEntries) cache.delete(cache.keys().next().value);
        }
        entry.resolve(url);
    }
    function drain() {
        while (!stopped && active < 4 && queue.length) {
            const entry = queue.shift();
            for (const [avatar, token] of entry.subscribers) {
                if (pending.get(avatar) !== token || !matches(avatar, entry.input)) {
                    if (pending.get(avatar) === token) pending.delete(avatar);
                    entry.subscribers.delete(avatar);
                }
            }
            if (!entry.subscribers.size) { complete(entry, null, true); continue; }
            active++;
            Promise.resolve().then(() => request?.(entry.input)).catch(() => null).then(url => {
                complete(entry, typeof url === 'string' && /^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(url) ? url : null);
            }).finally(() => { active--; drain(); });
        }
    }
    function load(input, avatar, token) {
        const key = JSON.stringify(input);
        const queued = requests.get(key);
        if (queued) { queued.subscribers.set(avatar, token); return queued.promise; }
        const cached = cache.get(key);
        if (cached && cached.expires > Date.now()) return cached.promise;
        const entry = { key, input, subscribers: new Map([[avatar, token]]), expires: Infinity, promise: null, resolve: null };
        entry.promise = new Promise(resolve => { entry.resolve = resolve; });
        cache.delete(key); requests.set(key, entry); queue.push(entry); drain();
        return entry.promise;
    }
    return {
        hydrate(root) {
            if (stopped || !request || !root) return;
            for (const avatar of root.querySelectorAll('[data-app-icon]')) {
                const input = { appId: avatar.dataset.appIcon, date: avatar.dataset.appIconDate || '' };
                const key = JSON.stringify(input);
                if (pending.get(avatar)?.key === key || avatar.querySelector('img')) continue;
                const token = { key };
                pending.set(avatar, token);
                const finish = () => { if (pending.get(avatar) === token) pending.delete(avatar); };
                load(input, avatar, token).then(url => {
                    if (pending.get(avatar) !== token) return;
                    if (!url || stopped || !matches(avatar, input)) { finish(); return; }
                    const image = createImage();
                    image.alt = ''; image.className = 'app-avatar__image';
                    image.onload = () => {
                        if (!stopped && pending.get(avatar) === token && matches(avatar, input)) avatar.replaceChildren(image);
                        image.onload = image.onerror = null; finish();
                    };
                    image.onerror = () => { image.onload = image.onerror = null; finish(); };
                    image.src = url;
                });
            }
        },
        stop() {
            stopped = true; cache.clear();
            for (const entry of queue.splice(0)) complete(entry, null, true);
            for (const entry of requests.values()) entry.subscribers.clear();
        }
    };
}
