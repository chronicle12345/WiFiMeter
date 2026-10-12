import test from 'node:test';
import assert from 'node:assert/strict';
import { createAppControlModel } from '../renderer/data/desktop-actions.js';

const program = 'C:\\Apps\\browser.exe';
const record = { path: program, name: 'browser.exe', state: { Blocked: true, Throttled: false, DownloadThrottled: false }, savedAt: '2026-10-12T00:00:00.000Z' };

test('读取限制记录不会更改选中应用状态，连续请求复用进行中的读取', async () => {
    let resolve, calls = 0;
    const model = createAppControlModel({ platform: 'win32', appControl: { list: () => { calls++; return new Promise(done => { resolve = done; }); } } });
    assert.equal(typeof model.loadRules, 'function');
    model.select({ path: program, name: 'Browser' });
    model.state = { Blocked: false };
    const first = model.loadRules();
    const second = model.loadRules();
    assert.equal(model.rulesBusy, true);
    await Promise.resolve();
    resolve({ ok: true, records: [record] });
    await Promise.all([first, second]);
    assert.deepEqual(model.rules, [record]);
    assert.deepEqual(model.state, { Blocked: false });
    assert.equal(model.path, program);
    assert.equal(model.rulesBusy, false);
    assert.equal(calls, 1);
});

test('列表读取失败保留原记录并显示错误，随后可恢复', async () => {
    let result = { ok: true, records: [record] };
    const model = createAppControlModel({ platform: 'win32', appControl: { list: async () => {
        if (result instanceof Error) throw result;
        return result;
    } } });
    assert.equal(typeof model.loadRules, 'function');
    await model.loadRules();
    result = { ok: false, error: { message: 'record file unavailable' } };
    await model.loadRules();
    assert.deepEqual(model.rules, [record]);
    assert.equal(model.rulesError, 'record file unavailable');
    result = Error('bridge unavailable');
    await model.loadRules();
    assert.equal(model.rulesError, 'bridge unavailable');
    result = { ok: true, records: [] };
    await model.loadRules();
    assert.deepEqual(model.rules, []);
    assert.equal(model.rulesError, '');
});

test('配置动作完成后刷新列表且保留保存错误和系统回读状态', async () => {
    const model = createAppControlModel({ platform: 'win32', appControl: {
        request: async () => ({ ok: true, result: { path: program, state: { Blocked: true } }, recordsError: { message: 'disk full' } }),
        list: async () => ({ ok: true, records: [record] })
    } });
    assert.equal(typeof model.loadRules, 'function');
    model.select({ path: program });
    await model.run('block');
    assert.deepEqual(model.rules, [record]);
    assert.deepEqual(model.state, { Blocked: true });
    assert.equal(model.rulesError, 'disk full');
    assert.equal(model.busy, false);
});

test('切换应用会使用记录中的名称，程序选择返回后清除之前应用的名称', async () => {
    const model = createAppControlModel({ platform: 'win32', appControl: {
        chooseProgram: async () => ({ ok: true, result: { path: 'C:\\Apps\\Other.exe', state: { Blocked: false } } })
    } });
    model.select({ path: program, name: 'Browser' });
    await model.choose();
    assert.equal(model.name, 'Other.exe');
});
