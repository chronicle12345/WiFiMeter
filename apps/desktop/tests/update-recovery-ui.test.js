import test from 'node:test';
import assert from 'node:assert/strict';
import { updatesView } from '../renderer/ui/updates.js';
import { setLanguage } from '../renderer/i18n.js';

test('recovery action takes priority over installation, is disabled while busy, and is translated', () => {
    const status = { state: 'available', canInstall: true, recoveryRequired: true };
    const html = updatesView(status, true);
    assert.match(html, /data-action="install-update" disabled>恢复采集<\/button>/);
    assert.doesNotMatch(html, /下载并安装/);
    setLanguage('en');
    try {
        assert.match(updatesView({ state: 'error', recoveryRequired: true }), />Resume collection<\/button>/);
        assert.match(updatesView({ state: 'recovered', recoveryRequired: false }), /Previous collection state restored/);
    } finally { setLanguage('zh-CN'); }
});
