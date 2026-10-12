'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { assertArchitecture, buildPaths, checkBackend } = require('../targets.cjs');

const repositoryRoot = path.resolve(__dirname, '../..');

function nativeTarget({ platform = process.platform, arch = process.arch } = {}, host = process) {
    if (!['win32', 'linux'].includes(platform)) throw new Error(`Tauri 构建暂不支持 ${platform}。`);
    if (!['x64', 'arm64', ...(platform === 'win32' ? ['ia32'] : [])].includes(arch)) throw new Error(`不支持 ${platform}/${arch}。`);
    if (platform !== host.platform || arch !== host.arch) {
        throw new Error(`Tauri 资源需要 ${platform}/${arch} 的本机 Node 和工具链；当前为 ${host.platform}/${host.arch}，不能混用架构。`);
    }
    return { platform, arch };
}

function copy(source, destination) {
    if (!fs.existsSync(source)) throw new Error(`缺少构建资源：${source}`);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.cpSync(source, destination, { recursive: true });
}

function resetGenerated(root, output) {
    const workspace = fs.realpathSync(root);
    fs.mkdirSync(output, { recursive: true });
    const physicalOutput = fs.realpathSync(output);
    const relative = path.relative(workspace, physicalOutput);
    if (relative !== path.join('apps', 'desktop', 'src-tauri')) throw new Error(`生成资源目录超出预期工作区：${physicalOutput}`);
    for (const name of ['resources', 'ui']) {
        const directory = path.join(physicalOutput, name);
        if (fs.existsSync(directory) && fs.lstatSync(directory).isSymbolicLink()) throw new Error(`生成目录不能是符号链接：${directory}`);
        // Only these two generated children are cleared; the Rust sources and Cargo.lock stay in place.
        fs.rmSync(directory, { recursive: true, force: true });
    }
}

function tauriCsp(html) {
    return html.replace(/(<meta\b[^>]*http-equiv="Content-Security-Policy"[^>]*content=")([^"]*)("[^>]*>)/i,
        (_match, start, policy, end) => {
            const connection = 'connect-src ipc: http://ipc.localhost';
            return start + (/\bconnect-src\s+[^;]*/.test(policy)
                ? policy.replace(/\bconnect-src\s+[^;]*/, connection) : `${policy}; ${connection}`) + end;
        });
}

function stageUi(appDirectory, uiDirectory) {
    copy(path.join(appDirectory, 'renderer'), path.join(uiDirectory, 'main'));
    copy(path.join(appDirectory, 'host/mini'), path.join(uiDirectory, 'mini'));
    copy(path.join(appDirectory, 'assets/icon.png'), path.join(uiDirectory, 'assets/icon.png'));
    copy(path.join(appDirectory, 'assets/icon.ico'), path.join(uiDirectory, 'favicon.ico'));
    for (const page of ['main/index.html', 'mini/index.html']) {
        const file = path.join(uiDirectory, page);
        fs.writeFileSync(file, tauriCsp(fs.readFileSync(file, 'utf8')));
    }
    for (const file of ['mini/rates.js', 'mini/style.css']) {
        const target = path.join(uiDirectory, file);
        fs.writeFileSync(target, fs.readFileSync(target, 'utf8').replaceAll('../../renderer/', '../main/'));
    }
    const dependencies = [
        ['marked/lib/marked.esm.js', 'marked.esm.js'],
        ['dompurify/dist/purify.es.mjs', 'purify.es.mjs'],
        ['marked/LICENSE', 'marked-LICENSE.txt'],
        ['dompurify/LICENSE', 'DOMPurify-LICENSE.txt']
    ];
    for (const [source, destination] of dependencies) copy(path.join(appDirectory, 'node_modules', source), path.join(uiDirectory, 'vendor', destination));
    const releaseNotes = path.join(uiDirectory, 'main/ui/release-notes.js');
    fs.writeFileSync(releaseNotes, fs.readFileSync(releaseNotes, 'utf8')
        .replace('../../node_modules/marked/lib/marked.esm.js', '../../vendor/marked.esm.js')
        .replace('../../node_modules/dompurify/dist/purify.es.mjs', '../../vendor/purify.es.mjs'));
}

function nodeLicense({ root = repositoryRoot, nodeExecutable = process.execPath, nodeVersion = process.versions.node,
    arch = process.arch, platform = process.platform, license = process.env.WIFIMETER_NODE_LICENSE } = {}) {
    const candidates = [license, path.join(path.dirname(nodeExecutable), 'LICENSE'), path.join(path.dirname(nodeExecutable), 'LICENSE.txt'),
        path.join(root, '.cross-build', `node-v${nodeVersion}-${platform === 'win32' ? 'win' : platform}-${arch}`, 'LICENSE'),
        path.join(root, 'packaging/tauri/licenses', `node-v${nodeVersion}-LICENSE.txt`)].filter(Boolean);
    const found = candidates.find(file => fs.existsSync(file) && fs.statSync(file).isFile());
    if (!found) throw new Error(`缺少 Node.js ${nodeVersion} 许可证。请将官方 LICENSE 放在 Node 程序旁，或设置 WIFIMETER_NODE_LICENSE。`);
    return found;
}

