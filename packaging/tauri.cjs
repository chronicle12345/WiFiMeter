'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { buildOptions, buildPaths, checkBackend, assertArchitecture } = require('./targets.cjs');

const root = path.resolve(__dirname, '..');
const app = path.join(root, 'apps/desktop');
const manifest = require('../apps/desktop/package.json');

function targetTriple(platform, arch) {
    if (platform === 'win32' && arch === 'x64') return 'x86_64-pc-windows-gnu';
    if (platform === 'linux' && ['x64', 'arm64'].includes(arch)) {
        return `${arch === 'x64' ? 'x86_64' : 'aarch64'}-unknown-linux-gnu`;
    }
    throw new Error(`Linux 打包暂不支持 ${platform}/${arch}。`);
}

function bundleConfig({ platform, arch, formats }) {
    const windows = platform === 'win32';
    const backend = path.join(root, buildPaths(platform, arch).backend, 'app');
    const resources = Object.fromEntries(['wifimeter-backend', 'wifimeter-app-capture'].map(name => {
        const file = name + (windows ? '.exe' : '');
        return [path.join(backend, file), file];
    }));
    resources[path.join(root, 'LICENSE')] = 'licenses/WiFiMeter.txt';
    if (!windows) {
        resources[path.join(backend, 'wifimeter-app-capture.bpf.o')] = 'wifimeter-app-capture.bpf.o';
        resources[path.join(root, 'backend/third_party/libbpf/LICENSE.BSD-2-Clause')] = 'licenses/libbpf.BSD-2-Clause';
        resources[path.join(root, 'backend/platform/linux/COPYING.BPF')] = 'licenses/wifimeter-app-capture.GPL-2.0';
    }
    return {
        mainBinaryName: windows ? 'WiFiMeter' : 'wifimeter',
        bundle: {
            active: true,
            targets: formats.filter(format => !['dir', 'portable'].includes(format)).map(format => format.toLowerCase()),
            resources,
            useLocalToolsDir: true,
            publisher: 'WiFiMeter contributors <chronicle12345@users.noreply.github.com>',
            homepage: manifest.homepage,
            category: 'Utility',
            shortDescription: manifest.description,
            windows: {
                nsis: {
                    installMode: 'both', languages: ['SimpChinese', 'English'],
                    displayLanguageSelector: true, compression: 'lzma',
                    installerHooks: path.join(__dirname, 'windows/tauri-hooks.nsh')
                },
                webviewInstallMode: { type: 'downloadBootstrapper', silent: true }
            },
            linux: {
                deb: {
                    depends: ['libgtk-3-0 (>= 3.24) | libgtk-3-0t64 (>= 3.24)', 'libwebkit2gtk-4.1-0 (>= 2.40)', 'libayatana-appindicator3-1', 'libelf1 | libelf1t64', 'zlib1g', 'libssl3 | libssl3t64', 'libsqlite3-0', 'pkexec | policykit-1', 'xdg-utils'],
                    replaces: ['wifimeter-linux'], conflicts: ['wifimeter-linux'], provides: ['wifimeter-linux'],
                    section: 'net', desktopTemplate: path.join(__dirname, 'linux/wifimeter.desktop')
                },
                rpm: {
                    depends: ['gtk3', 'webkit2gtk4.1', 'libayatana-appindicator-gtk3', 'elfutils-libelf', 'zlib', 'openssl-libs', 'sqlite-libs', 'libstdc++', 'polkit', 'xdg-utils'],
                    obsoletes: ['wifimeter-linux'], provides: ['wifimeter-linux'],
                    desktopTemplate: path.join(__dirname, 'linux/wifimeter.desktop')
                }
            }
        }
    };
}

function checkDistribution(directory, platform, arch) {
    const windows = platform === 'win32';
    assertArchitecture(path.join(directory, windows ? 'WiFiMeter.exe' : 'bin/wifimeter'), platform, arch);
    const resources = windows ? directory : path.join(directory, 'lib/WiFiMeter');
    checkBackend(resources, platform, arch);
    if (windows) assertArchitecture(path.join(directory, 'WebView2Loader.dll'), platform, arch);
    else if (!fs.statSync(path.join(resources, 'wifimeter-app-capture.bpf.o')).size) throw new Error('缺少 eBPF 采集对象。');
}

function debDependencies(directory, env) {
    const work = path.join(root, '.cross-build/tauri/shlibdeps');
    fs.mkdirSync(path.join(work, 'debian'), { recursive: true });
    fs.writeFileSync(path.join(work, 'debian/control'), 'Source: wifimeter\n\nPackage: wifimeter\nArchitecture: any\nDescription: Network traffic monitor\n');
    // 根据实际二进制计算 libc / libstdc++ 等最低版本，不能把本机编译产物标成旧发行版可用。
    const libdir = execFileSync('pkg-config', ['--variable=libdir', 'webkit2gtk-4.1'], { env, encoding: 'utf8' }).trim();
    const executables = ['bin/wifimeter', 'lib/WiFiMeter/wifimeter-backend', 'lib/WiFiMeter/wifimeter-app-capture'];
    const output = execFileSync('dpkg-shlibdeps', ['-O', '--ignore-missing-info', `-l${libdir}`,
        ...executables.map(file => path.join(directory, file))], { cwd: work, env, encoding: 'utf8' });
    const line = output.split('\n').find(value => value.startsWith('shlibs:Depends='));
    if (!line) throw new Error('无法确定 Debian 运行库依赖。');
    return line.slice('shlibs:Depends='.length).split(', ');
}

