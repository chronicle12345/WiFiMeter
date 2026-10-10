'use strict';

// 仅裁剪桌面宿主未使用的功能；TLS、加密、fetch、流和中英文 ICU 数据均保留。
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { createHash } = require('node:crypto');
const { pipeline } = require('node:stream/promises');
const { execFileSync } = require('node:child_process');
const { assertArchitecture } = require('../targets.cjs');

const VERSION = '22.23.3';
const SOURCE_SHA256 = 'bd97093e1a1e9243338950c174a693a64d4e0926a9c6ce259962bc58d5e96909';
const SOURCE_URL = `https://nodejs.org/dist/v${VERSION}/node-v${VERSION}.tar.xz`;
const CONFIGURE_FLAGS = Object.freeze([
    '--with-intl=small-icu', '--with-icu-locales=root,en,zh,zh_Hans,zh_Hant',
    '--without-inspector', '--without-node-snapshot', '--without-node-code-cache',
    '--without-sqlite', '--without-amaro', '--without-npm', '--without-corepack',
    '--v8-disable-object-print'
]);
const repositoryRoot = path.resolve(__dirname, '../..');

function digest(file) {
    const hash = createHash('sha256');
    const descriptor = fs.openSync(file, 'r');
    const buffer = Buffer.alloc(1024 * 1024);
    try {
        let count;
        while ((count = fs.readSync(descriptor, buffer)) > 0) hash.update(buffer.subarray(0, count));
        return hash.digest('hex');
    } finally { fs.closeSync(descriptor); }
}

function options(args = process.argv.slice(2)) {
    const result = { arch: process.arch, jobs: Math.min(4, os.availableParallelism()),
        output: path.join(repositoryRoot, 'build/lean-node-runtime'), sourceRoot: path.join(repositoryRoot, 'build/lean-node') };
    for (let index = 0; index < args.length; index += 2) {
        if (!['--arch', '--jobs', '--output', '--source-root'].includes(args[index]) || !args[index + 1]) throw Error('使用 --arch、--jobs、--output 或 --source-root。');
        const value = args[index + 1];
        if (args[index] === '--arch') result.arch = value;
        else if (args[index] === '--jobs') result.jobs = Number(value);
        else result[args[index] === '--output' ? 'output' : 'sourceRoot'] = path.resolve(value);
    }
    if (!['win32', 'linux'].includes(process.platform) || !['x64', 'arm64', ...(process.platform === 'win32' ? ['ia32'] : [])].includes(result.arch)) throw Error('精简 Node 仅支持 Windows x64/ia32/arm64 和 Linux x64/arm64。');
    if (!Number.isInteger(result.jobs) || result.jobs < 1 || result.jobs > 32) throw Error('编译并行数必须为 1 到 32。');
    if (process.platform === 'linux' && result.arch !== process.arch) throw Error('Linux 精简 Node 必须在目标架构本机编译。');
    return result;
}

function run(executable, args, configuration = {}) {
    return execFileSync(executable, args, { stdio: 'inherit', windowsHide: true, ...configuration });
}

async function source(configuration) {
    fs.mkdirSync(configuration.sourceRoot, { recursive: true });
    const archive = path.join(configuration.sourceRoot, `node-v${VERSION}.tar.xz`);
    if (!fs.existsSync(archive)) {
        const response = await fetch(SOURCE_URL, { signal: AbortSignal.timeout(600000) });
        if (!response.ok || !response.body) throw Error(`下载 Node 源码失败：HTTP ${response.status}`);
        const temporary = `${archive}.part`;
        try {
            await pipeline(response.body, fs.createWriteStream(temporary, { flags: 'wx' }));
            if (digest(temporary) !== SOURCE_SHA256) throw Error('Node 官方源码 SHA-256 不符。');
            fs.renameSync(temporary, archive);
        } finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
    }
    if (digest(archive) !== SOURCE_SHA256) throw Error('缓存的 Node 官方源码 SHA-256 不符。');
    const directory = path.join(configuration.sourceRoot, `node-v${VERSION}`);
    const stamp = path.join(directory, '.wifimeter-source-sha256');
    if (!fs.existsSync(stamp) || fs.readFileSync(stamp, 'utf8').trim() !== SOURCE_SHA256) {
        // Windows 的 bsdtar 在部分系统中无法解码这个测试目录；它不参与宿主编译。
        run(process.env.WIFIMETER_TAR || 'tar', [`--exclude=node-v${VERSION}/test/fixtures/copy/utf`, '-xf', archive, '-C', configuration.sourceRoot]);
        fs.writeFileSync(stamp, SOURCE_SHA256 + '\n');
    }
    return directory;
}

