'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { test } = require('node:test');
const verification = require('./verify-windows.cjs');

function temporary(t) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'wifimeter-package-verify-'));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    return directory;
}

function binary(platform, arch, suffix = '') {
    const bytes = Buffer.alloc(256);
    if (platform === 'win32') {
        bytes.write('MZ');
        bytes.writeUInt32LE(128, 0x3c);
        bytes.write('PE\0\0', 128);
        bytes.writeUInt16LE({ x64: 0x8664, ia32: 0x14c, arm64: 0xaa64 }[arch], 132);
    } else {
        bytes.write('\x7fELF', 'binary');
        bytes[4] = 2;
        bytes[5] = 1;
        bytes.writeUInt16LE({ x64: 62, arm64: 183 }[arch], 18);
    }
    return Buffer.concat([bytes, Buffer.from(suffix)]);
}

test('the packaged executable may differ only at the Tauri bundle marker', async t => {
    assert.equal(typeof verification.compareExecutable, 'function');
    const directory = temporary(t);
    const reference = path.join(directory, 'built.exe');
    const actual = path.join(directory, 'packaged.exe');
    fs.writeFileSync(reference, binary('win32', 'x64', '__TAURI_BUNDLE_TYPE_VAR_UNK'));
    fs.writeFileSync(actual, binary('win32', 'x64', '__TAURI_BUNDLE_TYPE_VAR_NSS'));
    await verification.compareExecutable(reference, actual, 'NSS');
    const corrupted = fs.readFileSync(actual);
    corrupted[230] = 7;
    fs.writeFileSync(actual, corrupted);
    await assert.rejects(verification.compareExecutable(reference, actual, 'NSS'), /executable differs/i);
    fs.writeFileSync(actual, binary('win32', 'x64', '__TAURI_BUNDLE_TYPE_VAR_UNK'));
    await assert.rejects(verification.compareExecutable(reference, actual, 'NSS'), /executable differs/i);
});

test('missing, changed and extra runtime resources fail package verification', async t => {
    assert.equal(typeof verification.compareResources, 'function');
    const directory = temporary(t);
    const reference = path.join(directory, 'prepared');
    const actual = path.join(directory, 'packaged');
    fs.mkdirSync(path.join(reference, 'runtime'), { recursive: true });
    fs.writeFileSync(path.join(reference, 'runtime/host.cjs'), 'verified desktop worker');
    fs.cpSync(reference, actual, { recursive: true });
    assert.equal(await verification.compareResources(reference, actual), 1);
    fs.writeFileSync(path.join(actual, 'runtime/host.cjs'), 'corrupted worker');
    await assert.rejects(verification.compareResources(reference, actual), /resource differs/i);
    fs.copyFileSync(path.join(reference, 'runtime/host.cjs'), path.join(actual, 'runtime/host.cjs'));
    fs.writeFileSync(path.join(actual, 'unexpected'), 'not prepared');
    await assert.rejects(verification.compareResources(reference, actual), /exactly the prepared/i);
    fs.rmSync(path.join(actual, 'unexpected'));
    fs.rmSync(path.join(actual, 'runtime/host.cjs'));
    await assert.rejects(verification.compareResources(reference, actual), /exactly the prepared/i);
});

test('AppImage verification compares the final deployment binary after ELF processing', async t => {
    const directory = temporary(t);
    const reference = path.join(directory, 'deployed');
    const actual = path.join(directory, 'extracted');
    fs.writeFileSync(reference, binary('linux', 'x64', '__TAURI_BUNDLE_TYPE_VAR_APP'));
    fs.copyFileSync(reference, actual);
    await verification.compareExecutable(reference, actual, 'APP', { bundledReference: true });
    fs.writeFileSync(actual, binary('linux', 'arm64', '__TAURI_BUNDLE_TYPE_VAR_APP'));
    await assert.rejects(verification.compareExecutable(reference, actual, 'APP', { bundledReference: true }), /executable differs/i);
    fs.writeFileSync(reference, binary('linux', 'x64', '__TAURI_BUNDLE_TYPE_VAR_DEB'));
    fs.copyFileSync(reference, actual);
    await assert.rejects(verification.compareExecutable(reference, actual, 'APP', { bundledReference: true }), /AppImage marker/i);
});

