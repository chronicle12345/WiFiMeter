const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');

const notes = () => require('./notes.cjs');
const { recordPair } = require('./i18n.cjs');
const stem = '2026-10-18-document-workflow';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wifimeter-notes-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function write(root, name, content) {
  const target = path.join(root, name);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
}

function noteText(lifecycle = 'implemented', chinese = false, topic = stem) {
  const status = lifecycle === 'rejected' ? 'rejected — superseded by a simpler approach' : lifecycle;
  const headings = lifecycle === 'implemented'
    ? (chinese ? ['问题', '决定', '备选方案', '影响'] : ['Problem', 'Decision', 'Alternatives considered', 'Consequences'])
    : (chinese ? ['问题', '方案', '备选方案', '验收标准', '风险'] : ['Problem', 'Proposal', 'Alternatives considered', 'Acceptance criteria', 'Risks']);
  const switcher = chinese ? `[English](${topic}.md) | 简体中文` : `English | [简体中文](${topic}.zh-CN.md)`;
  return `# Agent Note: ${chinese ? '文档工作流程' : 'Document workflow'}\n\nStatus: ${status}\n\n${switcher}\n\n${headings.map((heading) => `## ${heading}\n\n${chinese ? '说明已确定的行为。' : 'Explain the established behavior.'}`).join('\n\n')}\n`;
}

function pair(root, lifecycle = 'implemented', topic = stem, kind = 'process') {
  const english = `.agents/notes/${lifecycle}/${kind}/${topic}.md`;
  write(root, english, noteText(lifecycle, false, topic));
  write(root, english.replace(/\.md$/, '.zh-CN.md'), noteText(lifecycle, true, topic));
  recordPair(root, english);
  return english;
}

function tree(root) {
  const out = {};
  function scan(dir, rel = '') {
    for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
      const child = rel ? `${rel}/${item.name}` : item.name;
      if (item.isDirectory()) scan(path.join(dir, item.name), child);
      else out[child] = fs.readFileSync(path.join(dir, item.name)).toString('base64');
    }
  }
  scan(root);
  return out;
}

