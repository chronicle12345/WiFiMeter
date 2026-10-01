'use strict';

// Run from the repository: node packaging/generate-icons.cjs
// Uses desktop Playwright; set PLAYWRIGHT_CHANNEL=msedge to use installed Edge.
// docs/assets/logo.svg is the read-only source for every generated icon.
const fs = require('node:fs/promises');
const path = require('node:path');
const { createRequire } = require('node:module');
const root = path.resolve(__dirname, '..');
const desktopRequire = createRequire(path.join(root, 'apps/desktop/package.json'));
const { chromium } = desktopRequire('playwright');
const sizes = [16, 24, 32, 48, 64, 128, 256];

async function main() {
    const source = await fs.readFile(path.join(root, 'docs/assets/logo.svg'));
    const assets = path.join(root, 'apps/desktop/assets');
    const browser = await chromium.launch({ headless: true, channel: process.env.PLAYWRIGHT_CHANNEL || undefined });
    try {
        const page = await browser.newPage({ deviceScaleFactor: 1 });
        await page.setContent('<style>html,body{margin:0;background:transparent}img{display:block;width:100vw;height:100vh}</style><img alt="">');
        await page.locator('img').evaluate(async (image, src) => {
            image.src = src;
            await image.decode();
        }, `data:image/svg+xml;base64,${source.toString('base64')}`);
        const images = [];
        for (const size of [...sizes, 512]) {
            await page.setViewportSize({ width: size, height: size });
            images.push(await page.screenshot({ omitBackground: true }));
        }
        // ICO directory entries point to PNG frames, supported by modern Windows.
        const directory = Buffer.alloc(6 + sizes.length * 16);
        directory.writeUInt16LE(1, 2);
        directory.writeUInt16LE(sizes.length, 4);
        let offset = directory.length;
        sizes.forEach((size, index) => {
            const entry = 6 + index * 16;
            directory[entry] = directory[entry + 1] = size === 256 ? 0 : size;
            directory.writeUInt16LE(1, entry + 4);
            directory.writeUInt16LE(32, entry + 6);
            directory.writeUInt32LE(images[index].length, entry + 8);
            directory.writeUInt32LE(offset, entry + 12);
            offset += images[index].length;
        });
        await fs.writeFile(path.join(assets, 'icon.svg'), source);
        await fs.writeFile(path.join(assets, 'icon.png'), images.pop());
        await fs.writeFile(path.join(assets, 'icon.ico'), Buffer.concat([directory, ...images]));
        console.log(`Generated icon.svg, icon.png (512), icon.ico (${sizes.join(', ')}) from docs/assets/logo.svg`);
    } finally {
        await browser.close();
    }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
