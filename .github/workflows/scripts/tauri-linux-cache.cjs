'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { assertArchitecture } = require('../../../packaging/targets.cjs');

const driverVersion = '2.0.5';
const libbpfVersion = '1.3.3';
const libbpfSha256 = 'cfb8bcb2aa7d8645c69a093841a4e5ed483855bf7e403c27054da2c15bc7bbde';
const driverManifest = 'wifimeter-driver-cache.json';
const targets = { x64: 'x86_64-unknown-linux-gnu', arm64: 'aarch64-unknown-linux-gnu' };
const digest = value => createHash('sha256').update(value).digest('hex');

function execute(executable, args, options = {}) {
    return execFileSync(executable, args, { encoding: 'utf8', timeout: 30000, stdio: 'pipe', windowsHide: true, ...options });
}

function ownedDirectory(directory, temporaryDirectory = process.env.RUNNER_TEMP, allowFinalSymlink = false) {
    assert.ok(temporaryDirectory, 'RUNNER_TEMP is required for dependency caches.');
    const temporary = fs.realpathSync(temporaryDirectory), target = path.resolve(directory);
    const relative = path.relative(temporary, target);
    assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative), 'Dependency cache must stay inside RUNNER_TEMP.');
    let current = temporary;
    for (const segment of relative.split(path.sep)) {
        current = path.join(current, segment);
        if (fs.existsSync(current) && !(allowFinalSymlink && current === target)) assert.ok(!fs.lstatSync(current).isSymbolicLink(), 'Dependency cache cannot use symbolic links.');
    }
    return target;
}

function archiveDirectory(directory, { temporaryDirectory = process.env.RUNNER_TEMP } = {}) {
    const target = ownedDirectory(directory, temporaryDirectory, true);
    if (!fs.existsSync(target)) return;
    const archive = ownedDirectory(path.join(temporaryDirectory, 'tauri-rejected-dependency-caches'), temporaryDirectory);
    fs.mkdirSync(archive, { recursive: true });
    const destination = path.join(archive, `${path.basename(target)}-${randomUUID()}`);
    for (let attempt = 0; ; attempt++) {
        try { fs.renameSync(target, destination); break; }
        catch (error) {
            if (process.platform !== 'win32' || !['EPERM', 'EACCES', 'EBUSY'].includes(error.code) || attempt >= 9) throw error;
            // Local Windows fixtures can briefly retain a handle after inspecting an executable.
            Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
        }
    }
}

function metadata({ arch = process.arch, temporaryDirectory = process.env.RUNNER_TEMP, run = execute } = {}) {
    assert.ok(targets[arch], 'Linux dependency cache architecture must be x64 or arm64.');
    const baseline = String(run('lsb_release', ['--release', '--short'])).trim();
    assert.equal(baseline, '22.04', 'Linux dependencies must use the Ubuntu 22.04 compatibility baseline.');
    const toolchain = [
        ['gcc', ['-dumpmachine']], ['gcc', ['-dumpfullversion', '-dumpversion']], ['gcc', ['--version']],
        ['ld', ['--version']], ['ar', ['--version']], ['pkg-config', ['--modversion', 'libelf', 'zlib']]
    ].map(([command, args]) => [command, args, String(run(command, args)).trim()]);
    return {
        driver_version: driverVersion, driver_directory: ownedDirectory(path.join(temporaryDirectory, 'tauri-driver-cache'), temporaryDirectory),
        libbpf_version: libbpfVersion, libbpf_sha256: libbpfSha256, libbpf_toolchain: digest(JSON.stringify(toolchain)),
        libbpf_baseline: baseline, libbpf_directory: ownedDirectory(path.join(temporaryDirectory, 'tauri-native-deps/install'), temporaryDirectory)
    };
}

function driverReceipt(directory, arch, temporaryDirectory) {
    const receipt = JSON.parse(fs.readFileSync(ownedDirectory(path.join(directory, '.crates2.json'), temporaryDirectory), 'utf8'));
    const entries = Object.entries(receipt.installs || {}).filter(([name]) => name.startsWith('tauri-driver '));
    assert.equal(entries.length, 1, 'Driver cache must contain one Cargo installation receipt.');
    const [name, installed] = entries[0];
    assert.equal(name, `tauri-driver ${driverVersion} (registry+https://github.com/rust-lang/crates.io-index)`, 'Driver Cargo version or registry does not match.');
    assert.equal(installed.target, targets[arch], 'Driver Cargo target does not match the runner.');
    assert.deepEqual(installed.bins, ['tauri-driver'], 'Driver Cargo receipt is missing its executable.');
}

