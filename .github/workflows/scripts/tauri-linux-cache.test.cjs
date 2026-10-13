'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { spawnSync } = require('node:child_process');
const cache = require('./tauri-linux-cache.cjs');

const root = path.resolve(__dirname, '../../..');
function temporary() {
    const fixtures = path.join(root, 'del/ci-linux-cache-fixtures');
    fs.mkdirSync(fixtures, { recursive: true });
    return fs.mkdtempSync(path.join(fixtures, 'cache with spaces & '));
}

function elf(arch = 'x64') {
    const bytes = Buffer.alloc(256);
    bytes.write('\x7fELF', 'binary'); bytes[4] = 2; bytes[5] = 1;
    bytes.writeUInt16LE(arch === 'x64' ? 62 : 183, 18);
    return bytes;
}

function installedDriver(directory, arch = 'x64', version = cache.driverVersion) {
    const executable = path.join(directory, 'bin/tauri-driver');
    fs.mkdirSync(path.dirname(executable), { recursive: true });
    fs.writeFileSync(executable, elf(arch));
    fs.writeFileSync(path.join(directory, '.crates2.json'), JSON.stringify({ installs: {
        [`tauri-driver ${version} (registry+https://github.com/rust-lang/crates.io-index)`]: {
            bins: ['tauri-driver'], target: arch === 'x64' ? 'x86_64-unknown-linux-gnu' : 'aarch64-unknown-linux-gnu'
        }
    } }));
    const sha256 = createHash('sha256').update(fs.readFileSync(executable)).digest('hex');
    fs.writeFileSync(path.join(directory, cache.driverManifest), JSON.stringify({ version, arch, sha256 }));
    return executable;
}

function driverRunner(calls, directory, arch = 'x64') {
    return (command, args) => {
        calls.push({ command, args });
        if (command === 'cargo') { installedDriver(directory, arch); return ''; }
        assert.deepEqual(args, ['--help']);
        return 'USAGE: tauri-driver [FLAGS] [OPTIONS]\n--native-port NUMBER\n';
    };
}

test('a cold driver cache installs the exact locked version and records the executable digest', () => {
    const temporaryDirectory = temporary(), directory = path.join(temporaryDirectory, 'driver'), calls = [];
    const result = cache.ensureDriver(directory, { temporaryDirectory, run: driverRunner(calls, directory) });
    assert.equal(result.cacheHit, false);
    assert.deepEqual(calls[0], { command: 'cargo', args: ['install', 'tauri-driver', '--version', '=2.0.5', '--locked', '--root', directory] });
    assert.equal(calls.filter(call => call.command === result.executable).length, 1);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(directory, cache.driverManifest))), result.manifest);
});

test('a verified warm driver cache starts the supported help command without installing or requesting --version', () => {
    for (const arch of ['x64', 'arm64']) {
        const temporaryDirectory = temporary(), directory = path.join(temporaryDirectory, 'driver'), calls = [];
        const executable = installedDriver(directory, arch);
        const result = cache.ensureDriver(directory, { arch, temporaryDirectory, run: driverRunner(calls, directory, arch) });
        assert.equal(result.cacheHit, true);
        assert.deepEqual(calls, [{ command: executable, args: ['--help'] }]);
    }
});

test('wrong versions, wrong architectures, changed binaries and failed startup archive the driver before reinstalling', () => {
    for (const failure of ['version', 'architecture', 'digest', 'startup']) {
        const temporaryDirectory = temporary(), directory = path.join(temporaryDirectory, 'driver'), calls = [];
        const executable = installedDriver(directory, failure === 'architecture' ? 'arm64' : 'x64', failure === 'version' ? '2.0.4' : cache.driverVersion);
        if (failure === 'digest') fs.appendFileSync(executable, 'corrupted');
        const runner = driverRunner(calls, directory);
        let startupFailed = false;
        const run = (command, args) => {
            if (failure === 'startup' && command === executable && !startupFailed) { startupFailed = true; throw Error('loader failed'); }
            return runner(command, args);
        };
        const result = cache.ensureDriver(directory, { temporaryDirectory, run });
        assert.equal(result.cacheHit, false, failure);
        assert.equal(calls.filter(call => call.command === 'cargo').length, 1, failure);
        const archived = fs.readdirSync(path.join(temporaryDirectory, 'tauri-rejected-dependency-caches'));
        assert.equal(archived.length, 1, failure);
        assert.ok(fs.existsSync(path.join(temporaryDirectory, 'tauri-rejected-dependency-caches', archived[0], 'bin/tauri-driver')));
    }
});

test('a failed fresh driver installation or unsupported target cannot be accepted as a cache hit', () => {
    const temporaryDirectory = temporary(), directory = path.join(temporaryDirectory, 'driver');
    assert.throws(() => cache.ensureDriver(directory, { temporaryDirectory, run: () => { throw Error('install failed'); } }), /install failed/);
    installedDriver(directory);
    assert.throws(() => cache.verifyDriver(directory, { arch: 'ia32', temporaryDirectory }), /architecture/);
});

