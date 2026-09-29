// 界面测试：跑在真实的采集后端之上。
//
// 网卡数据由夹具注入（假的 nmcli 与假的 /proc/net/dev），其余全是真实实现：
// 主进程拉起 wifimeter-backend、按行交换 JSON、SQLite 落库、页面读取快照。

import { test, expect, _electron as electron } from '@playwright/test';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { createHarness, backendBinary } from './support/backend-harness.mjs';

let app, page, profile, errors, harness, fakeHome;

async function launch(extraEnv = {}) {
    const env = { ...process.env, WIFIMETER_USER_DATA: profile, ...harness.env, ...extraEnv };
    delete env.ELECTRON_RUN_AS_NODE;
    app = await electron.launch({ executablePath: process.env.WIFIMETER_EXECUTABLE || undefined, args: process.env.WIFIMETER_EXECUTABLE ? [] : ['.'], env });
    page = await app.firstWindow();
    page.on('pageerror', error => errors.push(error.message));
    await expect(page.locator('h1')).toHaveText('流量总览');
    // 数据来自后端，等首屏拿到快照再继续。
    await expect(page.locator('.connection-title')).not.toHaveText('等待本机采集器');
}

async function navigate(name) {
    const id = { '总览': 'overview', '网络': 'networks', '历史': 'history', '设置': 'settings' }[name];
    await page.locator(`.nav [data-page="${id}"]`).click();
}

async function saveDialog(filePath) {
    await app.evaluate(({ dialog }, result) => {
        dialog.showSaveDialog = async () => result;
    }, { filePath, canceled: false });
}

async function openDialog(filePath) {
    // showOpenDialog 的结果用 filePaths 数组，与 showSaveDialog 的 filePath 不同。
    await app.evaluate(({ dialog }, result) => {
        dialog.showOpenDialog = async () => result;
    }, { filePaths: [filePath], canceled: false });
}

// 提示可能同时存在多条，按内容定位而不是要求唯一。
async function expectToast(text) {
    await expect(page.locator('.toast').filter({ hasText: text }).first()).toBeVisible();
}

// 直接查数据库，验证界面操作真的落盘，而不是只改了内存。
function query(sql) {
    return execFileSync('sqlite3', [harness.databasePath, sql], { encoding: 'utf8' }).trim();
}

test.beforeEach(async () => {
    test.skip(!existsSync(backendBinary), '未构建后端，跳过界面测试');
    profile = await mkdtemp(path.join(os.tmpdir(), 'wifimeter-ui-'));
    errors = [];
    harness = await createHarness();
    await launch();
});

test.afterEach(async () => {
    if (app) await app.close();
    harness?.cleanup();
    await rm(profile, { recursive: true, force: true });
    if (fakeHome) {
        await rm(fakeHome, { recursive: true, force: true });
        fakeHome = null;
    }
    expect(errors).toEqual([]);
});

test('四个页面展示真实采集结果，筛选、详情与键盘操作可用', async () => {
    // 总览显示夹具注入的网络与用量。
    await expect(page.locator('.connection-title')).toContainText('家里的 Wi-Fi');
    await expect(page.locator('.connection-details')).toContainText('Habitat_5G');
    await expect(page.locator('.connection-details')).toContainText('5 GHz');
    await expect(page.locator('.connection-details')).toContainText('信号 82%');
    await expect(page.locator('#footer')).toContainText('本机采集');

    await navigate('网络');
    const row = page.locator('tr', { hasText: '家里的 Wi-Fi' }).first();
    await expect(row).toBeVisible();

    // 详情抽屉：真实数值与额度。
    await row.getByRole('button', { name: /详情/ }).click();
    await expect(page.locator('.drawer h2')).toHaveText('家里的 Wi-Fi');
    await expect(page.locator('.drawer')).toContainText('Habitat_5G');
    await expect(page.locator('.drawer')).toContainText('AICSemi AIC8800DC');
    await expect(page.locator('.drawer-total .metric-number')).toContainText('3.60');

    // 应用分布标签页如实说明尚未采集。
    await page.getByRole('tab', { name: '应用分布' }).click();
    await expect(page.locator('.drawer')).toContainText('应用级流量尚未采集');

    // 键盘：Esc 关闭抽屉。
    await page.keyboard.press('Escape');
    await expect(page.locator('.drawer')).toHaveCount(0);

    await navigate('历史');
    await expect(page.locator('.history-stat').first()).toContainText('3.60');
    await navigate('设置');
    await expect(page.locator('.settings-aside')).toContainText('本机数据库');
});

test('采集状态显示真实网卡，暂停与恢复都由后端执行', async () => {
    await page.getByRole('button', { name: '采集状态' }).click();
    await expect(page.locator('.modal')).toContainText('采集器：运行中');
    await expect(page.locator('.modal')).toContainText('AICSemi AIC8800DC');
    await page.getByRole('button', { name: '完成' }).click();

    // 暂停：后端停止采样，界面显示已暂停，并留下一段未结束的覆盖空档。
    await page.getByRole('button', { name: '暂停统计' }).click();
    await expect(page.locator('#collector')).toContainText('统计已暂停');
    expect(query('SELECT COUNT(*) FROM coverage_gaps')).toBe('1');

    // 恢复：空档被闭合。
    await page.getByRole('button', { name: '恢复统计' }).click();
    await expect(page.locator('#collector')).toContainText('正在采集');
    expect(query("SELECT COUNT(*) FROM coverage_gaps WHERE ended_at <> ''")).toBe('1');
});

