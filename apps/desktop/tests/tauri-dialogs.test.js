import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const copy = JSON.parse(await readFile(new URL('../tauri/dialog-copy.json', import.meta.url), 'utf8'));

test('所有宿主确认弹窗中英文完整对应，不混排，并默认选择取消', () => {
    assert.deepEqual(Object.keys(copy).sort(), ['close', 'discard', 'overlap', 'resume', 'update-install', 'update-manual']);
    for (const [kind, dialog] of Object.entries(copy)) {
        const [zhTitle, zhDescription, zhButtons] = dialog.zh;
        const [enTitle, enDescription, enButtons] = dialog.en;
        assert.ok(zhTitle && zhDescription && enTitle && enDescription, kind);
        assert.equal(zhButtons.length, enButtons.length, kind);
        assert.doesNotMatch([zhTitle, zhDescription, ...zhButtons].join('').replaceAll('WiFiMeter', '').replaceAll('{version}', '1.3.0'), /[A-Za-z]/, kind);
        assert.doesNotMatch([enTitle, enDescription, ...enButtons].join(''), /[\u3400-\u9fff]/, kind);
        assert.equal(zhButtons[dialog.default], '取消', kind);
        assert.equal(enButtons[dialog.default], 'Cancel', kind);
    }
});
