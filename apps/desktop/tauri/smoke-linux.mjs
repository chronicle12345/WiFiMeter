// 真正的 WebKitGTK → Tauri IPC → C++ → SQLite，复用原有网卡及应用采集夹具。
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createHarness } from '../tests/support/backend-harness.mjs';

assert.equal(process.platform, 'linux');
const packaged = process.argv.includes('--packaged');
assert.ok(process.env.WIFIMETER_EXECUTABLE, 'Set WIFIMETER_EXECUTABLE to a Tauri build; use --packaged for Release validation');
const harness = await createHarness({ appId: '/usr/bin/sh' });
if (!packaged) {
    await mkdir(join(harness.directory, 'update-fixture'));
    await writeFile(join(harness.directory, 'update-fixture/release.json'), JSON.stringify({ tag_name: 'v1.3.0', body: 'Fixture notes', assets: [] }));
}
const server = createServer();
server.listen(0, '127.0.0.1');
await once(server, 'listening');
const port = server.address().port;
await new Promise(resolve => server.close(resolve));
const env = { ...process.env, ...harness.env, TAURI_WEBVIEW_AUTOMATION: 'true' };
if (packaged) delete env.WIFIMETER_BACKEND;
const driver = spawn(process.env.WEBKIT_WEBDRIVER || 'WebKitWebDriver', ['-p', String(port)], {
    detached: true, stdio: ['ignore', 'pipe', 'pipe'],
    env
});
let output = '', startError, session;
driver.on('error', error => { startError = error; });
for (const stream of [driver.stdout, driver.stderr]) stream.on('data', data => { output += data; process.stderr.write(data); });
async function request(path, body, method = body === undefined ? 'GET' : 'POST') {
    const response = await fetch(`http://127.0.0.1:${port}${path}`, {
        method, headers: { 'content-type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(40000)
    });
    const { value } = await response.json();
    assert.ok(response.ok, JSON.stringify(value));
    return value;
}
async function poll(operation, predicate = Boolean, timeout = 15000) {
    const until = Date.now() + timeout;
    let value;
    while (Date.now() < until) {
        value = await operation();
        if (predicate(value)) return value;
        await delay(100);
    }
    throw Error(`Timed out: ${JSON.stringify(value)}`);
}
const evaluate = (script, ...args) => request(`/session/${session}/execute/sync`, { script, args });
async function evaluateAsync(script, ...args) {
    const result = await request(`/session/${session}/execute/async`, {
        script: `const done = arguments[arguments.length - 1]; Promise.resolve((async () => { ${script} })()).then(value => done({value}), error => done({error: String(error)}));`, args
    });
    assert.equal(result.error, undefined);
    return result.value;
}
const click = selector => evaluate('document.querySelector(arguments[0]).click();', selector);
try {
    await poll(async () => {
        if (startError) throw startError;
        if (driver.exitCode !== null) throw Error(`Driver exited: ${output}`);
        return request('/status').catch(() => null);
    });
    const created = await request('/session', { capabilities: { alwaysMatch: {
        'webkitgtk:browserOptions': { binary: process.env.WIFIMETER_EXECUTABLE, args: [] }
    } } });
    session = created.sessionId;
    await request(`/session/${session}/timeouts`, { script: 30000 });
    await poll(() => evaluate('return Boolean(window.desktop && document.querySelector("#collector"));'));
    assert.equal(await evaluate('return window.desktop.platform;'), 'linux');
    assert.match(await poll(() => evaluate('return document.querySelector(".connection-title")?.textContent;'), value => value?.includes('家里的')), /家里的 Wi-Fi/);
    const snapshot = await evaluateAsync('return window.desktop.backend.request("snapshot");');
    assert.equal(snapshot.ok, true);
    assert.equal(snapshot.result.records[0].rxBytes, '3100000000');
    const notes = await evaluateAsync('return (await import("./ui/release-notes.js")).releaseNotes("**release**<script>bad()</script>");');
    assert.match(notes, /<strong>release<\/strong>/);
    assert.ok(!notes.includes('<script>'));
    for (const page of ['networks', 'history', 'settings', 'overview']) {
        await click(`.nav [data-page="${page}"]`);
        await poll(() => evaluate('return document.querySelector("#content").textContent.trim();'));
    }
    assert.deepEqual(await evaluateAsync('return window.desktop.legacy.status();'), { found: false });
    await evaluateAsync('return window.desktop.backend.request("setPaused", {paused:true});');
    assert.equal((await evaluateAsync('return window.desktop.backend.request("hello");')).result.paused, true);
    await evaluateAsync('return window.desktop.backend.request("setPaused", {paused:false});');
    console.log('Linux pages, real backend, stored traffic and pause/resume passed');

    await click('.nav [data-page="apps"]');
    await poll(() => evaluate('return [...document.querySelectorAll("button")].some(button => button.textContent === "启用应用采集");'));
    await evaluate('[...document.querySelectorAll("button")].find(button => button.textContent === "启用应用采集").click();');
    await evaluateAsync('return window.desktop.backend.request("collectNow");');
    harness.appCounters(80000000, 20000000);
    await evaluateAsync('return window.desktop.backend.request("collectNow");');
    const icon = await evaluateAsync('return window.desktop.appIcons.get({appId:"/usr/bin/sh"});');
    assert.match(icon, /^data:image\/png;base64,/);
    assert.equal(await evaluateAsync('return window.desktop.appIcons.get({appId:"/unknown-wifimeter-app"});'), null);

    for (const language of ['zh-CN', 'en']) {
        await click('.nav [data-page="settings"]');
        await evaluate('const select = document.querySelector("[name=language]"); select.value = arguments[0]; select.dispatchEvent(new Event("change", {bubbles:true}));', language);
        await poll(() => evaluate('return document.documentElement.lang;'), value => value === (language === 'en' ? 'en-US' : 'zh-CN'));
        for (const action of ['request', 'chooseProgram']) {
            const result = await evaluateAsync('return window.desktop.appControl[arguments[0]]({action:"read",path:"/usr/bin/sh"});', action);
            assert.equal(result.error.code, 'unsupported');
            assert.equal(/[\u4e00-\u9fff]/.test(result.error.message), language !== 'en');
        }
        // 发布构建不提供更新夹具传输；真实更新服务由独立集成测试覆盖。
        if (packaged) continue;
        const update = await evaluateAsync('return window.desktop.updates.check();');
        assert.equal(update.state, 'available');
        assert.equal(update.canInstall, false);
        await evaluate('window.installResult = undefined; window.desktop.updates.install().then(result => { window.installResult = result; });');
        await poll(() => evaluate('return document.querySelector(".desktop-dialog")?.dataset.kind;'), value => value === 'update-manual');
        const text = await evaluate('return document.querySelector(".desktop-dialog").innerText;');
        assert.equal(/[\u4e00-\u9fff]/.test(text), language !== 'en');
        if (process.env.WIFIMETER_SCREENSHOT) {
            const file = process.env.WIFIMETER_SCREENSHOT.replace(/\.png$/, `-${language}-dialog.png`);
            await writeFile(file, Buffer.from(await request(`/session/${session}/screenshot`), 'base64'));
        }
        await click('.desktop-dialog footer button:last-child');
        await poll(() => evaluate('return window.installResult;'));
    }
    console.log(packaged ? 'Native icons and bilingual unsupported controls passed' : 'Native icons, unsupported controls and bilingual update dialogs passed');

    const main = await request(`/session/${session}/window`);
    await evaluateAsync('return window.desktop.windowPreferences.update({miniWindow:true});');
    const handles = await poll(() => request(`/session/${session}/window/handles`), values => values.length === 2);
    await request(`/session/${session}/window`, { handle: handles.find(handle => handle !== main) });
    await poll(() => evaluate('return Boolean(window.miniDesktop);'));
    assert.match(await evaluate('return location.href;'), /electron\/mini\/index.html/);
    await evaluateAsync('return window.miniDesktop.openMain();');
    await request(`/session/${session}/window`, { handle: main });
    await evaluateAsync('return window.desktop.windowPreferences.update({miniWindow:false,closeAction:"exit"});');
    await poll(() => request(`/session/${session}/window/handles`), values => values.length === 1);
    console.log('Floating window creation, IPC and removal passed');
    if (process.env.WIFIMETER_SCREENSHOT) {
        await writeFile(process.env.WIFIMETER_SCREENSHOT, Buffer.from(await request(`/session/${session}/screenshot`), 'base64'));
    }
    await request(`/session/${session}/window`, undefined, 'DELETE');
    console.log(`PASS: Linux WebKitGTK ${packaged ? 'packaged Release with bundled backend' : 'desktop'} smoke test`);
} catch (error) {
    console.error(output);
    throw error;
} finally {
    if (session) await request(`/session/${session}`, undefined, 'DELETE').catch(() => {});
    if (driver.pid) {
        try { process.kill(-driver.pid, 'SIGTERM'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
        if (driver.exitCode === null && driver.signalCode === null) await once(driver, 'exit');
    }
    harness.cleanup();
}
