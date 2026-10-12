import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { createAutosave } from '../renderer/ui/autosave.js';

const source = fs.readFileSync(new URL('../renderer/app.js', import.meta.url), 'utf8');
function settingsHarness({ pruneFailure = false, reloadFailure = false, failRetentions = [] } = {}) {
    const calls = [];
    const context = vm.createContext({
        data: { settings: { retention: 90 } }, windowFields: new Set(), windowPreferences: null, window: {},
        retentionFollowups: new WeakMap(), pendingRetentionFollowup: null, Object, t: text => text,
        confirmAutosave: async () => { calls.push('confirm'); return true; },
        restartSampler() { calls.push('restartSampler'); }, setLanguage() {}, receiveWindowPreferences() {},
        store: {
            async updateSettings(patch) {
                calls.push(['updateSettings', patch]);
                if (failRetentions.includes(patch.retention)) throw Error('settings write failed');
                Object.assign(context.data.settings, patch); return {};
            },
            async pruneUsage() { calls.push('pruneUsage'); if (pruneFailure) { pruneFailure = false; throw Error('database busy'); } },
            async reload() { calls.push('reload'); if (reloadFailure) { reloadFailure = false; throw Error('snapshot unavailable'); } }
        }
    });
    const start = source.indexOf('async function writeAutosave(');
    const end = source.indexOf("\ndocument.addEventListener('focusout'", start);
    const discardStart = source.indexOf('function discardAutosaves('), discardEnd = source.indexOf('function formAutosave(', discardStart);
    vm.runInContext(source.slice(start, end) + source.slice(discardStart, discardEnd) + ';globalThis.writeAutosave = writeAutosave;globalThis.discardAutosaves = discardAutosaves;', context);
    const form = { id: 'settingsForm' };
    const save = createAutosave({ write: fields => context.writeAutosave(form, fields) });
    context.activeSaves = new Set([{ form, save }]); context.syncSaveFlags = () => {};
    return { calls, context, save };
}

test('retention retry completes failed pruning after settings already committed', async () => {
    const h = settingsHarness({ pruneFailure: true });
    h.save.set('retention', { retention: 30 });
    await h.save.flush();
    assert.equal(h.save.state, 'error');
    assert.equal(h.context.data.settings.retention, 30);
    await h.save.flush();
    assert.equal(h.save.state, 'saved');
    assert.equal(h.calls.filter(call => call === 'confirm').length, 1);
    assert.equal(h.calls.filter(call => call === 'pruneUsage').length, 2);
    assert.equal(h.calls.filter(call => call === 'reload').length, 1);
});

test('retention retry refreshes the snapshot without repeating a successful prune', async () => {
    const h = settingsHarness({ reloadFailure: true });
    h.save.set('retention', { retention: 30 });
    await h.save.flush();
    assert.equal(h.save.state, 'error');
    await h.save.flush();
    assert.equal(h.save.state, 'saved');
    assert.equal(h.calls.filter(call => call === 'pruneUsage').length, 1);
    assert.equal(h.calls.filter(call => call === 'reload').length, 2);
});

test('a newer retention edit supersedes the failed pruning task', async () => {
    const h = settingsHarness({ pruneFailure: true });
    h.save.set('retention', { retention: 30 });
    await h.save.flush();
    h.save.set('retention', { retention: 90 });
    await h.save.flush();
    assert.equal(h.save.state, 'saved');
    assert.equal(h.context.data.settings.retention, 90);
    assert.equal(h.calls.filter(call => call === 'pruneUsage').length, 1);
    assert.equal(h.calls.filter(call => call === 'reload').length, 0);
});

test('reselecting the same committed retention completes pruning after a different edit failed', async () => {
    const h = settingsHarness({ pruneFailure: true, failRetentions: [90] });
    h.save.set('retention', { retention: 30 }); await h.save.flush();
    assert.equal(h.save.state, 'error');
    h.save.set('retention', { retention: 90 }); await h.save.flush();
    assert.equal(h.save.state, 'error');
    assert.equal(h.context.data.settings.retention, 30);
    h.save.set('retention', { retention: 30 }); await h.save.flush();
    assert.equal(h.save.state, 'saved');
    assert.equal(h.context.data.settings.retention, 30);
    assert.equal(h.calls.filter(call => call === 'confirm').length, 1);
    assert.equal(h.calls.filter(call => call === 'pruneUsage').length, 2);
    assert.equal(h.calls.filter(call => call === 'reload').length, 1);
});

