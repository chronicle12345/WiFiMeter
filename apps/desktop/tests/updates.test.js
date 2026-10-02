import { createRequire } from 'node:module';
import { updatesView } from '../renderer/ui/updates.js';
import { setLanguage } from '../renderer/i18n.js';
const require = createRequire(import.meta.url);
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { createUpdateService } = require('../electron/updates.cjs');

const page = 'https://github.com/chronicle12345/WiFiMeter/releases/tag/v1.3.0';
const bytes = Buffer.from('mock installer');
const digest = 'sha256:' + createHash('sha256').update(bytes).digest('hex');
function release() {
    return { tag_name: 'v1.3.0', body: 'Release notes', html_url: page, draft: false, prerelease: false,
        assets: ['x64', 'ia32', 'arm64'].map(arch => ({
            name: `WiFiMeter-1.3.0-${arch}-Setup.exe`, digest,
            browser_download_url: `${page.replace('/tag/', '/download/')}/WiFiMeter-1.3.0-${arch}-Setup.exe`
        })) };
}
async function fixture(t, options = {}) {
    const userData = await fs.mkdtemp(path.join(os.tmpdir(), 'wifimeter-updates-'));
    t.after(() => fs.rm(userData, { recursive: true, force: true }));
    const calls = [], events = [];
    const config = { currentVersion: '1.2.0', platform: 'win32', arch: 'x64', userData,
        fetch: async (url, init) => {
            calls.push({ url, init });
            return url.includes('api.github.com') ? Response.json(release()) : new Response(bytes);
        },
        confirm: async () => { events.push('confirm'); return true; },
        beforeInstall: async () => { events.push('stop'); },
        launchInstaller: async (file, argv) => {
            assert.deepEqual(await fs.readFile(file), bytes);
            assert.deepEqual(argv, []);
            events.push('launch');
        },
        openExternal: async url => { events.push(url); }, ...options };
    return { service: createUpdateService(config), config, calls, events, userData };
}

test('preferences persist independently and automatic checks can be disabled', async t => {
    const f = await fixture(t);
    assert.deepEqual(await f.service.settings(), { checkOnStartup: true });
    await f.service.setCheckOnStartup(false);
    const other = createUpdateService(f.config);
    assert.deepEqual(await other.settings(), { checkOnStartup: false });
    assert.equal((await other.check({ automatic: true })).skipped, 'disabled');
    assert.equal(f.calls.length, 0);
    assert.equal((await other.check()).state, 'available');
    assert.deepEqual((await fs.readdir(f.userData)), ['update-preferences.json']);
});

test('automatic checks are limited across restarts; manual checks bypass the limit', async t => {
    const f = await fixture(t);
    await Promise.all([f.service.check({ automatic: true }), f.service.check({ automatic: true })]);
    assert.equal(f.calls.length, 1);
    assert.equal((await createUpdateService(f.config).check({ automatic: true })).skipped, 'cached');
    await f.service.check();
    assert.equal(f.calls.length, 2);
});

for (const [currentVersion, tag, expected] of [
    ['1.2.0', 'v1.1.1', 'latest'], ['1.3.0+local', 'v1.3.0', 'latest'],
    ['1.2.0', 'v1.10.0', 'available'], ['1.3.0-rc.2', 'v1.3.0', 'available'],
    ['1.3.0-rc.10', 'v1.3.0-rc.2', 'error'], ['1.2.0', 'garbage', 'error']
]) test(`semver ${currentVersion} / ${tag}`, async t => {
    const f = await fixture(t, { currentVersion, fetch: async () => Response.json({ ...release(), tag_name: tag }) });
    assert.equal((await f.service.check()).state, expected);
});

for (const arch of ['x64', 'ia32', 'arm64']) test(`Windows ${arch} installs only matching Setup.exe after confirmation`, async t => {
    const f = await fixture(t, { arch });
    const result = await f.service.check();
    assert.equal(result.canInstall, true);
    assert.equal(result.notes, 'Release notes');
    assert.equal(result.currentVersion, '1.2.0');
    assert.equal(result.latestVersion, '1.3.0');
    assert.equal(result.url, page);
    assert.equal((await f.service.install()).state, 'installing');
    assert.match(f.calls[1].url, new RegExp(`-${arch}-Setup.exe$`));
    assert.deepEqual(f.events, ['confirm', 'stop', 'launch']);
    assert.equal(f.calls[1].init.redirect, 'manual');
});

