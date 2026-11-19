const fs = require('node:fs');
const path = require('node:path');
const { markdownFiles, repositoryFiles, readText, digest, safePath } = require('./repository.cjs');
const { parseMarkdown, collectLinks, structureSignature } = require('./markdown.cjs');

const CHINESE_SUFFIX = '.zh-CN.md';
const RECORD_SUFFIX = '.i18n.json';
const HEX_SHA256 = /^[0-9a-f]{64}$/;

function relativePath(root, filename) {
    if (typeof filename !== 'string' || !filename.trim()) throw new Error('A named document path is required.');
    return path.relative(root, safePath(root, filename)).split(path.sep).join('/');
}

function pairPaths(root, filename) {
    let english = relativePath(root, filename);
    if (english.endsWith(CHINESE_SUFFIX)) english = english.slice(0, -CHINESE_SUFFIX.length) + '.md';
    else if (english.endsWith(RECORD_SUFFIX)) english = english.slice(0, -RECORD_SUFFIX.length) + '.md';
    else if (!english.endsWith('.md')) throw new Error(`${english}: expected .md, .zh-CN.md, or .i18n.json path`);
    return { english, chinese: english.slice(0, -3) + CHINESE_SUFFIX, record: english.slice(0, -3) + RECORD_SUFFIX };
}

function inScope(filename) {
    const rel = filename.replaceAll('\\', '/');
    const name = path.posix.basename(rel).toLowerCase();
    if (/(^|\/)(?:vendor|upstream|node_modules|\.git)(?:\/|$)/i.test(rel) || rel.startsWith('backend/third_party/sqlite/')) return false;
    if (['agents.md', 'claude.md', 'changelog.md'].includes(name)) return false;
    if (/^(?:licen[cs]e|copying)\.md$/.test(name)) return false;
    if (rel.startsWith('docs/releases/') || rel.startsWith('.agents/notes/archived/')) return false;
    if (rel === 'docs/i18n/terminology.md') return false;
    return name === 'readme.md' || name === 'contributing.md'
        || rel.startsWith('docs/') || rel.startsWith('.agents/notes/')
        || rel.startsWith('backend/platform/') || rel.startsWith('packaging/') || rel.startsWith('contracts/');
}

function recordFiles(root) {
    return repositoryFiles(root).filter(filename => filename.endsWith(RECORD_SUFFIX));
}

function pairSources(root, files) {
    const names = files === undefined ? [...markdownFiles(root), ...recordFiles(root)] : files;
    return [...new Set(names.map(filename => pairPaths(root, filename).english).filter(inScope))].sort();
}

function fileExists(root, rel) {
    const target = safePath(root, rel);
    return fs.existsSync(target) && fs.statSync(target).isFile();
}

function localLink(owner, href) {
    if (!href || /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(href)) return undefined;
    const hash = href.indexOf('#');
    const withoutFragment = hash < 0 ? href : href.slice(0, hash);
    const query = withoutFragment.indexOf('?');
    let pathname = query < 0 ? withoutFragment : withoutFragment.slice(0, query);
    try { pathname = decodeURIComponent(pathname); } catch { /* A malformed URL remains an unmatched destination. */ }
    return { pathname, target: path.posix.normalize(path.posix.join(path.posix.dirname(owner), pathname)), query: query < 0 ? '' : withoutFragment.slice(query) };
}

