import test from 'node:test';
import assert from 'node:assert/strict';
import { installCloseGuard } from '../renderer/host/close-guard.js';

test('Tauri 退出检查沿用 beforeunload，并把请求编号和未保存状态回给宿主', async () => {
    let listener, removed = false;
    const replies = [], target = new EventTarget();
    const remove = await installCloseGuard({ target,
        listen: async (channel, handler) => {
            assert.equal(channel, 'window:before-close'); listener = handler;
            return () => { removed = true; };
        },
        invoke: async (command, payload) => { replies.push({ command, ...payload }); }
    });
    listener({ payload: 1 });
    const dirty = event => event.preventDefault();
    target.addEventListener('beforeunload', dirty);
    listener({ payload: 2 });
    target.removeEventListener('beforeunload', dirty);
    listener({ payload: 3 });
    assert.deepEqual(replies, [
        { command: 'desktop_close_reply', id: 1, dirty: false },
        { command: 'desktop_close_reply', id: 2, dirty: true },
        { command: 'desktop_close_reply', id: 3, dirty: false }
    ]);
    remove(); assert.equal(removed, true);
});
