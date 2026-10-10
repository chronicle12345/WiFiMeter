'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { readMetadata, validateAssets } = require('./release.cjs');
const common = require('./verify-common.cjs');
const { root, verificationOptions, compareResources, compareExecutable, verifyRuntime } = common;

function sevenZipExecutable() {
    const appDirectory = path.join(root, 'apps/desktop');
    const candidates = [
        path.join(appDirectory, 'node_modules/electron-winstaller/vendor/7z.exe'),
        path.win32.join(process.env.ProgramFiles || 'C:\\Program Files', '7-Zip/7z.exe'),
        path.win32.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', '7-Zip/7z.exe')
    ];
    const installed = candidates.find(file => fs.existsSync(file));
    if (installed) return installed;
    try {
        const located = execFileSync('where.exe', ['7z.exe'], { encoding: 'utf8', windowsHide: true, stdio: 'pipe' });
        candidates.push(...located.trim().split(/\r?\n/));
    } catch (error) { if (error.status !== 1 && error.code !== 'ENOENT') throw error; }
    const executable = candidates.find(file => fs.existsSync(file));
    assert.ok(executable, 'Install the full 7-Zip program (7z.exe) to extract the NSIS package; 7za.exe does not support NSIS.');
    return executable;
}

async function main(args = process.argv.slice(2)) {
    assert.equal(process.platform, 'win32', 'Windows package validation requires Windows.');
    const options = verificationOptions(args);
    const { version } = readMetadata(root);
    const [installer] = await validateAssets(options.directory, version, { buildTree: true, platform: 'win32', arch: options.arch });
    const sevenZip = sevenZipExecutable();
    assert.ok(fs.existsSync(sevenZip), 'Install the locked desktop development dependencies before validating packages.');
    const build = path.join(root, 'build');
    fs.mkdirSync(build, { recursive: true });
    const output = fs.mkdtempSync(path.join(build, `tauri-package-check-${options.arch}-`));
    const directory = path.join(output, 'installer');
    fs.mkdirSync(directory);
    execFileSync(sevenZip, ['x', installer, `-o${directory}`, '-y'], { cwd: root, windowsHide: true, stdio: 'pipe' });
    const executable = path.join(directory, 'wifimeter.exe');
    const resources = path.join(directory, 'resources');
    verifyRuntime(executable, resources, { ...options, version });
    const resourceCount = await compareResources(options.resources, resources);
    const executableDigest = await compareExecutable(path.join(options.release, 'wifimeter.exe'), executable, 'NSS');
    console.log(`PASS Windows ${options.arch} installer: executable and ${resourceCount} runtime resources match the verified build`);
    execFileSync(process.execPath, [path.join(root, 'apps/desktop/tests/tauri-smoke.mjs')], {
        cwd: root, windowsHide: true, stdio: 'inherit',
        env: { ...process.env, WIFIMETER_TAURI_EXECUTABLE: executable }
    });
    const packages = [{ name: 'installer', archive: installer, bytes: fs.statSync(installer).size, executableDigest, resourceCount, nativeIntegration: true }];
    fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify({ version, platform: 'win32', arch: options.arch, passed: true, packages }, null, 2));
    console.log(`Windows package validation passed. Evidence: ${output}`);
    return output;
}

module.exports = { ...common, sevenZipExecutable, main };
if (require.main === module) main().catch(error => { console.error(error.stack || error.message); process.exitCode = 1; });
