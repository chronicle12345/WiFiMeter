import { test, expect } from '@playwright/test';
import assert from 'node:assert/strict';
import { launchMini } from './support/renderer-harness.mjs';

// 收起由宿主逐帧缩窗口、页面同时过渡；这里只验证页面这一半不再是硬切换。
test('小窗收起时面板淡出平移、边条淡入，都不再从布局里移除', async () => {
    const mini = await launchMini();
    try {
        const main = mini.page.locator('main');
        const strip = mini.page.locator('.edge-strip');
        assert.equal(await main.evaluate(element => getComputedStyle(element).opacity), '1');
        assert.equal(await strip.evaluate(element => getComputedStyle(element).opacity), '0');
        assert.notEqual(await main.evaluate(element => getComputedStyle(element).display), 'none');
        assert.match(await main.evaluate(element => getComputedStyle(element).transitionDuration), /0\.16s/);
        await mini.page.evaluate(() => window.fixtureState({ collapsed: true, edge: 'right' }));
        await expect.poll(() => main.evaluate(element => getComputedStyle(element).opacity)).toBe('0');
        await expect.poll(() => strip.evaluate(element => getComputedStyle(element).opacity)).toBe('1');
        assert.notEqual(await main.evaluate(element => getComputedStyle(element).display), 'none');
        assert.equal(await main.evaluate(element => getComputedStyle(element).pointerEvents), 'none');
        assert.equal(await main.evaluate(element => element.inert), true);
        assert.equal(await main.evaluate(element => getComputedStyle(element).transform), 'matrix(1, 0, 0, 1, 14, 0)');
        await mini.page.evaluate(() => window.fixtureState({ collapsed: false, edge: 'right' }));
        await expect.poll(() => main.evaluate(element => getComputedStyle(element).opacity)).toBe('1');
        assert.equal(await main.evaluate(element => element.inert), false);
    } finally { await mini.close(); }
});

test('系统要求减少动态效果时小窗不做过渡', async () => {
    const mini = await launchMini();
    try {
        await mini.page.emulateMedia({ reducedMotion: 'reduce' });
        for (const selector of ['main', '.edge-strip']) {
            assert.equal(await mini.page.locator(selector).evaluate(element => getComputedStyle(element).transitionDuration), '0s');
        }
    } finally { await mini.close(); }
});
