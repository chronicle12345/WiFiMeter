// 页面回归测试使用浏览器和真实 C++ 后端；系统窗口行为由 e2e/ 的 Tauri 测试覆盖。
import { chromium } from '@playwright/test';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { BackendClient } from './backend-client.cjs';

const root = path.resolve(fileURLToPath(new URL('../../', import.meta.url)));
const bootstrap = `
import { createDesktopBridge } from '/renderer/host/bridge.js';
const listeners = new Map();
window.fixtureEmit = (channel, payload) => listeners.get(channel)?.({ payload });
const bridge = await createDesktopBridge({
    platform: '${process.platform}',
    invoke: (_command, request) => window.fixtureRequest(request),
    listen: async (channel, callback) => { listeners.set(channel, callback); return () => listeners.delete(channel); }
});
window.desktop = bridge.desktop;
await import('/renderer/app.js');
`;
// 小窗页面只需要宿主状态和小窗桥接，用来回归收起/展开的页面表现。
const miniBootstrap = `
const handlers = new Map();
window.miniDesktop = {
    openMain: async () => {}, close: async () => {},
    onLive: handler => { handlers.set('live', handler); return () => handlers.delete('live'); },
    onPreferences: handler => { handlers.set('preferences', handler); return () => handlers.delete('preferences'); },
    onState: handler => { handlers.set('state', handler); return () => handlers.delete('state'); }
};
window.fixtureState = state => handlers.get('state')?.(state);
await import('/renderer/mini/renderer.js');
`;

