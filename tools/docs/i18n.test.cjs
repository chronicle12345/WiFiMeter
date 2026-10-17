const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { test } = require('node:test');

const { checkPairs, recordPair, recordPairs } = require('./i18n.cjs');
const { checkMarkdown } = require('./markdown.cjs');

function fixture(t, files = {}) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wifimeter-doc-pairs-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    for (const [name, text] of Object.entries(files)) write(root, name, text);
    return root;
}

function write(root, name, text) {
    const target = path.join(root, name);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, text);
}

const english = '# Guide\n\nEnglish | [简体中文](guide.zh-CN.md)\n\n## Setup\n\nRead the guide.\n';
const chinese = '# 使用指南\n\n[English](guide.md) | 简体中文\n\n## 安装\n\n阅读指南。\n';

function pairFixture(t, en = english, zh = chinese) {
    return fixture(t, { 'docs/guide.md': en, 'docs/guide.zh-CN.md': zh });
}

test('a complete translation without a record fails instead of silently becoming confirmed', (t) => {
    const root = pairFixture(t);
    assert.match(checkPairs(root).join('\n'), /guide\.i18n\.json.*missing|missing.*guide\.i18n\.json/i);
});

test('finds an untranslated source, an orphan translation, and an orphan record', (t) => {
    const root = fixture(t, {
        'docs/source.md': '# Source\n',
        'docs/orphan.zh-CN.md': '# 孤立译文\n',
        'docs/record-only.i18n.json': '{}\n',
    });
    const errors = checkPairs(root).join('\n');
    for (const name of ['source.zh-CN.md', 'orphan.md', 'record-only.md']) assert.ok(errors.includes(name), errors);
});

test('recording is explicit, normalizes LF, and detects either language changing afterwards', (t) => {
    const root = pairFixture(t, english.replaceAll('\n', '\r\n'));
    assert.throws(() => recordPairs(root, [] , { reviewed: true }), /path|named|empty/i);
    assert.throws(() => recordPairs(root, ['docs/guide.md']), /review/i);
    recordPairs(root, ['docs/guide.zh-CN.md'], { reviewed: true });
    const record = JSON.parse(fs.readFileSync(path.join(root, 'docs/guide.i18n.json'), 'utf8'));
    assert.deepEqual(Object.keys(record).sort(), ['chinese', 'english', 'sha256', 'version']);
    assert.equal(record.version, 1);
    assert.equal(record.english, 'guide.md');
    assert.equal(record.chinese, 'guide.zh-CN.md');
    assert.equal(record.sha256.en, createHash('sha256').update(english).digest('hex'));
    assert.deepEqual(checkPairs(root), []);
    write(root, 'docs/guide.md', english);
    assert.deepEqual(checkPairs(root), []);
    write(root, 'docs/guide.zh-CN.md', chinese.replace('阅读指南。', '阅读安装指南。'));
    assert.match(checkPairs(root).join('\n'), /hash|sha256|out.of.sync/i);
    recordPairs(root, ['docs/guide.md'], { reviewed: true });
    write(root, 'docs/guide.md', english.replace('Read the guide.', 'Read the installation guide.'));
    assert.match(checkPairs(root).join('\n'), /hash|sha256|out.of.sync/i);
});

test('rejects malformed records and records naming a different sibling', (t) => {
    const root = pairFixture(t);
    recordPair(root, 'docs/guide.md');
    const filename = path.join(root, 'docs/guide.i18n.json');
    write(root, 'docs/guide.i18n.json', '{invalid');
    assert.match(checkPairs(root).join('\n'), /record|JSON/i);
    recordPair(root, 'docs/guide.md');
    const record = JSON.parse(fs.readFileSync(filename, 'utf8'));
    record.english = 'another.md';
    fs.writeFileSync(filename, JSON.stringify(record));
    assert.match(checkPairs(root).join('\n'), /record|english|sibling/i);
});

