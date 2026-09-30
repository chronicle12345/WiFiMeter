// 界面测试：跑在真实的采集后端之上。
//
// 网卡数据由两端共用的 JSON 夹具注入，其余全是真实实现：
// 主进程拉起 wifimeter-backend、按行交换 JSON、SQLite 落库、页面读取快照。

import { test, expect, _electron as electron } from '@playwright/test';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
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
    const database = new DatabaseSync(harness.databasePath, { readOnly: true });
    try {
        return Object.values(database.prepare(sql).get()).join('|');
    } finally {
        database.close();
    }
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
    if (profile) await rm(profile, { recursive: true, force: true });
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

// 第一阶段单独验证应用展示：仅替换快照中的应用记录，网卡数据仍来自真实后端。
// 原生应用采集接入后，另用进程夹具覆盖采集到 SQLite 再到界面的完整路径。
async function applicationSnapshot(records) {
    await page.evaluate(() => window.desktop.backend.request('setPaused', { paused: true }));
    const response = await page.evaluate(() => window.desktop.backend.request('snapshot'));
    const snapshot = response.result;
    snapshot.appRecords = records.map(record => ({ networkId: snapshot.networks[0].id, ...record }));
    await app.evaluate(({ ipcMain }, snapshot) => {
        ipcMain.removeHandler('backend:request');
        ipcMain.handle('backend:request', (_event, payload) => ({ ok: true,
            result: payload.method === 'snapshot' ? snapshot : { protocol: 1 } }));
    }, snapshot);
    await page.reload();
    await navigate('总览');
    await expect(page.locator('.connection-title')).toContainText('家里的 Wi-Fi');
    await navigate('网络');
    await page.locator('tr', { hasText: '家里的 Wi-Fi' }).first().getByRole('button', { name: /详情/ }).click();
    await page.getByRole('tab', { name: '应用分布' }).click();
}

test('应用分布聚合、排序、搜索与展开，占比分母不随搜索改变', async () => {
    const date = new Date().toLocaleDateString('en-CA');
    const records = Array.from({ length: 12 }, (_, i) => ({ date, appId: `app-${i}`, name: `应用 ${i}`,
        rxBytes: String((12 - i) * 1000000), txBytes: '0' }));
    records.push({ date, appId: 'app-0', name: '应用 0', rxBytes: '1000000', txBytes: '20000000' });
    await applicationSnapshot(records);
    await expect(page.locator('.app-row')).toHaveCount(10);
    await expect(page.locator('.app-row').first()).toContainText('应用 0');
    await expect(page.locator('.app-row').first()).toContainText('33 MB');
    await expect(page.locator('.app-row').first()).toContainText('33.3%');
    await page.getByRole('button', { name: '显示全部应用' }).click();
    await expect(page.locator('.app-row')).toHaveCount(12);
    await page.locator('#appSort').selectOption('rx');
    await page.locator('#appSearch').fill('应用 0');
    await expect(page.locator('.app-row')).toHaveCount(1);
    await expect(page.locator('.app-row')).toContainText('33.3%');
    await expect(page.locator('#appSearch')).toBeFocused();
    await page.locator('#appSearch').fill('不存在');
    await expect(page.locator('#appListRegion')).toContainText('没有匹配的应用');
    await page.locator('#appSearch').fill('');
    await page.getByRole('tab', { name: '用量明细' }).click();
    await expect(page.locator('.drawer-total .metric-number')).toContainText('3.60');
});

test('应用零用量、名称转义与历史无记录状态正常展示', async () => {
    const date = new Date().toLocaleDateString('en-CA');
    await applicationSnapshot([{ date, appId: 'zero', name: '<img src=x onerror=alert(1)>', rxBytes: '0', txBytes: '0' }]);
    await expect(page.locator('.app-row')).toContainText('<img src=x onerror=alert(1)>');
    await expect(page.locator('.app-row img')).toHaveCount(0);
    await expect(page.locator('.app-row')).toContainText('0 B');
    await expect(page.locator('.app-value')).toContainText('—');
    await page.keyboard.press('Escape');
    await applicationSnapshot([{ date: '2000-01-01', appId: 'old', name: '历史应用', rxBytes: '123', txBytes: '456' }]);
    await expect(page.locator('.drawer')).toContainText('所选时段没有应用记录');
    await expect(page.locator('.drawer')).not.toContainText('尚未采集');
});