test('cancellation downloads nothing and never stops the backend', async t => {
    const f = await fixture(t, { confirm: async () => false });
    await f.service.check();
    assert.equal((await f.service.install()).state, 'cancelled');
    assert.equal(f.calls.length, 1);
    assert.deepEqual(f.events, []);
});

for (const badDigest of [undefined, 'sha256:' + '0'.repeat(64)]) test(`digest required and verified: ${badDigest}`, async t => {
    const data = release();
    data.assets.forEach(asset => { asset.digest = badDigest; });
    const f = await fixture(t, { fetch: async url => url.includes('api.github.com') ? Response.json(data) : new Response(bytes) });
    await f.service.check();
    const result = await f.service.install();
    assert.equal(result.state, badDigest ? 'error' : 'manual');
    assert.ok(!f.events.includes('stop'));
    assert.ok(!f.events.includes('launch'));
    const files = await fs.readdir(path.join(f.userData, 'updates')).catch(() => []);
    assert.deepEqual(files, []);
});

test('Linux returns manual and opens only the official release page', async t => {
    const f = await fixture(t, { platform: 'linux' });
    const result = await f.service.check();
    assert.equal(result.canInstall, false);
    assert.equal(result.manual, true);
    assert.equal((await f.service.install()).state, 'manual');
    assert.deepEqual(f.events, ['confirm', page]);
    assert.equal(f.calls.length, 1);
});

test('network errors are visible, sanitized, and automatically rate limited', async t => {
    const f = await fixture(t, { fetch: async () => { throw Error('secret-token local-path SSID'); } });
    const result = await f.service.check({ automatic: true });
    assert.equal(result.state, 'error');
    assert.ok(result.error);
    assert.equal(JSON.stringify(result).includes('secret-token'), false);
    assert.equal((await f.service.check({ automatic: true })).skipped, 'cached');
    assert.equal((await fs.readFile(path.join(f.userData, 'update-preferences.json'), 'utf8')).includes('secret-token'), false);
});

test('an arbitrary asset host cannot be fetched or launched', async t => {
    const data = release();
    data.assets[0].browser_download_url = 'https://evil.example/Setup.exe';
    const f = await fixture(t, { fetch: async url => {
        assert.ok(url.startsWith('https://api.github.com/'));
        return Response.json(data);
    } });
    assert.equal((await f.service.check()).canInstall, false);
    assert.equal((await f.service.install()).state, 'manual');
    assert.ok(!f.events.includes('launch'));
});

test('download redirects to arbitrary hosts are rejected', async t => {
    const f = await fixture(t, { fetch: async url => url.includes('api.github.com')
        ? Response.json(release()) : new Response(null, { status: 302, headers: { location: 'https://evil.example/a.exe' } }) });
    await f.service.check();
    assert.equal((await f.service.install()).state, 'error');
    assert.deepEqual(f.events, ['confirm']);
});

test('UI status mirrors state and confirmation includes a usable message', async t => {
    let message;
    const f = await fixture(t, { confirm: async value => { message = value; return false; } });
    const checked = await f.service.check();
    assert.equal(checked.status, 'available');
    const installed = await f.service.install();
    assert.equal(installed.status, 'cancelled');
    assert.equal(message.title, '安装 WiFiMeter 更新');
    assert.match(message.message, /1\.3\.0/);
    assert.match(message.detail, /退出/);
    assert.equal(message.currentVersion, '1.2.0');
    assert.equal(message.url, page);
});

