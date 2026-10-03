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

export async function launchRenderer({ env }) {
    const backend = new BackendClient({ executable: env.WIFIMETER_BACKEND,
        databasePath: path.join(env.WIFIMETER_USER_DATA, 'wifimeter.db'),
        args: ['--fake-adapter', env.WIFIMETER_FAKE_ADAPTER, '--fake-counters', env.WIFIMETER_FAKE_COUNTERS, '--fake-apps', env.WIFIMETER_FAKE_APPS] });
    const browser = await chromium.launch({ headless: true });
    const server = createServer(async (request, response) => {
        try {
            const pathname = new URL(request.url, 'http://localhost').pathname;
            const file = path.resolve(root, '.' + pathname);
            if (!file.startsWith(root + path.sep) && file !== root) { response.writeHead(404).end(); return; }
            let content = pathname === '/test-bootstrap.js' ? bootstrap : await readFile(file);
            if (pathname === '/renderer/index.html') content = content.toString()
                .replace(/<meta http-equiv="Content-Security-Policy"[^>]*>/, '')
                .replace('src="./app.js"', 'src="/test-bootstrap.js"');
            const type = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.png': 'image/png' }[path.extname(pathname)] || 'application/octet-stream';
            response.writeHead(200, { 'Content-Type': type }).end(content);
        } catch { response.writeHead(404).end(); }
    });
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
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
    await page.goto(`http://127.0.0.1:${server.address().port}/renderer/index.html`);
    return {
        firstWindow: async () => page,
        evaluate: (callback, arg) => {
            context.fixtureArgument = arg;
            return vm.runInContext(`(${callback.toString()})({ requests, events, files }, fixtureArgument)`, context);
        },
        async close() {
            await browser.close(); await backend.stop();
            await new Promise(resolve => server.close(resolve));
        }
    };
}
