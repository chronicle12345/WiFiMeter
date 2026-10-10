'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { assertArchitecture, buildPaths } = require('../targets.cjs');

const root = path.resolve(__dirname, '../..');
const targets = {
    win32: { x64: 'x86_64-pc-windows-msvc', ia32: 'i686-pc-windows-msvc', arm64: 'aarch64-pc-windows-msvc' },
    linux: { x64: 'x86_64-unknown-linux-gnu', arm64: 'aarch64-unknown-linux-gnu' }
};

function verificationOptions(args = [], host = { root, platform: process.platform, arch: process.arch, env: process.env }) {
    let arch = host.arch, target = null, targetDirectory = null;
    for (let index = 0; index < args.length; index += 2) {
        const name = args[index], value = args[index + 1];
        assert.ok(['--arch', '--target', '--target-directory'].includes(name) && value && !value.startsWith('--'), `Invalid package verification argument: ${name}`);
        if (name === '--arch') arch = value;
        if (name === '--target') target = value;
        if (name === '--target-directory') targetDirectory = value;
    }
    assert.ok(targets[host.platform]?.[arch], `Unsupported package verification architecture: ${host.platform}/${arch}`);
    assert.ok(!target || target === targets[host.platform][arch], 'Cargo target does not match the package architecture.');
    const appDirectory = path.join(host.root, 'apps/desktop');
    const targetRoot = path.resolve(appDirectory, targetDirectory || host.env?.CARGO_TARGET_DIR || 'src-tauri/target');
    return { arch, platform: host.platform, target, directory: path.join(host.root, buildPaths(host.platform, arch).output),
        resources: path.join(appDirectory, 'src-tauri/resources'), release: path.join(targetRoot, ...(target ? [target] : []), 'release') };
}

function filesUnder(directory, relative = '') {
    return fs.readdirSync(path.join(directory, relative), { withFileTypes: true }).flatMap(entry => {
        const file = path.join(relative, entry.name);
        assert.ok(!entry.isSymbolicLink(), `Runtime resource must not be a symbolic link: ${file}`);
        assert.ok(entry.isDirectory() || entry.isFile(), `Runtime resource is not a regular file: ${file}`);
        return entry.isDirectory() ? filesUnder(directory, file) : [file];
    }).sort();
}

async function digest(file) {
    const hash = createHash('sha256');
    for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
    return hash.digest('hex');
}

async function compareResources(reference, actual) {
    const expected = filesUnder(reference);
    assert.deepEqual(filesUnder(actual), expected, 'The package must contain exactly the prepared runtime resources.');
    for (const file of expected) {
        assert.equal(await digest(path.join(actual, file)), await digest(path.join(reference, file)), `Packaged resource differs: ${file}`);
    }
    return expected.length;
}

async function compareExecutable(reference, actual, bundleType, { bundledReference = false } = {}) {
    assert.ok(['NSS', 'DEB', 'RPM', 'APP'].includes(bundleType), 'Unsupported Tauri package marker.');
    const expected = fs.readFileSync(reference);
    if (bundledReference) {
        assert.equal(bundleType, 'APP', 'Only AppImage may use a deployment-stage reference executable.');
        assert.ok(expected.includes(Buffer.from('__TAURI_BUNDLE_TYPE_VAR_APP')), 'Deployment executable is missing its AppImage marker.');
    } else {
        const marker = Buffer.from('__TAURI_BUNDLE_TYPE_VAR_UNK');
        const offset = expected.indexOf(marker);
        if (offset >= 0) {
            assert.equal(expected.indexOf(marker, offset + 1), -1, 'Expected exactly one unmodified Tauri bundle-type marker in the Cargo release executable.');
            // Tauri writes these three bytes into each bundled copy of the Cargo executable.
            expected.write(`__TAURI_BUNDLE_TYPE_VAR_${bundleType}`, offset, 'ascii');
        } else {
            // Some bundler versions leave the Cargo binary marked after collecting the package.
            assert.ok(expected.includes(Buffer.from(`__TAURI_BUNDLE_TYPE_VAR_${bundleType}`)), 'Cargo release executable is missing the expected package marker.');
        }
    }
    const actualDigest = await digest(actual);
    assert.equal(actualDigest, createHash('sha256').update(expected).digest('hex'), 'Packaged executable differs from the Cargo release build.');
    return actualDigest;
}

function verifyRuntime(executable, resources, { platform, arch, version }) {
    const suffix = platform === 'win32' ? '.exe' : '';
    for (const file of [executable, ...['wifimeter-backend', 'wifimeter-app-capture', `runtime/${platform === 'win32' ? 'node.exe' : 'node'}`]
        .map(name => path.join(resources, name.includes('/') ? name : name + suffix))]) {
        assert.ok(fs.lstatSync(file).isFile(), `Packaged executable must be a regular file: ${file}`);
        assertArchitecture(file, platform, arch);
        if (process.platform === 'linux' && platform === 'linux') fs.accessSync(file, fs.constants.X_OK);
    }
    const manifest = JSON.parse(fs.readFileSync(path.join(resources, 'runtime-manifest.json'), 'utf8'));
    assert.equal(manifest.version, version, 'Runtime manifest version does not match the package.');
    assert.equal(manifest.platform, platform, 'Runtime manifest platform does not match the package.');
    assert.equal(manifest.arch, arch, 'Runtime manifest architecture does not match the package.');
    assert.ok(!fs.existsSync(path.join(path.dirname(executable), `electron${suffix}`)) && !fs.existsSync(path.join(resources, 'app.asar')), 'Tauri package contains the Electron runtime.');
    return manifest;
}

module.exports = { root, verificationOptions, filesUnder, digest, compareResources, compareExecutable, verifyRuntime };
