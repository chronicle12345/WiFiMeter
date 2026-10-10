'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { readMetadata, validateAssets } = require('./release.cjs');
const { assertArchitecture, binaryArchitecture } = require('../targets.cjs');
const { root, verificationOptions, filesUnder, digest, compareResources, compareExecutable, verifyRuntime } = require('./verify-common.cjs');

function run(command, args, options = {}) {
    return execFileSync(command, args, { cwd: root, stdio: 'pipe', ...options });
}

function packageLayout(directory) {
    const { productName } = JSON.parse(fs.readFileSync(path.join(root, 'apps/desktop/src-tauri/tauri.conf.json'), 'utf8'));
    const executable = path.join(directory, 'usr/bin/wifimeter');
    const resources = path.join(directory, 'usr/lib', productName, 'resources');
    assert.ok(fs.existsSync(executable) && fs.lstatSync(executable).isFile(), 'Linux package is missing the installed application executable.');
    assert.ok(fs.existsSync(resources) && fs.lstatSync(resources).isDirectory(), 'Linux package is missing its installed runtime resources.');
    return { executable, resources };
}

async function compareAppImageResources(prepared, deployed, actual) {
    const expected = filesUnder(prepared);
    assert.deepEqual(filesUnder(deployed), expected, 'AppImage deployment must contain exactly the prepared runtime resources.');
    const nativeFiles = new Set(['runtime/node', 'wifimeter-backend', 'wifimeter-app-capture']);
    for (const file of expected) {
        const source = path.join(prepared, file), target = path.join(deployed, file);
        if (nativeFiles.has(file.split(path.sep).join('/'))) {
            assert.deepEqual(binaryArchitecture(target), binaryArchitecture(source), `AppImage deployment changed the resource architecture: ${file}`);
        } else {
            assert.equal(await digest(target), await digest(source), `AppImage prepared resource differs: ${file}`);
        }
    }
    return compareResources(deployed, actual);
}

function extractPackage(archive, directory, { arch, version }) {
    fs.mkdirSync(directory, { recursive: true });
    if (archive.endsWith('.deb')) {
        const packageArch = run('dpkg-deb', ['--field', archive, 'Architecture'], { encoding: 'utf8' }).trim();
        const packageVersion = run('dpkg-deb', ['--field', archive, 'Version'], { encoding: 'utf8' }).trim();
        assert.equal(packageArch, arch === 'x64' ? 'amd64' : 'arm64', 'Debian package architecture does not match the build.');
        assert.equal(packageVersion, version, 'Debian package version does not match the build.');
        run('dpkg-deb', ['--extract', archive, directory]);
        return { ...packageLayout(directory), bundleType: 'DEB', launcher: path.join(directory, 'usr/bin/wifimeter') };
    }
    if (archive.endsWith('.rpm')) {
        const metadata = run('rpm', ['--query', '--package', '--queryformat', '%{ARCH}\n%{VERSION}\n', archive], { encoding: 'utf8' }).trim().split('\n');
        assert.deepEqual(metadata, [arch === 'x64' ? 'x86_64' : 'aarch64', version], 'RPM package architecture or version does not match the build.');
        const payload = path.join(path.dirname(directory), 'payload.cpio');
        const output = fs.openSync(payload, 'wx');
        try { run('rpm2cpio', [archive], { stdio: ['ignore', output, 'pipe'] }); }
        finally { fs.closeSync(output); }
        const input = fs.openSync(payload, 'r');
        try { run('cpio', ['--extract', '--make-directories', '--no-absolute-filenames', '--quiet'], { cwd: directory, stdio: [input, 'pipe', 'pipe'] }); }
        finally { fs.closeSync(input); fs.rmSync(payload); }
        return { ...packageLayout(directory), bundleType: 'RPM', launcher: path.join(directory, 'usr/bin/wifimeter') };
    }
    assert.ok(archive.endsWith('.AppImage'), 'Unknown Linux package format.');
    assertArchitecture(archive, 'linux', arch);
    fs.chmodSync(archive, fs.statSync(archive).mode | 0o111);
    run(archive, ['--appimage-extract'], { cwd: directory, maxBuffer: 8 * 1024 * 1024 });
    const appDirectory = path.join(directory, 'squashfs-root');
    const launcher = path.join(appDirectory, 'AppRun');
    assert.ok(fs.existsSync(launcher), 'AppImage is missing its native AppRun launcher.');
    fs.accessSync(launcher, fs.constants.X_OK);
    return { ...packageLayout(appDirectory), bundleType: 'APP', launcher };
}

async function main(args = process.argv.slice(2)) {
    assert.equal(process.platform, 'linux', 'Linux package validation requires Linux.');
    const options = verificationOptions(args);
    assert.equal(options.arch, process.arch, 'Linux package integration must run on the package architecture.');
    const { version } = readMetadata(root);
    const archives = await validateAssets(options.directory, version, { buildTree: true, platform: 'linux', arch: options.arch });
    assert.equal(archives.length, 3, 'Linux validation requires Debian, RPM and AppImage packages.');
    const build = path.join(root, 'build');
    fs.mkdirSync(build, { recursive: true });
    const output = fs.mkdtempSync(path.join(build, `tauri-package-check-linux-${options.arch}-`));
    const packages = [];
    for (const archive of archives) {
        const format = path.extname(archive).slice(1);
        const layout = extractPackage(archive, path.join(output, format), options);
        verifyRuntime(layout.executable, layout.resources, { ...options, version });
        // AppImage deployment may change ELF rpaths and strip sections after Cargo builds it.
        const bundledReference = layout.bundleType === 'APP';
        const deployed = bundledReference ? packageLayout(path.join(options.release, 'bundle/appimage/WiFiMeter.AppDir')) : null;
        const resourceCount = bundledReference
            ? await compareAppImageResources(options.resources, deployed.resources, layout.resources)
            : await compareResources(options.resources, layout.resources);
        const reference = bundledReference
            ? deployed.executable
            : path.join(options.release, 'wifimeter');
        const executableDigest = await compareExecutable(reference, layout.executable, layout.bundleType, { bundledReference });
        console.log(`PASS Linux ${options.arch} ${format}: executable and ${resourceCount} runtime resources match the ${bundledReference ? 'AppImage deployment' : 'Cargo and prepared'} build`);
        run('xvfb-run', ['-a', 'dbus-run-session', '--', process.execPath, path.join(root, 'apps/desktop/tests/tauri-smoke-linux.mjs')], {
            stdio: 'inherit', env: { ...process.env, WIFIMETER_TAURI_EXECUTABLE: layout.executable,
                WIFIMETER_TAURI_LAUNCHER: layout.launcher, WIFIMETER_TAURI_RESOURCES: layout.resources }
        });
        packages.push({ name: format, archive, bytes: fs.statSync(archive).size, executableDigest, resourceCount, nativeIntegration: true });
    }
    fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify({ version, platform: 'linux', arch: options.arch, passed: true, packages }, null, 2));
    console.log(`Linux package validation passed. Evidence: ${output}`);
    return output;
}

module.exports = { packageLayout, compareAppImageResources, extractPackage, main };
if (require.main === module) main().catch(error => { console.error(error.stack || error.message); process.exitCode = 1; });
