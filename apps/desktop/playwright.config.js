import { defineConfig } from '@playwright/test';
process.env.WIFIMETER_BACKGROUND_TEST = '1';
export default defineConfig({
    testDir: './tests', testMatch: '**/*.spec.js',
    workers: 1, timeout: 60000, reporter: 'list',
    use: { trace: 'retain-on-failure' }
});
