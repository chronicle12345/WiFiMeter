import { cp, mkdir, readFile, rm, writeFile, access } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const appDirectory = fileURLToPath(new URL('../', import.meta.url));
const vendorFiles = {
    'node_modules/marked/lib/marked.esm.js': 'vendor/marked.esm.js',
    'node_modules/dompurify/dist/purify.es.mjs': 'vendor/purify.es.mjs'
};
const miniFiles = ['index.html', 'renderer.js', 'style.css', 'rates.js'];

export async function buildFrontend(output = path.join(appDirectory, 'dist/tauri')) {
    // 先检查依赖，避免安装缺失时生成不完整的可发布目录。
    for (const file of Object.keys(vendorFiles)) await access(path.join(appDirectory, file));
    await rm(output, { recursive: true, force: true });
    await mkdir(output, { recursive: true });
    await cp(path.join(appDirectory, 'renderer'), path.join(output, 'renderer'), { recursive: true });
    for (const file of [
        ...Object.keys(vendorFiles), ...miniFiles.map(file => `electron/mini/${file}`),
        'tauri/bridge.js', 'tauri/bootstrap.js', 'tauri/close-guard.js', 'tauri/dialogs.js', 'tauri/dialogs.css', 'tauri/dialog-copy.json', 'assets/icon.png'
    ]) {
        const destination = path.join(output, vendorFiles[file] || file);
        await mkdir(path.dirname(destination), { recursive: true });
        await cp(path.join(appDirectory, file), destination);
    }
    // Tauri 发布构建禁止 frontendDist 中包含 node_modules，仅复制浏览器实际使用的模块。
    const notesFile = path.join(output, 'renderer/ui/release-notes.js');
    let notes = await readFile(notesFile, 'utf8');
    for (const [source, destination] of Object.entries(vendorFiles)) {
        notes = notes.replace(`'../../${source}'`, `'../../${destination}'`);
    }
    await writeFile(notesFile, notes);
    for (const [file, entry, bootstrap] of [
        ['renderer/index.html', './app.js', '../tauri/bootstrap.js'],
        ['electron/mini/index.html', 'renderer.js', '../../tauri/bootstrap.js']
    ]) {
        const source = await readFile(path.join(output, file), 'utf8');
        // CSP 由 Tauri 配置统一注入。Electron 的 connect-src 'none' 会阻止 Tauri IPC。
        const styled = file === 'renderer/index.html' ? source.replace('</head>', '<link rel="stylesheet" href="../tauri/dialogs.css">\n</head>') : source;
        const html = styled.replace(/<meta http-equiv="Content-Security-Policy"[^>]*>\r?\n/, '')
            .replace(`src="${entry}"`, `src="${bootstrap}"`);
        await writeFile(path.join(output, file), html);
    }
    return output;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    console.log(await buildFrontend());
}
