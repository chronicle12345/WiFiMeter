import test from 'node:test';
import assert from 'node:assert/strict';
import { dataLocationPanel, dataLocationMessage } from '../renderer/data/data-location.js';
import { setLanguage } from '../renderer/i18n.js';

const esc = value => String(value).replace(/[&<>"]/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[character]));
const button = (action, label, icon, cls, extra = '') => `<button data-action="${action}" class="${cls}" ${extra}>${label}</button>`;
const panel = state => dataLocationPanel(state, { esc, button });
const defaults = directory => ({ directory, database: `${directory}/wifimeter.db`, custom: false, temporaryDefault: false, defaultDirectory: directory });

test('未读取时只显示加载状态，不显示操作按钮', () => {
    const html = panel(null);
    assert.match(html, /id="dataLocationRegion"/);
    assert.match(html, /读取中…/);
    assert.doesNotMatch(html, /data-action="data-location/);
});

test('默认位置只提供更改入口，路径按 HTML 转义', () => {
    const html = panel(defaults('C:\\Users\\<script>'));
    assert.match(html, /C:\\Users\\&lt;script&gt;/);
    assert.doesNotMatch(html, /<script>/);
    assert.match(html, /当前使用默认位置。/);
    assert.match(html, /data-action="data-location-change"/);
    assert.doesNotMatch(html, /data-action="data-location-reset"/);
    assert.doesNotMatch(html, /disabled/);
});

test('自定义与临时默认位置显示不同说明，并提供恢复默认入口', () => {
    const custom = panel({ ...defaults('/data'), custom: true });
    assert.match(custom, /data-action="data-location-reset"/);
    assert.doesNotMatch(custom, /当前使用默认位置。/);
    const temporary = panel({ ...defaults('/data'), custom: true, temporaryDefault: true });
    assert.match(temporary, /本次运行暂时使用默认位置；保存的自定义位置会在下次启动时继续尝试。/);
    assert.doesNotMatch(temporary, /当前使用默认位置。/);
});

test('切换中禁用按钮并替换按钮文案', () => {
    const html = panel({ ...defaults('/data'), custom: true, busy: true });
    assert.equal(html.match(/disabled/g).length, 2);
    assert.match(html, /正在切换…/);
    assert.doesNotMatch(html, />更改位置</);
});

test('失败提示优先显示为错误，成功与取消给出可读结论', () => {
    const failed = panel({ ...defaults('/data'), error: '磁盘空间不足。' });
    assert.match(failed, /role="alert"/);
    assert.match(failed, /磁盘空间不足。/);

    assert.equal(dataLocationMessage({ canceled: true }), '');
    assert.equal(dataLocationMessage(undefined), '');
    assert.equal(dataLocationMessage({ changed: false }), '当前已经是这个数据位置。');
    assert.equal(dataLocationMessage({ ok: true, changed: true, cleared: true }), '已恢复默认位置，不再使用自定义位置。');
    assert.equal(dataLocationMessage({ ok: false, error: '复制失败。' }), '复制失败。');
    assert.equal(dataLocationMessage({ ok: false }), '未能切换数据位置。');
    assert.equal(
        dataLocationMessage({ ok: true, copied: true, database: 'D:\\数据\\wifimeter.db' }),
        '数据位置已切换，当前数据库已复制到新位置。 当前数据库：D:\\数据\\wifimeter.db'
    );
    assert.equal(
        dataLocationMessage({ ok: true, copied: false, source: null, archived: '/mnt/old/wifimeter.db.replaced' }),
        '数据位置已切换，新位置会新建空白数据库。 目标文件夹原有的数据库已归档为：/mnt/old/wifimeter.db.replaced'
    );
});

test('英文界面下区域与结论文案全部有对照，不残留中文', () => {
    setLanguage('en');
    try {
        const states = [
            null,
            defaults('C:\\Data'),
            { ...defaults('C:\\Data'), custom: true },
            { ...defaults('C:\\Data'), custom: true, temporaryDefault: true },
            { ...defaults('C:\\Data'), error: 'copy failed' },
            { ...defaults('C:\\Data'), busy: true }
        ];
        const messages = [
            dataLocationMessage({ canceled: true }),
            dataLocationMessage({ changed: false }),
            dataLocationMessage({ ok: true, changed: true, cleared: true }),
            dataLocationMessage({ ok: false, error: 'copy failed' }),
            dataLocationMessage({ ok: true, copied: true, source: 'C:\\old', archived: 'C:\\old.replaced', database: 'D:\\new' }),
            dataLocationMessage({ ok: true, copied: false })
        ];
        for (const html of [...states.map(panel), ...messages]) {
            assert.doesNotMatch(html, /[\u3400-\u9fff]/, html);
        }
    } finally {
        setLanguage('zh-CN');
    }
});