for (const [name, enBody, zhBody, expected] of [
    ['heading depth', '## Setup\n', '### 安装\n', /heading|structure/i],
    ['table columns', '| A | B |\n| - | - |\n| x | y |\n', '| 甲 |\n| - |\n| 值 |\n', /table|structure/i],
    ['table rows', '| A |\n| - |\n| x |\n| y |\n', '| 甲 |\n| - |\n| 值 |\n', /table|structure/i],
    ['list nesting', '- one\n  - nested\n', '- 一项\n- 嵌套项\n', /list|structure/i],
    ['ordered list starts', '3. one\n4. two\n', '1. 一\n2. 二\n', /list|structure/i],
    ['task state', '- [x] done\n', '- [ ] 完成\n', /list|task|structure/i],
    ['fenced code bytes', '```sh\nnpm test\n```\n', '```sh\nnpm run test\n```\n', /code|structure/i],
    ['fenced code language', '```sh\nnpm test\n```\n', '```bash\nnpm test\n```\n', /code|structure/i],
]) {
    test(`refuses to record a pair with different ${name}`, (t) => {
        const root = pairFixture(t, english.split('## Setup')[0] + enBody, chinese.split('## 安装')[0] + zhBody);
        assert.throws(() => recordPairs(root, ['docs/guide.md'], { reviewed: true }), expected);
        assert.equal(fs.existsSync(path.join(root, 'docs/guide.i18n.json')), false);
    });
}

test('links preserve semantic destinations and locale while localized fragments and images may differ', (t) => {
    const root = pairFixture(t,
        english + '\n[Next](next.md#setup)\n\n![Screenshot](assets/en.png)\n',
        chinese + '\n[下一步](next.zh-CN.md#安装)\n\n![截图](assets/zh.png)\n');
    write(root, 'docs/next.md', '# Next\n');
    write(root, 'docs/next.zh-CN.md', '# 下一步\n');
    recordPair(root, 'docs/guide.md');
    assert.deepEqual(checkPairs(root, ['docs/guide.i18n.json']), []);
    write(root, 'docs/guide.zh-CN.md', chinese + '\n[下一步](next.md#安装)\n');
    assert.throws(() => recordPair(root, 'docs/guide.md'), /locale|language|\.zh-CN/i);
    write(root, 'docs/guide.zh-CN.md', chinese + '\n[下一步](other.zh-CN.md#安装)\n');
    assert.throws(() => recordPair(root, 'docs/guide.md'), /link|destination|structure/i);
});

test('code links are not Markdown links and both language switchers are required', (t) => {
    const root = pairFixture(t,
        english + '\n```md\n[Example](untranslated.md)\n```\n',
        chinese + '\n```md\n[Example](untranslated.md)\n```\n');
    recordPair(root, 'docs/guide.md');
    assert.deepEqual(checkPairs(root), []);
    write(root, 'docs/guide.zh-CN.md', chinese.replace('[English](guide.md) | 简体中文', '简体中文'));
    assert.throws(() => recordPair(root, 'docs/guide.md'), /switch|backlink|English/i);
});

test('excluded documents do not need pairs, including archived notes', (t) => {
    const root = fixture(t, {
        'AGENTS.md': '# Instructions\n',
        'docs/AGENTS.md': '# Instructions\n',
        'docs/CLAUDE.md': '# Instructions\n',
        'CHANGELOG.md': '# Changelog\n',
        'docs/releases/v1.md': '# Release\n',
        'docs/i18n/terminology.md': '# Terms\n',
        '.agents/notes/archived/architecture/2026-01-01-old.md': '# Old\n',
        'vendor/library/README.md': '# Vendor\n',
        'docs/third-party/LICENSE.md': '# Original license\n',
        'backend/third_party/sqlite/README.md': '# Upstream SQLite\n',
    });
    assert.deepEqual(checkPairs(root), []);
});

test('project-maintained notice and dependency documentation require translation', (t) => {
    const root = fixture(t, {
        'docs/NOTICE.md': '# Project notices\n',
        'docs/THIRD_PARTY_NOTICES.md': '# Project dependencies\n'
    });
    const errors = checkPairs(root).join('\n');
    assert.ok(errors.includes('docs/NOTICE.zh-CN.md'), errors);
    assert.ok(errors.includes('docs/THIRD_PARTY_NOTICES.zh-CN.md'), errors);
});

test('maintained backend platform and packaging contracts also require complete pairs', (t) => {
    const root = fixture(t, {
        'backend/platform/win32/APP_TRAFFIC.md': '# Application traffic\n',
        'packaging/tauri/windows/SOURCES.md': '# Sources\n',
        'contracts/APPLICATION_TRAFFIC.md': '# Application traffic\n'
    });
    const errors = checkPairs(root).join('\n');
    assert.ok(errors.includes('backend/platform/win32/APP_TRAFFIC.zh-CN.md'), errors);
    assert.ok(errors.includes('packaging/tauri/windows/SOURCES.zh-CN.md'), errors);
    assert.ok(errors.includes('contracts/APPLICATION_TRAFFIC.zh-CN.md'), errors);
});

