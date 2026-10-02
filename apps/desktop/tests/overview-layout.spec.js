import { test, expect, _electron as electron } from '@playwright/test';
import { createHarness } from './support/backend-harness.mjs';

let app, page, harness;
test.beforeEach(async () => {
    harness = await createHarness({ rxStep: 4100000000 });
    const env = { ...process.env, ...harness.env, WIFIMETER_BACKGROUND_TEST: '1' };
    delete env.ELECTRON_RUN_AS_NODE;
    app = await electron.launch({ args: ['.', '--force-device-scale-factor=1'], env });
    page = await app.firstWindow();
    await expect(page.locator('.connection-title')).toContainText('家里的 Wi-Fi');
    await expect(page.locator('.notice-line')).toBeVisible();
});
test.afterEach(async () => {
    if (app) await app.close();
    harness?.cleanup();
    app = null;
});

async function resizeWindow(width, height) {
    // Electron 的视口模拟可能不更新媒体查询，使用原生窗口并补偿平台边框尺寸。
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setMinimumSize(0, 0));
    let windowWidth = width, windowHeight = height;
    for (let attempt = 0; attempt < 3; attempt++) {
        await app.evaluate(({ BrowserWindow }, size) => BrowserWindow.getAllWindows()[0].setSize(size.width, size.height), { width: windowWidth, height: windowHeight });
        await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
        const actual = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
        if (actual.width === width && actual.height === height) return;
        windowWidth += width - actual.width;
        windowHeight += height - actual.height;
    }
    expect(await page.evaluate(() => ({ width: innerWidth, height: innerHeight }))).toEqual({ width, height });
}

for (const language of ['zh-CN', 'en']) {
    for (const quotaState of ['notice', 'quiet', 'unset']) {
        for (const [width, height] of [[1280, 800], [1248, 768], [900, 650], [1280, 900]]) {
            test(`overview fits ${width}x${height} in ${language} with ${quotaState} without clipping`, async ({}, testInfo) => {
                await page.evaluate(language => window.desktop.backend.request('updateSettings', { settings: { language } }), language);
                await page.evaluate(async quotaState => {
                    const key = document.querySelector('.quota-card [data-id]').dataset.id;
                    await window.desktop.backend.request('updateNetwork', { key, capGb: quotaState === 'unset' ? 0 : quotaState === 'quiet' ? 50 : 5 });
                }, quotaState);
                await page.reload();
                await resizeWindow(width, height);
                await expect(page.locator('.quota-body')).toBeVisible();
                await expect(page.locator('.notice-line')).toHaveCount(quotaState === 'notice' ? 1 : 0);
                await page.screenshot({ path: testInfo.outputPath('overview.png'), fullPage: true });
                const layout = await page.evaluate(() => {
                    const root = document.scrollingElement;
                    const selectors = ['.toolbar', '.connection', '.metrics', '.total-quota-card', '.chart-row', '.chart', '.chart-caption', '.quota-body', '.quota-foot', '.notice-line'];
                    return {
                        bottomGap: innerHeight - document.querySelector('#content').lastElementChild.getBoundingClientRect().bottom,
                        cards: [...document.querySelectorAll('.chart-row>.panel')].map(element => {
                            const rect = element.getBoundingClientRect();
                            return { top: rect.top, bottom: rect.bottom, height: rect.height };
                        }),
                        controls: ['#networkFilter', '[data-action="refresh"]', '[data-action="export"]'].map(selector => {
                            const rect = document.querySelector(`.toolbar-actions ${selector}`).getBoundingClientRect();
                            return { top: rect.top, bottom: rect.bottom, left: rect.left, right: rect.right };
                        }),
                        height: innerHeight, scrollHeight: root.scrollHeight,
                        width: innerWidth, scrollWidth: root.scrollWidth,
                        outside: selectors.filter(selector => {
                            const element = document.querySelector(selector);
                            if (!element) return false;
                            const rect = element.getBoundingClientRect();
                            return rect.top < 0 || rect.bottom > innerHeight || rect.left < 0 || rect.right > innerWidth;
                        }),
                        clipping: [document.documentElement, document.body, document.querySelector('.main'), document.querySelector('#content'), ...document.querySelectorAll('#content .panel')]
                            .filter(el => ['hidden', 'clip'].includes(getComputedStyle(el).overflowY)).map(el => el.className || el.tagName)
                    };
                });
                console.log(`${language} ${width}x${height}: ${JSON.stringify(layout)}`);
                expect(layout.scrollHeight).toBeLessThanOrEqual(layout.height);
                expect(layout.scrollWidth).toBeLessThanOrEqual(layout.width);
                expect(layout.bottomGap).toBeGreaterThanOrEqual(16);
                expect(layout.bottomGap).toBeLessThanOrEqual(24);
                expect(Math.abs(layout.cards[0].top - layout.cards[1].top)).toBeLessThan(1);
                expect(Math.abs(layout.cards[0].bottom - layout.cards[1].bottom)).toBeLessThan(1);
                for (const control of layout.controls.slice(1)) {
                    expect(Math.abs(control.top - layout.controls[0].top)).toBeLessThan(1);
                    expect(Math.abs(control.bottom - layout.controls[0].bottom)).toBeLessThan(1);
                }
                expect(layout.controls[1].left - layout.controls[0].right).toBeLessThanOrEqual(12);
                expect(layout.outside).toEqual([]);
                expect(layout.clipping).toEqual([]);
                expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().every(window => !window.isFocused() && !window.isFocusable()))).toBe(true);
            });
        }
    }
}

