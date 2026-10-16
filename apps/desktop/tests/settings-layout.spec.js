import { test, expect } from '@playwright/test';
import { desktop } from './support/browser-desktop.mjs';
import { createHarness } from './support/backend-harness.mjs';

let app, page, harness;
test.beforeEach(async () => {
    harness = await createHarness();
    app = await desktop.launch({ env: { ...process.env, ...harness.env, WIFIMETER_BACKGROUND_TEST: '1' } });
    page = await app.firstWindow();
    await expect(page.locator('.nav [data-page="overview"]')).toBeVisible();
});
test.afterEach(async () => {
    if (app) await app.close();
    harness?.cleanup();
    app = null;
});

const settleScroll = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
const category = id => page.locator(`[data-category="${id}"]`);

for (const language of ['zh-CN', 'en']) {
    for (const [width, height] of [[1549, 1002], [420, 740]]) {
        test(`settings end at real content in ${width}x${height} ${language}`, async ({}, testInfo) => {
            await page.evaluate(language => window.desktop.backend.request('updateSettings', { settings: { language } }), language);
            await page.reload();
            await page.setViewportSize({ width, height });
            await page.locator('.nav [data-page="settings"]').click();

            await category('data').click();
            await settleScroll();
            await expect(category('data')).toHaveAttribute('aria-current', 'location');
            expect(await page.locator('#settings-data').evaluate(element => Math.abs(element.getBoundingClientRect().top - 24))).toBeLessThan(2);
            await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }));
            await expect(category('general')).toHaveAttribute('aria-current', 'location');

            await category('about').click();
            await settleScroll();
            await expect(category('about')).toHaveAttribute('aria-current', 'location');
            await expect(page.locator('#updatesPanel [data-action="check-updates"]')).toBeInViewport();
            await page.evaluate(() => window.scrollTo({ top: document.scrollingElement.scrollHeight, behavior: 'instant' }));
            await settleScroll();
            await page.screenshot({ path: testInfo.outputPath(`settings-about-${width}x${height}-${language}.png`) });
            const geometry = await page.evaluate(() => {
                const root = document.scrollingElement;
                const about = document.querySelector('#settings-about').getBoundingClientRect();
                const updates = document.querySelector('#updatesPanel').getBoundingClientRect();
                const actions = document.querySelector('#updatesPanel > .settings-actions').getBoundingClientRect();
                return {
                    bottomScrollGap: root.scrollHeight - innerHeight - scrollY,
                    aboutTail: about.bottom - updates.bottom,
                    contentTail: root.scrollHeight - (scrollY + actions.bottom),
                    mainPadding: parseFloat(getComputedStyle(document.querySelector('#main')).paddingBottom),
                    horizontalOverflow: root.scrollWidth - root.clientWidth,
                    outsideControls: [...document.querySelectorAll('.settings-content button,.settings-content input,.settings-content select')]
                        .filter(element => element.getClientRects().length).filter(element => {
                            const rect = element.getBoundingClientRect();
                            return rect.left < 0 || rect.right > innerWidth;
                        }).map(element => element.name || element.id || element.dataset.action)
                };
            });
            console.log(`${width}x${height} ${language}: ${JSON.stringify(geometry)}`);
            expect(Math.abs(geometry.bottomScrollGap)).toBeLessThanOrEqual(1);
            expect(geometry.aboutTail).toBeLessThanOrEqual(1);
            // The update section already has 20 px bottom padding and 20 px margin, plus the card border.
            expect(geometry.contentTail).toBeGreaterThanOrEqual(geometry.mainPadding + 39);
            expect(geometry.contentTail).toBeLessThanOrEqual(geometry.mainPadding + 44);
            expect(geometry.horizontalOverflow).toBeLessThanOrEqual(0);
            expect(geometry.outsideControls).toEqual([]);
        });
    }
}

test('settings category clicks near the end stay selected until the page is scrolled', async () => {
    await page.setViewportSize({ width: 1549, height: 1002 });
    await page.locator('.nav [data-page="settings"]').click();
    for (const id of ['status', 'about', 'status']) {
        await category(id).click();
        await settleScroll();
        await expect(category(id)).toHaveAttribute('aria-current', 'location');
        await expect(page.locator(`#settings-${id} .panel-head`)).toBeInViewport();
    }
    await page.evaluate(() => window.scrollBy({ top: -100, behavior: 'instant' }));
    await settleScroll();
    await page.evaluate(() => window.scrollTo({ top: document.scrollingElement.scrollHeight, behavior: 'instant' }));
    await expect(category('about')).toHaveAttribute('aria-current', 'location');
    await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }));
    await expect(category('general')).toHaveAttribute('aria-current', 'location');
    await category('status').click();
    await settleScroll();
    await page.setViewportSize({ width: 1549, height: 1100 });
    await settleScroll();
    await expect(category('about')).toHaveAttribute('aria-current', 'location');
    await page.locator('.nav [data-page="overview"]').click();
    await page.locator('.nav [data-page="settings"]').click();
    await settleScroll();
    await expect(category('general')).toHaveAttribute('aria-current', 'location');
});
