import fs from 'node:fs';
import { runInNewContext } from 'node:vm';

// 执行发布版的页面桥接；原生事件和请求均使用内存替身。
export function tauriBridge({ mini = false, platform = 'win32', invoke = async () => undefined } = {}) {
    let receive;
    const calls = [];
    const window = { __TAURI__: { core: { invoke: async (_command, request) => {
        calls.push([request.channel, ...request.args]);
        return invoke(request.channel, ...request.args);
    } }, event: { listen: async (_event, handler) => { receive = handler; } } } };
    runInNewContext(fs.readFileSync(new URL('../../tauri/bridge.js', import.meta.url), 'utf8'), {
        window, location: { pathname: mini ? '/mini/index.html' : '/main/index.html' },
        navigator: { userAgent: platform === 'win32' ? 'Windows' : 'Linux' },
        document: { addEventListener() {} }, console
    });
    return {
        api: mini ? window.miniDesktop : window.desktop, calls, window,
        send(channel, payload) { receive({ payload: { channel, payload } }); }
    };
}
