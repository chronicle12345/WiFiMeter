import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createLinuxFileIcons, validPng } = require('../tauri/linux-icons.cjs');
const { createNativeAdapter } = require('../tauri/native-adapter.cjs');
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
const desktopValue = value => value.replaceAll('\\', '\\\\');

async function fixture(t) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wifimeter-linux-icons-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const user = path.join(root, 'user'), system = path.join(root, 'system');
    await Promise.all([fs.mkdir(path.join(user, 'applications'), { recursive: true }), fs.mkdir(path.join(system, 'applications'), { recursive: true })]);
    const env = { HOME: root, XDG_DATA_HOME: user, XDG_DATA_DIRS: system, GTK_ICON_THEME: 'Fixture' };
    const write = async (relative, data) => { const file = path.join(root, relative); await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, data); return file; };
    return { root, env, write };
}

test('Linux 图标读取用户 desktop 与继承主题中的 PNG，缓存后不重复查询系统', async t => {
    const { env, write } = await fixture(t);
    await write('user/applications/browser.desktop', '[Desktop Entry]\nType=Application\nExec=/usr/bin/browser %U\nIcon=fixture-browser\n');
    await write('system/icons/Fixture/index.theme', '[Icon Theme]\nDirectories=64x64/apps\nInherits=Parent\n');
    await write('system/icons/Parent/index.theme', '[Icon Theme]\nDirectories=64x64/apps\n');
    const icon = await write('system/icons/Parent/64x64/apps/fixture-browser.png', png);
    const calls = [];
    const icons = createLinuxFileIcons({ env, executeAsync: async (...args) => { calls.push(args); throw Error('不应转换现有 PNG'); } });
    const result = await icons.get('/usr/bin/browser');
    assert.equal(result.isEmpty(), false);
    assert.equal(result.toDataURL(), 'data:image/png;base64,' + png.toString('base64'));
    await fs.unlink(icon);
    assert.equal((await icons.get('/usr/bin/browser')).toDataURL(), result.toDataURL());
    assert.deepEqual(calls, []);
});

test('同名用户 desktop 隐藏条目覆盖系统条目，不运行应用程序', async t => {
    const { env, write } = await fixture(t);
    const icon = await write('system/pixmaps/browser.png', png);
    await write('user/applications/browser.desktop', '[Desktop Entry]\nType=Application\nHidden=true\nExec=/usr/bin/browser\n');
    await write('system/applications/browser.desktop', `[Desktop Entry]\nType=Application\nExec=/usr/bin/browser\nIcon=${desktopValue(icon)}\n`);
    const icons = createLinuxFileIcons({ env, executeAsync: async () => { throw Error('不应调用系统命令'); } });
    assert.equal((await icons.get('/usr/bin/browser')).isEmpty(), true);
});

test('desktop 启动路径为符号链接时仍可识别实际进程的可执行文件', async t => {
    const { env, write } = await fixture(t);
    const icon = await write('system/pixmaps/browser.png', png);
    await write('system/applications/browser.desktop', `[Desktop Entry]\nType=Application\nExec=/usr/bin/browser\nIcon=${desktopValue(icon)}\n`);
    const icons = createLinuxFileIcons({ env, io: { ...fs, realpath: async file => {
        if (file === '/usr/bin/browser') return '/opt/browser/browser-bin';
        return file;
    } } });
    assert.equal((await icons.get('/opt/browser/browser-bin')).isEmpty(), false);
});