function semanticLinks(root, owner, tokens, counterpart, errors) {
    const links = [];
    let switcher = false;
    for (const { href, image } of collectLinks(tokens)) {
        if (image || /\.(?:png|jpe?g|gif|svg|webp|avif|ico)(?:[?#]|$)/i.test(href)) continue;
        const local = localLink(owner, href);
        if (!local) { links.push(href); continue; }
        if (!local.pathname) continue; // Local heading fragments are language-specific.
        if (local.target === counterpart && !local.query) { switcher = true; continue; }
        const targetEnglish = local.target.endsWith(CHINESE_SUFFIX)
            ? local.target.slice(0, -CHINESE_SUFFIX.length) + '.md' : local.target;
        if (targetEnglish.endsWith('.md') && inScope(targetEnglish)) {
            const wantChinese = owner.endsWith(CHINESE_SUFFIX);
            const targetChinese = targetEnglish.slice(0, -3) + CHINESE_SUFFIX;
            const expected = wantChinese ? targetChinese : targetEnglish;
            if (local.target !== expected) errors.push(`${owner}: link ${href} uses the wrong language; expected ${expected}`);
            if (!fileExists(root, targetEnglish) || !fileExists(root, targetChinese)) {
                errors.push(`${owner}: link ${href} targets an incomplete language pair (${targetEnglish}, ${targetChinese})`);
            }
            links.push(`${targetEnglish}${local.query}`);
        } else {
            links.push(`${local.target}${local.query}`);
        }
    }
    if (!switcher) errors.push(`${owner}: missing language switcher/backlink to ${path.posix.basename(counterpart)}`);
    return links;
}

function inspectPair(root, source) {
    const paths = pairPaths(root, source);
    const errors = [];
    for (const rel of [paths.english, paths.chinese]) if (!fileExists(root, rel)) errors.push(`${rel}: missing document in language pair`);
    if (errors.length) return { paths, errors };
    const enText = readText(root, paths.english);
    const zhText = readText(root, paths.chinese);
    const enTokens = parseMarkdown(enText);
    const zhTokens = parseMarkdown(zhText);
    // This signature checks Markdown structure, not translated heading text,
    // paragraph counts, inline code, HTML layout, or the meaning of the prose.
    if (JSON.stringify(structureSignature(enTokens)) !== JSON.stringify(structureSignature(zhTokens))) {
        errors.push(`${paths.english}: Markdown structure differs from ${paths.chinese} (heading, table, list, blockquote, or code)`);
    }
    const enLinks = semanticLinks(root, paths.english, enTokens, paths.chinese, errors);
    const zhLinks = semanticLinks(root, paths.chinese, zhTokens, paths.english, errors);
    // Fragments may use translated headings; localized images are outside this
    // comparison. Other links retain their destination, order, and query string.
    if (JSON.stringify(enLinks) !== JSON.stringify(zhLinks)) errors.push(`${paths.english}: semantic link destinations differ from ${paths.chinese}`);
    return { paths, errors, enText, zhText };
}

function expectedRecord(pair) {
    return { version: 1, english: path.posix.basename(pair.paths.english), chinese: path.posix.basename(pair.paths.chinese), sha256: { en: digest(pair.enText), zh: digest(pair.zhText) } };
}

function validRecord(record, expected) {
    return record && typeof record === 'object' && !Array.isArray(record)
        && Object.keys(record).sort().join(',') === 'chinese,english,sha256,version'
        && record.version === 1 && record.english === expected.english && record.chinese === expected.chinese
        && record.sha256 && Object.keys(record.sha256).sort().join(',') === 'en,zh'
        && typeof record.sha256.en === 'string' && HEX_SHA256.test(record.sha256.en)
        && typeof record.sha256.zh === 'string' && HEX_SHA256.test(record.sha256.zh);
}

function checkPairs(root, files) {
    const errors = [];
    let sources;
    try { sources = pairSources(root, files); } catch (error) { return [error.message]; }
    for (const source of sources) {
        try {
            const pair = inspectPair(root, source);
            errors.push(...pair.errors);
            if (!fileExists(root, pair.paths.record)) { errors.push(`${pair.paths.record}: missing consistency record`); continue; }
            if (pair.enText === undefined || pair.zhText === undefined) continue;
            let record;
            try { record = JSON.parse(readText(root, pair.paths.record)); }
            catch { errors.push(`${pair.paths.record}: invalid JSON consistency record`); continue; }
            const expected = expectedRecord(pair);
            if (!validRecord(record, expected)) errors.push(`${pair.paths.record}: invalid record schema or sibling filenames`);
            else if (record.sha256.en !== expected.sha256.en || record.sha256.zh !== expected.sha256.zh) {
                errors.push(`${pair.paths.record}: SHA-256 hashes are out of sync; update the counterpart, review meaning, then record explicitly`);
            }
        } catch (error) { errors.push(`${source}: ${error.message}`); }
    }
    return errors;
}

function writeRecord(root, pair) {
    const target = safePath(root, pair.paths.record);
    fs.writeFileSync(target, `${JSON.stringify(expectedRecord(pair), null, 2)}\n`);
    return pair.paths.record;
}

// Mechanical lifecycle moves may re-record unchanged prose without claiming a
// new semantic review. Callers own that precondition; structure is still checked.
function recordPair(root, englishPath) {
    const pair = inspectPair(root, englishPath);
    if (pair.errors.length) throw new Error(pair.errors.join('\n'));
    return writeRecord(root, pair);
}

function recordPairs(root, namedPaths, options = {}) {
    if (!Array.isArray(namedPaths) || namedPaths.length === 0) throw new Error('record requires explicit named document paths');
    if (options.reviewed !== true) throw new Error('record requires reviewed: true after checking both languages for equivalent meaning');
    const sources = [...new Set(namedPaths.map(filename => pairPaths(root, filename).english))];
    for (const source of sources) if (!inScope(source)) throw new Error(`${source}: excluded from active translation pairing`);
    // Validate every named pair before writing any record.
    const pairs = sources.map(source => inspectPair(root, source));
    const errors = pairs.flatMap(pair => pair.errors);
    if (errors.length) throw new Error(errors.join('\n'));
    return pairs.map(pair => writeRecord(root, pair));
}

function main(args = process.argv.slice(2), root = path.resolve(__dirname, '../..')) {
    const [command, ...rest] = args;
    if (!['check', 'list', 'record'].includes(command)) throw new Error('usage: node tools/docs/i18n.cjs check|list|record [path...] [--all] [--reviewed]');
    const flags = rest.filter(arg => arg.startsWith('--'));
    if (flags.some(flag => !['--all', '--reviewed'].includes(flag))) throw new Error('unknown i18n flag');
    const names = rest.filter(arg => !arg.startsWith('--'));
    const all = flags.includes('--all');
    if (all && names.length) throw new Error('--all cannot be combined with named paths');
    if (command !== 'record' && flags.includes('--reviewed')) throw new Error('--reviewed is only valid for record');
    if (command === 'record') {
        const sources = all ? pairSources(root) : names;
        const written = recordPairs(root, sources, { reviewed: flags.includes('--reviewed') });
        for (const file of written) console.log(`recorded ${file}`);
        return 0;
    }
    const sources = pairSources(root, names.length ? names : undefined);
    if (command === 'list') {
        let failed = false;
        for (const source of sources) {
            const errors = checkPairs(root, [source]);
            const status = errors.length === 0 ? 'ok' : errors.some(error => /missing/i.test(error)) ? 'missing' : 'out-of-sync';
            if (errors.length) failed = true;
            console.log(`${status.padEnd(11)} ${source}`);
        }
        return failed ? 1 : 0;
    }
    const errors = checkPairs(root, names.length ? names : undefined);
    if (errors.length) { for (const error of errors) console.error(error); return 1; }
    console.log(`i18n: ${sources.length} pair(s) checked`);
    return 0;
}

module.exports = { checkPairs, recordPair, recordPairs, isPairedDocument: inScope, main };
if (require.main === module) {
    try { process.exitCode = main(); }
    catch (error) { console.error(`i18n: ${error.message}`); process.exitCode = 1; }
}
