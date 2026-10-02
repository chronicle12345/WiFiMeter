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
    await expect(page).toHaveTitle(/流量总览/);
    await expect(page.locator('#pageHead')).toHaveCount(0);
    await expect(page.locator('h1, .breadcrumbs')).toHaveCount(0);
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
        const row = database.prepare(sql).get();
        return row ? Object.values(row).join('|') : '';
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

test('四个页面展示真实采集结果，筛选、详情与键盘操作可用 @packaged-smoke', async () => {
    // 总览显示夹具注入的网络与用量。
    await expect(page.locator('.connection-title')).toContainText('家里的 Wi-Fi');
    await expect(page.locator('.connection-details')).toContainText('Habitat_5G');
    await expect(page.locator('.connection-details')).toContainText('5 GHz');
    await expect(page.locator('.connection-details')).toContainText('信号 82%');
    await expect(page.locator('#footer')).toBeEmpty();

    await expect(page.locator('.chart-caption')).toContainText('单位：');
    await expect(page.locator('.chart-caption')).not.toContainText('无记录不等于零流量');
    await expect(page.locator('.chart-caption')).not.toContainText('按所选网络汇总');

    await navigate('网络');
    await expect(page.locator('#pageHead .page-description')).toHaveCount(0);
    await expect(page.getByText('网络名称可添加备注', { exact: false })).toHaveCount(0);
    const row = page.locator('tr', { hasText: '家里的 Wi-Fi' }).first();
    await expect(row).toBeVisible();

    // 详情抽屉：真实数值与额度。
    await row.getByRole('button', { name: /详情/ }).click();
    await expect(page.locator('.drawer h2')).toHaveText('家里的 Wi-Fi');
    await expect(page.locator('.drawer')).toContainText('Habitat_5G');
    await expect(page.locator('.drawer')).toContainText('AICSemi AIC8800DC');
    await expect(page.locator('.drawer-total .metric-number')).toContainText('3.6');

    // 应用分布标签页如实说明尚未采集。
    await page.getByRole('tab', { name: '应用分布' }).click();
    await expect(page.locator('.drawer')).toContainText('启用应用采集后开始记录。');

    // 键盘：Esc 关闭抽屉。
    await page.keyboard.press('Escape');
    await expect(page.locator('.drawer')).toHaveCount(0);

    await navigate('历史');
    await expect(page.locator('.history-stat').first()).toContainText('3.6');
    await navigate('设置');
    await expect(page.locator('.settings-aside')).toHaveCount(0);
    await expect(page.locator('[data-action="settings-category"]')).toHaveCount(7);
});

test('总览保留用量、连接、趋势与额度，网络明细只在网络页展示', async () => {
    await expect(page.locator('#content table')).toHaveCount(0);
    await expect(page.getByRole('heading', { name: '网络用量', exact: true })).toHaveCount(0);
    await expect(page.locator('.collector-sub')).toHaveCount(0);
    await expect(page.locator('#collector')).toContainText('正在采集');
    await expect(page.getByRole('button', { name: '暂停统计', exact: true })).toBeEnabled();
    await expect(page.locator('.connection-title')).toContainText('家里的 Wi-Fi');
    await expect(page.locator('.connection-details')).toContainText('Habitat_5G');
    const metrics = page.locator('#content > .metrics .metric-number');
    await expect(metrics).toHaveCount(3);
    await expect(metrics.nth(0)).toHaveText(/3\.6\s*GB/);
    await expect(metrics.nth(1)).toHaveText(/3\.1\s*GB/);
    await expect(metrics.nth(2)).toHaveText(/500\s*MB/);
    await expect(page.locator('#usage-chart-desc')).toContainText('GB');
    await expect(page.locator('.total-quota-card')).toBeVisible();
    await expect(page.locator('.quota-card .progress-meta')).toContainText('已用 3.6 GB / 5 GB');
    await expect(page.getByRole('button', { name: '设置该网络额度', exact: true })).toBeEnabled();
    await expect(page.locator('#footer')).toBeEmpty();

    await navigate('网络');
    await expect(page.locator('#networkTableRegion table')).toHaveCount(1);
    const row = page.locator('#networkTableRegion tbody tr');
    await expect(row).toHaveCount(1);
    await expect(row).toContainText('家里的 Wi-Fi');
    await expect(row.locator('td').nth(1)).toHaveText('3.1 GB');
    await expect(row.locator('td').nth(2)).toHaveText('500 MB');
    await expect(row.locator('td').nth(3)).toHaveText('3.6 GB');
});

