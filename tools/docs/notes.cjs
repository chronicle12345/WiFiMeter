'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { normalizeText, digest, safePath, readText, markdownFiles } = require('./repository.cjs');

const NOTE_ROOT = '.agents/notes';
const MANIFEST = `${NOTE_ROOT}/archived/manifest.json`;
const STATES = new Set(['proposed', 'implemented', 'rejected', 'archived']);
const CLASSES = new Set(['feature', 'bug-fix', 'simplification', 'architecture', 'process', 'testing']);
const CONTROL_FILES = new Set(['AGENTS.md', 'CLAUDE.md', 'README.md', 'README.zh-CN.md', 'README.i18n.json']);
const SHA256 = /^sha256:[0-9a-f]{64}$/;

function validDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function artifactName(filename) {
  const match = /^(\d{4}-\d{2}-\d{2}-.+?)(\.zh-CN\.md|\.i18n\.json|\.md)$/.exec(filename);
  return match && validDate(match[1].slice(0, 10)) ? { stem: match[1], suffix: match[2] } : undefined;
}

function inventory(root, errors) {
  const files = new Map();
  const start = safePath(root, NOTE_ROOT);
  if (!fs.existsSync(start)) return files;
  function scan(directory, segments) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const parts = [...segments, entry.name];
      const relative = parts.join('/');
      if (entry.isSymbolicLink()) {
        const controlLocation = parts.length === 1 || parts.length === 2 && STATES.has(parts[0]) && parts[0] !== 'archived';
        if (controlLocation && entry.name === 'CLAUDE.md') {
          try {
            const companion = safePath(root, `${NOTE_ROOT}/${relative}`);
            const instructions = path.join(directory, 'AGENTS.md');
            if (path.resolve(directory, fs.readlinkSync(companion)) !== instructions || !fs.lstatSync(instructions).isFile()) throw new Error('expected a link to same-directory AGENTS.md');
            safePath(root, `${NOTE_ROOT}/${[...segments, 'AGENTS.md'].join('/')}`);
            continue;
          } catch (error) { errors.push(`${NOTE_ROOT}/${relative}: invalid CLAUDE.md symbolic link: ${error.message}`); continue; }
        }
        errors.push(`${NOTE_ROOT}/${relative}: symbolic links are not allowed in the Notes tree`);
        continue;
      }
      if (entry.isDirectory()) {
        if (parts.length === 1 && !STATES.has(entry.name)) errors.push(`${NOTE_ROOT}/${relative}: unknown lifecycle`);
        else if (parts.length === 2 && !CLASSES.has(entry.name)) errors.push(`${NOTE_ROOT}/${relative}: unknown class`);
        else if (parts.length > 2) errors.push(`${NOTE_ROOT}/${relative}: expected lifecycle/class/file, without nested directories`);
        scan(path.join(directory, entry.name), parts);
        continue;
      }
      if (!entry.isFile()) { errors.push(`${NOTE_ROOT}/${relative}: expected a regular file`); continue; }
      if (parts.length === 1 && CONTROL_FILES.has(entry.name)) continue;
      if (parts[0] === 'archived' && relative === 'archived/manifest.json') continue;
      if (parts[0] !== 'archived' && parts.length === 2 && CONTROL_FILES.has(entry.name)) continue;
      if (parts.length !== 3 || !STATES.has(parts[0]) || !CLASSES.has(parts[1]) || !artifactName(entry.name)) {
        errors.push(`${NOTE_ROOT}/${relative}: expected lifecycle/class/yyyy-mm-dd-topic.{md,zh-CN.md,i18n.json} with a valid date`);
      }
      files.set(relative, readText(root, `${NOTE_ROOT}/${relative}`));
    }
  }
  scan(start, []);
  return files;
}

// Only document prose contributes headings and state lines; examples and comments do not.
function proseLines(text) {
  const out = [];
  let fence;
  let comment = false;
  for (const line of normalizeText(text).split('\n')) {
    if (fence) {
      if (new RegExp(`^ {0,3}${fence.char}{${fence.length},}\\s*$`).test(line)) fence = undefined;
      continue;
    }
    if (comment) {
      if (line.includes('-->')) comment = false;
      continue;
    }
    if (line.includes('<!--')) { comment = !line.includes('-->', line.indexOf('<!--') + 4); continue; }
    const opening = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (opening) { fence = { char: opening[1][0], length: opening[1].length }; continue; }
    if (!/^\s*>/.test(line)) out.push(line);
  }
  return out;
}