test('narrow overview keeps both quotas accessible by scrolling', async ({}, testInfo) => {
    await resizeWindow(390, 650);
    await expect(page.locator('.quota-card')).toBeVisible();
    expect(await page.evaluate(() => document.scrollingElement.scrollHeight > innerHeight)).toBe(true);
    await page.locator('.quota-foot').scrollIntoViewIfNeeded();
    await expect(page.locator('.quota-foot')).toBeInViewport();
    expect(await page.evaluate(() => scrollY)).toBeGreaterThan(0);
    expect(await page.evaluate(() => document.scrollingElement.scrollWidth)).toBeLessThanOrEqual(390);
    await page.screenshot({ path: testInfo.outputPath('overview-mobile.png'), fullPage: true });
});

test('settings retain continuous document scrolling after leaving overview', async () => {
    await resizeWindow(900, 650);
    await page.locator('.nav [data-page="settings"]').click();
    await expect(page.locator('[data-settings-panel]:visible')).toHaveCount(7);
    await expect(page.locator('.settings-scroll-panel')).toHaveCount(1);
    expect(await page.evaluate(() => document.scrollingElement.scrollHeight > innerHeight)).toBe(true);
    await page.locator('[data-category="about"]').click();
    expect(await page.evaluate(() => scrollY)).toBeGreaterThan(0);
    await expect(page.locator('#settings-about')).toBeInViewport();
});

test('proxy table wraps long paths, aligns rates and scrolls with the applications page', async ({}, testInfo) => {
    await resizeWindow(900, 650);
    await page.locator('.nav [data-page="apps"]').click();
    await page.evaluate(async () => {
        await window.desktop.backend.request('setPaused', { paused: true });
        const { proxyClientsView } = await import('./ui/proxy.js');
        const clients = Array.from({ length: 12 }, (_, i) => ({
            appId: `C:\\Applications\\Browser${i}.exe`,
            name: `BrowserWithALongUnbrokenApplicationName${i}.exe`,
            proxyName: 'C:\\Users\\Example\\Applications\\ProxyClientWithALongName\\proxy.exe',
            connections: 12, measurementAvailable: true, rxPerSecond: '999000000', txPerSecond: '125000'
        }));
        document.querySelector('#proxyClientsRegion').innerHTML = proxyClientsView({ clients });
    });
    const table = page.locator('.proxy-client-table');
    await expect(table.locator('tbody tr')).toHaveCount(12);
    const layout = await table.evaluate(table => ({
        overflow: [...table.querySelectorAll('th,td')].filter(cell => cell.scrollWidth > cell.clientWidth + 1).map(cell => cell.textContent),
        aligned: [...table.rows].every(row => [...row.cells].slice(2).every(cell => getComputedStyle(cell).textAlign === 'right')),
        rates: [...table.querySelectorAll('tbody td:nth-child(n+4)')].every(cell => getComputedStyle(cell).whiteSpace === 'nowrap'),
        fits: table.getBoundingClientRect().right <= innerWidth,
        scrolls: document.scrollingElement.scrollHeight > innerHeight
    }));
    expect(layout).toEqual({ overflow: [], aligned: true, rates: true, fits: true, scrolls: true });
    await table.locator('tbody tr').last().scrollIntoViewIfNeeded();
    expect(await page.evaluate(() => scrollY)).toBeGreaterThan(0);
    await expect(table.locator('tbody tr').last()).toBeInViewport();
    await page.screenshot({ path: testInfo.outputPath('proxy-table.png') });
});