function validatePrepared(directory, { platform = process.platform, arch = process.arch } = {}) {
    const resources = path.join(directory, 'resources');
    checkBackend(resources, platform, arch);
    assertArchitecture(path.join(resources, 'runtime', platform === 'win32' ? 'node.exe' : 'node'), platform, arch);
    for (const file of ['runtime/host.cjs', 'runtime/native-adapter.cjs', 'runtime/host/main.cjs', 'runtime/host/desktop-runtime.cjs', 'runtime/package.json', 'licenses/Nodejs-LICENSE.txt']) {
        if (!fs.existsSync(path.join(resources, file))) throw new Error(`Tauri 资源不完整：${file}`);
    }
    for (const file of ['main/index.html', 'mini/index.html', 'main/shared/tokens.css', 'assets/icon.png', 'favicon.ico', 'vendor/marked.esm.js', 'vendor/purify.es.mjs']) {
        if (!fs.existsSync(path.join(directory, 'ui', file))) throw new Error(`Tauri 页面资源不完整：${file}`);
    }
    if (fs.existsSync(path.join(resources, 'runtime/node_modules')) || fs.existsSync(path.join(resources, 'runtime/electron'))
        || fs.existsSync(path.join(resources, 'runtime/host/preload.cjs'))
        || fs.existsSync(path.join(directory, 'ui/mini/preload.cjs'))) throw new Error('Tauri 发布资源包含旧 Electron 运行时入口。');
}

function existingBackendDirectory(root, platform, arch) {
    if (platform === 'win32') {
        const msvc = path.join(root, 'build/msvc-validation/app');
        try { checkBackend(msvc, platform, arch); return msvc; }
        catch { /* A fresh checkout or another architecture uses the standard backend directory. */ }
    }
    return path.join(root, buildPaths(platform, arch).backend, 'app');
}

function prepare({ root = repositoryRoot, platform = process.platform, arch = process.arch,
    nodeExecutable = process.env.WIFIMETER_NODE_EXECUTABLE || process.execPath,
    nodeVersion = process.env.WIFIMETER_NODE_VERSION || process.versions.node,
    license = process.env.WIFIMETER_NODE_LICENSE,
    backendDirectory = existingBackendDirectory(root, platform, arch) } = {}) {
    nativeTarget({ platform, arch });
    assertArchitecture(nodeExecutable, platform, arch);
    checkBackend(backendDirectory, platform, arch);
    const licenseFile = nodeLicense({ root, platform, arch, nodeExecutable, nodeVersion, license });
    const appDirectory = path.join(root, 'apps/desktop');
    const output = path.join(appDirectory, 'src-tauri');
    const resources = path.join(output, 'resources');
    const runtime = path.join(resources, 'runtime');
    const metadata = JSON.parse(fs.readFileSync(path.join(appDirectory, 'package.json'), 'utf8'));
    resetGenerated(root, output);
    stageUi(appDirectory, path.join(output, 'ui'));
    copy(nodeExecutable, path.join(runtime, platform === 'win32' ? 'node.exe' : 'node'));
    for (const file of fs.readdirSync(path.join(appDirectory, 'tauri'))) {
        if (file.endsWith('.cjs') && !file.endsWith('.test.cjs')) copy(path.join(appDirectory, 'tauri', file), path.join(runtime, file));
    }
    fs.mkdirSync(path.join(runtime, 'host'), { recursive: true });
    for (const file of fs.readdirSync(path.join(appDirectory, 'host'))) {
        if (file.endsWith('.cjs') && file !== 'preload.cjs') copy(path.join(appDirectory, 'host', file), path.join(runtime, 'host', file));
    }
    copy(path.join(appDirectory, 'assets'), path.join(runtime, 'assets'));
    fs.writeFileSync(path.join(runtime, 'package.json'), JSON.stringify({ name: 'wifimeter', version: metadata.version, private: true }, null, 2) + '\n');
    for (const name of ['wifimeter-backend', 'wifimeter-app-capture']) {
        const filename = name + (platform === 'win32' ? '.exe' : '');
        copy(path.join(backendDirectory, filename), path.join(resources, filename));
    }
    if (platform === 'win32') copy(path.join(appDirectory, 'native/windows'), path.join(resources, 'native/windows'));
    else if (fs.existsSync(path.join(backendDirectory, 'wifimeter-app-capture.bpf.o'))) {
        copy(path.join(backendDirectory, 'wifimeter-app-capture.bpf.o'), path.join(resources, 'wifimeter-app-capture.bpf.o'));
        copy(path.join(root, 'backend/third_party/libbpf/LICENSE.BSD-2-Clause'), path.join(resources, 'licenses/libbpf.BSD-2-Clause'));
        copy(path.join(root, 'backend/platform/linux/COPYING.BPF'), path.join(resources, 'licenses/wifimeter-app-capture.GPL-2.0'));
    }
    copy(path.join(appDirectory, 'LICENSE'), path.join(resources, 'licenses/WiFiMeter-LICENSE.txt'));
    copy(licenseFile, path.join(resources, 'licenses/Nodejs-LICENSE.txt'));
    fs.writeFileSync(path.join(resources, 'runtime-manifest.json'), JSON.stringify({ version: metadata.version, platform, arch, node: nodeVersion }, null, 2) + '\n');
    validatePrepared(output, { platform, arch });
    return { root, appDirectory, output, resources, version: metadata.version, platform, arch };
}

module.exports = { prepare, stageUi, tauriCsp, nativeTarget, nodeLicense, validatePrepared, resetGenerated, existingBackendDirectory };

if (require.main === module) {
    try { const result = prepare(); process.stdout.write(`Tauri 资源已准备：${result.output}\n`); }
    catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1; }
}
