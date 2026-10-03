import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildFrontend } from '../tauri/build-frontend.mjs';

const appDirectory = fileURLToPath(new URL('../', import.meta.url));

test('Tauri 构建复用全部页面代码与样式，适配启动入口、CSP 和宿主弹窗样式', async () => {
    const output = await mkdtemp(path.join(os.tmpdir(), 'wifimeter-assets-'));
    try {
        await writeFile(path.join(output, 'stale.js'), 'old build');
        await buildFrontend(output);
        const files = await readdir(output, { recursive: true });
        assert.ok(!files.includes('stale.js'));
        assert.ok(!files.some(file => file.split(path.sep).includes('node_modules')));
        assert.ok(!files.some(file => /preload|main\.cjs|electron\.asar/.test(file)));
        for (const file of files) {
            if (!(await stat(path.join(output, file))).isFile()) continue;
            const relative = file.split(path.sep).join('/');
            const built = await readFile(path.join(output, file), 'utf8');
            const original = {
                'vendor/marked.esm.js': 'node_modules/marked/lib/marked.esm.js',
                'vendor/purify.es.mjs': 'node_modules/dompurify/dist/purify.es.mjs'
            }[relative] || file;
            const source = await readFile(path.join(appDirectory, original), 'utf8');
            if (relative.endsWith('index.html')) {
                const main = relative === 'renderer/index.html';
                const styled = main ? source.replace('</head>', '<link rel="stylesheet" href="../tauri/dialogs.css">\n</head>') : source;
                const normalized = styled.replace(/<meta http-equiv="Content-Security-Policy"[^>]*>\r?\n/, '')
                    .replace(main ? 'src="./app.js"' : 'src="renderer.js"',
                        main ? 'src="../tauri/bootstrap.js"' : 'src="../../tauri/bootstrap.js"');
                assert.equal(built, normalized, relative);
            } else if (relative === 'renderer/ui/release-notes.js') {
                assert.equal(built, source
                    .replace('../../node_modules/marked/lib/marked.esm.js', '../../vendor/marked.esm.js')
                    .replace('../../node_modules/dompurify/dist/purify.es.mjs', '../../vendor/purify.es.mjs'));
            } else {
                assert.equal(built, source, `${relative} 必须保持不变`);
            }
            if (relative.startsWith('vendor/')) continue;
            // 验证实际输出中的 HTML、JS 和 CSS 相对依赖，尤其是小窗的共享速率和 token。
            const imports = [...built.matchAll(/(?:from\s+|import\s*\(|(?:src|href)=|url\()["']([^"']+)["']/g)];
            for (const [, target] of imports) {
                if (!target.startsWith('.') && !/\.(js|css)$/.test(target)) continue;
                assert.ok((await stat(path.resolve(output, path.dirname(file), target))).isFile(), `${relative} -> ${target}`);
            }
        }
        const rendererFiles = await readdir(path.join(appDirectory, 'renderer'), { recursive: true });
        for (const file of rendererFiles) {
            assert.ok(files.includes(path.join('renderer', file)), `缺少 ${file}`);
        }
    } finally {
        await rm(output, { recursive: true, force: true });
    }
});
