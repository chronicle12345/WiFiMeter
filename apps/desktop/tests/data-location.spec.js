import { test, expect } from '@playwright/test';
import { launchRenderer } from './support/renderer-harness.mjs';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHarness } from './support/backend-harness.mjs';

let app, page, profile, harness, errors;
const region = () => page.locator('#dataLocationRegion');
const button = name => region().getByRole('button', { name });
const database = directory => path.join(directory, 'wifimeter.db');
const defaultState = directory => ({ directory, database: database(directory), custom: false, temporaryDefault: false, defaultDirectory: directory });
// 隔离目录由夹具创建，数据位置断言必须使用夹具实际使用的目录。
const userData = () => harness.env.WIFIMETER_USER_DATA;

test.beforeEach(async () => {
    profile = await mkdtemp(path.join(os.tmpdir(), 'wifimeter-location-'));
    harness = await createHarness();
    errors = [];
    app = await launchRenderer({ args: ['.'], env: { ...process.env, WIFIMETER_USER_DATA: profile, ...harness.env } });
    page = await app.firstWindow();
    page.on('pageerror', error => errors.push(error.message));
    await expect(page.locator('.connection-title')).toContainText('家里的 Wi-Fi');
    await page.locator('.nav [data-page="settings"]').click();
    await expect(region()).toBeVisible();
});
test.afterEach(async () => {
    if (app) await app.close();
    harness?.cleanup();
    if (profile) await rm(profile, { recursive: true, force: true });
    expect(errors).toEqual([]);
});

// 覆盖数据位置通道：read 返回 before，切换动作返回 result 并让后续 read 返回 after。
async function fixture({ before, after, result }) {
    await app.evaluate(({ requests }, payload) => {
        globalThis.locationFixture = { ...payload, done: false };
        for (const channel of ['data-location:read', 'data-location:choose', 'data-location:reset']) requests.removeHandler(channel);
        requests.handle('data-location:read', () => (globalThis.locationFixture.done && globalThis.locationFixture.after) || globalThis.locationFixture.before);
        const run = () => {
            globalThis.locationFixture.done = true;
            return globalThis.locationFixture.result;
        };
        requests.handle('data-location:choose', run);
        requests.handle('data-location:reset', run);
    }, { before, after: after || null, result });
    await page.reload();
    await page.locator('.nav [data-page="settings"]').click();
    await expect(region()).toBeVisible();
}

test('默认位置只读显示，切换后展示自定义路径并保留原文件说明', async () => {
    const custom = `${userData()}-custom`;
    await expect(region().locator('code')).toHaveText(userData());
    await expect(region()).toContainText('当前使用默认位置。');
    await expect(button('恢复默认位置')).toHaveCount(0);

    await fixture({
        before: defaultState(userData()),
        after: { ...defaultState(custom), custom: true },
        result: { ok: true, changed: true, directory: custom, database: database(custom), copied: true, source: database(userData()) }
    });
    await button('更改位置').click();

    await expect(region().locator('code')).toHaveText(custom);
    await expect(region()).toContainText('数据位置已切换，当前数据库已复制到新位置。');
    await expect(region()).toContainText(`原数据库仍保留在：${database(userData())}`);
    await expect(button('恢复默认位置')).toBeVisible();
    await expect(page.locator('.toast').last()).toContainText('数据位置已更新。');
});

test('恢复默认位置清除自定义状态并提示归档结果', async () => {
    const custom = `${userData()}-custom`;
    await fixture({
        before: { ...defaultState(custom), custom: true },
        after: defaultState(userData()),
        result: { ok: true, changed: true, directory: userData(), database: database(userData()), copied: true, archived: `${database(userData())}.replaced-20261003T120000Z` }
    });
    await button('恢复默认位置').click();

    await expect(region().locator('code')).toHaveText(userData());
    await expect(region()).toContainText('数据位置已切换，当前数据库已复制到新位置。');
    await expect(region()).toContainText(`目标文件夹原有的数据库已归档为：${database(userData())}.replaced-20261003T120000Z`);
    await expect(button('恢复默认位置')).toHaveCount(0);
});

test('切换失败显示错误且不改动当前路径', async () => {
    await fixture({
        before: defaultState(userData()),
        result: { ok: false, error: '复制数据库失败：磁盘空间不足。' }
    });
    await button('更改位置').click();

    await expect(region().locator('[role="alert"]')).toHaveText('复制数据库失败：磁盘空间不足。');
    await expect(region().locator('code')).toHaveText(userData());
    await expect(region()).not.toContainText('数据位置已切换');
});

test('取消选择不显示结论，也不留下错误提示', async () => {
    await fixture({ before: defaultState(userData()), result: { canceled: true } });
    await button('更改位置').click();

    await expect(region().locator('[role="alert"]')).toHaveCount(0);
    await expect(region().locator('code')).toHaveText(userData());
    await expect(region()).not.toContainText('数据位置已切换');
});

test('自定义位置不可用时说明本次运行范围并仍可恢复默认', async () => {
    await fixture({ before: { ...defaultState(userData()), custom: true, temporaryDefault: true }, result: { canceled: true } });

    await expect(region().locator('code')).toHaveText(userData());
    await expect(region()).toContainText('本次运行暂时使用默认位置；保存的自定义位置会在下次启动时继续尝试。');
    await expect(region()).not.toContainText('当前使用默认位置。');
    await expect(button('恢复默认位置')).toBeVisible();
});

test('临时默认位置下恢复默认会清除自定义设置', async () => {
    await fixture({
        before: { ...defaultState(userData()), custom: true, temporaryDefault: true },
        after: defaultState(userData()),
        result: { ok: true, changed: true, cleared: true, directory: userData(), database: database(userData()) }
    });
    await button('恢复默认位置').click();

    await expect(region()).toContainText('已恢复默认位置，不再使用自定义位置。');
    await expect(region()).toContainText('当前使用默认位置。');
    await expect(button('恢复默认位置')).toHaveCount(0);
});

test('同一位置不切换文件，也不显示切换结论', async () => {
    await fixture({ before: defaultState(userData()), result: { changed: false, directory: userData() } });
    await button('更改位置').click();

    await expect(region().locator('[role="status"]').last()).toContainText('当前已经是这个数据位置。');
    await expect(region().locator('code')).toHaveText(userData());
    await expect(region()).not.toContainText('数据位置已切换');
});
