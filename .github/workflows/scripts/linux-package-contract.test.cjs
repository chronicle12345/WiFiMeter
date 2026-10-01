const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { createRequire } = require('node:module');
const appRequire = createRequire(path.resolve(__dirname, '../../../apps/desktop/package.json'));
const FpmTarget = appRequire('app-builder-lib/out/targets/FpmTarget').default;
const { PlatformPackager } = appRequire('app-builder-lib/out/platformPackager');
const { Arch } = appRequire('builder-util');
const config = require('../../../packaging/linux/electron-builder.cjs');
const metadata = require('../../../apps/desktop/package.json');
const { expectedFiles } = require('./ci.cjs');

function packager() {
    const value = Object.create(PlatformPackager.prototype);
    Object.defineProperties(value, {
        config: { value: config },
        platformSpecificBuildOptions: { value: config.linux },
        appInfo: { value: { productName: 'WiFiMeter', productFilename: 'WiFiMeter', sanitizedProductName: 'WiFiMeter', version: metadata.version, linuxPackageName: metadata.name, computePackageUrl: async () => metadata.homepage } },
        platform: { value: { buildConfigurationKey: 'linux' } },
        info: { value: { metadata } }
    });
    return value;
}
test('real RPM builder accepts public maintainer metadata', async () => {
    const target = Object.create(FpmTarget.prototype);
    target.packager = packager();
    target.options = { ...config.linux, ...config.rpm };
    const value = await target.computeFpmMetaInfoOptions();
    assert.match(value.maintainer, /@users\.noreply\.github\.com>/);
    assert.match(value.url, /^https:\/\/github.com\/chronicle12345\/WiFiMeter$/);
});
test('release manifest names equal actual electron-builder macro expansion for both Linux architectures', () => {
    for (const arch of ['x64', 'arm64']) {
        const value = packager();
        const actual = ['rpm', 'AppImage'].map(ext => value.expandArtifactNamePattern({ ...config.linux, ...(config[ext] || {}) }, ext, Arch[arch]));
        assert.deepEqual(expectedFiles('linux', arch, metadata.version).slice(1), actual);
    }
});

test('failed build remains failed after cleanup listeners change the exit code', () => {
    const { EventEmitter } = require('node:events');
    const { reportBuildFailure } = require('../../../packaging/build-failure.cjs');
    const runtime = new EventEmitter();
    runtime.on('exit', () => { runtime.exitCode = 0; });
    const logs = [];
    reportBuildFailure(Error('package failed'), runtime, value => logs.push(value));
    assert.equal(runtime.exitCode, 1);
    runtime.emit('exit');
    assert.equal(runtime.exitCode, 1);
    assert.match(logs[0], /package failed/);
});