test('未设额度时保留设置入口，不显示重复说明', async () => {
    await displaySnapshot(snapshot => { snapshot.networks[0].capGb = 0; });
    await expect(page.locator('.quota-card')).toContainText('尚未设置流量额度');
    await expect(page.locator('.quota-card')).not.toContainText('可单独为每个 Wi-Fi 设置');
    await page.getByRole('button', { name: '设置该网络额度', exact: true }).click();
    await expect(page.locator('#quotaInput')).toBeVisible();
    await expect(page.locator('#quotaInput')).toHaveValue('');
});

test('后端连接失败时页脚仍显示错误', async () => {
    await app.evaluate(({ ipcMain }) => {
        ipcMain.removeHandler('backend:request');
        ipcMain.handle('backend:request', () => ({ ok: false, error: { message: 'backend unavailable' } }));
    });
    await page.reload();
    await expect(page.locator('#footer')).toHaveText('无法连接采集后端，请检查状态');
    await expect(page.locator('#footer')).toBeVisible();
    await expectToast('无法连接采集后端：backend unavailable');
});

// 第一阶段单独验证应用展示：仅替换快照中的应用记录，网卡数据仍来自真实后端。
// 原生应用采集接入后，另用进程夹具覆盖采集到 SQLite 再到界面的完整路径。
async function displaySnapshot(update) {
    await page.evaluate(() => window.desktop.backend.request('setPaused', { paused: true }));
    const response = await page.evaluate(() => window.desktop.backend.request('snapshot'));
    const snapshot = response.result;
    update(snapshot);
    await app.evaluate(({ ipcMain }, snapshot) => {
        ipcMain.removeHandler('backend:request');
        ipcMain.handle('backend:request', (_event, payload) => ({ ok: true,
            result: payload.method === 'snapshot' ? snapshot : { protocol: 1 } }));
    }, snapshot);
    await page.reload();
    await navigate('总览');
    await expect(page.locator('.connection-title')).toContainText('家里的 Wi-Fi');
}

async function applicationSnapshot(records) {
    await displaySnapshot(snapshot => {
        snapshot.appRecords = records.map(record => ({ networkId: snapshot.networks[0].id, ...record }));
    });
    await navigate('网络');
    await page.locator('tr', { hasText: '家里的 Wi-Fi' }).first().getByRole('button', { name: /详情/ }).click();
    await page.getByRole('tab', { name: '应用分布' }).click();
}

async function smallUsageSnapshot(rxBytes, txBytes, unit = 'GB') {
    await displaySnapshot(snapshot => {
        const date = new Date().toLocaleDateString('en-CA'), networkId = snapshot.networks[0].id;
        snapshot.settings.unit = unit;
        snapshot.records = [{ date, networkId, rxBytes, txBytes }];
        snapshot.hourly = [{ date, networkId, hour: 0, rxBytes, txBytes }];
        snapshot.appRecords = [{ date, networkId, appId: 'small', name: '小流量应用', rxBytes, txBytes }];
        snapshot.networks[0].capGb = 10;
        snapshot.networks[0].quotaLedger = { periodKey: date.slice(0, 7), usedBytes: String(BigInt(rxBytes) + BigInt(txBytes)) };
    });
}

