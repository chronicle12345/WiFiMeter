import { test, expect } from '@playwright/test';
import { desktop } from './support/browser-desktop.mjs';
import { createHarness } from './support/backend-harness.mjs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

let app, page, harness;
const snapshot = () => page.evaluate(async () => (await window.desktop.backend.request('snapshot')).result);

async function launch() {
    app = await desktop.launch({ env: { ...process.env, ...harness.env, WIFIMETER_BACKGROUND_TEST: '1' } });
    page = await app.firstWindow();
    await expect(page.locator('.connection-title')).toContainText('家里的 Wi-Fi');
}

test.beforeEach(async () => { app = null; harness = await createHarness(); await launch(); });
test.afterEach(async () => { if (app) await app.close(); harness?.cleanup(); app = null; });

test('custom 0.25 second sampling emits distinct milliseconds and drives a rolling rate curve with speed tooltips', async ({}, testInfo) => {
    await page.evaluate(() => {
        window.__sampleTimes = [];
        window.__unavailableSamples = [];
        window.desktop.backend.onEvent(message => {
            if (message.event !== 'live') return;
            window.__sampleTimes.push(message.updatedAt);
            if (message.connections?.some(connection => connection.measurementAvailable === false)) window.__unavailableSamples.push(message);
        });
    });
    await page.locator('.nav [data-page="settings"]').click();
    await page.locator('[name="interval"]').fill('0.25');
    await page.locator('[name="interval"]').blur();
    await expect.poll(async () => (await snapshot()).settings.interval).toBe(0.25);
    await page.locator('[data-category="display"]').click();
    await page.locator('[name="speedUnit"]').selectOption('Mbps');
    await expect.poll(async () => (await snapshot()).settings.speedUnit).toBe('Mbps');
    await page.locator('.nav [data-page="overview"]').click();
    await page.locator('[data-action="period"][data-value="recent"]').click();
    await expect(page.locator('.traffic-chart-line[data-chart-mode="speed"]')).toBeVisible();
    await expect.poll(() => page.evaluate(() => window.__sampleTimes.length)).toBeGreaterThan(3);
    const times = await page.evaluate(() => window.__sampleTimes);
    expect(times.every(value => /\.\d{3}Z$/.test(value))).toBe(true);
    const intervals = times.slice(1).map((value, index) => Date.parse(value) - Date.parse(times[index]));
    expect(intervals.some(value => value > 0 && value < 1000)).toBe(true);
    harness.slowDownCounters(5000000 + harness.seedRx + 500000, 900000 + harness.seedTx + 100000);
    await expect.poll(() => page.locator('[data-chart-point][data-missing="0"]').evaluateAll(points => points.some(point => BigInt(point.dataset.rx) > 0n))).toBe(true);
    const measured = page.locator('[data-chart-point][data-missing="0"]').filter({ has: page.locator('.traffic-marker') });
    const firstCount = await page.locator('[data-chart-point]').count();
    await expect.poll(() => page.locator('[data-chart-point]').count()).toBeGreaterThan(firstCount);
    const point = measured.last();
    await point.focus();
    await expect(page.locator('#tooltip')).toBeVisible();
    await expect(page.locator('#tooltip')).toContainText('Mbps');
    await expect(page.locator('#recentMetricsRegion')).toContainText('按速率估算');
    await page.locator('.toolbar').click({ position: { x: 2, y: 2 } });
    await page.screenshot({ path: testInfo.outputPath('recent-rate-curve.png'), fullPage: true });
    const file = path.join(harness.directory, 'recent-rates.csv');
    await app.evaluate(({ dialog }, file) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath: file }); }, file);
    await page.locator('.toolbar [data-action="export"]').click();
    await expect.poll(async () => { try { return await readFile(file, 'utf8'); } catch { return ''; } }).toContain('下载字节每秒');
    expect(await readFile(file, 'utf8')).toContain('本机采样');
    const missingBeforeReset = await page.locator('[data-chart-point][data-missing="1"]').count();
    await page.evaluate(() => { window.__unavailableSamples = []; });
    harness.slowDownCounters(100, 10);
    await expect.poll(() => page.evaluate(() => window.__unavailableSamples.length)).toBeGreaterThan(0);
    const unavailable = await page.evaluate(() => window.__unavailableSamples.flatMap(sample => sample.connections).filter(connection => connection.measurementAvailable === false));
    expect(unavailable.every(connection => connection.rxPerSecond === null && connection.txPerSecond === null)).toBe(true);
    await expect.poll(() => page.locator('[data-chart-point][data-missing="1"]').count()).toBeGreaterThan(missingBeforeReset);
});

test('line charts are the default and a saved bar preference survives a real host restart', async ({}, testInfo) => {
    await expect(page.locator('.traffic-chart-line')).toBeVisible();
    await page.locator('.nav [data-page="settings"]').click();
    await page.locator('[data-category="display"]').click();
    await expect(page.locator('[name="chartStyle"]')).toHaveValue('line');
    await page.locator('[name="chartStyle"]').selectOption('bar');
    await expect.poll(() => page.evaluate(() => window.desktop.windowPreferences.read())).toMatchObject({ chartStyle: 'bar' });
    await page.locator('.nav [data-page="overview"]').click();
    await expect(page.locator('.traffic-chart-bar')).toBeVisible();
    await expect(page.locator('.bar-rx')).not.toHaveCount(0);
    await page.screenshot({ path: testInfo.outputPath('retained-bar-chart.png'), fullPage: true });
    await app.close(); app = null; await launch();
    await expect(page.locator('.traffic-chart-bar')).toBeVisible();
    await page.locator('.nav [data-page="settings"]').click();
    await page.locator('[data-category="display"]').click();
    await expect(page.locator('[name="chartStyle"]')).toHaveValue('bar');
    await expect(page.locator('[name="interval"]')).toHaveAttribute('min', '0.25');
});
