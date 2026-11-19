'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { parseMarkdown } = require('./markdown.cjs');
const { isPairedDocument } = require('./i18n.cjs');
const { markdownFiles, readText, safePath } = require('./repository.cjs');

const CONFIG_PATH = 'tools/docs/budgets.json';
const TYPES = ['rootAgent', 'subtreeAgent', 'note', 'reference', 'rootReadme', 'terminology'];

function decodeEntities(text) {
    return text
        .replace(/&(nbsp|amp|lt|gt|quot|apos);/gi, (_, entity) => ({ nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" })[entity.toLowerCase()])
        .replace(/&#(x[0-9a-f]+|[0-9]+);/gi, (original, code) => {
            const value = code[0].toLowerCase() === 'x' ? parseInt(code.slice(1), 16) : Number(code);
            return value <= 0x10ffff ? String.fromCodePoint(value) : original;
        });
}

function plainHtml(html) {
    return decodeEntities(html
        .replace(/<!--[\s\S]*?(?:-->|$)/g, '')
        .replace(/<(?:script|style|pre)\b[^>]*>[\s\S]*?<\/(?:script|style|pre)\s*>/gi, '')
        .replace(/<\/?(?:p|div|li|tr|h[1-6]|br|section|article)\b(?:[^>"']|"[^"]*"|'[^']*')*>/gi, ' ')
        .replace(/<(?:[^>"']|"[^"]*"|'[^']*')*>/g, ''));
}

function visibleText(tokens) {
    const pieces = [];
    for (const token of tokens || []) {
        if (['code', 'def', 'image', 'space'].includes(token.type)) continue;
        if (token.type === 'html') pieces.push(plainHtml(token.text));
        else if (token.tokens) pieces.push(visibleText(token.tokens));
        else if (typeof token.text === 'string') pieces.push(token.type === 'codespan' ? token.text : decodeEntities(token.text));
        for (const item of token.items || []) pieces.push(visibleText(item.tokens));
        for (const cell of token.header || []) pieces.push(visibleText(cell.tokens));
        for (const row of token.rows || []) for (const cell of row) pieces.push(visibleText(cell.tokens));
    }
    return pieces.join(' ');
}

/** One Han character or Latin/numeric word is one unit. Apostrophes and
 * hyphens within a Latin word do not split it. This is a size convention,
 * not a tokenizer or a prose-quality score. */
function countWords(text) {
    const visible = visibleText(parseMarkdown(text))
        .replace(/(?:[a-z][a-z0-9+.-]*:\/\/|mailto:|www\.)[^\s<>]+/gi, '');
    return [...visible.matchAll(/\p{Script=Han}|[\p{Script=Latin}\p{N}]+(?:[-'’][\p{Script=Latin}\p{N}]+)*/gu)].length;
}

function englishPath(filename) {
    return filename.replaceAll('\\', '/').replace(/\.zh-CN\.md$/, '.md');
}

function budgetType(filename) {
    const rel = englishPath(filename);
    const lower = rel.toLowerCase();
    const base = path.posix.basename(lower);
    if (/(^|\/)(?:vendor|upstream|node_modules|\.git)(?:\/|$)/i.test(rel) || lower.startsWith('backend/third_party/sqlite/')) return undefined;
    if (lower.startsWith('docs/releases/') || lower.startsWith('.agents/notes/archived/')) return undefined;
    if (base === 'changelog.md' || /^(?:licen[cs]e|copying)\.md$/.test(base)) return undefined;
    if (lower === 'agents.md') return 'rootAgent';
    if (base === 'agents.md') return 'subtreeAgent';
    if (lower === 'docs/i18n/terminology.md') return 'terminology';
    if (!isPairedDocument(rel)) return undefined;
    if (lower === 'readme.md') return 'rootReadme';
    if (/^\.agents\/notes\/(?:proposed|implemented|rejected)\//.test(rel)) return 'note';
    return 'reference';
}

function validateLimits(limits, name) {
    if (!limits || typeof limits !== 'object' || Array.isArray(limits)
        || Object.keys(limits).sort().join(',') !== 'en,zh'
        || !Number.isSafeInteger(limits.en) || limits.en <= 0
        || !Number.isSafeInteger(limits.zh) || limits.zh <= 0) {
        throw new Error(`${name}: limits must contain positive integer en and zh values`);
    }
}

function loadConfig(root) {
    let config;
    try { config = JSON.parse(readText(root, CONFIG_PATH)); }
    catch (error) { throw new Error(`${CONFIG_PATH}: invalid or missing JSON configuration: ${error.message}`); }
    if (!config || Object.keys(config).sort().join(',') !== 'defaults,overrides,version' || config.version !== 1) {
        throw new Error(`${CONFIG_PATH}: expected version 1, defaults, and overrides`);
    }
    if (!config.defaults || Object.keys(config.defaults).sort().join(',') !== [...TYPES].sort().join(',')) {
        throw new Error(`${CONFIG_PATH}: defaults must define ${TYPES.join(', ')}`);
    }
    for (const name of TYPES) validateLimits(config.defaults[name], `defaults.${name}`);
    if (!config.overrides || typeof config.overrides !== 'object' || Array.isArray(config.overrides)) {
        throw new Error(`${CONFIG_PATH}: overrides must be an object`);
    }
    for (const [name, limits] of Object.entries(config.overrides)) {
        const target = safePath(root, name);
        if (!name.endsWith('.md') || name.endsWith('.zh-CN.md') || englishPath(name) !== name || !budgetType(name)) {
            throw new Error(`${CONFIG_PATH}: override ${name} must name an in-scope English document`);
        }
        if (!fs.existsSync(target) || !fs.statSync(target).isFile()) throw new Error(`${CONFIG_PATH}: override names missing file ${name}`);
        validateLimits(limits, `overrides.${name}`);
    }
    return config;
}

function measurements(root, files) {
    const config = loadConfig(root);
    const rows = [];
    for (const filename of files === undefined ? markdownFiles(root) : files) {
        const type = budgetType(filename);
        if (!type) continue;
        const lang = filename.endsWith('.zh-CN.md') ? 'zh' : 'en';
        const limit = (config.overrides[englishPath(filename)] || config.defaults[type])[lang];
        rows.push({ file: filename, units: countWords(readText(root, filename)), limit, type });
    }
    return rows;
}

function checkBudgets(root, files) {
    try {
        return measurements(root, files)
            .filter(row => row.units > row.limit)
            .map(row => `${row.file}: ${row.units} units exceeds limit ${row.limit} (${row.type}); relocate or condense before changing the budget`);
    } catch (error) { return [error.message]; }
}

function main(args = process.argv.slice(2), root = path.resolve(__dirname, '../..')) {
    if (!['check', 'list'].includes(args[0]) || args.slice(1).some(arg => arg.startsWith('--'))) {
        throw new Error('usage: node tools/docs/budgets.cjs check|list [path...]');
    }
    const rows = measurements(root, args.length > 1 ? args.slice(1) : undefined);
    for (const row of rows) console.log(`${row.units > row.limit ? 'over' : 'ok'} ${row.units}/${row.limit} units ${row.file}`);
    const over = rows.filter(row => row.units > row.limit);
    if (args[0] === 'check' && over.length) console.error(`budgets: ${over.length} document(s) exceed their limit`);
    return over.length ? 1 : 0;
}

module.exports = { countWords, checkBudgets, main };
if (require.main === module) {
    try { process.exitCode = main(); }
    catch (error) { console.error(`budgets: ${error.message}`); process.exitCode = 1; }
}
