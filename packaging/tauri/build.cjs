'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { prepare, nativeTarget } = require('./prepare.cjs');
const { assertArchitecture, buildPaths } = require('../targets.cjs');

const root = path.resolve(__dirname, '../..');

function buildOptions(args = [], host = process) {
    const options = { mode: 'build', platform: host.platform, arch: host.arch, formats: null, skipBackend: false, target: null };
    for (let index = 0; index < args.length; index++) {
        const argument = args[index];
        if (index === 0 && ['dev', 'build'].includes(argument)) { options.mode = argument; continue; }
        if (['--skip-backend', '--skip-rebuild'].includes(argument)) { options.skipBackend = true; continue; }
        if (!['--platform', '--arch', '--formats', '--target'].includes(argument) || !args[index + 1] || args[index + 1].startsWith('--')) {
            throw new Error(`不支持的 Tauri 参数：${argument}。使用 dev/build、--platform、--arch、--formats、--target 或 --skip-backend。`);
        }
        const value = args[++index];
        if (argument === '--platform') options.platform = value === 'windows' ? 'win32' : value;
        else if (argument === '--arch') options.arch = value;
        else if (argument === '--target') options.target = value;
        else options.formats = [...new Set(value.split(','))];
    }
    nativeTarget(options, host);
    const target = { win32: { x64: 'x86_64-pc-windows-msvc', ia32: 'i686-pc-windows-msvc', arm64: 'aarch64-pc-windows-msvc' },
        linux: { x64: 'x86_64-unknown-linux-gnu', arm64: 'aarch64-unknown-linux-gnu' } }[options.platform][options.arch];
    if (options.target && options.target !== target) throw new Error(`Rust 目标 ${options.target} 与 ${options.platform}/${options.arch} 不匹配。`);
    options.formats ||= options.platform === 'win32' ? ['nsis'] : ['deb', 'rpm', 'appimage'];
    const allowed = options.platform === 'win32' ? ['nsis', 'dir'] : ['deb', 'rpm', 'appimage', 'dir'];
    if (!options.formats.length || options.formats.some(format => !allowed.includes(format))) throw new Error(`不支持的 Tauri 格式：${options.formats.join(',')}。`);
    return options;
}

function run(executable, args, options = {}) {
    return execFileSync(executable, args, { cwd: root, stdio: 'inherit', windowsHide: true, ...options });
}

function cachedCmake() {
    for (const relative of ['build/windows/CMakeCache.txt', 'build/msvc-validation/CMakeCache.txt', 'build/CMakeCache.txt']) {
        const file = path.join(root, relative);
        if (!fs.existsSync(file)) continue;
        const command = fs.readFileSync(file, 'utf8').match(/^CMAKE_COMMAND:[^=]*=(.+)$/m)?.[1].trim();
        if (command && fs.existsSync(command)) return command;
    }
    return null;
}

function buildBackend(options) {
    if (!process.env.CMAKE_COMMAND) {
        const command = cachedCmake();
        if (command) process.env.CMAKE_COMMAND = command;
    }
    const msvcDirectory = path.join(root, 'build/msvc-validation');
    const cacheFile = path.join(msvcDirectory, 'CMakeCache.txt');
    const cache = options.platform === 'win32' && options.arch === process.arch && fs.existsSync(cacheFile) ? fs.readFileSync(cacheFile, 'utf8') : '';
    const compiler = cache.match(/^CMAKE_CXX_COMPILER:[^=]*=(.+)$/m)?.[1].trim().replaceAll('\\', '/');
    const studio = compiler?.match(/^(.*)\/VC\/Tools\/MSVC\/.*\/cl\.exe$/i)?.[1];
    const developerCommand = studio && path.join(studio, 'Common7/Tools/VsDevCmd.bat');
    if (developerCommand && fs.existsSync(developerCommand)) {
        if (/["\r\n&|<>^%]/.test(developerCommand)) throw new Error('Visual Studio 初始化路径包含不支持的命令字符。');
        const architecture = { x64: 'x64', arm64: 'arm64', ia32: 'x86' }[options.arch];
        const environmentOutput = run('cmd.exe', ['/d', '/s', '/c', `call "${developerCommand}" -no_logo -arch=${architecture} -host_arch=${architecture} >nul && set`],
            { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], windowsVerbatimArguments: true });
        const env = { ...process.env };
        for (const line of environmentOutput.split(/\r?\n/)) {
            const equals = line.indexOf('=');
            if (equals > 0) env[line.slice(0, equals)] = line.slice(equals + 1);
        }
        run(process.env.CMAKE_COMMAND, ['-S', 'backend', '-B', msvcDirectory, '-DCMAKE_BUILD_TYPE=Release'], { env });
        run(process.env.CMAKE_COMMAND, ['--build', msvcDirectory, '--target', 'wifimeter-backend', '--config', 'Release'], { env });
        return path.join(msvcDirectory, 'app');
    }
    require('../build-backend.cjs').buildBackend({ arch: options.arch, linuxAppCapture: options.platform === 'linux' });
    return path.join(root, buildPaths(options.platform, options.arch).backend, 'app');
}

function cargoTargetDirectory(appDirectory) {
    const metadata = JSON.parse(run('cargo', ['metadata', '--format-version', '1', '--no-deps', '--manifest-path', path.join(appDirectory, 'src-tauri/Cargo.toml')],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] }));
    return metadata.target_directory;
}