function verifyDriver(directory, { arch = process.arch, temporaryDirectory = process.env.RUNNER_TEMP, run = execute, requireManifest = true } = {}) {
    const target = ownedDirectory(directory, temporaryDirectory);
    assert.ok(targets[arch], 'Unsupported driver cache architecture.');
    driverReceipt(target, arch, temporaryDirectory);
    const executable = ownedDirectory(path.join(target, 'bin/tauri-driver'), temporaryDirectory);
    assert.ok(fs.lstatSync(executable).isFile() && !fs.lstatSync(executable).isSymbolicLink(), 'Driver cache executable must be a regular file.');
    assertArchitecture(executable, 'linux', arch);
    const sha256 = digest(fs.readFileSync(executable));
    if (requireManifest) {
        const manifest = JSON.parse(fs.readFileSync(ownedDirectory(path.join(target, driverManifest), temporaryDirectory), 'utf8'));
        assert.deepEqual(manifest, { version: driverVersion, arch, sha256 }, 'Driver cache manifest does not match the installed executable.');
    }
    // The official 2.0.5 CLI supports --help but rejects --version. Cargo records the pinned version.
    // https://docs.rs/crate/tauri-driver/2.0.5/source/src/cli.rs
    const help = String(run(executable, ['--help']));
    assert.match(help, /USAGE:\s*tauri-driver/);
    assert.match(help, /--native-port/);
    return { executable, manifest: { version: driverVersion, arch, sha256 } };
}

function ensureDriver(directory, options = {}) {
    const run = options.run || execute;
    try {
        const verified = verifyDriver(directory, { ...options, run });
        return { ...verified, cacheHit: true };
    } catch {
        archiveDirectory(directory, options);
    }
    const target = ownedDirectory(directory, options.temporaryDirectory);
    run('cargo', ['install', 'tauri-driver', '--version', `=${driverVersion}`, '--locked', '--root', target], { timeout: 20 * 60 * 1000, stdio: 'inherit' });
    const verified = verifyDriver(target, { ...options, run, requireManifest: false });
    fs.writeFileSync(path.join(target, driverManifest), JSON.stringify(verified.manifest) + '\n');
    return { ...verified, cacheHit: false };
}

const libbpfProbe = `#include <bpf/libbpf.h>
#include <bpf/libbpf_version.h>
_Static_assert(LIBBPF_MAJOR_VERSION == 1 && LIBBPF_MINOR_VERSION == 3, "Unexpected libbpf headers");
int main(void) {
    if (libbpf_major_version() != LIBBPF_MAJOR_VERSION || libbpf_minor_version() != LIBBPF_MINOR_VERSION) return 1;
    struct bpf_object_open_opts options = { .sz = sizeof(options) };
    const char invalid_elf[] = "cache ABI probe";
    struct bpf_object *object = bpf_object__open_mem(invalid_elf, sizeof(invalid_elf), &options);
    if (object) { bpf_object__close(object); return 2; }
    return 0;
}
`;

function verifyLibbpf(directory, { arch = process.arch, temporaryDirectory = process.env.RUNNER_TEMP, run = execute } = {}) {
    const target = ownedDirectory(directory, temporaryDirectory);
    assert.ok(targets[arch], 'Unsupported libbpf cache architecture.');
    const include = path.join(target, 'usr/include'), library = path.join(target, 'usr/lib/libbpf.a');
    for (const file of [path.join(include, 'bpf/libbpf.h'), path.join(include, 'bpf/libbpf_version.h'), library]) {
        ownedDirectory(file, temporaryDirectory);
        assert.ok(fs.existsSync(file) && fs.lstatSync(file).isFile() && !fs.lstatSync(file).isSymbolicLink(), 'libbpf cache is incomplete.');
    }
    assert.equal(fs.readFileSync(library).subarray(0, 8).toString(), '!<arch>\n', 'libbpf cache must contain a static archive.');
    const probe = ownedDirectory(path.join(temporaryDirectory, 'tauri-libbpf-probes'), temporaryDirectory);
    fs.mkdirSync(probe, { recursive: true });
    const source = path.join(probe, `probe-${randomUUID()}.c`), executable = source.slice(0, -2);
    fs.writeFileSync(source, libbpfProbe);
    run('gcc', ['-Werror', '-I', include, source, library, '-lelf', '-lz', '-o', executable]);
    assertArchitecture(executable, 'linux', arch);
    run(executable, []);
    return { include, library };
}

function appendOutputs(file, values) {
    assert.ok(file, 'GitHub output file is required.');
    for (const [name, value] of Object.entries(values)) {
        assert.ok(!/[\r\n]/.test(String(value)), 'GitHub outputs must use a single line.');
        fs.appendFileSync(file, `${name}=${value}\n`);
    }
}

function main([command, directory], env = process.env) {
    if (command === 'metadata') appendOutputs(env.GITHUB_OUTPUT, metadata());
    else if (command === 'archive') archiveDirectory(directory);
    else if (command === 'libbpf') {
        verifyLibbpf(directory);
        console.log(`Verified libbpf ${libbpfVersion} static headers, linker symbols and runtime ABI.`);
    } else if (command === 'driver') {
        const verified = ensureDriver(directory);
        appendOutputs(env.GITHUB_ENV, { WIFIMETER_TAURI_DRIVER: verified.executable });
        console.log(`Verified tauri-driver ${driverVersion}: ${verified.cacheHit ? 'restored cache' : 'locked installation'}.`);
    } else throw Error(`Unknown Linux dependency cache command: ${command}`);
}

module.exports = { driverVersion, libbpfVersion, libbpfSha256, driverManifest, metadata, ownedDirectory, archiveDirectory, verifyDriver, ensureDriver, libbpfProbe, verifyLibbpf, appendOutputs, main };
if (require.main === module) {
    try { main(process.argv.slice(2)); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