function installedLibbpf(directory) {
    const include = path.join(directory, 'usr/include/bpf');
    fs.mkdirSync(include, { recursive: true });
    fs.mkdirSync(path.join(directory, 'usr/lib'), { recursive: true });
    for (const file of ['libbpf.h', 'libbpf_version.h']) fs.writeFileSync(path.join(include, file), 'fixture header');
    fs.writeFileSync(path.join(directory, 'usr/lib/libbpf.a'), '!<arch>\nfixture objects');
}

test('restored libbpf headers and its static archive must compile, link and execute an ABI probe on each architecture', () => {
    for (const arch of ['x64', 'arm64']) {
        const temporaryDirectory = temporary(), directory = path.join(temporaryDirectory, 'libbpf'), calls = [];
        installedLibbpf(directory);
        const run = (command, args) => {
            calls.push({ command, args });
            if (command === 'gcc') {
                const source = fs.readFileSync(args[3], 'utf8');
                assert.match(source, /struct bpf_object_open_opts/);
                assert.match(source, /libbpf_major_version\(\)/);
                assert.match(source, /bpf_object__open_mem/);
                fs.writeFileSync(args.at(-1), elf(arch));
            }
            return '';
        };
        const result = cache.verifyLibbpf(directory, { arch, temporaryDirectory, run });
        assert.equal(result.library, path.join(directory, 'usr/lib/libbpf.a'));
        assert.ok(calls[0].args.includes('-lelf') && calls[0].args.includes('-lz'));
        assert.ok(calls[0].args.includes(result.library));
        assert.deepEqual(calls[1], { command: calls[0].args.at(-1), args: [] });
    }
});

test('a missing libbpf cache returns a normal validation failure without invoking the compiler', () => {
    const temporaryDirectory = temporary(), directory = path.join(temporaryDirectory, 'missing');
    assert.throws(() => cache.verifyLibbpf(directory, { temporaryDirectory, run: () => assert.fail('compiler must not run') }), /incomplete/);
    installedLibbpf(directory);
    fs.writeFileSync(path.join(directory, 'usr/lib/libbpf.a'), 'shared library');
    assert.throws(() => cache.verifyLibbpf(directory, { temporaryDirectory, run: () => assert.fail('compiler must not run') }), /static archive/);
});

test('unavailable linker symbols, the wrong ELF architecture and an incompatible runtime ABI reject libbpf', () => {
    for (const failure of ['link', 'architecture', 'abi']) {
        const temporaryDirectory = temporary(), directory = path.join(temporaryDirectory, 'libbpf');
        installedLibbpf(directory);
        const run = (command, args) => {
            if (command === 'gcc') {
                if (failure === 'link') throw Error('missing cached linker symbol');
                fs.writeFileSync(args.at(-1), elf(failure === 'architecture' ? 'arm64' : 'x64'));
            } else if (failure === 'abi') throw Error('ABI probe failed');
            return '';
        };
        assert.throws(() => cache.verifyLibbpf(directory, { temporaryDirectory, run }));
    }
});

test('cache metadata separates GCC, binutils and prerequisite ABI versions without interpolating paths into a shell', () => {
    const temporaryDirectory = temporary();
    const tools = { gcc: 'gcc fixture 12.3', ld: 'GNU ld fixture 2.38', ar: 'GNU ar fixture 2.38', 'pkg-config': '0.186\n1.2.11' };
    const run = command => command === 'lsb_release' ? '22.04\n' : tools[command];
    const first = cache.metadata({ temporaryDirectory, run });
    assert.equal(first.driver_version, '2.0.5');
    assert.equal(first.libbpf_sha256.length, 64);
    assert.equal(first.driver_directory, path.join(temporaryDirectory, 'tauri-driver-cache'));
    for (const command of ['gcc', 'ld', 'ar', 'pkg-config']) {
        const previous = tools[command]; tools[command] += ' changed';
        assert.notEqual(cache.metadata({ temporaryDirectory, run }).libbpf_toolchain, first.libbpf_toolchain, command);
        tools[command] = previous;
    }
    assert.throws(() => cache.metadata({ temporaryDirectory, run: () => '24.04' }), /baseline/);
});

test('cache invalidation cannot archive a runner root or a path outside its owned directory', () => {
    const temporaryDirectory = temporary();
    assert.throws(() => cache.archiveDirectory(temporaryDirectory, { temporaryDirectory }), /RUNNER_TEMP/);
    assert.throws(() => cache.archiveDirectory(path.dirname(temporaryDirectory), { temporaryDirectory }), /RUNNER_TEMP/);
    assert.throws(() => cache.ownedDirectory(path.join(temporaryDirectory, '..', 'elsewhere'), temporaryDirectory), /RUNNER_TEMP/);
    const output = path.join(temporaryDirectory, 'github-output');
    assert.throws(() => cache.appendOutputs(output, { unsafe: 'injected\noutput=value' }), /single line/);
});