// 把 renderer/ 目录映射到根路径；virtual 提供测试引导脚本，rewrite 替换页面里的入口脚本。
async function servePages({ virtual = {}, rewrite = (_pathname, content) => content } = {}) {
    const server = createServer(async (request, response) => {
        try {
            const pathname = new URL(request.url, 'http://localhost').pathname;
            const file = path.resolve(root, '.' + pathname);
            if (!file.startsWith(root + path.sep) && file !== root) { response.writeHead(404).end(); return; }
            const source = Object.hasOwn(virtual, pathname) ? virtual[pathname] : await readFile(file);
            const type = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.png': 'image/png' }[path.extname(pathname)] || 'application/octet-stream';
            // 只有文本资源才做替换，图片等二进制内容保持原样。
            const text = ['text/html', 'text/javascript', 'text/css'].includes(type);
            const content = text ? rewrite(pathname, source.toString()) : source;
            response.writeHead(200, { 'Content-Type': type }).end(content);
        } catch { response.writeHead(404).end(); }
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    return {
        url: pathname => `http://127.0.0.1:${server.address().port}${pathname}`,
        close: () => new Promise(resolve => server.close(resolve))
    };
}

export async function launchMini() {
    const browser = await chromium.launch({ headless: true });
    const pages = await servePages({
        virtual: { '/test-mini-bootstrap.js': miniBootstrap },
        rewrite: (pathname, content) => pathname === '/renderer/mini/index.html'
            ? content.replace('src="renderer.js"', 'src="/test-mini-bootstrap.js"')
            : content
    });
    const page = await browser.newPage({ viewport: { width: 224, height: 92 } });
    await page.goto(pages.url('/renderer/mini/index.html'));
    return {
        page,
        async close() { await browser.close(); await pages.close(); }
    };
}

export async function launchRenderer({ env }) {
    const backend = new BackendClient({ executable: env.WIFIMETER_BACKEND,
        databasePath: path.join(env.WIFIMETER_USER_DATA, 'wifimeter.db'),
        args: ['--fake-adapter', env.WIFIMETER_FAKE_ADAPTER, '--fake-counters', env.WIFIMETER_FAKE_COUNTERS, '--fake-apps', env.WIFIMETER_FAKE_APPS] });
    const browser = await chromium.launch({ headless: true });
    const pages = await servePages({
        virtual: { '/test-bootstrap.js': bootstrap },
        rewrite: (pathname, content) => pathname === '/renderer/index.html'
            ? content.replace(/<meta http-equiv="Content-Security-Policy"[^>]*>/, '')
                .replace('src="./app.js"', 'src="/test-bootstrap.js"')
            : content
    });
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    const events = { emit: (channel, payload) => page.evaluate(({ channel, payload }) => window.fixtureEmit?.(channel, payload), { channel, payload }) };
    backend.on('event', value => { events.emit('backend:event', value).catch(() => {}); });
    const handlers = new Map();
    const requests = { handle: (channel, handler) => handlers.set(channel, handler), removeHandler: channel => handlers.delete(channel) };
    const files = { save: '', open: '' };
    let preferences = { miniWindow: false, miniShape: 'pill', miniPalette: 'auto', miniAutoHide: true, closeAction: 'tray', theme: 'system' };
    const preferencesFile = path.join(env.WIFIMETER_USER_DATA, 'window-preferences.json');
    try { preferences = { ...preferences, ...JSON.parse(await readFile(preferencesFile, 'utf8')) }; } catch (error) { if (error.code !== 'ENOENT') throw error; }
    let updates = { state: 'idle', currentVersion: '1.2.2', checkOnStartup: true };
    requests.handle('backend:request', async (_event, { method, params }) => {
        try { return { ok: true, result: await backend.request(method, params) }; }
        catch (error) { return { ok: false, error: { code: error.code, message: error.message } }; }
    });
    requests.handle('window-preferences:read', () => preferences);
    requests.handle('window-preferences:update', async (_event, patch) => {
        preferences = { ...preferences, ...patch };
        await writeFile(preferencesFile, JSON.stringify(preferences));
        await events.emit('window-preferences:changed', preferences);
        return preferences;
    });
    requests.handle('updates:status', () => updates);
    requests.handle('updates:setting', (_event, value) => (updates = { ...updates, checkOnStartup: value }));
    requests.handle('legacy:status', () => ({ found: false }));
    // 数据位置夹具：默认使用隔离目录，切换后指向 -custom 目录，测试可整体替换处理器。
    const defaultDatabase = path.join(env.WIFIMETER_USER_DATA, 'wifimeter.db');
    let dataLocation = { directory: env.WIFIMETER_USER_DATA, database: defaultDatabase, custom: false, temporaryDefault: false, defaultDirectory: env.WIFIMETER_USER_DATA };
    requests.handle('data-location:read', () => dataLocation);
    requests.handle('data-location:choose', () => {
        const directory = `${env.WIFIMETER_USER_DATA}-custom`;
        dataLocation = { ...dataLocation, directory, database: path.join(directory, 'wifimeter.db'), custom: true, temporaryDefault: false };
        return { ok: true, changed: true, directory, database: dataLocation.database, copied: true, source: defaultDatabase };
    });
    requests.handle('data-location:reset', () => {
        dataLocation = { ...dataLocation, directory: dataLocation.defaultDirectory, database: defaultDatabase, custom: false, temporaryDefault: false };
        return { ok: true, changed: true, directory: dataLocation.directory, database: defaultDatabase, copied: true };
    });
    requests.handle('app-icons:get', () => null);
    requests.handle('files:save', async (_event, { body }) => {
        if (!files.save) return { canceled: true };
        await writeFile(files.save, body); return { canceled: false };
    });
    requests.handle('files:open-backup', async () => files.open ? { canceled: false, body: await readFile(files.open, 'utf8') } : { canceled: true });
    await page.exposeBinding('fixtureRequest', (_source, { channel, payload }) => {
        const handler = handlers.get(channel);
        if (!handler) throw Error(`Missing renderer fixture: ${channel}`);
        return handler(null, payload);
    });
    // 每次启动独立的夹具上下文，让测试中的快照、延迟响应和计数在 reload 后仍有效。
    const context = vm.createContext({ requests, events, files, setTimeout, clearTimeout });
    await page.goto(pages.url('/renderer/index.html'));
    return {
        firstWindow: async () => page,
        evaluate: (callback, arg) => {
            context.fixtureArgument = arg;
            return vm.runInContext(`(${callback.toString()})({ requests, events, files }, fixtureArgument)`, context);
        },
        async close() {
            await browser.close(); await backend.stop();
            await pages.close();
        }
    };
}