async function buildDesktop(platform, args = process.argv.slice(2)) {
    if (process.platform !== 'linux') throw new Error('请在 Linux 环境中运行打包脚本。');
    const options = buildOptions(platform, args);
    const triple = targetTriple(platform, options.arch);
    const windows = platform === 'win32';
    const paths = buildPaths(platform, options.arch);
    const backend = path.join(root, paths.backend, 'app');
    const env = { ...process.env };
    if (windows) env.CARGO_TARGET_X86_64_PC_WINDOWS_GNU_LINKER ||= 'x86_64-w64-mingw32-gcc';
    const run = (command, arguments_, cwd = root) => execFileSync(command, arguments_, { cwd, env, stdio: 'inherit' });
    run('cargo', ['--version']);
    if (windows) run(env.CARGO_TARGET_X86_64_PC_WINDOWS_GNU_LINKER, ['--version']);
    if (!options.skipRebuild) {
        if (windows) (await import('./windows/build-backend.mjs')).buildWindowsBackend();
        else require('./build-backend.cjs').buildBackend({ arch: options.arch, linuxAppCapture: true });
    }
    checkBackend(backend, platform, options.arch);
    if (!windows) {
        const dependencies = execFileSync('readelf', ['-d', path.join(backend, 'wifimeter-app-capture')], { encoding: 'utf8' });
        if (dependencies.includes('libbpf.so.')) throw new Error('采集辅助进程应静态链接 libbpf。');
    }
    const config = bundleConfig(options);
    const configDirectory = path.join(root, '.cross-build/tauri');
    fs.mkdirSync(configDirectory, { recursive: true });
    const configFile = path.join(configDirectory, `${platform}-${options.arch}.json`);
    fs.writeFileSync(configFile, JSON.stringify(config, null, 2) + '\n');
    const cli = path.join(app, 'node_modules/@tauri-apps/cli/tauri.js');
    const flags = ['--ci', '--target', triple, '--config', configFile];
    run(process.execPath, [cli, 'build', ...flags, '--no-bundle'], app);
    const target = env.CARGO_TARGET_DIR ? path.resolve(app, env.CARGO_TARGET_DIR) : path.join(app, 'src-tauri/target');
    const release = path.join(target, triple, 'release');
    const output = path.join(root, paths.output);
    const unpacked = path.join(output, paths.unpacked);
    fs.rmSync(unpacked, { recursive: true, force: true });
    const executable = windows ? 'WiFiMeter.exe' : 'wifimeter';
    const executableDirectory = windows ? unpacked : path.join(unpacked, 'bin');
    const resourceDirectory = windows ? unpacked : path.join(unpacked, 'lib/WiFiMeter');
    fs.mkdirSync(executableDirectory, { recursive: true });
    fs.copyFileSync(path.join(release, executable), path.join(executableDirectory, executable));
    for (const [source, destination] of Object.entries(config.bundle.resources)) {
        const file = path.join(resourceDirectory, destination);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.copyFileSync(source, file);
    }
    if (windows) fs.copyFileSync(path.join(release, 'WebView2Loader.dll'), path.join(unpacked, 'WebView2Loader.dll'));
    checkDistribution(unpacked, platform, options.arch);
    if (config.bundle.targets.includes('deb')) {
        config.bundle.linux.deb.depends = [...new Set([...config.bundle.linux.deb.depends, ...debDependencies(unpacked, env)])];
        fs.writeFileSync(configFile, JSON.stringify(config, null, 2) + '\n');
    }
    if (config.bundle.targets.length) {
        for (const format of config.bundle.targets) fs.rmSync(path.join(release, 'bundle', format), { recursive: true, force: true });
        run(process.execPath, [cli, 'bundle', ...flags], app);
        for (const format of config.bundle.targets) {
            const extension = { nsis: '.exe', deb: '.deb', rpm: '.rpm', appimage: '.AppImage' }[format];
            const directory = path.join(release, 'bundle', format);
            const files = fs.readdirSync(directory).filter(file => file.endsWith(extension) && fs.statSync(path.join(directory, file)).isFile());
            if (files.length !== 1) throw new Error(`预期一个 ${format} 产物，实际为 ${files.length}。`);
            const name = `WiFiMeter-${manifest.version}-${windows ? 'windows' : 'linux'}-${options.arch}${windows ? '-Setup' : ''}${extension}`;
            fs.copyFileSync(path.join(directory, files[0]), path.join(output, name));
        }
    }
    if (options.formats.includes('portable')) {
        // 保留解压目录的位置，开机启动不会指向临时自解压目录。
        const archive = path.join(output, `WiFiMeter-${manifest.version}-windows-${options.arch}-Portable.zip`);
        fs.rmSync(archive, { force: true });
        run('zip', ['-q', '-r', archive, paths.unpacked], output);
    }
    console.log(`打包完成：${output}`);
    return { output, unpacked };
}

module.exports = { targetTriple, bundleConfig, checkDistribution, buildDesktop };

if (require.main === module) {
    buildDesktop(process.argv[2], process.argv.slice(3)).catch(error => {
        console.error(error.stack || error.message || String(error));
        process.exitCode = 1;
        // 清理监听器不能把失败的构建变成成功。
        process.on('exit', () => { process.exitCode = 1; });
    });
}