for (const contents of ['broken json', 'null', '{}', '{"checkOnStartup":"yes"}']) {
    test(`malformed preferences fail closed: ${contents}`, async t => {
        const f = await fixture(t);
        await fs.writeFile(path.join(f.userData, 'update-preferences.json'), contents);
        await assert.rejects(f.service.settings(), /偏好设置/);
        const result = await f.service.check({ automatic: true });
        assert.equal(result.status, 'error');
        assert.equal(result.checkOnStartup, false);
        assert.match(result.error, /偏好设置/);
        assert.equal(f.calls.length, 0);
        assert.equal(await fs.readFile(path.join(f.userData, 'update-preferences.json'), 'utf8'), contents);
        await fs.writeFile(path.join(f.userData, 'update-preferences.json'), '{"checkOnStartup":false}');
        assert.deepEqual(await f.service.settings(), { checkOnStartup: false });
    });
}

test('a failed preference write disables automatic checks in memory', async t => {
    const f = await fixture(t);
    await f.service.settings();
    await fs.mkdir(path.join(f.userData, 'update-preferences.json'));
    await assert.rejects(f.service.setCheckOnStartup(true), /偏好设置/);
    assert.equal((await f.service.check({ automatic: true })).checkOnStartup, false);
    assert.equal(f.calls.length, 0);
});

test('GitHub asset redirects are streamed and verified', async t => {
    const cdn = 'https://release-assets.githubusercontent.com/github-production-release-asset/123/asset?sig=test';
    const f = await fixture(t, { fetch: async url => {
        if (url.includes('api.github.com')) return Response.json(release());
        if (url === cdn) return new Response(new ReadableStream({ start(controller) {
            controller.enqueue(bytes.subarray(0, 4));
            controller.enqueue(bytes.subarray(4));
            controller.close();
        } }));
        return new Response(null, { status: 302, headers: { location: cdn } });
    } });
    await f.service.check();
    assert.equal((await f.service.install()).status, 'installing');
    assert.deepEqual(f.events, ['confirm', 'stop', 'launch']);
});

test('backend stop failure prevents installer launch', async t => {
    const f = await fixture(t, { beforeInstall: async () => { throw Error('stop timeout'); } });
    await f.service.check();
    assert.equal((await f.service.install()).status, 'error');
    assert.deepEqual(f.events, ['confirm']);
    assert.deepEqual(await fs.readdir(path.join(f.userData, 'updates')), []);
});

test('missing confirmation cannot authorize installation', async t => {
    const f = await fixture(t, { confirm: undefined });
    await f.service.check();
    assert.equal((await f.service.install()).status, 'cancelled');
    assert.equal(f.calls.length, 1);
});

test('latest version and unknown architecture never launch an installer', async t => {
    const f = await fixture(t, { currentVersion: '9.0.0' });
    assert.equal((await f.service.install()).status, 'latest');
    assert.deepEqual(f.events, []);
    const unknown = await fixture(t, { arch: 'mips' });
    assert.equal((await unknown.service.check()).manual, true);
    assert.equal((await unknown.service.install()).status, 'manual');
    assert.deepEqual(unknown.events, ['confirm', page]);
});

for (const arch of ['x64', 'ia32', 'arm64']) test(`Windows ${arch} prefers platform-qualified assets while retaining legacy names`, async t => {
    const data = release();
    data.assets.push(...data.assets.map(asset => ({ ...asset,
        name: asset.name.replace('1.3.0-', '1.3.0-windows-'),
        browser_download_url: asset.browser_download_url.replace('WiFiMeter-1.3.0-', 'WiFiMeter-1.3.0-windows-')
    })));
    const downloads = [];
    const f = await fixture(t, { arch, fetch: async url => {
        if (url.includes('api.github.com')) return Response.json(data);
        downloads.push(url); return new Response(bytes);
    } });
    assert.equal((await f.service.check()).canInstall, true);
    assert.equal((await f.service.install()).state, 'installing');
    assert.deepEqual(downloads, [`${page.replace('/tag/', '/download/')}/WiFiMeter-1.3.0-windows-${arch}-Setup.exe`]);
});

test('a release without an asset array remains available for manual installation', async t => {
    const f = await fixture(t, { fetch: async () => Response.json({ ...release(), assets: {} }) });
    const status = await f.service.check();
    assert.equal(status.state, 'available');
    assert.equal(status.canInstall, false);
    assert.equal(status.manual, true);
});