function dependencyShell({ warm = false, invalid = false, badChecksum = false } = {}) {
    const temporaryDirectory = temporary();
    if (warm) fs.writeFileSync(path.join(temporaryDirectory, 'cache-ready'), 'verified fixture');
    if (invalid) {
        fs.mkdirSync(path.join(temporaryDirectory, 'tauri-native-deps/install'), { recursive: true });
        fs.writeFileSync(path.join(temporaryDirectory, 'tauri-native-deps/install/invalid'), 'retain rejected cache');
    }
    const script = path.join(temporaryDirectory, 'dependency-commands.sh');
    fs.writeFileSync(script, `#!/usr/bin/env bash
set -euo pipefail
export RUNNER_TEMP="$1" GITHUB_ENV="$1/github-env"
record() { printf '%s\n' "$1" >> "$RUNNER_TEMP/commands"; }
node() {
  if [[ "$1" == -p ]]; then
    if [[ "$2" == *libbpfVersion* ]]; then printf '1.3.3\n'; else printf '${cache.libbpfSha256}\n'; fi
    return 0
  fi
  record "node-$2"
  case "$2" in
    libbpf) [[ -f "$RUNNER_TEMP/cache-ready" ]] ;;
    archive) if [[ -d "$3" ]]; then mv "$3" "$RUNNER_TEMP/rejected-native-deps"; fi ;;
    *) return 90 ;;
  esac
}
sudo() { record forbidden-system-install; return 90; }
curl() { record curl; printf 'download fixture\n' > "$RUNNER_TEMP/tauri-native-deps/libbpf.tar.gz"; }
sha256sum() {
  record checksum
  IFS= read -r checksum
  [[ "$checksum" == '${cache.libbpfSha256}  '* && "$CHECKSUM_FAIL" == 0 ]]
}
tar() { record tar; mkdir -p "$RUNNER_TEMP/tauri-native-deps/libbpf-1.3.3/src"; }
make() { record make; mkdir -p "$RUNNER_TEMP/tauri-native-deps/install/usr/lib"; printf '!<arch>\n' > "$RUNNER_TEMP/tauri-native-deps/install/usr/lib/libbpf.a"; printf 'verified\n' > "$RUNNER_TEMP/cache-ready"; }
getconf() { printf 'glibc 2.35\n'; }
pkg-config() { printf 'fixture dependency versions\n'; }
source "$2" libbpf
`);
    const bash = process.env.WIFIMETER_TEST_BASH || (process.platform === 'win32' ? 'C:/Program Files/Git/bin/bash.exe' : 'bash');
    const result = spawnSync(bash, [script.replaceAll('\\', '/'), temporaryDirectory.replaceAll('\\', '/'), path.join(root, '.github/workflows/scripts/tauri-linux-deps.sh').replaceAll('\\', '/')], {
        cwd: root, windowsHide: true, encoding: 'utf8', timeout: 30000, env: { ...process.env, CHECKSUM_FAIL: badChecksum ? '1' : '0' }
    });
    assert.ifError(result.error);
    const commands = fs.existsSync(path.join(temporaryDirectory, 'commands')) ? fs.readFileSync(path.join(temporaryDirectory, 'commands'), 'utf8').trim().split('\n') : [];
    return { result, commands, temporaryDirectory };
}

test('the libbpf shell skips download and build only after a warm-cache probe succeeds', () => {
    const { result, commands } = dependencyShell({ warm: true });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(commands, ['node-libbpf']);
});

test('cold and rejected libbpf caches retain the checksum, rebuild and repeat the ABI probe', () => {
    for (const invalid of [false, true]) {
        const { result, commands, temporaryDirectory } = dependencyShell({ invalid });
        assert.equal(result.status, 0, result.stderr);
        assert.deepEqual(commands, ['node-libbpf', 'node-archive', 'curl', 'checksum', 'tar', 'make', 'node-libbpf']);
        if (invalid) assert.ok(fs.existsSync(path.join(temporaryDirectory, 'rejected-native-deps/install/invalid')));
        assert.match(fs.readFileSync(path.join(temporaryDirectory, 'github-env'), 'utf8'), /TAURI_LIBBPF_LIBRARY=.*\/install\/usr\/lib\/libbpf\.a/);
    }
    const { result, commands } = dependencyShell({ badChecksum: true });
    assert.notEqual(result.status, 0);
    assert.deepEqual(commands, ['node-libbpf', 'node-archive', 'curl', 'checksum']);
});
