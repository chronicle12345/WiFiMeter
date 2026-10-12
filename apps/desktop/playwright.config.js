import { defineConfig } from '@playwright/test';
import { fileURLToPath } from 'node:url';
process.env.WIFIMETER_BACKGROUND_TEST = '1';
export default defineConfig({
    testDir: './tests', testMatch: '**/*.spec.js',
    fullyParallel: true,
    outputDir: fileURLToPath(new URL('../../del/playwright/test-results/', import.meta.url)),
    workers: 1, timeout: 60000, reporter: 'list',
    use: { trace: 'retain-on-failure' }
});