test('a Cargo executable already marked for its package must match every packaged byte', async t => {
    const directory = temporary(t);
    const reference = path.join(directory, 'built');
    const actual = path.join(directory, 'packaged');
    fs.writeFileSync(reference, binary('win32', 'arm64', '__TAURI_BUNDLE_TYPE_VAR_NSS'));
    fs.copyFileSync(reference, actual);
    await verification.compareExecutable(reference, actual, 'NSS');
    const corrupted = fs.readFileSync(actual);
    corrupted[230] = 7;
    fs.writeFileSync(actual, corrupted);
    await assert.rejects(verification.compareExecutable(reference, actual, 'NSS'), /executable differs/i);
    fs.writeFileSync(reference, binary('linux', 'arm64', '__TAURI_BUNDLE_TYPE_VAR_DEB'));
    fs.copyFileSync(reference, actual);
    await assert.rejects(verification.compareExecutable(reference, actual, 'RPM'), /package marker/i);
});

test('AppImage permits native ELF deployment changes but preserves every resource in the final package', async t => {
    const linux = require('./verify-linux.cjs');
    assert.equal(typeof linux.compareAppImageResources, 'function');
    const directory = temporary(t);
    const prepared = path.join(directory, 'prepared');
    const deployed = path.join(directory, 'deployed');
    const actual = path.join(directory, 'actual');
    fs.mkdirSync(path.join(prepared, 'runtime'), { recursive: true });
    fs.writeFileSync(path.join(prepared, 'runtime/node'), binary('linux', 'x64', 'original ELF'));
    fs.writeFileSync(path.join(prepared, 'runtime/host.cjs'), 'verified worker');
    fs.cpSync(prepared, deployed, { recursive: true });
    fs.writeFileSync(path.join(deployed, 'runtime/node'), binary('linux', 'x64', 'deployed ELF rpath'));
    fs.cpSync(deployed, actual, { recursive: true });
    assert.equal(await linux.compareAppImageResources(prepared, deployed, actual), 2);
    fs.writeFileSync(path.join(actual, 'runtime/node'), binary('linux', 'x64', 'different ELF'));
    await assert.rejects(linux.compareAppImageResources(prepared, deployed, actual), /resource differs/i);
    fs.cpSync(deployed, actual, { recursive: true });
    fs.writeFileSync(path.join(deployed, 'runtime/host.cjs'), 'changed worker');
    fs.copyFileSync(path.join(deployed, 'runtime/host.cjs'), path.join(actual, 'runtime/host.cjs'));
    await assert.rejects(linux.compareAppImageResources(prepared, deployed, actual), /prepared resource differs/i);
});

test('runtime verification rejects a worker with a different architecture', async t => {
    assert.equal(typeof verification.verifyRuntime, 'function');
    const directory = temporary(t);
    const executable = path.join(directory, 'wifimeter');
    const resources = path.join(directory, 'resources');
    fs.mkdirSync(path.join(resources, 'runtime'), { recursive: true });
    fs.writeFileSync(executable, binary('linux', 'arm64'), { mode: 0o755 });
    for (const file of ['wifimeter-backend', 'wifimeter-app-capture', 'runtime/node']) {
        fs.writeFileSync(path.join(resources, file), binary('linux', 'arm64'), { mode: 0o755 });
    }
    fs.writeFileSync(path.join(resources, 'runtime-manifest.json'), JSON.stringify({ version: '1.3.0', platform: 'linux', arch: 'arm64' }));
    verification.verifyRuntime(executable, resources, { platform: 'linux', arch: 'arm64', version: '1.3.0' });
    fs.writeFileSync(path.join(resources, 'runtime/node'), binary('linux', 'x64'));
    assert.throws(() => verification.verifyRuntime(executable, resources, { platform: 'linux', arch: 'arm64', version: '1.3.0' }), /架构不匹配/);
});