function checkHeader(relative, text, state, errors) {
  const lines = text.split('\n');
  const fail = message => errors.push(`${NOTE_ROOT}/${relative}: ${message}`);
  if (!/^# Agent Note: \S/.test(lines[0] || '')) fail('line 1 must be # Agent Note: <title>');
  if (lines[1] !== '') fail('line 2 must be blank');
  const status = state === 'rejected' ? /^Status: rejected — \S.*$/ : new RegExp(`^Status: ${state === 'archived' ? 'implemented' : state}$`);
  if (!status.test(lines[2] || '')) fail(`line 3 must match Status: ${state === 'archived' ? 'implemented' : state}${state === 'rejected' ? ' — reason' : ''}`);
  if (proseLines(text).filter(line => /^Status:/.test(line)).length !== 1) fail('Status: must appear exactly once outside examples');
  if (state !== 'archived') {
    if (lines[3] !== '') fail('line 4 must be blank');
    if (proseLines(text).some(line => /^Archived:/.test(line))) fail('active notes may not carry Archived: metadata');
  } else {
    const archived = /^Archived: (\d{4}-\d{2}-\d{2})$/.exec(lines[3] || '')?.[1];
    const firstDate = path.posix.basename(relative).slice(0, 10);
    if (!archived || !validDate(archived) || archived < firstDate) fail('line 4 must have a valid Archived: YYYY-MM-DD at or after the proposal date');
    if (lines[4] !== '') fail('line 5 must be blank after Archived:');
  }
}

function checkBody(relative, text, state, errors) {
  const headings = proseLines(text).filter(line => /^## /.test(line)).map(line => line.trimEnd());
  const required = state === 'implemented'
    ? [['Problem', '问题'], ['Decision', '决定'], ['Alternatives considered', '备选方案'], ['Consequences', '影响']]
    : [['Problem', '问题'], ['Proposal', '方案'], ['Alternatives considered', '备选方案'], ['Acceptance criteria', '验收标准'], ['Risks', '风险']];
  if (!['## Problem', '## 问题'].includes(headings[0])) errors.push(`${NOTE_ROOT}/${relative}: first section must be ## Problem / ## 问题`);
  for (const names of required) {
    if (!names.some(name => headings.includes(`## ${name}`))) errors.push(`${NOTE_ROOT}/${relative}: missing ## ${names.join(' / ## ')}`);
  }
  if (state === 'implemented') {
    const banned = /^## (?:Proposal\b|Plan\b|Migration plan\b|Acceptance criteria\b|方案(?:$|[（(])|提案(?:$|[（(])|提议(?:$|[（(])|计划(?:$|[（(])|迁移计划(?:$|[（(])|验收标准(?:$|[（(]))/i;
    for (const heading of headings.filter(item => banned.test(item))) errors.push(`${NOTE_ROOT}/${relative}: proposal heading is forbidden in implemented notes: ${heading}`);
  }
}

function parseManifest(text) {
  const value = JSON.parse(text);
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).sort().join(',') !== 'files,version' || value.version !== 1 || !value.files || typeof value.files !== 'object' || Array.isArray(value.files)) throw new Error('expected {version: 1, files: {relativeArchivedPath: sha256}}');
  for (const [name, seal] of Object.entries(value.files)) {
    const parts = name.split('/');
    if (parts.length !== 2 || !CLASSES.has(parts[0]) || !artifactName(parts[1]) || typeof seal !== 'string' || !SHA256.test(seal)) throw new Error(`invalid archived path or SHA-256 seal: ${name}`);
  }
  return value;
}

function baselineManifest(root, baseRef, errors) {
  const explicit = baseRef !== undefined || Boolean(process.env.DOCS_BASE_REF);
  const reference = baseRef === undefined ? process.env.DOCS_BASE_REF || 'HEAD' : baseRef;
  if (/^0{40}(?:0{24})?$/.test(reference)) return { version: 1, files: {} };
  const git = args => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  try { git(['rev-parse', '--git-dir']); }
  catch { if (explicit) errors.push(`archive baseline ${reference}: repository is not available`); return undefined; }
  let commit;
  try { commit = git(['rev-parse', '--verify', '--end-of-options', `${reference}^{commit}`]).trim(); }
  catch {
    // An unborn local repository has no historical manifest to preserve.
    let unborn = false;
    if (!explicit && reference === 'HEAD') { try { unborn = git(['show-ref']).trim() === ''; } catch (error) { unborn = error.status === 1; } }
    if (!unborn) errors.push(`archive baseline ${reference}: cannot read the requested Git commit`);
    return undefined;
  }
  try {
    if (!git(['ls-tree', '--name-only', commit, '--', MANIFEST]).trim()) return { version: 1, files: {} };
    return parseManifest(git(['show', `${commit}:${MANIFEST}`]));
  } catch (error) { errors.push(`archive baseline ${reference}: ${error.message}`); return undefined; }
}

