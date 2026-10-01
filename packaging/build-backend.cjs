const path = require('node:path');
const fs = require('node:fs');
const { execFileSync } = require('node:child_process');

function cacheValue(cache, key) {
    return cache.split(/\r?\n/).find(line => line.startsWith(`${key}:`))?.split('=').slice(1).join('=') || '';
}

function windowsGeneratorOptions({ arch, cache = '', generator, generators = [], hostArch = process.arch, toolchain, cachedArch = hostArch }) {
    const platform = { x64: 'x64', arm64: 'ARM64', ia32: 'Win32' }[arch];
    const cachedGenerator = cacheValue(cache, 'CMAKE_GENERATOR');
    if (cachedGenerator) {
        const cachedPlatform = cacheValue(cache, 'CMAKE_GENERATOR_PLATFORM');
        if (cachedGenerator.startsWith('Visual Studio') && cachedPlatform !== platform) {
            throw new Error(`CMake 缓存架构不匹配：${cachedPlatform}，目标为 ${platform}。`);
        }
        if (!cachedGenerator.startsWith('Visual Studio') && arch !== cachedArch && !toolchain && !cacheValue(cache, 'CMAKE_TOOLCHAIN_FILE')) {
            throw new Error('现有非 Visual Studio 工具链仅支持本机架构；跨架构需要显式指定 CMAKE_TOOLCHAIN_FILE。');
        }
        return [];
    }
    generator ||= generators.filter(name => name.startsWith('Visual Studio '))
        .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))[0];
    const options = generator ? ['-G', generator] : [];
    if (generator?.startsWith('Visual Studio ')) options.push('-A', platform);
    else if (arch !== hostArch && !toolchain) {
        throw new Error('跨架构需要 Visual Studio 生成器或显式指定 CMAKE_TOOLCHAIN_FILE；Ninja/MinGW 默认仅支持本机架构。');
    }
    if (toolchain) options.push(`-DCMAKE_TOOLCHAIN_FILE=${toolchain}`);
    return options;
}

function buildBackend({ arch = process.arch, linuxAppCapture = process.argv.includes('--linux-app-capture') } = {}) {
    const root = path.resolve(__dirname, '..');
    const { buildOptions, buildPaths, binaryArchitecture, assertArchitecture } = require('./targets.cjs');
    buildOptions(process.platform, ['--arch', arch]);
    const buildDirectory = buildPaths(process.platform, arch).backend;
    const options = linuxAppCapture ? ['-DWIFIMETER_LINUX_APP_CAPTURE=ON'] : [];
    const cacheFile = path.join(root, buildDirectory, 'CMakeCache.txt');
    const cache = fs.existsSync(cacheFile) ? fs.readFileSync(cacheFile, 'utf8') : '';
    const cmake = process.env.CMAKE_COMMAND || cacheValue(cache, 'CMAKE_COMMAND') || 'cmake';
    if (process.platform === 'win32') {
        const executable = path.join(root, buildDirectory, 'app/wifimeter-backend.exe');
        let cachedArch;
        if (cache && fs.existsSync(executable)) {
            assertArchitecture(executable, 'win32', arch);
            cachedArch = binaryArchitecture(executable).arch;
        }
        const generator = process.env.CMAKE_GENERATOR;
        const generators = cache || generator ? [] : JSON.parse(execFileSync(cmake, ['-E', 'capabilities'], { encoding: 'utf8' })).generators.map(item => item.name);
        options.push(...windowsGeneratorOptions({ arch, cache, generator, generators, cachedArch, toolchain: process.env.CMAKE_TOOLCHAIN_FILE }));
    }
    execFileSync(cmake, ['-S', 'backend', '-B', buildDirectory, '-DCMAKE_BUILD_TYPE=Release', ...options], { cwd: root, stdio: 'inherit' });
    execFileSync(cmake, ['--build', buildDirectory, '--target', 'wifimeter-backend', '--config', 'Release'], { cwd: root, stdio: 'inherit' });
}

module.exports = { buildBackend, windowsGeneratorOptions };

if (require.main === module) buildBackend();