for (const knownLength of [true, false]) test(`stream progress reports real bytes, known length=${knownLength}`, async t => {
    const statuses = [];
    const f = await fixture(t, { onProgress: value => statuses.push(value), fetch: async url => {
        if (url.includes('api.github.com')) return Response.json(release());
        return new Response(new ReadableStream({ async start(controller) {
            controller.enqueue(bytes.subarray(0, 4));
            await new Promise(resolve => setTimeout(resolve, 130));
            controller.enqueue(bytes.subarray(4, 8));
            controller.enqueue(bytes.subarray(8));
            controller.close();
        } }), { headers: knownLength ? { 'content-length': String(bytes.length) } : {} });
    } });
    const result = await f.service.install();
    assert.equal(result.state, 'installing');
    assert.equal(statuses[0].state, 'checking');
    const downloading = statuses.filter(value => value.state === 'downloading');
    assert.equal(downloading[0].progress.receivedBytes, 0);
    assert.ok(downloading.some(value => value.progress.receivedBytes > 0 && value.progress.receivedBytes < bytes.length));
    assert.ok(downloading.length <= 4, 'rapid chunks must be throttled between the forced start and end');
    assert.equal(downloading.at(-1).progress.receivedBytes, bytes.length);
    assert.equal(downloading.at(-1).progress.percent, knownLength ? 100 : null);
    for (const value of statuses) {
        assert.equal(value.status, value.state);
        assert.equal(value.currentVersion, '1.2.0');
        if (value.progress) {
            assert.equal(value.progress.phase, value.state);
            if (value.state !== 'downloading' || !knownLength) assert.equal(value.progress.percent, null);
        }
    }
    assert.deepEqual(statuses.slice(-3).map(value => value.state), ['verifying', 'preparing', 'installing']);
    assert.equal(result.progress.percent, null);
});

test('digest failure clears progress and never emits preparing or installing; retry clears error', async t => {
    const statuses = [];
    const f = await fixture(t, { onProgress: value => statuses.push(value), fetch: async url =>
        url.includes('api.github.com') ? Response.json(release()) : new Response('corrupt') });
    assert.equal((await f.service.install()).state, 'error');
    assert.equal(statuses.at(-1).progress, null);
    assert.equal(statuses.some(value => ['preparing', 'installing'].includes(value.state)), false);
    assert.deepEqual(f.events, ['confirm']);
    await f.service.check();
    assert.equal(statuses.at(-1).state, 'available');
    assert.equal(statuses.at(-1).error, undefined);
});

for (const asynchronous of [false, true]) test(`observer failure cannot interrupt updates, async=${asynchronous}`, async t => {
    let observations = 0;
    const f = await fixture(t, { onProgress: () => {
        observations++;
        if (asynchronous) return Promise.reject(Error('observer'));
        throw Error('observer');
    } });
    assert.equal((await f.service.install()).state, 'installing');
    await new Promise(setImmediate);
    assert.ok(observations > 0);
    assert.deepEqual(f.events, ['confirm', 'stop', 'launch']);
});

test('confirmation cancellation is published and checks cannot replace an active install', async t => {
    const statuses = [];
    let finishConfirm;
    const f = await fixture(t, { onProgress: value => statuses.push(value), confirm: () => new Promise(resolve => { finishConfirm = resolve; }) });
    await f.service.check();
    const pending = f.service.install();
    await new Promise(setImmediate);
    assert.equal((await f.service.check()).state, 'busy');
    assert.equal((await f.service.install()).state, 'busy');
    assert.equal(f.calls.length, 1);
    finishConfirm(false);
    assert.equal((await pending).state, 'cancelled');
    assert.equal(statuses.at(-1).state, 'cancelled');
    assert.equal(statuses.at(-1).progress, null);
});


