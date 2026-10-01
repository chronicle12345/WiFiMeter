'use strict';
// Measures an isolated synthetic profile; never opens the user's database.
const path = require('node:path');
const fs = require('node:fs/promises');
const { pathToFileURL } = require('node:url');
async function main() {
    const root = path.resolve(__dirname, '..');
    const { _electron } = require(require.resolve('@playwright/test', { paths: [path.join(root, 'apps/desktop')] }));
    const { createHarness } = await import(pathToFileURL(path.join(root, 'apps/desktop/tests/support/backend-harness.mjs')));
    const harness = await createHarness();
    let application;
    try {
        const env = { ...process.env, ...harness.env }; delete env.ELECTRON_RUN_AS_NODE;
        application = await _electron.launch({ args: [path.join(root, 'apps/desktop')], env });
        const page = await application.firstWindow();
        await page.locator('h1').waitFor();
        await page.waitForTimeout(3000);
        const sample = () => application.evaluate(({ app }) => app.getAppMetrics().map(item => ({
            type: item.type, cpuPercent: item.cpu.percentCPUUsage, workingSetKB: item.memory.workingSetSize,
            peakWorkingSetKB: item.memory.peakWorkingSetSize
        })));
        await sample(); await page.waitForTimeout(5000);
        const visible = await sample();
        await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].hide());
        await page.waitForTimeout(5000);
        const hidden = await sample();
        const result = { scope: 'Electron process tree with synthetic local data; excludes the native backend', visible, hidden };
        const output = path.join(root, 'artifacts', 'runtime-metrics.json');
        await fs.mkdir(path.dirname(output), { recursive: true });
        await fs.writeFile(output, JSON.stringify(result, null, 2));
        console.log(JSON.stringify(result, null, 2));
    } finally { if (application) await application.close(); harness.cleanup(); }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
