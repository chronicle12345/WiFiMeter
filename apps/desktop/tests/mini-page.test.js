import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const page = await readFile(fileURLToPath(new URL('../renderer/mini/index.html', import.meta.url)), 'utf8');

test('小窗拖动区不声明悬停提示，鼠标移上去不再弹出操作说明', () => {
    const drag = page.match(/<main[^>]*>/)?.[0];
    assert.ok(drag, '小窗缺少拖动区域');
    assert.ok(!/\stitle=/.test(drag), '小窗拖动区不应声明悬停提示');
});

test('小窗保留贴边收起所需的边条元素', () => {
    assert.match(page, /class="edge-strip"/);
    assert.match(page, /data-collapsed="false"/);
});

test('收起动效时长与宿主逐帧收缩的时长一致', async () => {
    const geometry = await readFile(fileURLToPath(new URL('../src-tauri/src/mini_geometry.rs', import.meta.url)), 'utf8');
    const style = await readFile(fileURLToPath(new URL('../renderer/mini/style.css', import.meta.url)), 'utf8');
    const host = Number(/pub const COLLAPSE: u64 = (\d+);/.exec(geometry)?.[1]);
    const renderer = Number(/--mini-collapse:(\d+)ms/.exec(style)?.[1]);
    assert.ok(host > 0 && renderer > 0, '宿主和页面都要声明收起动效时长');
    assert.equal(renderer, host, '页面过渡时长必须与 mini_geometry::COLLAPSE 相同');
});
