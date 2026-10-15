import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';
import childProcess from 'node:child_process';
import { pathToFileURL } from 'node:url';

// 每个测试独立加载共享宿主模块，避免全局夹具、环境变量和定时器跨测试泄漏。
export function createIsolatedHost({ root, env }) {
    const modules = new Map(), timers = new Set(), children = new Set(), childClosures = new Map();
    const runtimeProcess = Object.assign(new EventEmitter(), {
        env: { ...env }, platform: process.platform, arch: process.arch, pid: process.pid,
        execPath: process.execPath, resourcesPath: root, argv: [process.execPath],
        cwd: () => path.join(root, 'apps/desktop'), hrtime: process.hrtime,
        nextTick: process.nextTick.bind(process), exitCode: 0,
        exit: code => { runtimeProcess.exitCode = code || 0; }
    });
    const trackedTimers = {
        setTimeout: (callback, delay, ...args) => {
            const timer = setTimeout(() => { timers.delete(timer); callback(...args); }, delay);
            timers.add(timer); return timer;
        },
        clearTimeout: timer => { timers.delete(timer); clearTimeout(timer); },
        setInterval: (callback, delay, ...args) => { const timer = setInterval(callback, delay, ...args); timers.add(timer); return timer; },
        clearInterval: timer => { timers.delete(timer); clearInterval(timer); },
        setImmediate, clearImmediate
    };
    const spawn = (file, args, options = {}) => {
        const child = childProcess.spawn(file, args, { ...options, env: { ...env, ...options.env }, windowsHide: true });
        children.add(child);
        childClosures.set(child, new Promise(resolve => child.once('close', () => {
            children.delete(child); childClosures.delete(child); resolve();
        })));
        return child;
    };
    const context = vm.createContext({ console, process: runtimeProcess, Buffer, URL, URLSearchParams,
        AbortController, AbortSignal, fetch, Response, Request, Headers, TextEncoder, TextDecoder,
        structuredClone, queueMicrotask, ...trackedTimers });
    function load(file) {
        const filename = path.resolve(file);
        if (modules.has(filename)) return modules.get(filename).exports;
        const module = { exports: {} }; modules.set(filename, module);
        const nativeRequire = createRequire(filename);
        const require = request => {
            if (request === 'node:timers' || request === 'timers') return trackedTimers;
            if (request === 'node:child_process' || request === 'child_process') return { ...childProcess, spawn };
            const resolved = nativeRequire.resolve(request);
            if (resolved.startsWith(root + path.sep) && resolved.endsWith('.cjs')) return load(resolved);
            return nativeRequire(request);
        };
        const source = fs.readFileSync(filename, 'utf8');
        const script = new vm.Script('(function(require,module,exports,__filename,__dirname){' + source + '\n})', {
            filename, importModuleDynamically: specifier => import(specifier.startsWith('.') ? new URL(specifier, pathToFileURL(filename)).href : specifier)
        });
        script.runInContext(context)(require, module, module.exports, filename, path.dirname(filename));
        return module.exports;
    }
    return { load, context, process: runtimeProcess, children,
        async evaluate(callback, api, argument) {
            context.__testApi = api; context.__testArgument = argument;
            try { return await vm.runInContext('(' + callback.toString() + ')(__testApi,__testArgument)', context); }
            finally { delete context.__testApi; delete context.__testArgument; }
        },
        async dispose() {
            for (const timer of timers) { clearTimeout(timer); clearInterval(timer); }
            timers.clear();
            await Promise.all([...children].map(async child => {
                const closed = childClosures.get(child);
                if (child.exitCode === null && child.signalCode === null && !child.killed) child.kill();
                await closed;
            }));
        }
    };
}
