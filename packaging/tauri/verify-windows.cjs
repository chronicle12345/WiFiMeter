'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { readMetadata, validateAssets } = require('./release.cjs');
const { checkPortable } = require('./build.cjs');

const root = path.resolve(__dirname, '../..');

function filesUnder(directory, relative = '') {
    return fs.readdirSync(path.join(directory, relative), { withFileTypes: true }).flatMap(entry => {
        const file = path.join(relative, entry.name);
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

async function main() {
    assert.equal(process.platform, 'win32', 'Windows package validation requires Windows.');
    const { version } = readMetadata(root);
    const [installer, portable] = await validateAssets(path.join(root, 'dist/windows'), version, { buildTree: true });
    const sevenZip = path.join(root, 'apps/desktop/node_modules/electron-winstaller/vendor/7z.exe');
    assert.ok(fs.existsSync(sevenZip), 'Install the locked desktop development dependencies before validating packages.');
    const build = path.join(root, 'build');
    fs.mkdirSync(build, { recursive: true });
    const output = fs.mkdtempSync(path.join(build, 'tauri-package-check-'));
    const manifests = [];
    for (const [name, archive] of [['installer', installer], ['portable', portable]]) {
        const directory = path.join(output, name);
        fs.mkdirSync(directory);
        execFileSync(sevenZip, ['x', archive, `-o${directory}`, '-y'], { cwd: root, windowsHide: true, stdio: 'pipe' });
        checkPortable(directory, { platform: 'win32', arch: 'x64' });
        const resources = path.join(directory, 'resources');
        const manifest = JSON.parse(fs.readFileSync(path.join(resources, 'runtime-manifest.json'), 'utf8'));
        assert.equal(manifest.version, version);
        assert.equal(manifest.platform, 'win32');
        assert.equal(manifest.arch, 'x64');
        const resourceCount = await compareResources(path.join(root, 'apps/desktop/src-tauri/resources'), resources);
        const executable = path.join(directory, 'wifimeter.exe');
        const executableDigest = await digest(executable);
        const expectedExecutable = fs.readFileSync(path.join(root, 'dist/windows/tauri-portable/WiFiMeter.exe'));
        if (name === 'installer') {
            // Tauri 为 NSIS 写入 NSS 包类型；便携程序保留 UNK。只允许这三个字节有区别。
            const marker = Buffer.from('__TAURI_BUNDLE_TYPE_VAR_UNK');
            const offset = expectedExecutable.indexOf(marker);
            assert.ok(offset >= 0 && expectedExecutable.indexOf(marker, offset + 1) === -1, 'Expected one Tauri bundle-type marker.');
            expectedExecutable.write('__TAURI_BUNDLE_TYPE_VAR_NSS', offset, 'ascii');
        }
        assert.equal(executableDigest, createHash('sha256').update(expectedExecutable).digest('hex'));
        console.log(`PASS ${name}: executable and ${resourceCount} runtime resources match the verified build`);
        execFileSync(process.execPath, [path.join(root, 'apps/desktop/tests/tauri-smoke.mjs')], {
            cwd: root, windowsHide: true, stdio: 'inherit',
            env: { ...process.env, WIFIMETER_TAURI_EXECUTABLE: executable }
        });
        manifests.push({ name, archive, bytes: fs.statSync(archive).size, executableDigest, resourceCount, nativeIntegration: true });
    }
    fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify({ version, passed: true, packages: manifests }, null, 2));
    console.log(`Windows package validation passed. Evidence: ${output}`);
}

if (require.main === module) main().catch(error => { console.error(error.stack || error.message); process.exitCode = 1; });
