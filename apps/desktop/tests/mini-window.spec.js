import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';

test.use({ launchOptions: { ...(process.platform === 'win32' ? { channel: process.env.WIFIMETER_BROWSER_CHANNEL || 'msedge' } : {}) } });

// Exercise the shipped mini page and Tauri bridge without native windows or user data.
async function miniFixture(page) {
    const desktopRoot = new URL('../', import.meta.url);
    const bridge = await readFile(new URL('../tauri/bridge.js', import.meta.url), 'utf8');
    const preferences = { miniShape: 'bar', miniPalette: 'dark', miniExpanded: false,
        miniPinned: false, miniAutoHide: true, miniExcludeProxy: false, miniIncludeProxyEstimates: false, miniRange: '5m', miniCustomMinutes: 15 };
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
        if (channel === 'mini:applications') return { rows: [], status: 'running', range: { minutes: 5 }, miniExcludeProxy: preferences.miniExcludeProxy,
            miniIncludeProxyEstimates: preferences.miniIncludeProxyEstimates };
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

test('live source switches to port estimates, labels rates and restores the saved choice', async ({ page }) => {
    const fixture = await miniFixture(page);
    await page.locator('#apps').click();
    await page.getByRole('combobox', { name: '应用实时流量来源' }).selectOption('estimated');
    expect(fixture.preferences.miniIncludeProxyEstimates).toBe(true);
    await page.evaluate(() => window.__miniEvent('mini:applications', {
        range: { minutes: 5 }, status: 'running', miniExcludeProxy: false, miniIncludeProxyEstimates: true,
        rows: [{ appId: 'browser', name: 'Browser', estimated: true, measurementAvailable: true,
            rxPerSecond: '12300', txPerSecond: '1000', rxBytes: '800', txBytes: '200' }]
    }));
    await expect(page.locator('#appRows')).toContainText('估算');
    await expect(page.locator('#appRows')).toContainText('12.3');
    await expect(page.locator('#rangeSummary')).toContainText('原生分钟记录');
    await page.reload();
    await expect(page.getByRole('combobox', { name: '应用实时流量来源' })).toHaveValue('estimated');
    await page.getByRole('combobox', { name: '应用实时流量来源' }).selectOption('native');
    expect(fixture.preferences.miniIncludeProxyEstimates).toBe(false);
});

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

test('toolbar descriptions fit each shape and palette and disappear when the pointer leaves', async ({ page }, testInfo) => {
    const fixture = await miniFixture(page);
    const descriptions = [
        ['pin', '禁止拖动'], ['autoHide', '左右边缘'], ['proxyFilter', '代理程序'],
        ['apps', '应用'], ['open', '主窗口'], ['close', '继续运行']
    ];
    const tooltip = page.getByRole('tooltip');
    for (const [shape, width, height] of [['bar', 224, 92], ['square', 152, 152], ['circle', 168, 168]]) {
        for (const expanded of [false, true]) {
            await page.setViewportSize({ width: expanded ? 360 : width, height: expanded ? 420 : height });
            await fixture.publish({ miniShape: shape, miniExpanded: expanded });
            for (const palette of ['dark', 'light', 'indigo']) {
                await fixture.publish({ miniPalette: palette });
                for (const [id, description] of descriptions) {
                    const button = page.locator(`#${id}`);
                    await button.hover();
                    await expect(tooltip).toBeVisible();
                    await expect(tooltip).toContainText(description);
                    await expect(button).toHaveAttribute('aria-describedby', 'miniTooltip');
                    const layout = await tooltip.evaluate(element => {
                        const rect = element.getBoundingClientRect();
                        const circle = document.body.dataset.shape === 'circle' && document.body.dataset.expanded !== 'true';
                        const radius = innerWidth / 2;
                        const corners = [[rect.left, rect.top], [rect.right, rect.top], [rect.left, rect.bottom], [rect.right, rect.bottom]];
                        return { outside: rect.left < 0 || rect.right > innerWidth || rect.top < 0 || rect.bottom > innerHeight,
                            outsideCircle: circle && corners.some(([x, y]) => Math.hypot(x - radius, y - radius) > radius),
                            pointerEvents: getComputedStyle(element).pointerEvents,
                            background: getComputedStyle(element).backgroundColor };
                    });
                    expect(layout.outside).toBe(false);
                    expect(layout.outsideCircle).toBe(false);
                    expect(layout.pointerEvents).toBe('none');
                    expect(layout.background).not.toBe('rgb(255, 255, 255)');
                    await page.mouse.move(0, 0);
                    expect(await page.locator('#miniTooltip').evaluate(element => element.hidden)).toBe(true);
                    await expect(button).not.toHaveAttribute('aria-describedby');
                }
            }
            await fixture.publish({ miniPalette: 'dark' });
            await page.locator('#pin').hover();
            await page.screenshot({ path: testInfo.outputPath(`${shape}-${expanded ? 'expanded' : 'compact'}-tooltip.png`) });
            await page.mouse.move(0, 0);
        }
    }
    await expect(page.locator('[title]')).toHaveCount(0);
});

test('toolbar descriptions follow saved toggle state and hide on click', async ({ page }) => {
    const fixture = await miniFixture(page);
    await page.setViewportSize({ width: 224, height: 92 });
    const tooltip = page.getByRole('tooltip');
    for (const [id, text] of [['pin', '恢复拖动'], ['autoHide', '允许自动隐藏'], ['proxyFilter', '显示全部流量'], ['apps', '收起应用列表']]) {
        const button = page.locator(`#${id}`);
        await button.hover();
        await expect(tooltip).toBeVisible();
        await button.click();
        await expect(tooltip).toBeHidden();
        if (id === 'apps') await page.setViewportSize({ width: 360, height: 420 });
        await page.mouse.move(0, 0);
        await button.hover();
        await expect(tooltip).toContainText(text);
        await page.mouse.move(0, 0);
    }
    await page.locator('#pin').hover();
    await fixture.publish({ miniPinned: false });
    await expect(tooltip).toContainText('禁止拖动');
    await fixture.publish({ miniExpanded: false });
    await expect(tooltip).toBeHidden();
});

test('keyboard descriptions clear on Escape, focus loss, window blur and edge collapse', async ({ page }) => {
    await miniFixture(page);
    const button = page.locator('#pin');
    const tooltip = page.getByRole('tooltip');
    await button.focus();
    await expect(tooltip).toBeVisible();
    await expect(button).toHaveAttribute('aria-describedby', 'miniTooltip');
    await page.keyboard.press('Escape');
    await expect(tooltip).toBeHidden();
    await expect(button).not.toHaveAttribute('aria-describedby');
    await page.locator('#autoHide').focus();
    await expect(tooltip).toContainText('左右边缘');
    await page.locator('#autoHide').evaluate(element => element.blur());
    await expect(tooltip).toBeHidden();
    await button.focus();
    await page.evaluate(() => window.dispatchEvent(new Event('blur')));
    await expect(tooltip).toBeHidden();
    await page.locator('#open').focus();
    await expect(tooltip).toContainText('主窗口');
    await page.evaluate(() => window.__miniEvent('mini:state', { collapsed: true, edge: 'left' }));
    await expect(tooltip).toBeHidden();
    await expect(page.locator('main')).toBeHidden();
    await page.evaluate(() => window.__miniEvent('mini:state', { collapsed: false, edge: '' }));
    await button.focus();
    await expect(tooltip).toBeVisible();
    await page.evaluate(() => {
        Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
        document.dispatchEvent(new Event('visibilitychange'));
    });
    await expect(tooltip).toBeHidden();
});