test('ignored private sidecars do not enter pair discovery', (t) => {
    const root = fixture(t, {
        '.aws/README.i18n.json': '{}\n',
        'del/README.i18n.json': '{}\n'
    });
    assert.deepEqual(checkPairs(root), []);
});

test('record paths cannot escape the repository', (t) => {
    const root = pairFixture(t);
    assert.throws(() => recordPairs(root, ['../outside.md'], { reviewed: true }), /outside|escape|root|path/i);
});

test('CLI recording requires named paths or explicit all and reviewed flags', (t) => {
    const root = pairFixture(t);
    const entry = path.join(__dirname, 'i18n.cjs');
    const run = args => spawnSync(process.execPath, ['-e', 'process.exitCode = require(process.argv[1]).main(JSON.parse(process.argv[3]), process.argv[2])', entry, root, JSON.stringify(args)], { encoding: 'utf8' });
    for (const args of [['record'], ['record', '--reviewed'], ['record', '--all'], ['record', 'docs/guide.md', '--all', '--reviewed']]) {
        assert.notEqual(run(args).status, 0, JSON.stringify(args));
        assert.equal(fs.existsSync(path.join(root, 'docs/guide.i18n.json')), false);
    }
    assert.equal(run(['record', '--all', '--reviewed']).status, 0);
    assert.equal(run(['check', 'docs/guide.zh-CN.md']).status, 0);
    assert.match(run(['list']).stdout, /ok\s+docs\/guide\.md/);
});

test('Markdown validation reports missing Markdown, source, image, and reference-link targets', (t) => {
    const root = fixture(t, {
        'docs/guide.md': '# Guide\n\n[Missing](missing.md)\n\n[Source](../src/missing.cpp)\n\n![Image](assets/missing.png)\n\n[Reference][ref]\n\n[ref]: reference.md\n',
    });
    const errors = checkMarkdown(root).join('\n');
    for (const target of ['missing.md', 'missing.cpp', 'missing.png', 'reference.md']) assert.ok(errors.includes(target), errors);
});

test('Markdown validation checks HTML targets and ignores comments, fenced code, inline code, and external URLs', (t) => {
    const root = fixture(t, {
        'docs/guide.md': '# Guide\n\n<a href="absent.md">Link</a>\n\n<img src="absent.png" alt="image > preview">\n\n<!-- <a href="comment.md">hidden</a> -->\n\n`[Code](inline.md)`\n\n```md\n[Example](example.md)\n```\n\n[External](https://example.com/not-checked)\n',
    });
    const errors = checkMarkdown(root).join('\n');
    assert.ok(errors.includes('absent.md'), errors);
    assert.ok(errors.includes('absent.png'), errors);
    for (const ignored of ['comment.md', 'inline.md', 'example.md', 'not-checked']) assert.ok(!errors.includes(ignored), errors);
});

test('Markdown validation permits existing localized images and Chinese heading fragments', (t) => {
    const root = fixture(t, {
        'docs/guide.zh-CN.md': '# 使用指南\n\n[本页](#使用指南)\n\n[下一页](next.zh-CN.md#安装)\n\n![截图](assets/中文.png)\n',
        'docs/next.zh-CN.md': '# 安装\n',
        'docs/assets/中文.png': 'fixture image bytes',
    });
    assert.deepEqual(checkMarkdown(root), []);
});

test('Markdown validation rejects links escaping the repository, including encoded traversal', (t) => {
    const root = fixture(t, { 'README.md': '# Guide\n\n[Outside](../outside.md)\n\n[Encoded](%2e%2e/outside.md)\n' });
    const errors = checkMarkdown(root).join('\n');
    assert.match(errors, /escape|outside/i);
    assert.equal(checkMarkdown(root).length, 2);
});

test('Markdown validation rejects a symlink that resolves outside the repository', (t) => {
    const root = fixture(t, { 'README.md': '# Guide\n\n[Outside](linked/file.md)\n' });
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'wifimeter-doc-external-'));
    t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
    fs.writeFileSync(path.join(outside, 'file.md'), '# External\n');
    try {
        fs.symlinkSync(outside, path.join(root, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
    } catch (error) {
        if (['EPERM', 'EACCES', 'ENOSYS'].includes(error.code)) { t.skip(`Host does not allow symlink creation (${error.code})`); return; }
        throw error;
    }
    assert.match(checkMarkdown(root).join('\n'), /outside|symlink|escape/i);
});
