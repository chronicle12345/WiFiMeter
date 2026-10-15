'use strict';

// 后端进程客户端：拉起 wifimeter-backend，按行交换 JSON，并把事件转给上层。
//
// 协议见 backend/ipc/messages.h：请求 {id, method, params}，响应 {id, ok, result|error}，
// 事件 {event, ...} 没有 id。这里只负责传输与配对，不理解任何业务字段。

const { spawn } = require('node:child_process');
const { EventEmitter } = require('node:events');
const path = require('node:path');
const fs = require('node:fs');

const DEFAULT_TIMEOUT = 15000;

// 后端可执行文件的文件名：Windows 上带 .exe，其他平台没有后缀。
function executableName(platform) {
    return platform === 'win32' ? 'wifimeter-backend.exe' : 'wifimeter-backend';
}

// 后端可执行文件的位置：开发时在仓库的 build/ 下，打包后在 resources/ 下。
//
// 一个都没找到时退回可执行文件名本身（不带目录）：交给系统在 PATH 里查找，
// 比给一个确定不存在的路径更有用，日志里也不会误导读成“文件在那儿”。
// platform 可显式传入，便于在一种系统上验证另一种系统的查找规则。
function resolveExecutable({ repositoryRoot, resourcesPath, platform = process.platform }) {
    if (process.env.WIFIMETER_BACKEND) return process.env.WIFIMETER_BACKEND;
    const name = executableName(platform);
    const candidates = [];
    if (resourcesPath) candidates.push(path.join(resourcesPath, name));
    // Windows 的后端由交叉编译产出到 build/windows/app/，Linux 产出到 build/app/。
    const buildDirectory = platform === 'win32' ? path.join('build', 'windows', 'app') : path.join('build', 'app');
    if (repositoryRoot) candidates.push(path.join(repositoryRoot, buildDirectory, name));
    for (const candidate of candidates) {
        try {
            // Windows 没有可执行位，只能判断存在；其他平台还要求可执行。
            if (platform === 'win32') fs.accessSync(candidate, fs.constants.F_OK);
            else fs.accessSync(candidate, fs.constants.X_OK);
            return candidate;
        } catch {
            // 继续尝试下一个候选位置
        }
    }
    return name;
}

class BackendClient extends EventEmitter {
    constructor({ executable, databasePath, args = [], requestTimeout = DEFAULT_TIMEOUT, logger = () => {} }) {
        super();
        this.executable = executable;
        this.databasePath = databasePath;
        this.args = args;
        this.requestTimeout = requestTimeout;
        this.logger = logger;
        this.child = null;
        this.nextId = 1;
        this.pending = new Map();
        this.fragments = [];
        this.stopping = false;
        this.shutdownChild = null;
        this.collectionState = { paused: args.includes('--paused'), appsEnabled: false };
    }

    get running() {
        return this.child !== null && this.child.exitCode === null && !this.child.killed;
    }

    get shutdownPending() { return this.shutdownChild !== null; }

