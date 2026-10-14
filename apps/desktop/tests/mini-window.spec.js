import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';

test.use({ launchOptions: { ...(process.platform === 'win32' ? { channel: process.env.WIFIMETER_BROWSER_CHANNEL || 'msedge' } : {}) } });

// Exercise the shipped mini page and Tauri bridge without native windows or user data.
async function miniFixture(page) {
    const desktopRoot = new URL('../', import.meta.url);
    const bridge = await readFile(new URL('../tauri/bridge.js', import.meta.url), 'utf8');
    const preferences = { miniShape: 'bar', miniPalette: 'dark', miniExpanded: false,
        miniPinned: false, miniAutoHide: true, miniExcludeProxy: false, miniRange: '5m', miniCustomMinutes: 15 };
    const requests = [];
    let failSave = false;
    await page.route('http://mini.test/**', async route => {
        const pathname = new URL(route.request().url()).pathname;
        const file = new URL('.' + pathname, desktopRoot);
        if (!file.href.startsWith(desktopRoot.href)) return route.fulfill({ status: 403 });
        const contentType = file.pathname.endsWith('.html') ? 'text/html'
            : file.pathname.endsWith('.css') ? 'text/css' : 'text/javascript';
        await route.fulfill({ body: await readFile(file), contentType });
    });
    await page.exposeBinding('__miniRequest', async (_source, channel, args) => {
        requests.push([channel, ...args]);
        if (channel === 'mini:preferences-read') return { ...preferences };
        if (channel === 'mini:preferences-update') {
            if (failSave) throw Error('save failed');
            Object.assign(preferences, args[0]);
            return { ...preferences };
        }
        if (channel === 'mini:applications') return { rows: [], status: 'running', range: { minutes: 5 }, miniExcludeProxy: preferences.miniExcludeProxy };
        return null;
    });
    await page.addInitScript({ content: `(() => {
        const handlers = new Set();
        window.__miniEvent = (channel, payload) => {
            for (const handler of handlers) handler({ payload: { channel, payload } });
        };
        window.__TAURI__ = {
            core: { invoke: (_command, request) => window.__miniRequest(request.channel, request.args) },
            event: { listen: async (_event, handler) => { handlers.add(handler); } }
        };
    })();\n` + bridge });
    await page.goto('http://mini.test/host/mini/index.html');
    await expect.poll(() => requests.some(([channel]) => channel === 'mini:preferences-read')).toBe(true);
    return { preferences, requests, failSave: value => { failSave = value; },
        async publish(patch) {
            Object.assign(preferences, patch);
            await page.evaluate(value => window.__miniEvent('window-preferences:changed', value), { ...preferences });
        } };
}

test('pin button locks dragging and saved state survives reload', async ({ page }) => {
    const fixture = await miniFixture(page);
    await expect(page.locator('main')).not.toHaveAttribute('title');
    const drag = () => page.locator('.activity-dot').dispatchEvent('pointerdown', { button: 0 });
    await drag();
    await expect.poll(() => fixture.requests.filter(([channel]) => channel === 'mini:drag').length).toBe(1);
    await page.getByRole('button', { name: '固定位置', exact: true }).click();
    await expect(page.locator('#pin')).toHaveAttribute('aria-pressed', 'true');
    expect(fixture.preferences.miniPinned).toBe(true);
    await drag();
    expect(fixture.requests.filter(([channel]) => channel === 'mini:drag')).toHaveLength(1);
    await page.reload();
    await expect(page.locator('#pin')).toHaveAttribute('aria-pressed', 'true');
    await page.getByRole('button', { name: '取消固定', exact: true }).click();
    await expect(page.locator('#pin')).toHaveAttribute('aria-pressed', 'false');
    await drag();
    await expect.poll(() => fixture.requests.filter(([channel]) => channel === 'mini:drag').length).toBe(2);
});

test('proxy button updates cached rates immediately and keeps failed saves visible', async ({ page }) => {
    const fixture = await miniFixture(page);
    await page.evaluate(() => window.__miniEvent('mini:live', {
        collector: 'running', state: 'connected', connections: [{ rxPerSecond: '25000', txPerSecond: '10000' }],
        ratesWithoutProxy: { rxPerSecond: '5000', txPerSecond: '2000' }
    }));
    await expect(page.locator('#download')).toHaveText('25.0 KB/s');
    await page.getByRole('button', { name: '排除代理程序流量', exact: true }).click();
    await expect(page.locator('#proxyFilter')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('#download')).toHaveText('5.0 KB/s');
    await expect(page.locator('#upload')).toHaveText('2.0 KB/s');
    fixture.failSave(true);
    await page.getByRole('button', { name: '显示全部流量', exact: true }).click();
    await expect(page.locator('#miniError')).toBeVisible();
    await expect(page.locator('#miniError')).toContainText('save failed');
    await expect(page.locator('#proxyFilter')).toHaveAttribute('aria-pressed', 'true');
    expect(fixture.preferences.miniExcludeProxy).toBe(true);
    fixture.failSave(false);
    await page.getByRole('button', { name: '显示全部流量', exact: true }).click();
    await expect(page.locator('#download')).toHaveText('25.0 KB/s');
    await expect(page.locator('#miniError')).toBeHidden();
});

test('toolbar fits every mini shape and keeps application controls usable', async ({ page }, testInfo) => {
    const fixture = await miniFixture(page);
    await page.evaluate(() => window.__miniEvent('mini:live', {
        collector: 'running', state: 'connected', connections: [{ rxPerSecond: '17300', txPerSecond: '9400' }]
    }));
    for (const [shape, width, height] of [['bar', 224, 92], ['square', 152, 152], ['circle', 168, 168]]) {
        for (const expanded of [false, true]) {
            await page.setViewportSize({ width: expanded ? 360 : width, height: expanded ? 420 : height });
            await fixture.publish({ miniShape: shape, miniExpanded: expanded });
            for (const button of await page.locator('nav button').all()) await expect(button).toBeVisible();
            const layout = await page.evaluate(() => {
                const heading = document.querySelector('.mini-heading').getBoundingClientRect();
                const controls = [...document.querySelectorAll('nav button')].map(button => button.getBoundingClientRect());
                return { outside: controls.filter(rect => rect.left < 0 || rect.right > innerWidth || rect.top < 0 || rect.bottom > innerHeight).length,
                    overlap: controls.some(rect => rect.left < heading.right && rect.right > heading.left && rect.top < heading.bottom && rect.bottom > heading.top) };
            });
            expect(layout).toEqual({ outside: 0, overlap: false });
            await page.screenshot({ path: testInfo.outputPath(`${shape}-${expanded ? 'expanded' : 'compact'}.png`) });
        }
    }
});

test('keep-visible button saves independently of pinning and has no native tooltips', async ({ page }) => {
    const fixture = await miniFixture(page);
    await page.getByRole('button', { name: '保持显示', exact: true }).click();
    await expect(page.locator('#autoHide')).toHaveAttribute('aria-pressed', 'true');
    expect(fixture.preferences.miniAutoHide).toBe(false);
    expect(fixture.preferences.miniPinned).toBe(false);
    await page.reload();
    await expect(page.locator('#autoHide')).toHaveAttribute('aria-pressed', 'true');
    await page.getByRole('button', { name: '允许自动隐藏', exact: true }).click();
    expect(fixture.preferences.miniAutoHide).toBe(true);
    await expect(page.locator('[title]')).toHaveCount(0);
});