test('SVG 图标仅交给 thumbnailer 转换为验证后的 PNG，并清理临时目录', async t => {
    const { env, write, root } = await fixture(t);
    const icon = await write('system/pixmaps/browser.svg', '<svg xmlns="http://www.w3.org/2000/svg"/>');
    await write('system/applications/browser.desktop', `[Desktop Entry]\nType=Application\nExec="/opt/Fixture Browser/browser" %U\nIcon=${desktopValue(icon)}\n`);
    let output;
    const icons = createLinuxFileIcons({ env, temporaryRoot: root, executeAsync: async (command, args, options) => {
        assert.equal(command, 'gdk-pixbuf-thumbnailer');
        assert.deepEqual(args.slice(0, 3), ['--size', '64', icon]);
        assert.equal(options.shell, false);
        output = args[3];
        await fs.writeFile(output, png);
        return { stdout: '', stderr: '' };
    } });
    assert.equal((await icons.get('/opt/Fixture Browser/browser')).isEmpty(), false);
    await assert.rejects(fs.stat(path.dirname(output)), { code: 'ENOENT' });
});

test('转换工具缺失时保留默认图标并清理临时目录', async t => {
    const { env, write, root } = await fixture(t);
    const icon = await write('system/pixmaps/browser.xpm', '/* XPM */');
    await write('system/applications/browser.desktop', `[Desktop Entry]\nType=Application\nExec=browser\nIcon=${desktopValue(icon)}\n`);
    let output;
    const icons = createLinuxFileIcons({ env, temporaryRoot: root, executeAsync: async (_command, args) => { output = args[3]; throw Object.assign(Error('缺少 thumbnailer'), { code: 'ENOENT' }); } });
    assert.equal((await icons.get('/usr/bin/browser')).isEmpty(), true);
    await assert.rejects(fs.stat(path.dirname(output)), { code: 'ENOENT' });
});

test('拒绝损坏 PNG、相对程序路径与越界主题目录', async t => {
    assert.equal(validPng(png), true);
    const damaged = Buffer.from(png); damaged[damaged.length - 1] ^= 1;
    assert.equal(validPng(damaged), false);
    assert.equal(validPng(png.subarray(0, 33)), false);
    const { env, write } = await fixture(t);
    await write('system/applications/browser.desktop', '[Desktop Entry]\nType=Application\nExec=browser\nIcon=browser\n');
    await write('system/icons/Fixture/index.theme', '[Icon Theme]\nDirectories=../../outside\n');
    await write('system/outside/browser.png', png);
    const icons = createLinuxFileIcons({ env, executeAsync: async () => { throw Error('不应转换'); } });
    assert.equal((await icons.get('/usr/bin/browser')).isEmpty(), true);
    assert.equal((await icons.get('browser')).isEmpty(), true);
});

test('扫描数量上限限制 desktop 文件读取', async t => {
    const { env, write } = await fixture(t);
    await write('user/applications/one.desktop', '[Desktop Entry]\nType=Application\nExec=one\nIcon=one\n');
    await write('user/applications/two.desktop', '[Desktop Entry]\nType=Application\nExec=two\nIcon=two\n');
    let reads = 0;
    const icons = createLinuxFileIcons({ env, maxDesktopEntries: 1, io: { ...fs, readFile: async (...args) => { if (String(args[0]).endsWith('.desktop')) reads++; return fs.readFile(...args); } } });
    await icons.get('/usr/bin/unknown');
    assert.equal(reads, 1);
});

test('适配器按平台查询图标，Linux 不调用 Windows PowerShell', async () => {
    const commands = [];
    const executeAsync = async (command, args) => { commands.push({ command, args }); return { stdout: png.toString('base64') }; };
    const configuration = { userData: os.tmpdir(), appExe: process.execPath };
    const linux = createNativeAdapter({ send() {}, configuration: { ...configuration, platform: 'linux' }, executeAsync });
    assert.equal((await linux.app.getFileIcon('relative-program')).isEmpty(), true);
    assert.deepEqual(commands, []);
    const windows = createNativeAdapter({ send() {}, configuration: { ...configuration, platform: 'win32' }, executeAsync });
    assert.equal((await windows.app.getFileIcon('C:\\Program Files\\Browser\\browser.exe')).toDataURL(), 'data:image/png;base64,' + png.toString('base64'));
    assert.equal(commands.length, 1);
    assert.match(commands[0].command, /WindowsPowerShell.*powershell\.exe$/);
    assert.ok(commands[0].args.includes('-EncodedCommand'));
});
