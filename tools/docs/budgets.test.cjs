const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { countWords, checkBudgets } = require('./budgets.cjs');

function write(root, name, content) {
    const target = path.join(root, name);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
}

function config(overrides = {}) {
    return {
        version: 1,
        defaults: {
            rootAgent: { en: 800, zh: 2400 },
            subtreeAgent: { en: 400, zh: 1200 },
            note: { en: 500, zh: 1600 },
            reference: { en: 1200, zh: 3600 },
            rootReadme: { en: 1000, zh: 3000 },
            terminology: { en: 1200, zh: 3600 }
        },
        overrides
    };
}

function fixture(t, files, limits = config()) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wifimeter-doc-budgets-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    write(root, 'tools/docs/budgets.json', JSON.stringify(limits));
    for (const [name, text] of Object.entries(files)) write(root, name, text);
    return root;
}

test('counts every Han character and embedded English words across visible Markdown', () => {
    assert.equal(countWords('# Hello 世界\n\n中文 WiFiMeter 说明。\n\n- `npm test`\n\n| Name | 值 |\n| - | - |\n| alpha | 一 |\n'), 14);
});

test('excludes fenced code, URL destinations, visible URLs, HTML attributes, comments, and images', () => {
    const text = '# Guide\n\n[Read docs](https://example.com/a/b)\n\nhttps://example.com/visible-url\n\n```sh\nthese many code words do not count\n```\n\n<p data-test="many hidden attribute words">中文 <b>guide</b></p>\n\n<!-- hidden comment words -->\n\n![hidden alt text](assets/preview.png)\n';
    assert.equal(countWords(text), 6);
});

test('counts inline code and visible HTML text without counting attributes', () => {
    assert.equal(countWords('运行 `npm run build`。<span title="do not count">两个单词 hello world</span>'), 11);
});

test('decodes HTML entities in prose while preserving literal inline code', () => {
    assert.equal(countWords('One&nbsp;two'), 2);
    assert.equal(countWords('one &amp; two'), 2);
    assert.equal(countWords('One&#32;two &#x1f600;'), 2);
    assert.equal(countWords('&lt;literal&gt;'), 1);
    assert.equal(countWords('`One&nbsp;two`'), 3);
});

test('the exact budget passes and one additional unit fails independently for each language', (t) => {
    const root = fixture(t, { 'docs/guide.md': '# One\n\nTwo three\n', 'docs/guide.zh-CN.md': '# 一\n\n二三\n' }, config({ 'docs/guide.md': { en: 3, zh: 3 } }));
    assert.deepEqual(checkBudgets(root), []);
    write(root, 'docs/guide.zh-CN.md', '# 一\n\n二三四\n');
    assert.match(checkBudgets(root).join('\n'), /guide\.zh-CN\.md.*4.*3/);
    write(root, 'docs/guide.md', '# One\n\nTwo three four\n');
    assert.equal(checkBudgets(root).length, 2);
});

test('new active documents automatically use their type default without a per-file list', (t) => {
    const limits = config();
    limits.defaults.reference.en = 2;
    limits.defaults.subtreeAgent.en = 2;
    const root = fixture(t, { 'docs/new-reference.md': '# Three word title\n', 'src/AGENTS.md': '# Three word title\n' }, limits);
    const errors = checkBudgets(root).join('\n');
    assert.ok(errors.includes('docs/new-reference.md'), errors);
    assert.ok(errors.includes('src/AGENTS.md'), errors);
});

test('maintained backend platform and packaging contracts use the reference budget', (t) => {
    const limits = config();
    limits.defaults.reference.en = 2;
    const root = fixture(t, {
        'backend/platform/win32/APP_TRAFFIC.md': '# Three word title\n',
        'packaging/tauri/windows/SOURCES.md': '# Three word title\n',
        'contracts/APPLICATION_TRAFFIC.md': '# Three word title\n'
    }, limits);
    const errors = checkBudgets(root).join('\n');
    assert.ok(errors.includes('APP_TRAFFIC.md'), errors);
    assert.ok(errors.includes('SOURCES.md'), errors);
    assert.ok(errors.includes('contracts/APPLICATION_TRAFFIC.md'), errors);
});

test('rejects missing and malformed budget configuration rather than silently disabling limits', (t) => {
    const root = fixture(t, { 'docs/guide.md': '# Guide\n' });
    fs.unlinkSync(path.join(root, 'tools/docs/budgets.json'));
    assert.match(checkBudgets(root).join('\n'), /budgets\.json|configuration/i);
    write(root, 'tools/docs/budgets.json', '{invalid');
    assert.match(checkBudgets(root).join('\n'), /JSON|configuration/i);
    const limits = config();
    delete limits.defaults.note;
    write(root, 'tools/docs/budgets.json', JSON.stringify(limits));
    assert.match(checkBudgets(root).join('\n'), /note|default/i);
});

test('rejects stale exception paths, unsafe paths, and invalid limits', (t) => {
    const root = fixture(t, { 'docs/guide.md': '# Guide\n' }, config({ 'docs/missing.md': { en: 10, zh: 20 } }));
    assert.match(checkBudgets(root).join('\n'), /missing\.md/);
    write(root, 'tools/docs/budgets.json', JSON.stringify(config({ '../outside.md': { en: 10, zh: 20 } })));
    assert.match(checkBudgets(root).join('\n'), /outside|escape/i);
    const limits = config();
    limits.defaults.note.en = 0;
    write(root, 'tools/docs/budgets.json', JSON.stringify(limits));
    assert.match(checkBudgets(root).join('\n'), /positive|limit|note/i);
});

test('historical files and third-party license texts are exempt while current terminology has a limit', (t) => {
    const large = 'word '.repeat(5000);
    const root = fixture(t, {
        'CHANGELOG.md': large,
        'docs/releases/v1.md': large,
        '.agents/notes/archived/process/2026-01-01-old.md': large,
        'vendor/lib/README.md': large,
        'docs/third-party/LICENSE.md': large,
        'backend/third_party/sqlite/README.md': large,
        'docs/i18n/terminology.md': large
    });
    const errors = checkBudgets(root);
    assert.equal(errors.length, 1, errors.join('\n'));
    assert.match(errors[0], /terminology\.md/);
});

test('project-maintained notice and dependency documentation retain their budgets', (t) => {
    const limits = config();
    limits.defaults.reference.en = 2;
    const root = fixture(t, {
        'docs/NOTICE.md': '# Three word title\n',
        'docs/THIRD_PARTY_NOTICES.md': '# Three word title\n'
    }, limits);
    const errors = checkBudgets(root);
    assert.equal(errors.length, 2, errors.join('\n'));
    assert.ok(errors.some(error => error.includes('docs/NOTICE.md')));
    assert.ok(errors.some(error => error.includes('docs/THIRD_PARTY_NOTICES.md')));
});