test('reselecting the same committed retention retries only its incomplete snapshot refresh', async () => {
    const h = settingsHarness({ reloadFailure: true, failRetentions: [90] });
    h.save.set('retention', { retention: 30 }); await h.save.flush();
    assert.equal(h.save.state, 'error');
    h.save.set('retention', { retention: 90 }); await h.save.flush();
    assert.equal(h.save.state, 'error');
    assert.equal(h.context.data.settings.retention, 30);
    h.save.set('retention', { retention: 30 }); await h.save.flush();
    assert.equal(h.save.state, 'saved');
    assert.equal(h.calls.filter(call => call === 'confirm').length, 1);
    assert.equal(h.calls.filter(call => call === 'pruneUsage').length, 1);
    assert.equal(h.calls.filter(call => call === 'reload').length, 2);
});

test('discarded retention followups do not prune a subsequently restored data set', async () => {
    const h = settingsHarness({ pruneFailure: true });
    const oldField = { retention: 30 };
    h.save.set('retention', oldField); await h.save.flush();
    assert.equal(h.save.state, 'error');
    h.context.discardAutosaves(['settingsForm']);
    // 恢复的设置恰好相同，旧草稿对象也不能继续对新数据执行清理。
    h.context.data.settings = { retention: 30 };
    const save = createAutosave({ write: fields => h.context.writeAutosave({ id: 'settingsForm' }, fields) });
    save.set('retention', oldField); await save.flush();
    assert.equal(save.state, 'saved');
    assert.equal(h.calls.filter(call => call === 'pruneUsage').length, 1);
    assert.equal(h.calls.filter(call => call === 'reload').length, 0);
});

function dataChangeHarness({ dirty = false, flush = async () => {} } = {}) {
    const calls = [];
    const context = vm.createContext({
        settingsDirty: dirty, networkDirty: false, totalQuotaDirty: false, proxyDirty: false,
        t: text => text, tr: (strings, ...values) => strings.reduce((text, piece, index) => text + piece + (values[index] ?? ''), ''),
        async flushAutosaves() { calls.push('flush'); await flush(context); },
        toast(message) { calls.push(['toast', message]); },
        confirmModal() { calls.push('confirm'); },
        window: { desktop: { async openBackup() { calls.push('openBackup'); return { canceled: true }; } } }
    });
    const helperStart = source.indexOf('async function saveBeforeDataChange(');
    if (helperStart >= 0) vm.runInContext(source.slice(helperStart, source.indexOf('function discardAutosaves(', helperStart)), context);
    const restoreStart = source.indexOf('async function restore(');
    const clearStart = source.includes('async function clearRecords(') ? source.indexOf('async function clearRecords(') : source.indexOf('function clearRecords(');
    const clearEnd = source.indexOf('const autosaveForms=', clearStart);
    vm.runInContext(source.slice(restoreStart, clearEnd) + ';globalThis.restore = restore;globalThis.clearRecords = clearRecords;', context);
    return { context, calls };
}

test('failed drafts block restoring and clearing before confirmation or file dialogs', async () => {
    const h = dataChangeHarness({ dirty: true });
    await h.context.clearRecords();
    await h.context.restore();
    assert.equal(h.calls.includes('confirm'), false);
    assert.equal(h.calls.includes('openBackup'), false);
    assert.equal(h.calls.filter(call => call === 'flush').length, 2);
});

test('clearing waits for an in-flight save before showing its data confirmation', async () => {
    let release;
    const h = dataChangeHarness({ dirty: true, flush: context => new Promise(resolve => { release = () => { context.settingsDirty = false; resolve(); }; }) });
    const clearing = h.context.clearRecords();
    await Promise.resolve();
    assert.equal(h.calls.includes('confirm'), false);
    assert.equal(typeof release, 'function');
    release(); await clearing;
    assert.equal(h.calls.includes('confirm'), true);
});
