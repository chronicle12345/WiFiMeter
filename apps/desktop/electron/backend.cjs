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
        this.buffer = '';
        this.stopping = false;
    }

    get running() {
        return this.child !== null && this.child.exitCode === null && !this.child.killed;
    }

    start() {
        if (this.running) return;
        this.stopping = false;
        const args = [...this.args, '--db', this.databasePath];
        this.logger(`启动后端：${this.executable} ${args.join(' ')}`);
        this.child = spawn(this.executable, args, { stdio: ['pipe', 'pipe', 'pipe'] });

        this.child.stdout.setEncoding('utf8');
        this.child.stdout.on('data', chunk => this.consume(chunk));
        this.child.stderr.setEncoding('utf8');
        this.child.stderr.on('data', text => this.logger(`后端日志：${text.trimEnd()}`));
        this.child.on('error', error => {
            this.logger(`后端进程错误：${error.message}`);
            this.failAll(new Error(`后端进程启动失败：${error.message}`));
        });
        this.child.on('exit', (code, signal) => {
            const unexpected = !this.stopping;
            this.child = null;
            this.failAll(new Error(`后端进程已退出（code=${code}, signal=${signal}）。`));
            this.emit('exit', { code, signal, unexpected });
        });
    }

    consume(chunk) {
        this.buffer += chunk;
        let newline = this.buffer.indexOf('\n');
        while (newline !== -1) {
            const line = this.buffer.slice(0, newline).trim();
            this.buffer = this.buffer.slice(newline + 1);
            if (line) this.dispatch(line);
            newline = this.buffer.indexOf('\n');
        }
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
        if (message.ok) entry.resolve(message.result ?? {});
        else {
            const error = new Error(message.error?.message ?? '后端返回失败。');
            error.code = message.error?.code ?? 'unknown';
            entry.reject(error);
        }
    }

    failAll(error) {
        for (const [, entry] of this.pending) {
            clearTimeout(entry.timer);
            entry.reject(error);
        }
        this.pending.clear();
    }

    request(method, params = {}, { timeout = this.requestTimeout } = {}) {
        if (!this.running) {
            // 进程不在时自动拉起一次，避免界面因为一次崩溃就永久失联。
            this.start();
            if (!this.running) return Promise.reject(new Error('后端进程不可用。'));
        }

        const id = this.nextId++;
        const payload = JSON.stringify({ id, protocol: 1, method, params });
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pending.delete(id);
                const error = new Error(`后端在 ${timeout} 毫秒内没有响应 ${method}。`);
                error.code = 'timeout';
                reject(error);
            }, timeout);
            this.pending.set(id, { resolve, reject, timer });
            this.child.stdin.write(payload + '\n', error => {
                if (!error) return;
                this.pending.delete(id);
                clearTimeout(timer);
                reject(error);
            });
        });
    }

    async stop({ timeout = 3000 } = {}) {
        if (!this.child) return;
        this.stopping = true;
        const child = this.child;
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