test('应用历史来自 SQLite，重启、完整备份恢复与清空都保留正确数据', async () => {
    const database = new DatabaseSync(harness.databasePath);
    const date = new Date().toLocaleDateString('en-CA');
    try {
        const { key } = database.prepare('SELECT key FROM networks LIMIT 1').get();
        database.prepare('INSERT INTO app_usage(network_key, day, app_id, name, rx_bytes, tx_bytes) VALUES(?, ?, ?, ?, ?, ?)')
            .run(key, date, '/opt/browser', '浏览器', 80000000, 20000000);
    } finally {
        database.close();
    }
    await page.reload();
    await expect(page.locator('.connection-title')).toContainText('家里的 Wi-Fi');
    await navigate('网络');
    await page.locator('tr', { hasText: '家里的 Wi-Fi' }).first().getByRole('button', { name: /详情/ }).click();
    await page.getByRole('tab', { name: '应用分布' }).click();
    await expect(page.locator('.app-row')).toContainText('浏览器');
    await expect(page.locator('.app-row')).toContainText('100 MB');
    await app.close();
    await launch();
    await expect.poll(() => query('SELECT rx_bytes FROM app_usage')).toBe('80000000');
    await navigate('设置');
    const backupFile = path.join(profile, 'applications-backup.json');
    await saveDialog(backupFile);
    await page.getByRole('button', { name: '备份', exact: true }).click();
    await expectToast('已导出完整数据备份');
    const backup = JSON.parse(await readFile(backupFile, 'utf8'));
    expect(backup.appRecords).toHaveLength(1);
    expect(backup.appRecords[0].rxBytes).toBe('80000000');
    await page.getByRole('button', { name: '清空记录', exact: true }).click();
    await page.locator('#confirmText').fill('清空');
    await page.locator('.modal').getByRole('button', { name: '清空记录' }).click();
    await expectToast('记录已清空');
    await expect.poll(() => query('SELECT COUNT(*) FROM app_usage')).toBe('0');
    await openDialog(backupFile);
    await page.getByRole('button', { name: '恢复', exact: true }).click();
    await expect(page.locator('.modal')).toBeVisible();
    await page.locator('.modal').getByRole('button', { name: '确认恢复' }).click();
    await expect.poll(() => query('SELECT rx_bytes FROM app_usage')).toBe('80000000');
});

test('采集状态显示真实网卡，暂停与恢复都由后端执行', async () => {
    await page.getByRole('button', { name: '采集状态' }).click();
    await expect(page.locator('.modal')).toContainText('采集器：运行中');
    await expect(page.locator('.modal')).toContainText('AICSemi AIC8800DC');
    await page.getByRole('button', { name: '完成' }).click();

    // 暂停：后端停止采样，界面显示已暂停，并留下一段未结束的覆盖空档。
    await page.getByRole('button', { name: '暂停统计' }).click();
    await expect(page.locator('#collector')).toContainText('统计已暂停');
    await expect.poll(() => query('SELECT COUNT(*) FROM coverage_gaps')).toBe('1');

    // 恢复：空档被闭合。
    await page.getByRole('button', { name: '恢复统计' }).click();
    await expect(page.locator('#collector')).toContainText('正在采集');
    await expect.poll(() => query("SELECT COUNT(*) FROM coverage_gaps WHERE ended_at <> ''")).toBe('1');
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
    await expect.poll(() => query("SELECT alias || '|' || cap_gb FROM networks WHERE alias <> ''")).toBe('书房 Wi-Fi|8.0');

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
    await expect.poll(() => query('SELECT COUNT(*) FROM daily_usage')).toBe('0');

    await openDialog(backupFile);
    await page.getByRole('button', { name: '恢复', exact: true }).click();
    await page.locator('.modal').getByRole('button', { name: '确认恢复' }).click();
    await expectToast('已恢复备份');
    await expect.poll(() => query('SELECT COUNT(*) FROM daily_usage')).toBe('1');
    await expect.poll(() => query('SELECT alias FROM networks')).toBe('家里的 Wi-Fi');
});

test('开机启动开关按平台登记并取消', async () => {
    if (process.platform === 'win32') {
        // 验证界面到登录项接口的调用，不修改运行测试的 Windows 账户启动项。
        await app.evaluate(({ app }) => {
            let openAtLogin = false;
            app.setLoginItemSettings = options => { openAtLogin = options.openAtLogin; };
            app.getLoginItemSettings = () => ({ openAtLogin });
        });
    } else {
        // 用临时目录隔离 Linux 的 ~/.config/autostart。
        await app.close();
        fakeHome = await mkdtemp(path.join(os.tmpdir(), 'wifimeter-home-'));
        await launch({ HOME: fakeHome });
    }

    await navigate('设置');
    await page.locator('input[name="autoStart"]').check();
    await page.getByRole('button', { name: '保存设置' }).click();
    await expectToast('已保存偏好');

    const file = fakeHome && path.join(fakeHome, '.config/autostart/wifimeter.desktop');
    const enabled = () => process.platform === 'win32'
        ? app.evaluate(({ app }) => app.getLoginItemSettings().openAtLogin)
        : existsSync(file);
    await expect.poll(enabled, { timeout: 10000 }).toBe(true);
    if (file) {
        const text = await readFile(file, 'utf8');
        expect(text).toContain('[Desktop Entry]');
        expect(text).toContain('Exec=');
    }

    // 关掉后文件应当被删除。
    await page.locator('input[name="autoStart"]').uncheck();
    await page.getByRole('button', { name: '保存设置' }).click();
    await expect.poll(enabled, { timeout: 10000 }).toBe(false);
});

test('偏好设置会落库并影响后端行为', async () => {
    await navigate('设置');
    await page.locator('select[name="retention"]').selectOption('30');
    await page.getByRole('button', { name: '保存设置' }).click();
    await expectToast('已保存偏好');
    await expect.poll(() => query('SELECT retention_days FROM settings')).toBe('30');

    await page.locator('select[name="interval"]').selectOption('10');
    await page.getByRole('button', { name: '保存设置' }).click();
    await expect.poll(() => query('SELECT interval_seconds FROM settings')).toBe('10');

    // 单位换算立刻反映在界面上。
    await page.locator('select[name="unit"]').selectOption('GiB');
    await page.getByRole('button', { name: '保存设置' }).click();
    await expect.poll(() => query('SELECT unit FROM settings')).toBe('GiB');
    await navigate('总览');
    await expect(page.locator('.metric.featured')).toContainText('GiB');
});
