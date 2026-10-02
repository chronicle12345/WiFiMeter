import { test } from 'node:test';
import assert from 'node:assert/strict';
import { statusRows, statusHelpView } from '../renderer/ui/status-help.js';
import { setLanguage } from '../renderer/i18n.js';
test('missing snapshot is waiting, never claims healthy collection', () => {
    assert.ok(statusRows().every(row => row.tone === 'muted' && row.label === '等待状态'));
});
test('network and collector remain independent and partial app data is visible', () => {
    const rows = statusRows({ live:{state:'connected',collector:'paused'}, appCollection:{state:'partial'}, proxy:{available:false,status:'ready'}, updates:{state:'error',error:{message:'network timeout'}} });
    assert.deepEqual(rows.map(row=>row.tone), ['good','warn','warn','warn','error']);
    assert.equal(rows[4].detail,'network timeout');
});
test('diagnostics escape markup and remain collapsed alongside help actions', () => {
    const html = statusHelpView({live:{collector:'offline',error:'<img src=x onerror=alert(1)>'}}, {button: name=>`<button data-action="${name}"></button>`});
    assert.ok(html.includes('&lt;img')); assert.ok(!html.includes('<img')); assert.ok(!/<details[^>]*\bopen/.test(html));
    assert.ok(html.includes('data-action="demo"')); assert.ok(html.includes('data-action="help"'));
    assert.equal((html.match(/<dt>/g)||[]).length,5);
});
test('status block supports English without translating diagnostic content', () => {
    setLanguage('en');
    try { const html=statusHelpView({appCollection:{state:'permission',detail:'原始错误'}}); assert.ok(html.includes('Permission required')); assert.ok(html.includes('原始错误')); }
    finally { setLanguage('zh-CN'); }
});
