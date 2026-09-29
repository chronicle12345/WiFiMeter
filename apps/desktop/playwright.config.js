import { defineConfig } from '@playwright/test';
export default defineConfig({
    testDir: './tests', testMatch: '**/*.spec.js',
    workers: 1, timeout: 60000, reporter: 'list',
    use: { trace: 'retain-on-failure' }
});
