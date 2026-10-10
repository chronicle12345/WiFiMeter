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
const WINDOWS_SIZE_PROPS = path.join(__dirname, 'windows/node-size.props');

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
    return execFileSync(executable, args, { stdio: ['ignore', 'inherit', 'inherit'], windowsHide: true, ...configuration });
}

function phase(name, operation) {
    const started = Date.now();
    const log = status => process.stdout.write(`[lean-node] ${new Date().toISOString()} ${name}: ${status} (${Date.now() - started} ms)\n`);
    log('started');
    const complete = result => { log('completed'); return result; };
    const failed = error => { log('failed'); throw error; };
    try {
        const result = operation();
        return result && typeof result.then === 'function' ? result.then(complete, failed) : complete(result);
    } catch (error) { return failed(error); }
}

async function source(configuration) {
    fs.mkdirSync(configuration.sourceRoot, { recursive: true });
    const archive = path.join(configuration.sourceRoot, `node-v${VERSION}.tar.xz`);
    if (!fs.existsSync(archive)) {
        const temporary = `${archive}.part`;
        try {
            await phase('source download', async () => {
                const response = await fetch(SOURCE_URL, { signal: AbortSignal.timeout(600000) });
                if (!response.ok || !response.body) throw Error(`下载 Node 源码失败：HTTP ${response.status}`);
                await pipeline(response.body, fs.createWriteStream(temporary, { flags: 'wx' }));
            });
            phase('download verification', () => {
                if (digest(temporary) !== SOURCE_SHA256) throw Error('Node 官方源码 SHA-256 不符。');
            });
            fs.renameSync(temporary, archive);
        } finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
    }
    phase('source verification', () => {
        if (digest(archive) !== SOURCE_SHA256) throw Error('缓存的 Node 官方源码 SHA-256 不符。');
    });
    const directory = path.join(configuration.sourceRoot, `node-v${VERSION}`);
    const stamp = path.join(directory, '.wifimeter-source-sha256');
    if (!fs.existsSync(stamp) || fs.readFileSync(stamp, 'utf8').trim() !== SOURCE_SHA256) {
        let extractionArchive = archive;
        let temporaryDirectory;
        try {
            if (process.platform === 'win32') {
                // 完整 7-Zip 同时处理 XZ 和 tar，避免系统 tar 的 XZ 与 Unicode 路径问题。
                const { sevenZipExecutable } = require('./verify-windows.cjs');
                const sevenZip = sevenZipExecutable();
                temporaryDirectory = fs.mkdtempSync(path.join(configuration.sourceRoot, '.wifimeter-source-extract-'));
                extractionArchive = path.join(temporaryDirectory, `node-v${VERSION}.tar`);
                const descriptor = fs.openSync(extractionArchive, 'wx');
                try {
                    phase('source XZ decoding', () => run(sevenZip, ['x', '-txz', '-so', '-bd', '-y', archive],
                        { stdio: ['ignore', descriptor, 'inherit'], timeout: 900000 }));
                } finally { fs.closeSync(descriptor); }
                phase('source extraction', () => run(sevenZip,
                    ['x', '-ttar', '-bd', '-y', extractionArchive, `-o${configuration.sourceRoot}`], { timeout: 900000 }));
            } else {
                phase('source extraction', () => run(process.env.WIFIMETER_TAR || 'tar',
                    [`--exclude=node-v${VERSION}/test/fixtures/copy/utf`, '-xf', archive, '-C', configuration.sourceRoot], { timeout: 900000 }));
            }
            fs.writeFileSync(stamp, SOURCE_SHA256 + '\n');
        } finally {
            if (temporaryDirectory) {
                if (fs.existsSync(extractionArchive)) fs.unlinkSync(extractionArchive);
                fs.rmdirSync(temporaryDirectory);
            }
        }
    }
    return directory;
}