function checkPortable(directory, options) {
    const executable = path.join(directory, options.platform === 'win32' ? 'WiFiMeter.exe' : 'wifimeter');
    assertArchitecture(executable, options.platform, options.arch);
    const resources = path.join(directory, 'resources');
    for (const file of ['wifimeter-backend', 'wifimeter-app-capture']) assertArchitecture(path.join(resources, file + (options.platform === 'win32' ? '.exe' : '')), options.platform, options.arch);
    assertArchitecture(path.join(resources, 'runtime', options.platform === 'win32' ? 'node.exe' : 'node'), options.platform, options.arch);
    if (fs.existsSync(path.join(directory, 'electron.exe')) || fs.existsSync(path.join(resources, 'app.asar'))) throw new Error('Tauri 产物包含 Electron 运行时。');
}

function selectBundle(folder, extension, version) {
    const versionPattern = new RegExp(`(?:^|[_.-])${version.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?=[_.-]|$)`);
    const files = fs.existsSync(folder) ? fs.readdirSync(folder).filter(file => file.endsWith(extension) && versionPattern.test(file)) : [];
    if (files.length !== 1) throw new Error(`Tauri ${version} 产物数量异常：${files.length}，目录 ${folder}。`);
    return path.join(folder, files[0]);
}

function collectArtifacts(prepared, targetDirectory, options) {
    const output = path.join(root, buildPaths(options.platform, options.arch).output);
    fs.mkdirSync(output, { recursive: true });
    const label = `WiFiMeter-${prepared.version}-${options.platform === 'win32' ? 'windows' : 'linux'}-${options.arch}-Tauri`;
    const release = path.join(targetDirectory, ...(options.target ? [options.target] : []), 'release');
    const executable = path.join(release, options.platform === 'win32' ? 'wifimeter.exe' : 'wifimeter');
    assertArchitecture(executable, options.platform, options.arch);
    const artifacts = [];
    if (options.formats.includes('dir')) {
        const directory = path.join(output, 'tauri-unpacked');
        if (path.relative(fs.realpathSync(root), path.resolve(directory)) !== path.join(buildPaths(options.platform, options.arch).output, 'tauri-unpacked')) {
            throw new Error(`程序生成目录超出工作区：${directory}`);
        }
        if (fs.existsSync(directory) && fs.lstatSync(directory).isSymbolicLink()) throw new Error('程序生成目录不能是符号链接。');
        fs.rmSync(directory, { recursive: true, force: true });
        fs.mkdirSync(directory, { recursive: true });
        fs.copyFileSync(executable, path.join(directory, options.platform === 'win32' ? 'WiFiMeter.exe' : 'wifimeter'));
        fs.cpSync(prepared.resources, path.join(directory, 'resources'), { recursive: true });
        fs.copyFileSync(path.join(prepared.appDirectory, 'LICENSE'), path.join(directory, 'LICENSE.txt'));
        checkPortable(directory, options);
        artifacts.push(directory);
    }
    for (const format of options.formats.filter(format => format !== 'dir')) {
        const folder = path.join(release, 'bundle', format);
        const extension = { nsis: '.exe', deb: '.deb', rpm: '.rpm', appimage: '.AppImage' }[format];
        const source = selectBundle(folder, extension, prepared.version);
        const destination = path.join(output, `${label}${format === 'nsis' ? '-Setup' : ''}${extension}`);
        fs.copyFileSync(source, destination);
        artifacts.push(destination);
    }
    const installers = artifacts.filter(file => fs.statSync(file).isFile());
    if (installers.length) {
        const checksums = path.join(output, `${label}-SHA256SUMS.txt`);
        fs.writeFileSync(checksums, installers.map(file => `${createHash('sha256').update(fs.readFileSync(file)).digest('hex')}  ${path.basename(file)}`).join('\n') + '\n');
    }
    return artifacts;
}

function main(args = process.argv.slice(2)) {
    const options = buildOptions(args);
    const backendDirectory = options.skipBackend ? undefined : buildBackend(options);
    const prepared = prepare({ ...options, ...(backendDirectory ? { backendDirectory } : {}) });
    const cli = path.join(prepared.appDirectory, 'node_modules/@tauri-apps/cli/tauri.js');
    if (!fs.existsSync(cli)) throw new Error('未安装 Tauri CLI，请先运行 npm --prefix apps/desktop ci。');
    const common = { cwd: prepared.appDirectory };
    if (options.mode === 'dev') {
        run(process.execPath, [cli, 'dev', '--features', 'custom-protocol', '--no-dev-server', ...(options.target ? ['--target', options.target] : [])], common);
        return [];
    }
    const bundles = options.formats.filter(format => format !== 'dir');
    run(process.execPath, [cli, 'build', '--ci', '--features', 'custom-protocol', '--config', JSON.stringify({ bundle: { useLocalToolsDir: true } }),
        ...(options.platform === 'linux' ? ['--verbose'] : []),
        ...(options.target ? ['--target', options.target] : []),
        ...(bundles.length ? ['--bundles', bundles.join(',')] : ['--no-bundle'])], common);
    const artifacts = collectArtifacts(prepared, cargoTargetDirectory(prepared.appDirectory), options);
    for (const artifact of artifacts) process.stdout.write(`Tauri 产物：${artifact}\n`);
    return artifacts;
}

module.exports = { buildOptions, cachedCmake, buildBackend, checkPortable, selectBundle, collectArtifacts, main };

if (require.main === module) {
    try { main(); }
    catch (error) { require('../build-failure.cjs').reportBuildFailure(error); }
}
