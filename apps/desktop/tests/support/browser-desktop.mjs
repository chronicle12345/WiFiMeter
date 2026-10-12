import { chromium } from '@playwright/test';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';
import { createIsolatedHost } from './isolated-host.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const desktopRoot = path.join(root, 'apps/desktop');
const mime = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };
function bitmapImage(bytes, { width, height }) {
    const crc = data => {
        let value = 0xffffffff;
        for (const byte of data) { value ^= byte; for (let bit = 0; bit < 8; bit++) value = (value >>> 1) ^ (value & 1 ? 0xedb88320 : 0); }
        return (value ^ 0xffffffff) >>> 0;
    };
    const chunk = (name, data) => {
        const nameBytes = Buffer.from(name), length = Buffer.alloc(4), checksum = Buffer.alloc(4);
        length.writeUInt32BE(data.length); checksum.writeUInt32BE(crc(Buffer.concat([nameBytes, data])));
        return Buffer.concat([length, nameBytes, data, checksum]);
    };
    const header = Buffer.alloc(13); header.writeUInt32BE(width); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 6;
    const rows = Buffer.alloc(height * (width * 4 + 1));
    for (let y = 0; y < height; y++) Buffer.from(bytes).copy(rows, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
    const png = Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), chunk('IHDR', header), chunk('IDAT', deflateSync(rows)), chunk('IEND', Buffer.alloc(0))]);
    return { isEmpty: () => false, toDataURL: () => 'data:image/png;base64,' + png.toString('base64') };
}

