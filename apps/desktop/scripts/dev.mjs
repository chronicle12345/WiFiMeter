import { spawn } from 'node:child_process';
import { access } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const app = fileURLToPath(new URL('../', import.meta.url));
const root = path.resolve(app, '../..');
if (!['linux', 'win32'].includes(process.platform)) throw Error('开发入口支持 Windows 和 Linux。');
const backend = process.env.WIFIMETER_BACKEND || path.join(root, process.platform === 'win32'
    ? 'build/windows/app/wifimeter-backend.exe' : 'build/app/wifimeter-backend');
try { await access(backend); }
catch { throw Error(`缺少采集后端：${backend}。请先在仓库根目录执行 npm run build:backend。`); }
const child = spawn(process.execPath, [path.join(app, 'node_modules/@tauri-apps/cli/tauri.js'), 'dev', ...process.argv.slice(2)], {
    cwd: path.join(app, 'src-tauri'), stdio: 'inherit', env: { ...process.env, WIFIMETER_BACKEND: backend }
});
child.on('error', error => { console.error(error.message); process.exitCode = 1; });
child.on('exit', code => { process.exitCode = code ?? 1; });
