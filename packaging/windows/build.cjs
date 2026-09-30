// 构建 Windows 安装包（NSIS .exe）。
//
// 两条路径：
//
//   Windows 主机：先编译 C++ 后端，再由 electron-builder 生成本机安装包；
//   Linux 主机：用 Zig 交叉编译后端（build-backend.mjs），再由 electron-builder 交叉打包，
//               此时 NSIS 需要一个能运行 Windows 工具的运行时，因此用便携版 Wine。
//
// 两条路径产出同一个产品：WiFiMeter Demo，64 位，未签名，始终随包分发 wifimeter-backend.exe。

const path = require('node:path');

const appDir = path.resolve(__dirname, '../../apps/desktop');
const repositoryRoot = path.resolve(__dirname, '../..');
// 缓存都放在仓库内：开发机与 CI 的 HOME 可能是只读的（沙箱、容器），
// 而 electron-builder 与 @electron/get 默认写 ~/.cache。
const crossBuildDirectory = path.join(repositoryRoot, '.cross-build');

function requireFromApp(name) {
    return require(require.resolve(name, { paths: [appDir] }));
}

async function main() {
    const isWindows = process.platform === 'win32';

    if (isWindows) {
        // Windows 上没有交叉工具链，直接用本机的 CMake 构建后端。
        require('../build-backend.cjs').buildBackend();
    } else {
        const { buildWindowsBackend } = await import('./build-backend.mjs');
        const { ensureWine } = await import('./wine.mjs');
        buildWindowsBackend();
        // electron-builder 在非 Windows 主机上打包 NSIS 时需要 wine 来执行 Windows 工具，
        // 它只在 PATH 里找 wine，因此把便携版所在目录加到最前面。
        const wine = process.env.WIFIMETER_WINE || ensureWine(repositoryRoot);
        process.env.WIFIMETER_WINE = wine;
        process.env.PATH = `${path.dirname(wine)}${path.delimiter}${process.env.PATH}`;
        // wine 的默认 prefix 是 ~/.wine，在只读 HOME 下无法创建；固定到仓库内。
        process.env.WINEPREFIX = process.env.WINEPREFIX || path.join(crossBuildDirectory, 'wine-prefix');
    }

    // 未签名的演示版：不查找签名凭据，也不发布。
    process.env.CSC_IDENTITY_AUTO_DISCOVERY = 'false';
    // 缓存都改到仓库内：@electron/get 用 electron_config_cache，
    // app-builder-lib 用 XDG_CACHE_HOME 或 HOME 下的 .cache，两者在只读 HOME 下都会失败。
    const cacheDirectory = path.join(crossBuildDirectory, 'cache');
    process.env.XDG_CACHE_HOME = process.env.XDG_CACHE_HOME || cacheDirectory;
    process.env.ELECTRON_CACHE = process.env.ELECTRON_CACHE || path.join(crossBuildDirectory, 'electron');
    process.env.electron_config_cache = process.env.electron_config_cache || process.env.ELECTRON_CACHE;
    process.env.ELECTRON_BUILDER_CACHE = process.env.ELECTRON_BUILDER_CACHE || path.join(crossBuildDirectory, 'electron-builder');
    for (const key of ['CSC_LINK', 'CSC_KEY_PASSWORD', 'WIN_CSC_LINK', 'WIN_CSC_KEY_PASSWORD']) delete process.env[key];

    const { build, Platform, Arch } = requireFromApp('electron-builder');
    await build({
        projectDir: appDir,
        config: path.join(__dirname, 'electron-builder.cjs'),
        targets: Platform.WINDOWS.createTarget(['nsis'], Arch.x64),
        publish: 'never'
    });
}

main().catch(error => {
    console.error(error.stack || error.message);
    process.exitCode = 1;
});