    start() {
        if (this.shutdownPending) throw Error('Collector shutdown is pending; 等待原采集进程实际退出。');
        if (this.running) return;
        this.stopping = false;
        this.fragments = [];
        const args = [...this.args, '--db', this.databasePath];
        this.logger(`启动后端：${this.executable} ${args.join(' ')}`);
        const child = spawn(this.executable, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
        this.child = child;
        child.stdout.setEncoding('utf8');
        child.stdout.on('data', chunk => { if (this.child === child) this.consume(chunk); });
        child.stderr.setEncoding('utf8');
        child.stderr.on('data', text => this.logger(`后端日志：${text.trimEnd()}`));
        const fail = error => {
            if (this.child === child) this.logger(`后端进程或管道错误：${error.message}`);
            this.failAll(error, child);
        };
        // write 回调拒绝请求后，Writable 仍会发出 error；必须持续处理管道错误。
        for (const stream of [child.stdin, child.stdout, child.stderr]) stream.on('error', fail);
        child.on('error', error => fail(new Error(`后端进程启动失败：${error.message}`)));
        const exited = (code, signal) => {
            if (this.shutdownChild === child) this.shutdownChild = null;
            if (this.child !== child) { this.failAll(new Error('原后端进程已退出。'), child); return; }
            const unexpected = !this.stopping;
            this.child = null;
            this.fragments = [];
            this.failAll(new Error(`后端进程已退出（code=${code}, signal=${signal}）。`), child);
            this.emit('exit', { code, signal, unexpected });
        };
        child.on('exit', exited);
        // spawn 失败时只有 error 和 close，没有 exit。
        child.on('close', (code, signal) => { if (this.child === child && !child.pid) exited(code, signal); });
    }

    consume(chunk) {
        // 只扫描新到达的分段，避免大响应分段到达时反复复制、扫描整行。
        let start = 0;
        let newline = chunk.indexOf('\n');
        while (newline !== -1) {
            const part = chunk.slice(start, newline);
            let line;
            if (this.fragments.length) {
                this.fragments.push(part);
                line = this.fragments.join('').trim();
                this.fragments = [];
            } else {
                line = part.trim();
            }
            if (line) this.dispatch(line);
            start = newline + 1;
            newline = chunk.indexOf('\n', start);
        }
        if (start < chunk.length) this.fragments.push(chunk.slice(start));
    }

    dispatch(line) {
        let message;
        try {
            message = JSON.parse(line);
        } catch {
            this.logger(`无法解析的后端输出：${line.slice(0, 200)}`);
            return;
        }

        if (message.event) {
            if (typeof message.appCollection?.enabled === 'boolean') this.collectionState.appsEnabled = message.appCollection.enabled;
            this.emit('event', message);
            return;
        }
        const id = message.id;
        const entry = this.pending.get(id);
        if (!entry) {
            // 没有等待者的响应（例如超时后才回来）只记日志。
            this.logger(`收到无人等待的响应：id=${id}`);
            return;
        }
        this.pending.delete(id);
        clearTimeout(entry.timer);
        if (message.ok) {
            const result = message.result ?? {};
            if (entry.method === 'setPaused' && typeof result.paused === 'boolean') this.collectionState.paused = result.paused;
            if (entry.method === 'setAppCollection' && typeof result.appCollection?.enabled === 'boolean') this.collectionState.appsEnabled = result.appCollection.enabled;
            if (['restore', 'clearUsage'].includes(entry.method) && typeof result.paused === 'boolean') this.collectionState.paused = result.paused;
            entry.resolve(result);
        }
        else {
            const error = new Error(message.error?.message ?? '后端返回失败。');
            error.code = message.error?.code ?? 'unknown';
            entry.reject(error);
        }
    }

    failAll(error, child) {
        for (const [id, entry] of this.pending) {
            if (child && entry.child !== child) continue;
            clearTimeout(entry.timer);
            this.pending.delete(id);
            entry.reject(error);
        }
    }

    request(method, params = {}, { timeout = this.requestTimeout } = {}) {
        if (this.shutdownPending && (method !== 'shutdown' || !this.running)) {
            return Promise.reject(Error('Collector shutdown is pending; 等待原采集进程实际退出。'));
        }
        if (!this.running) {
            // 进程不在时自动拉起一次，避免界面因为一次崩溃就永久失联。
            this.start();
            if (!this.running) return Promise.reject(new Error('后端进程不可用。'));
        }

        const id = this.nextId++;
        const child = this.child;
        const payload = JSON.stringify({ id, protocol: 1, method, params });
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pending.delete(id);
                const error = new Error(`后端在 ${timeout} 毫秒内没有响应 ${method}。`);
                error.code = 'timeout';
                reject(error);
            }, timeout);
            this.pending.set(id, { resolve, reject, timer, child, method });
            child.stdin.write(payload + '\n', error => {
                if (!error) return;
                this.pending.delete(id);
                clearTimeout(timer);
                reject(error);
            });
        });
    }

    // 超时只停止等待，不代表旧进程已退出；收到 exit 前禁止重新启动。
    async waitForShutdown({ timeout = 30000 } = {}) {
        const child = this.shutdownChild;
        if (!child) return;
        await new Promise((resolve, reject) => {
            const onExit = () => { clearTimeout(timer); resolve(); };
            const timer = setTimeout(() => {
                child.removeListener('exit', onExit);
                reject(Error('原采集进程尚未退出，无法恢复采集；请稍后重试恢复。'));
            }, timeout);
            child.once('exit', onExit);
        });
    }

    async stopGracefully({ timeout = 30000 } = {}) {
        const child = this.child;
        if (!child || child.exitCode !== null) return;
        this.stopping = true;
        this.shutdownChild = child;
        let cleanup = () => {};
        const exited = new Promise((resolve, reject) => {
            const onExit = (code, signal) => { clearTimeout(timer); code === 0 ? resolve() : reject(Error(`Collector exited with ${code ?? signal}`)); };
            const timer = setTimeout(() => { child.removeListener('exit', onExit); reject(Error('Collector has not finished saving; update canceled.')); }, timeout);
            child.once('exit', onExit);
            cleanup = () => { clearTimeout(timer); child.removeListener('exit', onExit); };
        });
        // Attach rejection handling before waiting for the shutdown response.
        const completion = exited.catch(error => { throw error; });
        completion.catch(() => {});
        try { await this.request('shutdown', {}, { timeout }); await completion; }
        catch (error) {
            // 后端明确拒绝保存并关停时仍在运行，可恢复原采集；超时继续等待实际退出。
            if (error.code === 'storageFailure' && this.shutdownChild === child) this.shutdownChild = null;
            this.stopping = this.shutdownPending;
            throw error;
        }
        finally { cleanup(); }
    }

    async stop({ timeout = 3000 } = {}) {
        if (!this.child) return;
        this.stopping = true;
        const child = this.child;
        this.shutdownChild = child;
        try {
            await this.request('shutdown', {}, { timeout });
        } catch {
            // 后端可能已经退出或无法响应，下面按进程状态处理。
        }
        await new Promise(resolve => {
            if (child.exitCode !== null) return resolve();
            const timer = setTimeout(() => {
                this.logger('后端未按时退出，强制结束。');
                child.kill('SIGKILL');
                resolve();
            }, timeout);
            child.once('exit', () => {
                clearTimeout(timer);
                resolve();
            });
            child.stdin.end();
        });
    }
}

module.exports = { BackendClient, resolveExecutable };