test('小流量在所有用量入口使用自动单位，图表可见且 CSV 保留固定单位', async () => {
    await smallUsageSnapshot('520000', '1');
    const metrics = page.locator('#content > .metrics .metric-number');
    await expect(metrics.nth(0)).toHaveText(/520\s*KB/);
    await expect(metrics.nth(1)).toHaveText(/520\s*KB/);
    await expect(metrics.nth(2)).toHaveText(/1\s*B/);
    await expect(page.locator('.progress-meta').first()).toContainText('已用 520 KB / 10 GB');
    await expect(page.locator('.chart-caption')).toContainText('单位：KB');
    await expect(page.locator('#usage-chart-desc')).toContainText('单位 KB');
    await expect(page.locator('.chart title')).toContainText('KB');
    expect(Number(await page.locator('.bar-rx').first().getAttribute('height'))).toBeGreaterThan(50);
    await page.locator('[data-chart-point][data-missing="0"]').focus();
    await expect(page.locator('#tooltip')).toContainText('520 KB');
    await expect(page.locator('#tooltip')).toContainText('1 B');

    const csv = path.join(profile, 'small-usage.csv');
    await saveDialog(csv);
    await page.getByRole('button', { name: '导出数据', exact: true }).click();
    await page.getByRole('button', { name: '导出记录', exact: true }).click();
    await expect(page.locator('.modal')).toHaveCount(0);
    const csvText = await readFile(csv, 'utf8');
    expect(csvText).toContain('"下载_GB","上传_GB","总计_GB"');
    expect(csvText).toContain('"520000","1","520001"');
    expect(csvText).toContain('"0.000520","0.000000","0.000520"');

    await navigate('网络');
    const row = page.locator('tr', { hasText: '家里的 Wi-Fi' }).first();
    await expect(row.locator('td').nth(1)).toHaveText('520 KB');
    await expect(row.locator('td').nth(2)).toHaveText('1 B');
    await row.getByRole('button', { name: /详情/ }).click();
    await expect(page.locator('.drawer-total .metric-number')).toHaveText(/520\s*KB/);
    await expect(page.locator('#drawer-chart-desc')).toContainText('单位 KB');
    await expect(page.locator('.drawer td').nth(1)).toHaveText('520 KB');
    await page.getByRole('tab', { name: '应用分布' }).click();
    await expect(page.locator('#appTotal')).toHaveText(/520\s*KB/);
    await expect(page.locator('.app-row')).toContainText('下载 520 KB · 上传 1 B');
    await page.locator('#appSearch').fill('小流量');
    await expect(page.locator('#appTotal')).toHaveText(/520\s*KB/);
    await page.locator('[data-action="select-app"]').first().click();
    await expect(page.locator('.drawer .application-summary')).toContainText('520 KB');
    await page.keyboard.press('Escape');
    await expect(page.getByRole('tab',{name:'应用分布'})).toHaveAttribute('aria-selected','true');
    await expect(page.locator('#appSearch')).toHaveValue('小流量');
    await expect(page.locator('[data-action="select-app"]').first()).toBeFocused();
    await page.keyboard.press('Escape');

    await navigate('历史');
    for (const metric of await page.locator('.history-stat .metric-number').all())
        await expect(metric).toHaveText(/520\s*KB/);
    await expect(page.locator('tbody td').nth(1)).toHaveText('520 KB');
    await expect(page.locator('tbody td').nth(2)).toHaveText('1 B');
});