export const desktop = { async launch({ env = process.env } = {}) {
    const testEnv = { ...env, WIFIMETER_BACKGROUND_TEST: '1', WIFIMETER_TEST_ISOLATION: '1' };
    if (!testEnv.WIFIMETER_USER_DATA) throw Error('浏览器测试必须提供独立数据目录。');
    const isolated = createIsolatedHost({ root, env: testEnv });
    const effects = new Set(), pages = new Map(), windows = new Set(), responses = new Map(), events = new Map();
    let browser, context, adapter, origin, requestId = 1, closed = false, quitResolve;
    const quit = new Promise(resolve => { quitResolve = resolve; });
    const schedule = task => {
        const effect = Promise.resolve().then(task); effects.add(effect);
        effect.catch(error => { if (!closed) console.error('[browser fixture]', error.message); }).finally(() => effects.delete(effect));
        return effect;
    };
    const settle = async () => { for (let i = 0; i < 4 && effects.size; i++) await Promise.all([...effects]); };
    const server = http.createServer((request, response) => {
        const pathname = decodeURIComponent(new URL(request.url, 'http://127.0.0.1').pathname);
        const file = path.resolve(desktopRoot, '.' + pathname);
        if (!file.startsWith(desktopRoot + path.sep)) { response.writeHead(403).end(); return; }
        try { response.setHeader('Content-Type', mime[path.extname(file)] || 'application/octet-stream'); response.end(fs.readFileSync(file)); }
        catch { response.writeHead(404).end(); }
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    origin = 'http://127.0.0.1:' + server.address().port;
    const channel = process.env.WIFIMETER_BROWSER_CHANNEL || (process.platform === 'win32' ? 'msedge' : 'chromium');
    try {
        browser = await chromium.launch({ headless: true, ...(channel === 'chromium' ? {} : { channel }), args: ['--disable-background-timer-throttling', '--disable-renderer-backgrounding'] });
        context = await browser.newContext({ viewport: { width: 1248, height: 768 }, deviceScaleFactor: 1 });
        await context.exposeBinding('__desktopRequest', async ({ page }, channel, args) => {
            const id = requestId++, window = [...pages].find(([, candidate]) => candidate === page)?.[0];
            const result = new Promise((resolve, reject) => responses.set(id, { resolve, reject }));
            await adapter.receive({ type: 'request', id, window, channel, args });
            return result;
        });
        const bootstrap = `(() => {
            const handlers = new Set();
            window.__deliverDesktopEvent = message => { for (const handler of handlers) handler({payload:message}); };
            window.__TAURI__ = { core:{invoke:(_method,payload)=>window.__desktopRequest(payload.channel,payload.args)},
                event:{listen:async(_channel,handler)=>{handlers.add(handler);return()=>handlers.delete(handler);}} };
        })();\n` + fs.readFileSync(path.join(desktopRoot, 'tauri/bridge.js'), 'utf8');
        await context.addInitScript(bootstrap);
        const native = async message => {
            const { method, params = {} } = message;
            const page = pages.get(params.label);
            if (method === 'window:create') {
                const created = await context.newPage(); pages.set(params.label, created);
                created.on('dialog', dialog => dialog.dismiss());
                await created.setViewportSize({ width: params.options.width, height: params.options.height });
            } else if (method === 'window:load') {
                const target = params.label === 'mini' ? '/host/mini/index.html' : '/renderer/index.html';
                await page.goto(origin + target);
                await adapter.receive({ type: 'window-event', window: params.label, event: 'did-finish-load' });
                for (const event of events.get(params.label) || []) await page.evaluate(message => window.__deliverDesktopEvent(message), event);
                events.delete(params.label);
            } else if (method === 'window:setBounds') {
                if (page && !page.isClosed()) await page.setViewportSize({ width: params.width, height: params.height });
            } else if (method === 'window:destroy') {
                if (page && !page.isClosed()) await page.close({ runBeforeUnload: false }); pages.delete(params.label);
            } else if (method.startsWith('dialog:')) {
                return method === 'dialog:message' ? { response: 1, checkboxChecked: false } : { canceled: true, filePaths: [] };
            } else if (method === 'app:confirmQuit' || method === 'app:prepareUpdateQuit') return true;
            return null;
        };
        const send = message => {
            if (message.type === 'native') schedule(async () => {
                try { const result = await native(message); await adapter.receive({ type: 'native-result', id: message.id, ok: true, result }); }
                catch (error) { await adapter.receive({ type: 'native-result', id: message.id, ok: false, error: { message: error.message } }); }
            });
            else if (message.type === 'response') {
                const pending = responses.get(message.id); responses.delete(message.id);
                if (message.ok) pending?.resolve(message.result); else pending?.reject(Error(message.error.message));
            } else if (message.type === 'event') {
                const page = pages.get(message.window);
                if (!page || !page.url().startsWith(origin)) {
                    if (!events.has(message.window)) events.set(message.window, []); events.get(message.window).push(message);
                } else schedule(() => page.isClosed() ? undefined : page.evaluate(message => window.__deliverDesktopEvent(message), message));
            } else if (message.type === 'quit') quitResolve();
        };
        const { createNativeAdapter } = isolated.load(path.join(desktopRoot, 'tauri/native-adapter.cjs'));
        const image = bitmapImage(Buffer.from([0x40,0x80,0xc0,0xff]), { width: 1, height: 1 });
        adapter = createNativeAdapter({ send, configuration: { userData: testEnv.WIFIMETER_USER_DATA,
            appExe: process.execPath, isPackaged: false, version: JSON.parse(fs.readFileSync(path.join(desktopRoot, 'package.json'))).version,
            platform: process.platform },
            execute: () => { throw Error('系统操作在浏览器测试中禁用。'); },
            executeAsync: async () => ({ stdout: image.toDataURL().split(',')[1], stderr: '' }) });
        const api = adapter.api, NativeWindow = api.BrowserWindow;
        // 测试可以包装实际处理函数注入一次失败，其余请求继续走真实后端。
        const requestHandlers = new Map();
        const registerHandler = api.ipcMain.handle.bind(api.ipcMain);
        const removeHandler = api.ipcMain.removeHandler.bind(api.ipcMain);
        api.ipcMain.handle = (channel, handler) => {
            registerHandler(channel, handler); requestHandlers.set(channel, handler);
        };
        api.ipcMain.removeHandler = channel => {
            removeHandler(channel); requestHandlers.delete(channel);
        };
        api.ipcMain.getHandler = channel => requestHandlers.get(channel);
        api.BrowserWindow = class TestWindow extends NativeWindow {
            constructor(options) { super(options); windows.add(this); this.focusable = false; }
            setMinimumSize() {}
            setSize(width, height) { this.setBounds({ width, height }); }
            setContentSize(width, height) { this.setSize(width, height); }
            isFocusable() { return this.focusable; }
            isFocused() { return false; }
            setFocusable(value) { this.focusable = value; super.setFocusable(value); }
            close() { const event = { defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } }; this.emit('close', event); if (!event.defaultPrevented) this.destroy(); }
            static getAllWindows() { return [...windows].filter(window => !window.isDestroyed()); }
        };
        api.nativeImage.createFromBitmap = bitmapImage;
        isolated.load(path.join(desktopRoot, 'host/desktop-runtime.cjs')).configureDesktopRuntime(api);
        isolated.load(path.join(desktopRoot, 'host/main.cjs'));
        const startupDeadline = Date.now() + 30000;
        while (!pages.has('main') || !pages.get('main').url().startsWith(origin)) {
            if (Date.now() >= startupDeadline) throw Error('隔离宿主未完成主页面加载。');
            await settle(); await new Promise(resolve => setTimeout(resolve, 10));
        }
        await settle();
        return {
            firstWindow: async () => pages.get('main'), windows: () => [...pages.values()].filter(page => !page.isClosed()),
            context: () => context,
            async evaluate(callback, argument) { const result = await isolated.evaluate(callback, api, argument); await settle(); return result; },
            async close() {
                if (closed) return;
                let timeout;
                try {
                    adapter.app.quit();
                    await Promise.race([quit, new Promise((_, reject) => {
                        timeout = setTimeout(() => reject(Error('隔离宿主未完成后台退出。')), 10000);
                    })]);
                } finally {
                    clearTimeout(timeout); closed = true;
                    adapter.disconnect(); await isolated.dispose();
                    await context.close(); await browser.close();
                    await new Promise(resolve => server.close(resolve));
                }
            }
        };
    } catch (error) {
        closed = true; if (adapter) adapter.disconnect(); await isolated.dispose();
        await context?.close(); await browser?.close(); await new Promise(resolve => server.close(resolve));
        throw error;
    }
} };
