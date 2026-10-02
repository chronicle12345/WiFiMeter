import { cp, mkdir, readFile, rm, writeFile, access } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const appDirectory = fileURLToPath(new URL('../', import.meta.url));
const vendorFiles = [
    'node_modules/marked/lib/marked.esm.js',
    'node_modules/dompurify/dist/purify.es.mjs'
];
const miniFiles = ['index.html', 'renderer.js', 'style.css', 'rates.js'];

export async function buildFrontend(output = path.join(appDirectory, 'dist/tauri')) {
    // 先检查依赖，避免安装缺失时生成不完整的可发布目录。
    for (const file of vendorFiles) await access(path.join(appDirectory, file));
    await rm(output, { recursive: true, force: true });
    await mkdir(output, { recursive: true });
    await cp(path.join(appDirectory, 'renderer'), path.join(output, 'renderer'), { recursive: true });
    for (const file of [
        ...vendorFiles, ...miniFiles.map(file => `electron/mini/${file}`),
        'tauri/bridge.js', 'tauri/bootstrap.js', 'tauri/close-guard.js', 'assets/icon.png'
    ]) {
        await mkdir(path.dirname(path.join(output, file)), { recursive: true });
        await cp(path.join(appDirectory, file), path.join(output, file));
    }
    for (const [file, entry, bootstrap] of [
        ['renderer/index.html', './app.js', '../tauri/bootstrap.js'],
        ['electron/mini/index.html', 'renderer.js', '../../tauri/bootstrap.js']
    ]) {
        const source = await readFile(path.join(output, file), 'utf8');
        // CSP 由 Tauri 配置统一注入。Electron 的 connect-src 'none' 会阻止 Tauri IPC。
        const html = source.replace(/<meta http-equiv="Content-Security-Policy"[^>]*>\r?\n/, '')
            .replace(`src="${entry}"`, `src="${bootstrap}"`);
        await writeFile(path.join(output, file), html);
    }
    return output;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    console.log(await buildFrontend());
}