test('自动单位沿用二进制偏好，图表与额度明确标注单位', async () => {
    await smallUsageSnapshot('1048576', '1024', 'GiB');
    await expect(page.locator('.metric.featured .metric-number')).toHaveText(/1\s*MiB/);
    await expect(page.locator('#content > .metrics .metric-number').nth(2)).toHaveText(/1\s*KiB/);
    await expect(page.locator('.chart-caption')).toContainText('单位：MiB');
    await expect(page.locator('.progress-meta').first()).toContainText('已用 1 MiB / 9.31 GiB');
    const csv = path.join(profile, 'binary-usage.csv');
    await saveDialog(csv);
    await page.getByRole('button', { name: '导出数据', exact: true }).click();
    await page.getByRole('button', { name: '导出记录', exact: true }).click();
    await expect(page.locator('.modal')).toHaveCount(0);
    const csvText = await readFile(csv, 'utf8');
    expect(csvText).toContain('"下载_GiB","上传_GiB","总计_GiB"');
    expect(csvText).toContain('"0.000977","0.000001","0.000978"');
    await navigate('设置');
    await page.locator('[data-category="display"]').click();
    await expect(page.getByRole('combobox', { name: '流量单位进制' })).toHaveValue('GiB');
});

test('零用量显示 0 B，无记录仍显示破折号', async () => {
    await smallUsageSnapshot('0', '0');
    for (const metric of await page.locator('#content > .metrics .metric-number').all())
        await expect(metric).toHaveText(/0\s*B/);
    await navigate('网络');
    await page.locator('tr', { hasText: '家里的 Wi-Fi' }).first().getByRole('button', { name: /详情/ }).click();
    await page.getByRole('tab', { name: '应用分布' }).click();
    await expect(page.locator('#appTotal')).toHaveText(/0\s*B/);
    await page.keyboard.press('Escape');
    await displaySnapshot(snapshot => { snapshot.records = []; snapshot.hourly = []; snapshot.appRecords = []; });
    for (const metric of await page.locator('#content > .metrics .metric-number').all())
        await expect(metric).toHaveText('—');
    await expect(page.locator('.chart-wrap')).toContainText('所选时段暂无流量记录');
});

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
    await expect(page.locator('.drawer-total .metric-number')).toContainText('3.6');
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
    await page.locator('[data-category="data"]').click();
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

test('应用采集需要显式启用，实时列表、进程详情与暂停恢复正确', async () => {
    await navigate('网络');
    await page.locator('tr', { hasText: '家里的 Wi-Fi' }).first().getByRole('button', { name: /详情/ }).click();
    await page.getByRole('tab', { name: '应用分布' }).click();
    await expect(page.getByRole('button', { name: '启用应用采集', exact: true })).toBeVisible();
    await expect(page.locator('#appStatusRegion')).not.toContainText('应用采集未启用');
    await page.getByRole('button', { name: '启用应用采集', exact: true }).click();
    await page.evaluate(() => window.desktop.backend.request('collectNow'));
    await expect(page.locator('#appStatusRegion')).toContainText('应用采集中');
    harness.appCounters(80000000, 20000000);
    await page.evaluate(() => window.desktop.backend.request('collectNow'));
    await expect(page.locator('.app-row')).toContainText('100 MB');
    await expect.poll(() => query('SELECT rx_bytes FROM app_usage')).toBe('80000000');
    await page.locator('#appSearch').fill('浏览');
    await page.evaluate(() => window.desktop.backend.request('collectNow'));
    await expect(page.locator('#appSearch')).toBeFocused();
    await expect(page.locator('.app-row')).toContainText('100 MB');
    await page.locator('#appGrouping').selectOption('live');
    await page.locator('[data-action="select-live-app"]').first().click();
    await expect(page.locator('.drawer .application-summary')).toContainText('42');
    await page.keyboard.press('Escape');
    await expect(page.locator('#appGrouping')).toHaveValue('live');
    await expect(page.locator('#appSearch')).toHaveValue('浏览');
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: '暂停统计', exact: true }).click();
    harness.appCounters(180000000, 20000000);
    await page.evaluate(() => window.desktop.backend.request('collectNow'));
    await expect.poll(() => query('SELECT rx_bytes FROM app_usage')).toBe('80000000');
    await page.getByRole('button', { name: '恢复统计', exact: true }).click();
    await page.evaluate(() => window.desktop.backend.request('collectNow'));
    await expect.poll(() => query('SELECT rx_bytes FROM app_usage')).toBe('80000000');
    await page.locator('tr', { hasText: '家里的 Wi-Fi' }).first().getByRole('button', { name: /详情/ }).click();
    await page.getByRole('tab', { name: '应用分布' }).click();
    await page.getByRole('button', { name: '停止应用采集', exact: true }).click();
    await expect(page.getByRole('button', { name: '启用应用采集', exact: true })).toBeVisible();
    await expect(page.locator('#appStatusRegion')).not.toContainText('应用采集未启用');
    await expect(page.locator('.app-row')).toContainText('100 MB');
    await page.getByRole('tab', { name: '用量明细' }).click();
    await expect(page.locator('.drawer-total')).toContainText('3.6');
});

