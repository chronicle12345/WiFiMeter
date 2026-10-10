'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { stageUi, prepare, nativeTarget, validatePrepared } = require('./prepare.cjs');
const { buildOptions, selectBundle } = require('./build.cjs');

const root = path.resolve(__dirname, '../..');
const app = path.join(root, 'apps/desktop');

function temporary(t) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'wifimeter-tauri-packaging-'));
    t.after(() => {
        assert.equal(path.dirname(directory), path.resolve(os.tmpdir()));
        assert.ok(path.basename(directory).startsWith('wifimeter-tauri-packaging-'));
        fs.rmSync(directory, { recursive: true, force: true });
    });
    return directory;
}

function write(file, contents) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, contents);
}

function executable(machine) {
    const header = Buffer.alloc(256);
    header.write('MZ'); header.writeUInt32LE(128, 60);
    header.write('PE\0\0', 128); header.writeUInt16LE(machine, 132);
    return header;
}

function localImports(directory) {
    for (const file of fs.readdirSync(directory, { recursive: true }).filter(file => /\.(js|mjs)$/.test(file))) {
        const absolute = path.join(directory, file);
        for (const match of fs.readFileSync(absolute, 'utf8').matchAll(/\b(?:from\s*|import\s*)['"](\.{1,2}\/[^'"]+)['"]/g)) {
            assert.ok(fs.existsSync(path.resolve(path.dirname(absolute), match[1])), `缺少 ${file} 的依赖 ${match[1]}`);
        }
    }
}