function archiveState(root, files, errors, baseRef) {
  let manifest = { version: 1, files: {} };
  const manifestPath = safePath(root, MANIFEST);
  if (fs.existsSync(manifestPath)) {
    try { manifest = parseManifest(readText(root, MANIFEST)); }
    catch (error) { errors.push(`${MANIFEST}: ${error.message}`); }
  }
  const archived = new Map([...files].filter(([name]) => name.startsWith('archived/')).map(([name, text]) => [name.slice(9), text]));
  const groups = new Map();
  for (const [name, text] of archived) {
    if (manifest.files[name] !== `sha256:${digest(text)}`) errors.push(`${NOTE_ROOT}/archived/${name}: missing seal or SHA-256 hash mismatch`);
    const parts = name.split('/');
    const info = parts.length === 2 ? artifactName(parts[1]) : undefined;
    if (!info || !CLASSES.has(parts[0])) continue;
    const key = `${parts[0]}/${info.stem}`;
    if (!groups.has(key)) groups.set(key, new Map());
    groups.get(key).set(info.suffix, text);
  }
  for (const name of Object.keys(manifest.files)) if (!archived.has(name)) errors.push(`${NOTE_ROOT}/archived/${name}: sealed artifact is missing`);
  for (const [key, group] of groups) {
    for (const suffix of ['.md', '.zh-CN.md', '.i18n.json']) if (!group.has(suffix)) errors.push(`${NOTE_ROOT}/archived/${key}${suffix}: missing member of the archived triplet`);
    const english = group.get('.md');
    const chinese = group.get('.zh-CN.md');
    for (const suffix of ['.md', '.zh-CN.md']) if (group.has(suffix)) checkHeader(`archived/${key}${suffix}`, group.get(suffix), 'archived', errors);
    if (english === undefined || chinese === undefined || !group.has('.i18n.json')) continue;
    if (english.split('\n')[3] !== chinese.split('\n')[3]) errors.push(`${NOTE_ROOT}/archived/${key}: archive dates differ between languages`);
    const name = path.posix.basename(key);
    if (!english.includes(`](${name}.zh-CN.md)`) || !chinese.includes(`](${name}.md)`)) errors.push(`${NOTE_ROOT}/archived/${key}: missing language switcher/backlink`);
    try {
      const record = JSON.parse(group.get('.i18n.json'));
      if (!record || Object.keys(record).sort().join(',') !== 'chinese,english,sha256,version' || record.version !== 1 || record.english !== `${name}.md` || record.chinese !== `${name}.zh-CN.md` || !record.sha256 || Object.keys(record.sha256).sort().join(',') !== 'en,zh' || record.sha256.en !== digest(english) || record.sha256.zh !== digest(chinese)) throw new Error('schema or language hashes do not match');
    } catch (error) { errors.push(`${NOTE_ROOT}/archived/${key}.i18n.json: invalid consistency record: ${error.message}`); }
  }
  const baseline = baselineManifest(root, baseRef, errors);
  if (baseline) for (const [name, seal] of Object.entries(baseline.files)) if (manifest.files[name] !== seal) errors.push(`${MANIFEST}: baseline sealed entry changed or removed: ${name}; archive manifest is append-only`);
  return manifest;
}

function checkNotes(root, { baseRef } = {}) {
  const errors = [];
  try {
    const files = inventory(root, errors);
    for (const [relative, text] of files) {
      const state = relative.split('/')[0];
      if (!STATES.has(state) || state === 'archived' || !relative.endsWith('.md')) continue;
      checkHeader(relative, text, state, errors);
      checkBody(relative, text, state, errors);
    }
    archiveState(root, files, errors, baseRef);
  } catch (error) { errors.push(error.message); }
  return errors;
}