function git(root, ...args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function initGit(root) {
  git(root, 'init', '-q');
  git(root, 'config', 'user.name', 'Notes test');
  git(root, 'config', 'user.email', 'notes-test@example.invalid');
}

function symlink(t, target, filename) {
  try { fs.symlinkSync(target, filename, 'file'); }
  catch (error) {
    if (['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) { t.skip(`File symlinks are unavailable: ${error.code}`); return false; }
    throw error;
  }
  return true;
}

test('control file inventory accepts a local CLAUDE companion link', (t) => {
  const root = fixture(t);
  write(root, '.agents/notes/AGENTS.md', '# Notes instructions\n');
  write(root, '.agents/notes/CLAUDE.md', 'AGENTS.md');
  const originalReadDirectory = fs.readdirSync;
  const originalReadLink = fs.readlinkSync;
  const noteDirectory = path.join(root, '.agents/notes');
  t.mock.method(fs, 'readdirSync', function (directory, options) {
    const entries = originalReadDirectory.call(fs, directory, options);
    if (directory !== noteDirectory || !options?.withFileTypes) return entries;
    return entries.map(entry => entry.name === 'CLAUDE.md'
      ? { name: entry.name, isSymbolicLink: () => true, isDirectory: () => false, isFile: () => false }
      : entry);
  });
  t.mock.method(fs, 'readlinkSync', function (filename, ...args) {
    return filename === path.join(noteDirectory, 'CLAUDE.md') ? 'AGENTS.md' : originalReadLink.call(fs, filename, ...args);
  });
  assert.deepEqual(notes().checkNotes(root), []);
});

test('control CLAUDE symlinks may point to same-directory AGENTS instructions', (t) => {
  const root = fixture(t);
  for (const directory of ['.agents/notes', '.agents/notes/implemented']) {
    write(root, `${directory}/AGENTS.md`, '# Notes instructions\n');
    if (!symlink(t, 'AGENTS.md', path.join(root, directory, 'CLAUDE.md'))) return;
  }
  assert.deepEqual(notes().checkNotes(root), []);
});

test('control symlinks cannot point at other instructions or leave their directory', (t) => {
  const root = fixture(t);
  write(root, '.agents/notes/AGENTS.md', '# Notes instructions\n');
  write(root, '.agents/AGENTS.md', '# Other instructions\n');
  if (!symlink(t, '../AGENTS.md', path.join(root, '.agents/notes/CLAUDE.md'))) return;
  assert.match(notes().checkNotes(root).join('\n'), /CLAUDE\.md.*symbolic|CLAUDE\.md.*AGENTS/i);
});

test('note content symlinks remain forbidden', (t) => {
  const root = fixture(t);
  const directory = '.agents/notes/implemented/process';
  write(root, `${directory}/2026-10-18-other.md`, noteText());
  if (!symlink(t, '2026-10-18-other.md', path.join(root, directory, `${stem}.md`))) return;
  assert.match(notes().checkNotes(root).join('\n'), /symbolic links/);
});

test('rejects an unknown lifecycle and class, excess nesting, and a calendar-invalid filename', (t) => {
  const root = fixture(t);
  write(root, `.agents/notes/pending/process/${stem}.md`, noteText());
  write(root, `.agents/notes/implemented/refactor/${stem}.md`, noteText());
  write(root, `.agents/notes/implemented/process/nested/${stem}.md`, noteText());
  write(root, '.agents/notes/implemented/process/2026-02-30-invalid.md', noteText());
  const errors = notes().checkNotes(root).join('\n');
  for (const value of ['pending', 'refactor', 'nested', '2026-02-30']) assert.ok(errors.includes(value), errors);
});

test('checks both language headers and requires the lifecycle-specific body', (t) => {
  const root = fixture(t);
  const english = pair(root);
  write(root, english, noteText().replace('Status: implemented', 'Status: proposed').replace('## Consequences', '## Risks'));
  write(root, english.replace(/\.md$/, '.zh-CN.md'), noteText('implemented', true).replace('## 问题', '## 背景'));
  const errors = notes().checkNotes(root).join('\n');
  assert.match(errors, /status|Status/);
  assert.match(errors, /Consequences|影响/);
  assert.match(errors, /Problem|问题/);
});

test('implemented notes reject proposal headings outside examples', (t) => {
  const root = fixture(t);
  const english = pair(root);
  write(root, english, noteText() + '\n```md\n## Proposal\n```\n\n<!--\n## Migration plan\n-->\n');
  assert.deepEqual(notes().checkNotes(root), []);
  write(root, english, noteText() + '\n## 迁移计划\n');
  assert.match(notes().checkNotes(root).join('\n'), /迁移计划/);
});

test('rejecting a proposal retains its sections and requires a reason', (t) => {
  const root = fixture(t);
  const english = pair(root, 'rejected');
  assert.deepEqual(notes().checkNotes(root), []);
  write(root, english, noteText('rejected').replace('Status: rejected — superseded by a simpler approach', 'Status: rejected').replace('## Risks', '## Other'));
  const errors = notes().checkNotes(root).join('\n');
  assert.match(errors, /reason|Status/);
  assert.match(errors, /Risks|风险/);
});

test('archives a complete triplet and seals every resulting artifact', (t) => {
  const root = fixture(t);
  const english = pair(root);
  notes().archiveNote(root, english, { date: '2026-10-19' });
  const archivedEnglish = english.replace('/implemented/', '/archived/');
  assert.equal(fs.existsSync(path.join(root, english)), false);
  for (const suffix of ['.md', '.zh-CN.md']) {
    const filename = archivedEnglish.replace(/\.md$/, suffix);
    assert.match(fs.readFileSync(path.join(root, filename), 'utf8'), /Status: implemented\nArchived: 2026-10-19\n\n/);
  }
  const manifest = JSON.parse(fs.readFileSync(path.join(root, '.agents/notes/archived/manifest.json'), 'utf8'));
  assert.equal(manifest.version, 1);
  assert.deepEqual(Object.keys(manifest.files).sort(), [`.i18n.json`, '.md', '.zh-CN.md'].map((suffix) => `process/${stem}${suffix}`).sort());
  for (const [relative, seal] of Object.entries(manifest.files)) {
    const bytes = fs.readFileSync(path.join(root, '.agents/notes/archived', relative));
    assert.equal(seal, `sha256:${createHash('sha256').update(bytes).digest('hex')}`);
  }
  assert.deepEqual(notes().checkNotes(root), []);
});

for (const failure of ['missing translation', 'missing record', 'stale record', 'target occupied', 'translation target occupied', 'invalid date', 'before proposal date', 'not implemented', 'escaped path', 'malformed manifest']) {
  test(`archive preflight preserves all source bytes for ${failure}`, (t) => {
    const root = fixture(t);
    let english = pair(root, failure === 'not implemented' ? 'proposed' : 'implemented');
    if (failure === 'missing translation') fs.unlinkSync(path.join(root, english.replace(/\.md$/, '.zh-CN.md')));
    if (failure === 'missing record') fs.unlinkSync(path.join(root, english.replace(/\.md$/, '.i18n.json')));
    if (failure === 'stale record') fs.appendFileSync(path.join(root, english), '\nUnrecorded source edit.\n');
    if (failure === 'target occupied') write(root, english.replace('/implemented/', '/archived/'), 'existing archive bytes\n');
    if (failure === 'translation target occupied') write(root, english.replace('/implemented/', '/archived/').replace(/\.md$/, '.zh-CN.md'), 'existing translated archive bytes\n');
    if (failure === 'malformed manifest') write(root, '.agents/notes/archived/manifest.json', '{broken');
    if (failure === 'escaped path') english = '../outside.md';
    const before = tree(root);
    const date = failure === 'invalid date' ? '2026-02-30' : failure === 'before proposal date' ? '2026-10-17' : '2026-10-19';
    assert.throws(() => notes().archiveNote(root, english, { date }));
    assert.deepEqual(tree(root), before);
  });
}

test('archive seals remain stable after a Windows CRLF checkout', (t) => {
  const root = fixture(t);
  const english = pair(root);
  notes().archiveNote(root, english, { date: '2026-10-19' });
  const archiveDirectory = path.join(root, '.agents/notes/archived/process');
  for (const filename of fs.readdirSync(archiveDirectory)) {
    const target = path.join(archiveDirectory, filename);
    fs.writeFileSync(target, fs.readFileSync(target, 'utf8').replaceAll('\n', '\r\n'));
  }
  assert.deepEqual(notes().checkNotes(root), []);
});

test('frozen archives reject modified content, missing members, and unsealed extra files', (t) => {
  const root = fixture(t);
  const english = pair(root);
  notes().archiveNote(root, english, { date: '2026-10-19' });
  const archivedEnglish = english.replace('/implemented/', '/archived/');
  fs.appendFileSync(path.join(root, archivedEnglish), '\nChanged after sealing.\n');
  fs.unlinkSync(path.join(root, archivedEnglish.replace(/\.md$/, '.zh-CN.md')));
  write(root, '.agents/notes/archived/process/extra.txt', 'unsealed\n');
  const errors = notes().checkNotes(root).join('\n');
  assert.match(errors, /seal|hash|sha256/i);
  assert.match(errors, /zh-CN/);
  assert.match(errors, /extra\.txt/);
});

test('a real Git baseline catches an archive changed together with its current seal', (t) => {
  const root = fixture(t);
  initGit(root);
  const english = pair(root);
  notes().archiveNote(root, english, { date: '2026-10-19' });
  git(root, 'add', '.');
  git(root, 'commit', '-qm', 'record archive baseline');
  const baseline = git(root, 'rev-parse', 'HEAD');
  const relative = `process/${stem}.md`;
  const archivedEnglish = `.agents/notes/archived/${relative}`;
  fs.appendFileSync(path.join(root, archivedEnglish), '\nRewritten history.\n');
  recordPair(root, archivedEnglish);
  const manifestPath = path.join(root, '.agents/notes/archived/manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  for (const key of Object.keys(manifest.files)) manifest.files[key] = `sha256:${createHash('sha256').update(fs.readFileSync(path.join(root, '.agents/notes/archived', key))).digest('hex')}`;
  fs.writeFileSync(manifestPath, JSON.stringify(manifest));
  const errors = notes().checkNotes(root, { baseRef: baseline }).join('\n');
  assert.match(errors, /baseline|append.only|changed.*seal|sealed.*changed/i);
  assert.match(notes().checkNotes(root).join('\n'), /baseline|append.only|changed.*seal|sealed.*changed/i);
});

test('explicit missing Git baselines fail while a new-branch zero SHA needs no baseline', (t) => {
  const root = fixture(t);
  initGit(root);
  pair(root);
  git(root, 'add', '.');
  git(root, 'commit', '-qm', 'initial note');
  assert.match(notes().checkNotes(root, { baseRef: 'does-not-exist' }).join('\n'), /baseline|base ref|does-not-exist/i);
  assert.deepEqual(notes().checkNotes(root, { baseRef: '0'.repeat(40) }), []);
  assert.deepEqual(notes().checkNotes(root, { baseRef: 'HEAD' }), []);
});
