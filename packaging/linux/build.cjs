'use strict';

const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { buildOptions, buildPaths, checkBackend, packagingConfig } = require('../targets.cjs');

async function main() {
    const options = buildOptions('linux', process.argv.slice(2));
    const root = path.resolve(__dirname, '../..');
    const appDir = path.join(root, 'apps/desktop');
    const paths = buildPaths('linux', options.arch);
    if (!options.skipRebuild) require('../build-backend.cjs').buildBackend({ arch: options.arch, linuxAppCapture: true });
    const backendDirectory = path.join(root, paths.backend, 'app');
    checkBackend(backendDirectory, 'linux', options.arch);
    const dependencies = execFileSync('readelf', ['-d', path.join(backendDirectory, 'wifimeter-app-capture')], { encoding: 'utf8' });
    if (dependencies.includes('libbpf.so.')) throw new Error('采集辅助进程应静态链接 libbpf。');
    const { build, Platform, Arch } = require(require.resolve('electron-builder', { paths: [appDir] }));
    const targets = options.formats.filter(format => format !== 'deb');
    if (options.formats.includes('deb') && !targets.includes('dir')) targets.push('dir');
    await build({
        projectDir: appDir,
        config: packagingConfig(options),
        targets: Platform.LINUX.createTarget(targets, Arch[options.arch]),
        publish: 'never'
    });
    if (options.formats.includes('deb')) {
        execFileSync(process.execPath, [path.join(__dirname, 'build-deb.mjs'), '--arch', options.arch], { stdio: 'inherit' });
    }
}

main().catch(error => require('../build-failure.cjs').reportBuildFailure(error));
