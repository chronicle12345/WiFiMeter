import test from 'node:test';
import assert from 'node:assert/strict';
import { createAppControlModel, legacyMessage } from '../renderer/data/desktop-actions.js';

test('控制只按用户操作调用桥，KB/s 原样传入，失败仍展示回读状态', async () => {
    const calls = [];
    const model = createAppControlModel({ platform: 'win32', appControl: {
        chooseProgram: async () => ({ ok: true, result: { path: 'C:\\Apps\\browser.exe', state: { Blocked: false } } }),
        request: async input => { calls.push(input); return { ok: false, error: { message: 'partial failure' }, result: { state: { Blocked: null, FirewallError: 'query failed' } } }; }
    } });
    await model.choose();
    assert.equal(model.path, 'C:\\Apps\\browser.exe');
    await model.run('throttle', 0.125);
    assert.deepEqual(calls, [{ action: 'throttle', path: model.path, uploadKBps: 0.125 }]);
    assert.equal(model.state.Blocked, null);
    assert.equal(model.error, 'partial failure');
    assert.equal(model.busy, false);
    assert.equal(calls.length, 1);
});

test('不支持的平台不调用系统桥，取消选择保留当前路径，忙碌时不重复操作', async () => {
    let release, calls = 0;
    const bridge = { chooseProgram: async () => ({ canceled: true }), request: () => { calls++; return new Promise(resolve => { release = resolve; }); } };
    const linux = createAppControlModel({ platform: 'linux', appControl: bridge });
    await linux.run('read');
    assert.equal(linux.supported, false);
    assert.equal(calls, 0);
    const model = createAppControlModel({ platform: 'win32', appControl: bridge });
    model.select({ name: 'Browser', path: 'C:\\Apps\\browser.exe' });
    await model.choose();
    assert.equal(model.path, 'C:\\Apps\\browser.exe');
    const operation = model.run('read');
    await model.run('block');
    assert.equal(calls, 1);
    release({ ok: true, result: { state: { Blocked: false, UploadKbps: 8 } } });
    await operation;
    assert.equal(model.state.UploadKbps, 8);
    assert.equal(model.busy, false);
});

test('目录导入显示备份位置、重复导入和错误，不把取消当作成功', () => {
    assert.match(legacyMessage({ imported: true, backupDirectory: 'C:\\backup' }), /C:\\backup/);
    assert.match(legacyMessage({ alreadyImported: true }), /已导入/);
    assert.match(legacyMessage({ error: { message: 'bad source' } }), /bad source/);
    assert.equal(legacyMessage({ canceled: true }), '');
});

test('首次和重复导入都保留报告警告、仅归档数量及备份路径', () => {
    const report={warnings:['未映射额度：办公室','缓存 <archive> 仅归档'],appArchivedOnlyCount:3};
    for(const flags of [{imported:true},{imported:true,alreadyImported:true},{alreadyImported:true}]){
        const message=legacyMessage({...flags,report,backupDirectory:'C:\\备份'});
        assert.ok(message.includes('未映射额度：办公室'));
        assert.ok(message.includes('缓存 <archive> 仅归档'));
        assert.ok(message.includes('3'));
        assert.ok(message.includes('未加入应用用量统计'));
        assert.ok(message.includes('C:\\备份'));
    }
    assert.ok(!legacyMessage({imported:true,report:{warnings:[],appArchivedOnlyCount:0}}).includes('仅归档'));
});

 test('重叠日期报告说明略过数量并保留警告', () => {
    const message=legacyMessage({imported:true,report:{skippedDayCount:4,warnings:['保留本机记录']}});
    assert.match(message,/已略过 4 个重叠日期/);
    assert.match(message,/重叠日期保留现有记录/);
    assert.match(message,/保留本机记录/);
    assert.ok(!message.includes('旧版数据已导入。'));
 });
