import { test, expect, _electron as electron } from '@playwright/test';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

let app, page, profile, errors;
async function launch() {
    const env = { ...process.env, WIFIMETER_USER_DATA: profile };
    delete env.ELECTRON_RUN_AS_NODE;
    app = await electron.launch({
        executablePath: process.env.WIFIMETER_EXECUTABLE || undefined,
        args: process.env.WIFIMETER_EXECUTABLE ? [] : ['.'], env
    });
    page = await app.firstWindow();
    page.on('pageerror', error => errors.push(error.message));
    await expect(page.locator('h1')).toHaveText('流量总览');
}
async function navigate(name) {
    const id = { '总览': 'overview', '网络': 'networks', '历史': 'history', '设置': 'settings' }[name];
    await page.locator(`.nav [data-page="${id}"]`).click();
}
async function saveDialog(filePath, canceled = false) {
    await app.evaluate(({ dialog }, result) => {
        dialog.showSaveDialog = async () => result;
    }, { filePath, canceled });
}

test.beforeEach(async () => {
    profile = await mkdtemp(path.join(os.tmpdir(), 'wifimeter-ui-'));
    errors = [];
    await launch();
});
test.afterEach(async () => {
    if (app) await app.close();
    await rm(profile, { recursive: true, force: true });
    expect(errors).toEqual([]);
});

test('four pages, filters, details, preferences, keyboard and restart', async ({}, info) => {
    await page.locator('[data-action="pause"]').click();
    const expected = await page.evaluate(() => {
        const data = JSON.parse(localStorage.getItem('wifimeter-linux-demo-v1'));
        const now = new Date();
        const month = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
        const sum = id => data.records.filter(r => r.date.startsWith(month) && (!id || r.networkId === id))
            .reduce((total, r) => total + BigInt(r.rxBytes) + BigInt(r.txBytes), 0n);
        return { all: (Number(sum()) / 1e9).toFixed(2), home: (Number(sum('home')) / 1e9).toFixed(2) };
    });
    await expect(page.locator('.metric.featured .metric-number')).toContainText(expected.all);
    await page.screenshot({ path: info.outputPath('overview.png'), fullPage: true });
    await page.locator('#networkFilter').selectOption('home');
    await expect(page.locator('.metric.featured .metric-number')).toContainText(expected.home);
    await page.getByRole('button', { name: '自定义', exact: true }).click();
    await page.locator('#rangeStart').fill('2026-01-01');
    await page.locator('#rangeEnd').fill('2025-12-31');
    await page.getByRole('button', { name: '应用筛选' }).click();
    await expect(page.locator('#rangeError')).toContainText('有效');
    await page.keyboard.press('Escape');
    await navigate('网络');
    await page.locator('#networkSearch').fill('Habitat');
    await expect(page.locator('#networkTableRegion tbody tr')).toHaveCount(1);
    await page.locator('.network-name').click();
    await page.getByRole('tab', { name: '应用分布' }).click();
    await expect(page.locator('.drawer')).toContainText('Firefox');
    await page.getByRole('tab', { name: '网络设置' }).click();
    await page.locator('#aliasInput').fill('Linux 测试网络');
    await page.getByRole('button', { name: '保存网络设置' }).click();
    await expect(page.locator('#drawerTitle')).toHaveText('Linux 测试网络');
    await page.keyboard.press('Escape');
    await navigate('历史');
    await expect(page.locator('h1')).toHaveText('历史记录');
    await expect(page.locator('.pagination')).toBeVisible();
    await navigate('设置');
    await page.locator('[name="unit"]').selectOption('GiB');
    await page.locator('[name="interval"]').selectOption('2');
    await page.getByRole('button', { name: '保存设置', exact: true }).click();
    await navigate('总览');
    await expect(page.locator('.metric.featured')).toContainText('GiB');
    await app.close();
    await launch();
    await expect(page.locator('#networkFilter')).toContainText('Linux 测试网络');
    await expect(page.locator('.metric.featured')).toContainText('GiB');
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(900, 650));
    await page.screenshot({ path: info.outputPath('small-window.png'), fullPage: true });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    expect(await page.evaluate(() => typeof window.require)).toBe('undefined');
});

test('sample refresh preserves editing and demo states remain interactive', async () => {
    await navigate('设置');
    await page.locator('[name="interval"]').selectOption('2');
    await page.getByRole('button', { name: '保存设置', exact: true }).click();
    await navigate('总览');
    await page.getByRole('button', { name: '查看当前网络详情' }).click();
    await page.getByRole('tab', { name: '网络设置' }).click();
    await page.locator('#aliasInput').fill('尚未保存');
    await page.waitForTimeout(2300);
    await expect(page.locator('#aliasInput')).toHaveValue('尚未保存');
    await expect(page.locator('#aliasInput')).toBeFocused();
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: '放弃更改', exact: true }).click();
    for (const state of ['permission', 'offline', 'disconnected', 'connected']) {
        await page.locator('.demo-pill').click();
        await page.locator(`[data-state="${state}"]`).click();
        await expect(page.locator('.connection')).toBeVisible();
    }
});

test('CSV and JSON export, cancellation, failure, backup and restore through IPC', async () => {
    await page.locator('[data-action="pause"]').click();
    const csv = path.join(profile, 'usage.csv');
    await saveDialog(csv);
    await page.getByRole('button', { name: '导出数据', exact: true }).click();
    await page.getByRole('button', { name: '导出记录', exact: true }).click();
    await expect(page.locator('.modal')).toHaveCount(0);
    const csvText = await readFile(csv, 'utf8');
    expect(csvText).toContain('下载字节');
    expect(csvText).toContain('Habitat_5G');
    const json = path.join(profile, 'usage.json');
    await saveDialog(json);
    await page.getByRole('button', { name: '导出数据', exact: true }).click();
    await page.locator('#exportFormat').selectOption('json');
    await page.getByRole('button', { name: '导出记录', exact: true }).click();
    await expect(page.locator('.modal')).toHaveCount(0);
    expect(JSON.parse(await readFile(json, 'utf8')).source).toBe('demo');
    await saveDialog(undefined, true);
    await page.getByRole('button', { name: '导出数据', exact: true }).click();
    await page.getByRole('button', { name: '导出记录', exact: true }).click();
    await expect(page.locator('.modal')).toBeVisible();
    await expect(page.locator('#exportError')).toBeEmpty();
    await saveDialog(path.join(profile, 'missing', 'usage.csv'));
    await page.getByRole('button', { name: '导出记录', exact: true }).click();
    await expect(page.locator('#exportError')).toContainText('保存失败');
    await page.keyboard.press('Escape');
    await navigate('设置');
    const backup = path.join(profile, 'backup.json');
    await saveDialog(backup);
    await page.getByRole('button', { name: '备份', exact: true }).click();
    await expect(page.locator('#toasts')).toContainText('完整演示数据备份');
    expect(JSON.parse(await readFile(backup, 'utf8')).backupType).toBe('wifimeter-ui-demo');
    await app.evaluate(({ dialog }, file) => {
        dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] });
    }, backup);
    await page.getByRole('button', { name: '恢复', exact: true }).click();
    await page.getByRole('button', { name: '确认恢复', exact: true }).click();
    await expect(page.locator('#collector')).toContainText('统计已暂停');
    await writeFile(backup, '{invalid');
    await page.getByRole('button', { name: '恢复', exact: true }).click();
    await expect(page.locator('#toasts .error')).toBeVisible();
});