test('采集状态显示真实网卡，暂停与恢复都由后端执行', async () => {
    await page.locator('.nav [data-page="settings"]').click();
    await page.locator('[data-category="status"]').click();
    await page.locator('.status-guide summary').click();await page.locator('[data-action="demo"]').click();
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
    await expect(page.getByRole('button', { name: '保存网络设置' })).toHaveCount(0);

    // 落库校验：不只看界面。
    await expect.poll(() => query("SELECT alias || '|' || cap_gb FROM networks WHERE alias <> ''")).toBe('书房 Wi-Fi|8.0');
    await expect(page.locator('#networkSaveStatus')).toHaveAttribute('data-state', 'saved');
    await page.getByRole('tab', { name: '用量明细' }).click();
    await expect(page.locator('.drawer h2')).toHaveText('书房 Wi-Fi');

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
    await page.locator('[data-category="data"]').click();
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
        await launch({ HOME: fakeHome, WIFIMETER_TEST_HOME: fakeHome });
    }

    await navigate('设置');
    await page.getByRole('checkbox', { name: '开机自启', exact: true }).check();

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
    await page.getByRole('checkbox', { name: '开机自启', exact: true }).uncheck();
    await expect.poll(enabled, { timeout: 10000 }).toBe(false);
});

test('偏好设置会落库并影响后端行为', async () => {
    await navigate('设置');
    await page.locator('[data-category="data"]').click();
    await page.locator('select[name="retention"]').selectOption('30');
    await expect(page.locator('.modal')).toContainText('缩短保留期');
    expect(query('SELECT retention_days FROM settings')).not.toBe('30');
    await page.locator('.modal').getByRole('button', { name: '取消', exact: true }).click();
    await expect(page.locator('select[name="retention"]')).not.toHaveValue('30');
    await page.locator('select[name="retention"]').selectOption('30');
    await page.locator('.modal [data-action="confirm"]').click();
    await expect.poll(() => query('SELECT retention_days FROM settings')).toBe('30');

    await page.locator('[data-category="general"]').click();
    await page.locator('select[name="interval"]').selectOption('10');
    await expect.poll(() => query('SELECT interval_seconds FROM settings')).toBe('10');
    await expect(page.locator('#settingsForm')).not.toHaveAttribute('data-busy', 'true');

    // 单位换算立刻反映在界面上。
    await page.locator('[data-category="display"]').click();
    await page.locator('select[name="unit"]').selectOption('GiB');
    await expect.poll(() => query('SELECT unit FROM settings')).toBe('GiB');
    await expect(page.locator('#settingsForm')).not.toHaveAttribute('data-busy', 'true');
    await navigate('总览');
    await expect(page.locator('.metric.featured')).toContainText('GiB');
    await app.close();
    await launch();
    await expect(page.locator('.metric.featured')).toContainText('GiB');
    await navigate('设置');
    await page.locator('[data-category="display"]').click();
    await expect(page.getByRole('combobox', { name: '流量单位进制' })).toHaveValue('GiB');
});