test('修改网络备注与额度会写入数据库，重启后仍然保留', async () => {
    await navigate('网络');
    await page.locator('tr', { hasText: '家里的 Wi-Fi' }).first().getByRole('button', { name: /详情/ }).click();
    await page.getByRole('tab', { name: '网络设置' }).click();
    await page.locator('#aliasInput').fill('书房 Wi-Fi');
    await page.locator('#quotaInput').fill('8');
    await page.getByRole('button', { name: '保存网络设置' }).click();
    await expect(page.locator('.drawer h2')).toHaveText('书房 Wi-Fi');

    // 落库校验：不只看界面。
    expect(query("SELECT alias || '|' || cap_gb FROM networks WHERE alias <> ''")).toBe('书房 Wi-Fi|8.0');

    await app.close();
    await launch();
    await expect(page.locator('.connection-title')).toContainText('书房 Wi-Fi');
});

test('导出、备份与恢复都通过真实数据完成', async () => {
    const csv = path.join(profile, 'usage.csv');
    await saveDialog(csv);
    await page.getByRole('button', { name: '导出数据', exact: true }).click();
    await page.getByRole('button', { name: '导出记录', exact: true }).click();
    await expect(page.locator('.modal')).toHaveCount(0);

    const csvText = await readFile(csv, 'utf8');
    expect(csvText).toContain('下载字节');
    expect(csvText).toContain('Habitat_5G');
    expect(csvText).toContain('本机采集');
    // 夹具注入的 3.1 GB 下载量应当出现在导出里。
    expect(csvText).toContain('3100000000');

    // 完整备份：内容是后端导出的文档。
    const backupFile = path.join(profile, 'backup.json');
    await saveDialog(backupFile);
    await navigate('设置');
    await page.getByRole('button', { name: '备份' }).click();
    await expectToast('已导出完整数据备份');
    const backup = JSON.parse(await readFile(backupFile, 'utf8'));
    expect(backup.backupType).toBe('wifimeter-backend-backup');
    expect(backup.networks.length).toBe(1);
    expect(backup.records.length).toBe(1);

    // 清空后再恢复：记录与备注都要回来。
    await page.getByRole('button', { name: '清空记录', exact: true }).click();
    // 清空需要输入确认文字后按钮才可用。
    await page.locator('#confirmText').fill('清空');
    await page.locator('.modal').getByRole('button', { name: '清空记录' }).click();
    await expectToast('记录已清空');
    expect(query('SELECT COUNT(*) FROM daily_usage')).toBe('0');

    await openDialog(backupFile);
    await page.getByRole('button', { name: '恢复', exact: true }).click();
    await page.locator('.modal').getByRole('button', { name: '确认恢复' }).click();
    await expectToast('已恢复备份');
    expect(query('SELECT COUNT(*) FROM daily_usage')).toBe('1');
    expect(query('SELECT alias FROM networks')).toBe('家里的 Wi-Fi');
});

test('开机启动开关会写入系统的自启动目录', async () => {
    // 用一个临时的 HOME 启动应用，避免测试碰到开发机真实的 ~/.config/autostart。
    await app.close();
    fakeHome = await mkdtemp(path.join(os.tmpdir(), 'wifimeter-home-'));
    await launch({ HOME: fakeHome });

    await navigate('设置');
    await page.locator('input[name="autoStart"]').check();
    await page.getByRole('button', { name: '保存设置' }).click();
    await expectToast('已保存偏好');

    const file = path.join(fakeHome, '.config/autostart/wifimeter.desktop');
    await expect.poll(() => existsSync(file), { timeout: 10000 }).toBe(true);
    const text = await readFile(file, 'utf8');
    expect(text).toContain('[Desktop Entry]');
    expect(text).toContain('Exec=');

    // 关掉后文件应当被删除。
    await page.locator('input[name="autoStart"]').uncheck();
    await page.getByRole('button', { name: '保存设置' }).click();
    await expect.poll(() => existsSync(file), { timeout: 10000 }).toBe(false);
});

test('偏好设置会落库并影响后端行为', async () => {
    await navigate('设置');
    await page.locator('select[name="retention"]').selectOption('30');
    await page.getByRole('button', { name: '保存设置' }).click();
    await expectToast('已保存偏好');
    expect(query('SELECT retention_days FROM settings')).toBe('30');

    await page.locator('select[name="interval"]').selectOption('10');
    await page.getByRole('button', { name: '保存设置' }).click();
    expect(query('SELECT interval_seconds FROM settings')).toBe('10');

    // 单位换算立刻反映在界面上。
    await page.locator('select[name="unit"]').selectOption('GiB');
    await page.getByRole('button', { name: '保存设置' }).click();
    expect(query('SELECT unit FROM settings')).toBe('GiB');
    await navigate('总览');
    await expect(page.locator('.metric.featured')).toContainText('GiB');
});
