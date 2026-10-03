import { test, expect } from '@playwright/test';
import { launchRenderer } from './support/renderer-harness.mjs';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHarness } from './support/backend-harness.mjs';

test('PNG fixture updates only its avatar and preserves fallbacks', async () => {
    const profile = await mkdtemp(path.join(os.tmpdir(), 'wifimeter-icons-'));
    const harness = await createHarness();
    const env = { ...process.env, WIFIMETER_BACKGROUND_TEST: '1', WIFIMETER_USER_DATA: profile, ...harness.env };
    let app;
    try {
        app = await launchRenderer({ args: ['.'], env });
        const page = await app.firstWindow();
        await page.waitForLoadState('domcontentloaded');
        const url = 'data:image/png;base64,' + (await readFile(new URL('../assets/icon.png', import.meta.url))).toString('base64');
        expect(url).toMatch(/^data:image\/png;base64,/);
        await page.evaluate(async url => {
            const { createAppIconLoader } = await import('./ui/app-icons.js');
            const root = document.createElement('div'); root.id = 'icon-test';
            root.innerHTML = '<button id="icon-focus">Keep focus</button><span data-app-icon="known">K</span><span data-app-icon="missing">M</span>';
            document.body.append(root);
            window.iconTest = { calls: 0, root, button: root.firstChild, missing: root.lastChild };
            const loader = createAppIconLoader({ request: async ({ appId }) => { window.iconTest.calls++; if (appId === 'missing') throw Error('missing'); return url; } });
            window.iconTest.loader = loader;
            root.firstChild.focus(); loader.hydrate(root); loader.hydrate(root);
        }, url);
        await expect(page.locator('#icon-test [data-app-icon="known"] img')).toBeVisible();
        await expect(page.locator('#icon-test [data-app-icon="missing"]')).toHaveText('M');
        expect(await page.evaluate(() => ({ calls: iconTest.calls, sameButton: iconTest.root.firstChild === iconTest.button, sameFallback: iconTest.root.lastChild === iconTest.missing, focused: document.activeElement === iconTest.button })))
            .toEqual({ calls: 2, sameButton: true, sameFallback: true, focused: true });
        expect(await page.locator('#icon-test img').evaluate(img => img.naturalWidth)).toBeGreaterThan(0);
        await page.evaluate(async url => {
            const { createAppIconLoader } = await import('./ui/app-icons.js');
            const batch = document.createElement('div'); batch.id = 'icon-batch'; document.body.append(batch);
            for (let i = 0; i < 20; i++) {
                const avatar = document.createElement('span'); avatar.className = 'app-avatar'; avatar.dataset.appIcon = 'app-' + i; avatar.textContent = 'A'; batch.append(avatar);
            }
            window.iconBatch = { active: 0, peak: 0, completed: 0 };
            const loader = createAppIconLoader({ request: async () => {
                iconBatch.active++; iconBatch.peak = Math.max(iconBatch.peak, iconBatch.active);
                if (iconBatch.active > 8) { iconBatch.active--; return null; }
                await new Promise(resolve => setTimeout(resolve, 10)); iconBatch.active--; iconBatch.completed++; return url;
            } });
            loader.hydrate(batch);
        }, url);
        await expect(page.locator('#icon-batch img')).toHaveCount(20);
        expect(await page.locator('#icon-batch img').evaluateAll(images => images.every(image => image.complete && image.naturalWidth > 0))).toBe(true);
        expect(await page.evaluate(() => iconBatch.peak)).toBeLessThanOrEqual(4);
        await page.evaluate(async () => {
            const { createAppIconLoader } = await import('./ui/app-icons.js');
            let finish; const result = new Promise(resolve => { finish = resolve; });
            const node = document.createElement('span'); node.dataset.appIcon = 'late'; node.textContent = 'L'; iconTest.root.append(node);
            const loader = createAppIconLoader({ request: () => result }); loader.hydrate(iconTest.root); loader.stop();
            finish(iconTest.root.querySelector('img').src); await Promise.resolve();
        });
        await expect(page.locator('#icon-test [data-app-icon="late"]')).toHaveText('L');
    } finally {
        if (app) await app.close();
        harness.cleanup();
        await rm(profile, { recursive: true, force: true });
    }
});

// 原生图标提取与后端路径校验在两端 Tauri e2e 测试中验证。