test('the two Tauri windows retain all local modules, shared styles and browser dependencies', t => {
    const ui = path.join(temporary(t), 'ui');
    stageUi(app, ui);
    localImports(ui);
    assert.match(fs.readFileSync(path.join(ui, 'mini/style.css'), 'utf8'), /\.\.\/main\/shared\/tokens\.css/);
    assert.ok(fs.existsSync(path.join(ui, 'main/shared/tokens.css')));
    assert.equal(fs.existsSync(path.join(ui, 'mini/preload.cjs')), false);
    assert.equal(fs.existsSync(path.join(ui, 'node_modules')), false);
    for (const page of ['main/index.html', 'mini/index.html']) {
        const html = fs.readFileSync(path.join(ui, page), 'utf8');
        assert.match(html, /connect-src ipc: http:\/\/ipc\.localhost/);
        assert.doesNotMatch(html, /connect-src[^";]*(?:https:|\*)/);
    }
    for (const license of ['marked-LICENSE.txt', 'DOMPurify-LICENSE.txt']) assert.ok(fs.statSync(path.join(ui, 'vendor', license)).size > 0);
});

test('build targets reject cross architecture Node resources before packaging', () => {
    const host = { platform: 'win32', arch: 'x64' };
    assert.throws(() => nativeTarget({ platform: 'win32', arch: 'arm64' }, host), /不能混用架构/);
    assert.throws(() => nativeTarget({ platform: 'linux', arch: 'x64' }, host), /不能混用架构/);
    assert.deepEqual(buildOptions([], host).formats, ['nsis']);
    assert.deepEqual(buildOptions(['--formats', 'dir', '--skip-backend'], host), { mode: 'build', platform: 'win32', arch: 'x64', formats: ['dir'], skipBackend: true, target: null });
    assert.throws(() => buildOptions(['--formats', 'portable'], host), /不支持的 Tauri 格式/);
    assert.equal(buildOptions(['--target', 'i686-pc-windows-msvc'], { platform: 'win32', arch: 'ia32' }).target, 'i686-pc-windows-msvc');
    assert.throws(() => buildOptions(['--target', 'i686-pc-windows-msvc'], host), /不匹配/);
    assert.deepEqual(buildOptions([], { platform: 'linux', arch: 'arm64' }).formats, ['deb', 'rpm', 'appimage']);
    assert.throws(() => buildOptions(['--formats', 'exe'], host), /不支持的 Tauri 格式/);
});

test('artifact collection selects the current version and rejects missing or ambiguous installers', t => {
    const bundle = temporary(t);
    for (const filename of ['WiFiMeter_1.2.3_x64-setup.exe', 'WiFiMeter_1.3.0_x64-setup.exe', 'WiFiMeter_11.3.0_x64-setup.exe']) {
        write(path.join(bundle, filename), filename);
    }
    assert.equal(selectBundle(bundle, '.exe', '1.3.0'), path.join(bundle, 'WiFiMeter_1.3.0_x64-setup.exe'));
    assert.throws(() => selectBundle(bundle, '.exe', '1.4.0'), /产物数量异常：0/);
    write(path.join(bundle, 'WiFiMeter_1.3.0_arm64-setup.exe'), 'ambiguous');
    assert.throws(() => selectBundle(bundle, '.exe', '1.3.0'), /产物数量异常：2/);
});

test('Windows staging contains native policy resources and a matching Node worker without Electron', { skip: process.platform !== 'win32' }, t => {
    const fixture = temporary(t);
    const fixtureApp = path.join(fixture, 'apps/desktop');
    for (const folder of ['renderer', 'electron', 'assets', 'native/windows']) fs.cpSync(path.join(app, folder), path.join(fixtureApp, folder), { recursive: true });
    for (const dependency of ['marked', 'dompurify']) fs.cpSync(path.join(app, 'node_modules', dependency), path.join(fixtureApp, 'node_modules', dependency), { recursive: true });
    write(path.join(fixtureApp, 'package.json'), JSON.stringify({ version: '1.3.0' }));
    write(path.join(fixtureApp, 'LICENSE'), 'MIT fixture license');
    for (const worker of ['host.cjs', 'native-adapter.cjs']) write(path.join(fixtureApp, 'tauri', worker), '// Worker fixture');
    const binary = executable({ x64: 0x8664, arm64: 0xaa64, ia32: 0x14c }[process.arch]);
    const backend = path.join(fixture, 'backend-resources');
    for (const name of ['wifimeter-backend.exe', 'wifimeter-app-capture.exe']) write(path.join(backend, name), binary);
    const node = path.join(fixture, 'node.exe'), license = path.join(fixture, 'Node-LICENSE.txt');
    write(node, binary); write(license, 'Node fixture license');
    write(path.join(fixtureApp, 'src-tauri/resources/runtime/old-module.cjs'), '// stale');
    write(path.join(fixtureApp, 'src-tauri/ui/old-page.html'), '<html>stale</html>');
    write(path.join(fixtureApp, 'src-tauri/Cargo.toml'), '[package]\nname="fixture"');
    const result = prepare({ root: fixture, backendDirectory: backend, nodeExecutable: node, license });
    validatePrepared(result.output);
    assert.equal(result.version, '1.3.0');
    assert.equal(fs.existsSync(path.join(result.resources, 'runtime/old-module.cjs')), false);
    assert.equal(fs.existsSync(path.join(result.output, 'ui/old-page.html')), false);
    assert.ok(fs.existsSync(path.join(result.output, 'Cargo.toml')));
    for (const name of ['AppNetworkControl.psm1', 'DownloadNetworkControl.ps1', 'DownloadLimiter.cs', 'WinDivert/LICENSE']) {
        assert.deepEqual(fs.readFileSync(path.join(result.resources, 'native/windows', name)), fs.readFileSync(path.join(app, 'native/windows', name)));
    }
    const files = fs.readdirSync(result.resources, { recursive: true });
    assert.ok(files.some(file => file.endsWith('main.cjs')));
    assert.ok(!files.some(file => /(^|[\\/])(node_modules|app\.asar|electron\.exe|preload\.cjs)([\\/]|$)/.test(file)));
    write(node, executable(process.arch === 'x64' ? 0xaa64 : 0x8664));
    assert.throws(() => prepare({ root: fixture, backendDirectory: backend, nodeExecutable: node, license }), /架构不匹配/);
});
