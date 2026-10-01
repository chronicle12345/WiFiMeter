'use strict';

// npm metadata 保持不变；只为 CI 的 ia32 夹具提供实际的 Electron 43 runtime。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '../../..');
const appDir = path.join(root, 'apps/desktop');
const targets = require(path.join(root, 'packaging/targets.cjs'));
const { expectedElectronVersion } = require('./ci.cjs');

(async () => {
    assert.equal(process.platform, 'win32');
    assert.equal(process.arch, 'ia32');
    const version = expectedElectronVersion('win32', 'ia32');
    assert.equal(targets.packagingConfig({ platform: 'win32', arch: 'ia32' }).electronVersion, version, '打包配置必须使用同一个 ia32 兼容版本');
    if (process.argv[2] === 'download') {
        // 使用 package-lock 锁定的官方 @electron/get，验证该版本的官方 SHASUMS256.txt。
        const { downloadArtifact } = require(require.resolve('@electron/get', { paths: [appDir] }));
        const archive = await downloadArtifact({ version, platform: 'win32', arch: 'ia32', artifactName: 'electron', cacheRoot: process.env.ELECTRON_CACHE });
        const directory = path.join(process.env.RUNNER_TEMP, `electron-${version}-ia32`);
        fs.appendFileSync(process.env.GITHUB_OUTPUT, `archive=${archive}\ndirectory=${directory}\n`);
    } else if (process.argv[2] === 'activate') {
        const directory = path.resolve(process.argv[3]);
        targets.assertArchitecture(path.join(directory, 'electron.exe'), 'win32', 'ia32');
        assert.equal(fs.readFileSync(path.join(directory, 'version'), 'utf8').trim().replace(/^v/, ''), version);
        // Electron 的 require 路径解析器会读这个生成文件，避免自动下载不存在的 44 ia32 包。
        const electronPackage = path.dirname(require.resolve('electron/package.json', { paths: [appDir] }));
        fs.writeFileSync(path.join(electronPackage, 'path.txt'), 'electron.exe');
        fs.appendFileSync(process.env.GITHUB_ENV, `ELECTRON_OVERRIDE_DIST_PATH=${directory}\n`);
    } else throw new Error('只支持 download 或 activate');
})().catch(error => { console.error(error); process.exitCode = 1; });
