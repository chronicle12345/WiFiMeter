'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');
const root = path.resolve(__dirname, '..');
const desktopRequire = createRequire(path.join(root, 'apps/desktop/package.json'));
const assets = path.join(root, 'apps/desktop/assets');

test('Tauri uses the application ICO and PNG for native bundles', () => {
    const config = require('../apps/desktop/src-tauri/tauri.conf.json');
    assert.deepEqual(config.bundle.icon, ['../assets/icon.ico', '../assets/icon.png']);
});

test('SVG, PNG and every ICO frame match the official logo with transparent corners', async () => {
    const source = fs.readFileSync(path.join(root, 'docs/assets/logo.svg'));
    assert.deepEqual(fs.readFileSync(path.join(assets, 'icon.svg')), source);
    const ico = fs.readFileSync(path.join(assets, 'icon.ico'));
    assert.equal(ico.readUInt16LE(0), 0);
    assert.equal(ico.readUInt16LE(2), 1);
    const sizes = [16, 24, 32, 48, 64, 128, 256];
    assert.equal(ico.readUInt16LE(4), sizes.length);
    const frames = sizes.map((size, index) => {
        const entry = 6 + index * 16;
        assert.equal(ico[entry] || 256, size);
        assert.equal(ico[entry + 1] || 256, size);
        assert.equal(ico.readUInt16LE(entry + 6), 32);
        const length = ico.readUInt32LE(entry + 8);
        const offset = ico.readUInt32LE(entry + 12);
        assert.ok(offset >= 6 + sizes.length * 16 && offset + length <= ico.length);
        return { size, png: ico.subarray(offset, offset + length) };
    });
    frames.push({ size: 512, png: fs.readFileSync(path.join(assets, 'icon.png')) });
    const { chromium } = desktopRequire('playwright');
    const browser = await chromium.launch({ headless: true, channel: process.env.PLAYWRIGHT_CHANNEL || undefined });
    try {
        const page = await browser.newPage({ deviceScaleFactor: 1 });
        // 与生成器相同的 CSS 像素栅格化。
        await page.setContent('<style>html,body{margin:0;background:transparent}img{display:block;width:100vw;height:100vh}</style><img alt="">');
        await page.locator('img').evaluate(async (image, svg) => {
            image.src = `data:image/svg+xml;base64,${svg}`;
            await image.decode();
        }, source.toString('base64'));
        for (const { size, png } of frames) {
            await page.setViewportSize({ width: size, height: size });
            const reference = await page.screenshot({ omitBackground: true });
            const result = await page.evaluate(async ({ size, png, reference }) => {
                async function pixels(src) {
                    const image = new Image();
                    image.src = src;
                    await image.decode();
                    const canvas = document.createElement('canvas');
                    canvas.width = canvas.height = size;
                    const context = canvas.getContext('2d');
                    context.drawImage(image, 0, 0, size, size);
                    return { width: image.naturalWidth, height: image.naturalHeight, data: context.getImageData(0, 0, size, size).data };
                }
                const actual = await pixels(`data:image/png;base64,${png}`);
                const expected = await pixels(`data:image/png;base64,${reference}`);
                let difference = 0;
                for (let i = 0; i < actual.data.length; i += 4) {
                    // 比较实际可见颜色；完全透明像素的 RGB 以及低 alpha 边缘的反预乘舍入不影响显示。
                    for (let channel = 0; channel < 3; channel++) difference += Math.abs(
                        actual.data[i + channel] * actual.data[i + 3] / 255 - expected.data[i + channel] * expected.data[i + 3] / 255);
                    difference += Math.abs(actual.data[i + 3] - expected.data[i + 3]);
                }
                return { width: actual.width, height: actual.height, difference: difference / actual.data.length,
                    corners: [3, (size - 1) * 4 + 3, (size * (size - 1)) * 4 + 3, size * size * 4 - 1].map(i => actual.data[i]) };
            }, { size, png: png.toString('base64'), reference: reference.toString('base64') });
            assert.equal(result.width, size);
            assert.equal(result.height, size);
            assert.deepEqual(result.corners, [0, 0, 0, 0], `${size}px corners must remain transparent`);
            // 16/24px 图标的边缘占比高，允许 Windows/Linux 栅格化产生至多 4/255 的平均差异；
            // 其余尺寸保留 2/255 上限，拒绝不同配色或图案。
            const tolerance = size < 32 ? 4 : 2;
            assert.ok(result.difference < tolerance, `${size}px differs from the official SVG: ${result.difference}`);
        }
    } finally {
        await browser.close();
    }
});
