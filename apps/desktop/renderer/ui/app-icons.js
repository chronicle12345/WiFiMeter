// 图片异步解码完成后只更新对应头像，不触发列表、表单或抽屉重绘。
export function createAppIconLoader({ request, createImage = () => new Image(), maxEntries = 256 }) {
    const cache = new Map(), pending = new WeakSet();
    let stopped = false, active = 0;
    const queue = [];
    function drain() {
        while (!stopped && active < 4 && queue.length) {
            const { input, resolve } = queue.shift();
            active++;
            Promise.resolve().then(() => request?.(input)).catch(() => null).then(resolve).finally(() => { active--; drain(); });
        }
    }
    function requestQueued(input) {
        if (stopped) return Promise.resolve(null);
        return new Promise(resolve => { queue.push({ input, resolve }); drain(); });
    }
    function load(input) {
        const key = JSON.stringify(input);
        const cached = cache.get(key);
        if (cached && cached.expires > Date.now()) return cached.promise;
        const entry = { expires: Infinity, promise: null };
        entry.promise = requestQueued(input).then(url => {
            if (typeof url !== 'string' || !/^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(url)) { entry.expires = Date.now() + 10000; return null; }
            return url;
        });
        cache.delete(key); cache.set(key, entry);
        while (cache.size > maxEntries) cache.delete(cache.keys().next().value);
        return entry.promise;
    }
    return {
        hydrate(root) {
            if (stopped || !request || !root) return;
            for (const avatar of root.querySelectorAll('[data-app-icon]')) {
                if (pending.has(avatar) || avatar.querySelector('img')) continue;
                pending.add(avatar);
                const input = { appId: avatar.dataset.appIcon, date: avatar.dataset.appIconDate || '' };
                load(input).then(url => {
                    if (!url || stopped || !avatar.isConnected) { pending.delete(avatar); return; }
                    const image = createImage();
                    image.alt = ''; image.className = 'app-avatar__image';
                    image.onload = () => {
                        if (!stopped && avatar.isConnected && avatar.dataset.appIcon === input.appId) avatar.replaceChildren(image);
                        image.onload = image.onerror = null; pending.delete(avatar);
                    };
                    image.onerror = () => { image.onload = image.onerror = null; pending.delete(avatar); };
                    image.src = url;
                });
            }
        },
        stop() { stopped = true; cache.clear(); for (const task of queue.splice(0)) task.resolve(null); }
    };
}
