import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { createDemoFixture, DEMO_TIME } from './fixture.mjs';
import { createDemoTransport } from './transport.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const desktopRoot = path.join(root, 'apps/desktop');
const requireDesktop = createRequire(path.join(desktopRoot, 'package.json'));
const { chromium, expect } = requireDesktop('@playwright/test');
const temporaryRoot = path.join(root, 'del/demo');
await fs.mkdir(temporaryRoot, { recursive: true });
const output = await fs.mkdtemp(path.join(temporaryRoot, 'capture-'));
const assets = path.join(root, 'docs/assets');
const bridge = await fs.readFile(path.join(desktopRoot, 'tauri/bridge.js'), 'utf8');
const mime = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png' };
const server = http.createServer(async (request, response) => {
    try {
        const pathname = decodeURIComponent(new URL(request.url, 'http://127.0.0.1').pathname);
        const filename = path.resolve(desktopRoot, '.' + pathname);
        const relative = path.relative(desktopRoot, filename);
        if (relative.startsWith('..') || path.isAbsolute(relative)
            || !['renderer/', 'assets/', 'node_modules/marked/', 'node_modules/dompurify/'].some(prefix => relative.replaceAll('\\', '/').startsWith(prefix))) {
            response.writeHead(403).end(); return;
        }
        response.setHeader('Content-Type', mime[path.extname(filename)] || 'application/octet-stream');
        response.end(await fs.readFile(filename));
    } catch { response.writeHead(404).end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const channel = process.env.WIFIMETER_BROWSER_CHANNEL || (process.platform === 'win32' ? 'msedge' : 'chromium');
let browser;
try {
    browser = await chromium.launch({ headless: true, ...(channel === 'chromium' ? {} : { channel }) });
    for (const language of ['zh-CN', 'en']) {
        const errors = [];
        const context = await browser.newContext({ viewport: { width: 1200, height: 780 }, deviceScaleFactor: 1,
            locale: language, timezoneId: 'Asia/Shanghai', colorScheme: 'light', reducedMotion: 'reduce',
            userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/130.0.0.0 Safari/537.36' });
        await context.route('**/*', route => {
            if (new URL(route.request().url()).origin === origin) return route.continue();
            errors.push(`External request: ${route.request().url()}`);
            return route.abort();
        });
        const fixture = createDemoFixture(language);
        await context.addInitScript({ content: `(() => {
            const transport = (${createDemoTransport.toString()})(${JSON.stringify(fixture)});
            window.__demo = transport;
            window.__TAURI__ = {
                core: { invoke: async (_method, { channel, args }) => transport.request(channel, args) },
                event: { listen: async (_channel, handler) => transport.listen(handler) }
            };
        })();\n${bridge}` });
        const page = await context.newPage();
        page.on('pageerror', error => errors.push(error.message));
        page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
        await page.clock.setFixedTime(new Date(DEMO_TIME));
        await page.goto(`${origin}/renderer/index.html`);
        await expect(page.locator('.connection-title')).toContainText(fixture.snapshot.networks[0].alias);
        await expect.poll(() => page.locator('#brandMark img').evaluate(image => image.naturalWidth)).toBeGreaterThan(0);
        await page.evaluate(() => document.fonts.ready);
        const frames = [];
        let frameIndex = 0;
        async function frame(duration = 450) {
            await page.evaluate(index => window.__demo.frame(index), frameIndex++);
            await page.mouse.move(1190, 770);
            await page.evaluate(() => document.activeElement?.blur());
            await page.waitForTimeout(80);
            const filename = path.join(output, `${language}-${String(frames.length).padStart(3, '0')}.png`);
            await page.screenshot({ path: filename, animations: 'disabled' });
            frames.push({ path: filename, duration });
            return filename;
        }
        const overview = await frame(1400);
        await fs.copyFile(overview, path.join(assets, language === 'en' ? 'screenshot-en.png' : 'screenshot.png'));
        for (let index = 0; index < 6; index++) await frame();
        await page.locator('.nav [data-page="apps"]').click();
        await expect(page.locator('.application-workspace[data-view="live"]')).toBeVisible();
        for (let index = 0; index < 7; index++) await frame(index === 0 ? 1200 : 450);
        await page.locator('[data-action="application-view"][data-view="history"]').click();
        await page.locator('#appGrouping').selectOption('month');
        await expect(page.locator('#appGrouping')).toHaveValue('month');
        const history = await frame(2500);
        await fs.copyFile(history, path.join(assets, `applications-${language}.png`));
        await page.locator('.nav [data-page="networks"]').click();
        await frame(1800);
        await page.locator('[data-action="detail"][data-id="phone"]').first().click();
        await page.locator('[data-action="drawer-tab"][data-tab="settings"]').click();
        await expect(page.locator('#networkForm')).toBeVisible();
        await frame(2600);
        await page.locator('#closeDrawer').click();
        await page.locator('.nav [data-page="overview"]').click();
        await page.evaluate(() => window.desktop.windowPreferences.update({ theme: 'dark' }));
        await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
        for (let index = 0; index < 5; index++) await frame(index === 0 ? 1300 : 450);
        await page.evaluate(() => window.desktop.windowPreferences.update({ theme: 'light' }));
        await frame(1500);
        if (errors.length) throw Error(errors.join('\n'));
        const manifest = path.join(output, `${language}.json`);
        await fs.writeFile(manifest, JSON.stringify({ frames, output: path.join(assets, `demo-${language}.gif`) }));
        execFileSync(process.env.WIFIMETER_DEMO_PYTHON || 'python', [path.join(root, 'tools/demo/encode.py'), manifest], { windowsHide: true, stdio: 'inherit' });
        console.log(`${language}: ${frames.length} frames, ${frames.reduce((sum, value) => sum + value.duration, 0) / 1000}s`);
        await context.close();
    }
} finally {
    await browser?.close();
    await new Promise(resolve => server.close(resolve));
}
console.log(`Review frames: ${output}`);