test('verification resolves explicit Cargo targets and refuses unrelated targets', t => {
    assert.equal(typeof verification.verificationOptions, 'function');
    const root = temporary(t);
    const options = verification.verificationOptions(['--arch', 'ia32', '--target', 'i686-pc-windows-msvc'], { root, platform: 'win32', arch: 'x64', env: {} });
    assert.equal(options.directory, path.join(root, 'dist/windows-ia32'));
    assert.equal(options.release, path.join(root, 'apps/desktop/src-tauri/target/i686-pc-windows-msvc/release'));
    assert.throws(() => verification.verificationOptions(['--arch', 'ia32', '--target', 'x86_64-pc-windows-msvc'], { root, platform: 'win32', arch: 'x64', env: {} }), /target.*architecture/i);
    assert.throws(() => verification.verificationOptions(['--arch', 'ia32'], { root, platform: 'linux', arch: 'x64', env: {} }), /architecture/i);
});

test('Linux package layout preserves the configured product name in the native resource directory', t => {
    const linux = fs.existsSync(path.join(__dirname, 'verify-linux.cjs')) ? require('./verify-linux.cjs') : {};
    assert.equal(typeof linux.packageLayout, 'function');
    const directory = temporary(t);
    fs.mkdirSync(path.join(directory, 'usr/bin'), { recursive: true });
    fs.mkdirSync(path.join(directory, 'usr/lib/WiFiMeter/resources'), { recursive: true });
    fs.writeFileSync(path.join(directory, 'usr/bin/wifimeter'), binary('linux', 'x64'));
    const layout = linux.packageLayout(directory);
    assert.equal(layout.executable, path.join(directory, 'usr/bin/wifimeter'));
    assert.equal(layout.resources, path.join(directory, 'usr/lib/WiFiMeter/resources'));
    fs.rmSync(layout.resources, { recursive: true });
    fs.mkdirSync(path.join(directory, 'usr/lib/unrelated/resources'), { recursive: true });
    assert.throws(() => linux.packageLayout(directory), /runtime resources/i);
});

test('Linux entry point checks each Debian package against the release version before extracting it', async t => {
    const directory = temporary(t);
    const filename = path.join(__dirname, 'verify-linux.cjs');
    const localRequire = createRequire(filename);
    const version = '1.3.1';
    for (const arch of ['x64', 'arm64']) {
        for (const packageVersion of [version, '1.3.0']) {
            const extracted = Object.assign(new Error('Package metadata accepted; stop before native extraction.'), { status: 37 });
            let extractionRequested = false;
            const queries = [];
            const module = { exports: {} };
            const require = name => {
                if (name === 'node:child_process') return {
                    execFileSync(command, args) {
                        assert.equal(command, 'dpkg-deb');
                        if (args[0] === '--extract') {
                            extractionRequested = true;
                            throw extracted;
                        }
                        assert.equal(args[0], '--field');
                        queries.push(args[2]);
                        return args[2] === 'Architecture' ? (arch === 'x64' ? 'amd64\n' : 'arm64\n') : `${packageVersion}\n`;
                    }
                };
                if (name === './release.cjs') return {
                    readMetadata: () => ({ version }),
                    validateAssets: async () => ['deb', 'rpm', 'AppImage'].map(format => path.join(directory, `WiFiMeter.${format}`))
                };
                if (name === './verify-common.cjs') return {
                    ...verification, root: directory,
                    verificationOptions: args => verification.verificationOptions(args, { root: directory, platform: 'linux', arch, env: {} })
                };
                return localRequire(name);
            };
            vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
                module, require, console, process: { platform: 'linux', arch }
            }, { filename });
            await assert.rejects(module.exports.main(['--arch', arch]), error => {
                if (packageVersion === version) return extractionRequested && /dpkg-deb exited unsuccessfully.*status=37/.test(error.message);
                return !extractionRequested && error.code === 'ERR_ASSERTION' && error.actual === packageVersion && error.expected === version;
            });
            assert.deepEqual(queries, ['Architecture', 'Version']);
        }
    }
});