function quoteBatch(value) {
    if (/["%\r\n&|<>^!]/.test(value)) throw Error('Windows 编译路径包含不支持的命令字符。');
    return `"${value}"`;
}

function visualStudio() {
    const vswhere = path.join(process.env['ProgramFiles(x86)'] || 'C:/Program Files (x86)', 'Microsoft Visual Studio/Installer/vswhere.exe');
    const installations = phase('Visual Studio discovery', () => JSON.parse(run(vswhere,
        ['-all', '-prerelease', '-products', '*', '-requires', 'Microsoft.VisualStudio.Component.VC.Tools.x86.x64', '-format', 'json'],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 120000 })));
    const installation = installations.find(item => /^1[78]\./.test(item.installationVersion));
    if (!installation) throw Error('缺少 Visual Studio 2022 或 2026 的 C++ 编译工具。');
    return { path: installation.installationPath, version: installation.installationVersion.startsWith('18.') ? '2026' : '2022' };
}

function compileWindows(directory, configuration) {
    fs.accessSync(WINDOWS_SIZE_PROPS, fs.constants.R_OK);
    const studio = visualStudio();
    const target = { x64: 'x64', ia32: 'x86', arm64: 'arm64' }[configuration.arch];
    const host = process.env.PROCESSOR_ARCHITECTURE === 'ARM64' ? 'arm64' : 'x64';
    const environmentOutput = phase('Visual Studio initialization', () => {
        try {
            return run('cmd.exe', ['/d', '/s', '/c',
                `call ${quoteBatch(path.join(studio.path, 'Common7/Tools/VsDevCmd.bat'))} -no_logo -arch=${target} -host_arch=${host} >nul && set`],
            { cwd: directory, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 120000, windowsVerbatimArguments: true });
        } catch (error) {
            // 捕获的 stdout 包含环境变量；错误信息不能回显该输出。
            throw Error(error.code === 'ETIMEDOUT' ? 'Visual Studio 初始化超过 2 分钟。' : 'Visual Studio 初始化失败。');
        }
    });
    const env = {};
    for (const line of environmentOutput.split(/\r?\n/)) {
        const equals = line.indexOf('=');
        // Windows 环境变量名不区分大小写，统一后避免 PATH 等变量重复。
        if (equals > 0) env[line.slice(0, equals).toUpperCase()] = line.slice(equals + 1);
    }
    Object.assign(env, { GYP_MSVS_VERSION: studio.version, GYP_MSVS_OVERRIDE_PATH: studio.path,
        MULTIPROCMAXCOUNT: String(configuration.jobs), USEMULTITOOLTASK: 'True', ENFORCEPROCESSCOUNTACROSSBUILDS: 'True' });
    const flags = [...CONFIGURE_FLAGS, '--openssl-no-asm', '--with-ltcg', `--dest-cpu=${configuration.arch}`];
    if (configuration.arch === 'ia32') flags.push('--no-cross-compiling');
    phase('configure', () => run('python', ['-u', 'configure', ...flags], { cwd: directory, env, timeout: 600000 }));
    phase('MSBuild', () => run('msbuild', ['node.sln', '/t:node', '/m:2', '/p:Configuration=Release',
        `/p:Platform=${configuration.arch === 'ia32' ? 'Win32' : target === 'arm64' ? 'ARM64' : 'x64'}`,
        `/p:MultiProcMaxCount=${configuration.jobs}`, `/p:ForceImportBeforeCppTargets=${WINDOWS_SIZE_PROPS}`,
        '/clp:NoItemAndPropertyList;Verbosity=minimal', '/nologo'], { cwd: directory, env }));
    return path.join(directory, 'out/Release/node.exe');
}

function compileLinux(directory, configuration) {
    phase('configure', () => run('python3', ['-u', 'configure', ...CONFIGURE_FLAGS, `--dest-cpu=${configuration.arch}`],
        { cwd: directory, timeout: 600000 }));
    phase('make', () => run('make', [`-j${configuration.jobs}`, 'node'], { cwd: directory }));
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
    const profile = CONFIGURE_FLAGS.join(' ') + (process.platform === 'win32'
        ? ` msvc-release-minspace-size:${digest(WINDOWS_SIZE_PROPS)}` : '');
    if (!(cached?.version === VERSION && cached.sourceSha256 === SOURCE_SHA256 && cached.profile === profile
        && cached.platform === process.platform && cached.arch === configuration.arch && fs.existsSync(nodeExecutable)
        && fs.existsSync(license) && cached.sha256 === digest(nodeExecutable))) {
        const directory = await source(configuration);
        const built = process.platform === 'win32' ? compileWindows(directory, configuration) : compileLinux(directory, configuration);
        phase('runtime validation', () => validate(built, configuration));
        fs.copyFileSync(built, nodeExecutable);
        if (process.platform !== 'win32') fs.chmodSync(nodeExecutable, 0o755);
        fs.copyFileSync(path.join(directory, 'LICENSE'), license);
        fs.writeFileSync(manifestPath, JSON.stringify({ version: VERSION, platform: process.platform, arch: configuration.arch,
            sourceUrl: SOURCE_URL, sourceSha256: SOURCE_SHA256, profile, sha256: digest(nodeExecutable), bytes: fs.statSync(nodeExecutable).size }, null, 2) + '\n');
    } else phase('cached runtime validation', () => validate(nodeExecutable, configuration));
    if (process.env.GITHUB_ENV) fs.appendFileSync(process.env.GITHUB_ENV,
        `WIFIMETER_NODE_EXECUTABLE=${nodeExecutable}\nWIFIMETER_NODE_LICENSE=${license}\nWIFIMETER_NODE_VERSION=${VERSION}\n`);
    const result = { nodeExecutable, nodeVersion: VERSION, license, manifest: manifestPath, bytes: fs.statSync(nodeExecutable).size };
    process.stdout.write(JSON.stringify(result) + '\n');
    return result;
}

module.exports = { VERSION, SOURCE_SHA256, SOURCE_URL, CONFIGURE_FLAGS, options, digest, source, build, validate };
if (require.main === module) build().catch(error => { console.error(error.message); process.exitCode = 1; });
