const path = require('node:path');
const fs = require('node:fs');
const { createRequire } = require('node:module');
const { markdownFiles, readText, safePath } = require('./repository.cjs');

// Use the desktop application's pinned parser rather than adding a second dependency.
const desktopRequire = createRequire(path.resolve(__dirname, '../../apps/desktop/package.json'));
const { marked } = desktopRequire('marked');

function parseMarkdown(text) {
    return marked.lexer(text.replace(/\r\n?/g, '\n'), { gfm: true });
}

function visitTokens(tokens, visit) {
    for (const token of tokens || []) {
        visit(token);
        if (token.type === 'image' || token.type === 'code' || token.type === 'codespan') continue;
        if (token.tokens) visitTokens(token.tokens, visit);
        for (const item of token.items || []) visitTokens(item.tokens, visit);
        for (const cell of token.header || []) visitTokens(cell.tokens, visit);
        for (const row of token.rows || []) for (const cell of row) visitTokens(cell.tokens, visit);
    }
}

function decodeHtmlUrl(value) {
    return value.replace(/&amp;/gi, '&').replace(/&#(x[0-9a-f]+|[0-9]+);/gi, (_, code) => {
        const number = code[0].toLowerCase() === 'x' ? parseInt(code.slice(1), 16) : Number(code);
        return number <= 0x10ffff ? String.fromCodePoint(number) : _;
    });
}

function collectLinks(tokens, { includeImages = false } = {}) {
    const links = [];
    visitTokens(tokens, (token) => {
        if (token.type === 'link' || (includeImages && token.type === 'image')) {
            links.push({ href: token.href, image: token.type === 'image' });
        }
        // README badges and language switchers use ordinary HTML anchors. HTML
        // comments and fenced examples are excluded; this is not an HTML validator.
        if (token.type === 'html') {
            const html = token.text.replace(/<!--[\s\S]*?(?:-->|$)/g, '');
            const names = includeImages ? 'a|img' : 'a';
            const elements = new RegExp(`<(${names})\\b(?:[^>"']|"[^"]*"|'[^']*')*>`, 'gi');
            for (const element of html.matchAll(elements)) {
                const attribute = element[1].toLowerCase() === 'img' ? 'src' : 'href';
                const match = new RegExp(`\\s${attribute}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i').exec(element[0]);
                if (match) links.push({ href: decodeHtmlUrl(match[1] ?? match[2] ?? match[3]), image: attribute === 'src' });
            }
        }
    });
    return links;
}

function structureSignature(tokens) {
    const signature = [];
    for (const token of tokens || []) {
        if (token.type === 'heading') signature.push(['heading', token.depth]);
        if (token.type === 'code') signature.push(['code', token.lang || '', token.text]);
        if (token.type === 'table') signature.push(['table', token.header.length, token.rows.map(row => row.length)]);
        if (token.type === 'list') {
            signature.push(['list', token.ordered, token.ordered ? token.start : null,
                token.items.map(item => [!!item.task, item.task ? !!item.checked : null, structureSignature(item.tokens)])]);
        } else if (token.type === 'blockquote') {
            signature.push(['blockquote', structureSignature(token.tokens)]);
        }
    }
    return signature;
}

/** Check local file targets only. Fragments, external availability, HTML DOM
  * structure, and prose semantics remain outside this check's contract. */
function checkMarkdown(root, files = markdownFiles(root)) {
    const errors = [];
    for (const owner of files) {
        // Historical notes keep their original outbound links after archival.
        if (owner.replaceAll('\\', '/').startsWith('.agents/notes/archived/')) continue;
        try {
            const tokens = parseMarkdown(readText(root, owner));
            for (const { href } of collectLinks(tokens, { includeImages: true })) {
                if (!href || /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(href)) continue;
                const pathname = href.split(/[?#]/, 1)[0];
                if (!pathname) continue;
                try {
                    const decoded = decodeURIComponent(pathname).replaceAll('\\', '/');
                    if (decoded.startsWith('/') || /^[A-Za-z]:/.test(decoded)) throw new Error('Expected a repository-relative path');
                    const relative = path.posix.join(path.posix.dirname(owner.replaceAll('\\', '/')), decoded);
                    const target = safePath(root, relative);
                    if (!fs.existsSync(target)) errors.push(`${owner}: missing local link target ${href}`);
                } catch (error) {
                    errors.push(`${owner}: invalid local link target ${href}: ${error.message}`);
                }
            }
        } catch (error) { errors.push(`${owner}: ${error.message}`); }
    }
    return errors;
}

function main(args = process.argv.slice(2), root = path.resolve(__dirname, '../..')) {
    if (args[0] !== 'check' || args.slice(1).some(arg => arg.startsWith('--'))) {
        throw new Error('usage: node tools/docs/markdown.cjs check [path...]');
    }
    const files = args.length > 1 ? args.slice(1) : markdownFiles(root);
    const errors = checkMarkdown(root, files);
    if (errors.length) { for (const error of errors) console.error(error); return 1; }
    console.log(`markdown: ${files.length} file(s) checked (file targets only; fragments are not checked)`);
    return 0;
}

module.exports = { parseMarkdown, collectLinks, structureSignature, checkMarkdown, main };
if (require.main === module) {
    try { process.exitCode = main(); }
    catch (error) { console.error(`markdown: ${error.message}`); process.exitCode = 1; }
}