test('a failed stream clears progress, removes the partial file, and does not prepare installation', async t => {
    const statuses = [];
    const f = await fixture(t, { onProgress: value => statuses.push(value), fetch: async url => {
        if (url.includes('api.github.com')) return Response.json(release());
        return new Response(new ReadableStream({ async start(controller) {
            controller.enqueue(bytes.subarray(0, 4));
            await new Promise(resolve => setTimeout(resolve, 20));
            controller.error(Error('stream interrupted'));
        } }));
    } });
    assert.equal((await f.service.install()).progress, null);
    assert.equal(statuses.at(-1).state, 'error');
    assert.equal(statuses.some(value => ['verifying', 'preparing', 'installing'].includes(value.state)), false);
    assert.deepEqual(f.events, ['confirm']);
    assert.deepEqual(await fs.readdir(path.join(f.userData, 'updates')), []);
});

test('preparation and handoff hooks see their phase without an installation percentage', async t => {
    let status;
    const f = await fixture(t, { onProgress: value => { status = value; },
        beforeInstall: async () => { assert.equal(status.state, 'preparing'); assert.equal(status.progress.percent, null); },
        launchInstaller: async () => { assert.equal(status.state, 'installing'); assert.equal(status.progress.percent, null); }
    });
    assert.equal((await f.service.install()).state, 'installing');
});

for (const phase of ['downloading', 'verifying', 'preparing', 'installing']) test(`installation failure identifies ${phase} without leaking download URLs`, async t => {
    const options = {};
    if (phase === 'downloading') options.fetch = async url => {
        if (url.includes('api.github.com')) return Response.json(release());
        throw Object.assign(Error('fetch failed https://signed.example/secret?token=private'), { cause: { code: 'ECONNRESET' } });
    };
    if (phase === 'verifying') options.fetch = async url => url.includes('api.github.com') ? Response.json(release()) : new Response('changed');
    if (phase === 'preparing') options.beforeInstall = async () => { throw Error('Collector has not finished saving.'); };
    if (phase === 'installing') options.launchInstaller = async () => {
        throw Object.assign(Error('Update helper closed before READY.'), { code: 'HANDOFF_CLOSED_BEFORE_READY' });
    };
    const f = await fixture(t, options);
    const result = await f.service.install();
    assert.equal(result.state, 'error');
    assert.equal(result.errorPhase, phase);
    assert.equal(result.progress, null);
    const labels = { downloading: '下载更新失败', verifying: '更新文件 SHA-256 校验失败',
        preparing: '准备安装更新失败', installing: '启动更新辅助程序失败' };
    assert.ok(result.error.startsWith(labels[phase]));
    assert.doesNotMatch(result.error, /signed\.example|token=private/);
    if (phase === 'downloading') assert.equal(result.errorCode, 'ECONNRESET');
    if (phase === 'preparing') assert.match(result.error, /Collector has not finished saving/);
    if (phase === 'installing') assert.equal(result.errorCode, 'HANDOFF_CLOSED_BEFORE_READY');
    await f.service.check();
    assert.equal((await f.service.check()).errorPhase, undefined);
});

test('update errors translate fixed explanations while preserving local paths and recovery errors', async t => {
    const localPath = 'C:\\每月报告\\每日记录.exe';
    const f = await fixture(t, { beforeInstall: async () => { throw Error(`Cannot save ${localPath}`); } });
    const result = await f.service.install();
    assert.match(updatesView(result), /准备安装更新失败/);
    setLanguage('en');
    try {
        const html = updatesView(result);
        assert.match(html, /Update preparation failed/);
        assert.ok(html.includes(localPath));
        const helper = await fixture(t, { launchInstaller: async () => {
            throw Object.assign(Error('Update helper closed before READY.'), { code: 'HANDOFF_CLOSED_BEFORE_READY' });
        } });
        const helperHtml = updatesView(await helper.service.install());
        assert.match(helperHtml, /Could not start the update helper/);
        assert.match(helperHtml, /closed communication before it was ready/);
        assert.doesNotMatch(helperHtml, /辅助进程/);
        const recovery = updatesView({ ...result, recoveryRequired: true, error: 'Specific recovery failure' });
        assert.match(recovery, /Specific recovery failure/);
        assert.doesNotMatch(recovery, /Update preparation failed/);
    } finally { setLanguage('zh-CN'); }
});
