'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');

const root = path.resolve(__dirname, '../..');
const ignoredDirectories = new Set(['.git', 'node_modules', 'build', 'dist', 'target', 'artifacts', 'del', '.cross-build', '.codex', '.aws', '.agent', '.claude', '.gemini', '.vscode', '.idea', '.zcode', '.workbuddy-ai', 'test-results', 'playwright-report', '__pycache__']);

function normalizeText(text) {
    return String(text).replace(/\r\n?/g, '\n');
}

function digest(text) {
    return crypto.createHash('sha256').update(normalizeText(text), 'utf8').digest('hex');
}

function inside(directory, target) {
    const relative = path.relative(directory, target);
    return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function safePath(directory, relative) {
    if (typeof relative !== 'string' || !relative || relative.includes('\0') || path.isAbsolute(relative) || /^[A-Za-z]:/.test(relative)) {
        throw new Error(`Expected a repository-relative path: ${relative}`);
    }
    const resolvedRoot = path.resolve(directory);
    const target = path.resolve(resolvedRoot, relative);
    if (!inside(resolvedRoot, target)) throw new Error(`Path escapes repository: ${relative}`);
    let ancestor = target;
    while (true) {
        try { fs.lstatSync(ancestor); break; }
        catch (error) {
            if (error.code !== 'ENOENT') throw error;
            const parent = path.dirname(ancestor);
            if (parent === ancestor) throw new Error(`Missing repository: ${directory}`);
            ancestor = parent;
        }
    }
    const realRoot = fs.realpathSync(resolvedRoot);
    let realAncestor;
    try { realAncestor = fs.realpathSync(ancestor); }
    catch { throw new Error(`Path contains a broken symbolic link: ${relative}`); }
    if (!inside(realRoot, realAncestor)) throw new Error(`Path resolves outside repository: ${relative}`);
    return target;
}

function readText(directory, relative) {
    return normalizeText(fs.readFileSync(safePath(directory, relative), 'utf8'));
}

function repositoryFiles(directory) {
    if (fs.existsSync(path.join(directory, '.git'))) {
        return [...new Set(execFileSync('git', ['-C', directory, 'ls-files', '--cached', '--others', '--exclude-standard', '-z'], {
            encoding: 'utf8', windowsHide: true, maxBuffer: 16 * 1024 * 1024
        }).split('\0').filter(Boolean))].sort();
    }
    const files = [];
    function visit(relative) {
        for (const entry of fs.readdirSync(path.join(directory, relative), { withFileTypes: true })) {
            const name = relative ? `${relative}/${entry.name}` : entry.name;
            if (entry.isDirectory()) {
                if (ignoredDirectories.has(entry.name) || name.startsWith('.agents/') && name !== '.agents/notes' && !name.startsWith('.agents/notes/')) continue;
                visit(name);
            } else if (entry.isFile() || entry.isSymbolicLink()) files.push(name);
        }
    }
    visit('');
    return files.sort();
}

function markdownFiles(directory) {
    return repositoryFiles(directory).filter(file => /\.md$/i.test(file) && fs.existsSync(path.join(directory, file)));
}

module.exports = { root, normalizeText, digest, safePath, readText, repositoryFiles, markdownFiles };