function quoteBatch(value) {
    if (/["%\r\n&|<>^!]/.test(value)) throw Error('Windows 编译路径包含不支持的命令字符。');
    return `"${value}"`;
}

function visualStudio() {
    const vswhere = path.join(process.env['ProgramFiles(x86)'] || 'C:/Program Files (x86)', 'Microsoft Visual Studio/Installer/vswhere.exe');
    const installations = JSON.parse(execFileSync(vswhere,
        ['-all', '-prerelease', '-products', '*', '-requires', 'Microsoft.VisualStudio.Component.VC.Tools.x86.x64', '-format', 'json'],
        { encoding: 'utf8', windowsHide: true }));
    const installation = installations.find(item => /^1[78]\./.test(item.installationVersion));
    if (!installation) throw Error('缺少 Visual Studio 2022 或 2026 的 C++ 编译工具。');
    return { path: installation.installationPath, version: installation.installationVersion.startsWith('18.') ? '2026' : '2022' };
}

function compileWindows(directory, configuration) {
    const studio = visualStudio();
    const target = { x64: 'x64', ia32: 'x86', arm64: 'arm64' }[configuration.arch];
    const host = process.env.PROCESSOR_ARCHITECTURE === 'ARM64' ? 'arm64' : 'x64';
    const batch = path.join(configuration.sourceRoot, `compile-${configuration.arch}.cmd`);
    const flags = [...CONFIGURE_FLAGS, '--openssl-no-asm', '--with-ltcg', `--dest-cpu=${configuration.arch}`];
    if (configuration.arch === 'ia32') flags.push('--no-cross-compiling');
    const commands = [
        '@echo off',
        `call ${quoteBatch(path.join(studio.path, 'Common7/Tools/VsDevCmd.bat'))} -no_logo -arch=${target} -host_arch=${host}`,
        'if errorlevel 1 exit /b 1',
        `set GYP_MSVS_VERSION=${studio.version}`,
        `set GYP_MSVS_OVERRIDE_PATH=${studio.path}`,
        `set MultiProcMaxCount=${configuration.jobs}`,
        'set UseMultiToolTask=True', 'set EnforceProcessCountAcrossBuilds=True',
        `python configure ${flags.join(' ')}`,
        'if errorlevel 1 exit /b 1',
        `msbuild node.sln /t:node /m:2 /p:Configuration=Release /p:Platform=${configuration.arch === 'ia32' ? 'Win32' : target === 'arm64' ? 'ARM64' : 'x64'} /p:MultiProcMaxCount=${configuration.jobs} /clp:NoItemAndPropertyList;Verbosity=minimal /nologo`,
        'exit /b %errorlevel%'
    ];
    fs.writeFileSync(batch, commands.join('\r\n') + '\r\n');
    run('cmd.exe', ['/d', '/s', '/c', quoteBatch(batch)], { cwd: directory, windowsVerbatimArguments: true });
    return path.join(directory, 'out/Release/node.exe');
}

function compileLinux(directory, configuration) {
    run('python3', ['configure', ...CONFIGURE_FLAGS, `--dest-cpu=${configuration.arch}`], { cwd: directory });
    run('make', [`-j${configuration.jobs}`, 'node'], { cwd: directory });
    return path.join(directory, 'out/Release/node');
}

function validate(executable, configuration) {
    assertArchitecture(executable, process.platform, configuration.arch);
    const version = execFileSync(executable, ['-p', 'process.versions.node'], { encoding: 'utf8', windowsHide: true }).trim();
    if (version !== VERSION) throw Error(`精简 Node 版本不符：${version}，预期 ${VERSION}。`);
    run(executable, [path.join(__dirname, 'lean-node-check.cjs'), '--lean']);
}

async function build(configuration = options()) {
    fs.mkdirSync(configuration.output, { recursive: true });
    const nodeExecutable = path.join(configuration.output, process.platform === 'win32' ? 'node.exe' : 'node');
    const manifestPath = path.join(configuration.output, 'runtime-manifest.json');
    const license = path.join(configuration.output, 'LICENSE');
    let cached;
    try { cached = JSON.parse(fs.readFileSync(manifestPath, 'utf8')); } catch { /* 首次构建或不完整缓存会重新编译。 */ }
    const profile = CONFIGURE_FLAGS.join(' ');
    if (!(cached?.version === VERSION && cached.sourceSha256 === SOURCE_SHA256 && cached.profile === profile
        && cached.platform === process.platform && cached.arch === configuration.arch && fs.existsSync(nodeExecutable)
        && fs.existsSync(license) && cached.sha256 === digest(nodeExecutable))) {
        const directory = await source(configuration);
        const built = process.platform === 'win32' ? compileWindows(directory, configuration) : compileLinux(directory, configuration);
        validate(built, configuration);
        fs.copyFileSync(built, nodeExecutable);
        if (process.platform !== 'win32') fs.chmodSync(nodeExecutable, 0o755);
        fs.copyFileSync(path.join(directory, 'LICENSE'), license);
        fs.writeFileSync(manifestPath, JSON.stringify({ version: VERSION, platform: process.platform, arch: configuration.arch,
            sourceUrl: SOURCE_URL, sourceSha256: SOURCE_SHA256, profile, sha256: digest(nodeExecutable), bytes: fs.statSync(nodeExecutable).size }, null, 2) + '\n');
    } else validate(nodeExecutable, configuration);
    if (process.env.GITHUB_ENV) fs.appendFileSync(process.env.GITHUB_ENV,
        `WIFIMETER_NODE_EXECUTABLE=${nodeExecutable}\nWIFIMETER_NODE_LICENSE=${license}\nWIFIMETER_NODE_VERSION=${VERSION}\n`);
    const result = { nodeExecutable, nodeVersion: VERSION, license, manifest: manifestPath, bytes: fs.statSync(nodeExecutable).size };
    process.stdout.write(JSON.stringify(result) + '\n');
    return result;
}

module.exports = { VERSION, SOURCE_SHA256, SOURCE_URL, CONFIGURE_FLAGS, options, digest, build, validate };
if (require.main === module) build().catch(error => { console.error(error.message); process.exitCode = 1; });