function archiveNote(root, englishPath, { date } = {}) {
  const source = safePath(root, englishPath);
  const relative = path.relative(path.resolve(root), source).split(path.sep).join('/');
  const match = /^\.agents\/notes\/implemented\/([^/]+)\/([^/]+\.md)$/.exec(relative);
  if (!match || !CLASSES.has(match[1]) || match[2].endsWith('.zh-CN.md') || !artifactName(match[2])) throw new Error('Archive requires an English note in .agents/notes/implemented/<class>/ with a valid dated filename');
  const today = new Date();
  const archiveDate = date === undefined ? `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}` : date;
  if (!validDate(archiveDate) || archiveDate < match[2].slice(0, 10)) throw new Error('Archive date must be a valid YYYY-MM-DD at or after the proposal date');
  const sources = ['.md', '.zh-CN.md', '.i18n.json'].map(suffix => relative.slice(0, -3) + suffix);
  const targets = sources.map(filename => filename.replace('/implemented/', '/archived/'));
  for (const filename of sources) if (!fs.existsSync(safePath(root, filename)) || !fs.statSync(safePath(root, filename)).isFile()) throw new Error(`${filename}: missing regular source file`);
  for (const filename of targets) if (fs.existsSync(safePath(root, filename))) throw new Error(`${filename}: refusing to overwrite an existing archive`);
  const errors = checkNotes(root);
  errors.push(...require('./i18n.cjs').checkPairs(root, [relative]));
  if (errors.length) throw new Error(errors.join('\n'));
  const original = new Map(sources.map(filename => [filename, fs.readFileSync(safePath(root, filename))]));
  const manifestPath = safePath(root, MANIFEST);
  const oldManifest = fs.existsSync(manifestPath) ? fs.readFileSync(manifestPath) : undefined;
  const manifest = oldManifest ? parseManifest(normalizeText(oldManifest.toString('utf8'))) : { version: 1, files: {} };
  const stageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wifimeter-note-stage-'));
  let staged;
  try {
    // Mirror Markdown dependencies so language-link validation has the same targets.
    for (const filename of markdownFiles(root)) {
      const target = safePath(stageRoot, filename);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, readText(root, filename));
    }
    for (const filename of sources.slice(0, 2)) {
      const lines = normalizeText(original.get(filename).toString('utf8')).split('\n');
      lines.splice(3, 0, `Archived: ${archiveDate}`);
      const target = safePath(stageRoot, filename);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, lines.join('\n'));
    }
    require('./i18n.cjs').recordPair(stageRoot, relative);
    staged = sources.map(filename => fs.readFileSync(safePath(stageRoot, filename)));
  } finally { fs.rmSync(stageRoot, { recursive: true, force: true }); }
  for (let i = 0; i < sources.length; i++) {
    if (!fs.readFileSync(safePath(root, sources[i])).equals(original.get(sources[i]))) throw new Error(`${sources[i]} changed during archive preflight`);
    const key = targets[i].slice(`${NOTE_ROOT}/archived/`.length);
    if (Object.hasOwn(manifest.files, key)) throw new Error(`${key}: archive manifest already contains this path`);
    manifest.files[key] = `sha256:${digest(staged[i].toString('utf8'))}`;
  }
  if (oldManifest ? !fs.readFileSync(manifestPath).equals(oldManifest) : fs.existsSync(manifestPath)) throw new Error('Archive manifest changed during preflight');
  const manifestText = JSON.stringify({ version: 1, files: Object.fromEntries(Object.entries(manifest.files).sort(([a], [b]) => a.localeCompare(b))) }, null, 2) + '\n';
  const written = [];
  let manifestWritten = false;
  try {
    for (let i = 0; i < targets.length; i++) {
      const target = safePath(root, targets[i]);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, staged[i], { flag: 'wx' });
      written.push(target);
    }
    manifestWritten = true;
    fs.writeFileSync(manifestPath, manifestText);
    for (const filename of sources) fs.unlinkSync(safePath(root, filename));
  } catch (error) {
    for (const [filename, bytes] of original) fs.writeFileSync(safePath(root, filename), bytes);
    for (const target of written) fs.unlinkSync(target);
    if (manifestWritten) {
      if (oldManifest) fs.writeFileSync(manifestPath, oldManifest);
      else if (fs.existsSync(manifestPath)) fs.unlinkSync(manifestPath);
    }
    throw error;
  }
  return targets[0];
}

function main(args = process.argv.slice(2)) {
  const [command, ...rest] = args;
  const root = process.cwd();
  try {
    if (command === 'check' && (rest.length === 0 || rest.length === 2 && rest[0] === '--base')) {
      const errors = checkNotes(root, rest.length ? { baseRef: rest[1] } : {});
      if (errors.length) { console.error(errors.join('\n')); return 1; }
      console.log('Notes lifecycle and archive checks passed.');
      return 0;
    }
    if (command === 'archive' && (rest.length === 1 || rest.length === 3 && rest[1] === '--date')) {
      console.log(`Archived ${archiveNote(root, rest[0], rest.length === 3 ? { date: rest[2] } : {})}`);
      return 0;
    }
    throw new Error('Usage: node tools/docs/notes.cjs check [--base <ref>] | archive <English note path> [--date YYYY-MM-DD]');
  } catch (error) { console.error(error.message); return 1; }
}

if (require.main === module) process.exitCode = main();
module.exports = { checkNotes, archiveNote, main };
