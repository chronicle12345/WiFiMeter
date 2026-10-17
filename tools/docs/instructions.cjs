'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { root, readText, normalizeText, repositoryFiles, safePath } = require('./repository.cjs');

const copyHeader = '<!-- Generated from AGENTS.md by npm run docs:instructions. -->\n\n';

function instructionFiles(directory) {
    return repositoryFiles(directory).filter(file => path.posix.basename(file) === 'AGENTS.md');
}

function companionFor(file) {
    return file.replace(/AGENTS\.md$/, 'CLAUDE.md');
}

function inspect(directory, relative) {
    const file = path.join(directory, relative);
    try {
        const stat = fs.lstatSync(file);
        if (stat.isSymbolicLink()) return { kind: 'link', target: fs.readlinkSync(file) };
        if (!stat.isFile()) return { kind: 'other' };
        const text = normalizeText(fs.readFileSync(file, 'utf8'));
        return { kind: 'file', text };
    } catch (error) {
        if (error.code === 'ENOENT') return { kind: 'missing' };
        throw error;
    }
}

function indexedSymlink(directory, relative) {
    if (!fs.existsSync(path.join(directory, '.git'))) return false;
    return /^120000 /.test(execFileSync('git', ['ls-files', '--stage', '--', relative], {
        cwd: directory, encoding: 'utf8', windowsHide: true
    }));
}

function checkInstructions(directory) {
    const errors = [];
    const rules = instructionFiles(directory);
    if (!rules.includes('AGENTS.md')) errors.push('Missing root AGENTS.md.');
    const companions = new Set(rules.map(companionFor));
    for (const file of repositoryFiles(directory).filter(file => path.posix.basename(file) === 'CLAUDE.md')) {
        if (!companions.has(file)) errors.push(`${file}: orphan companion; missing same-directory AGENTS.md.`);
    }
    for (const file of rules) {
        try {
            const text = readText(directory, file);
            const budget = file === 'AGENTS.md' ? 120 : 80;
            if (text.trimEnd().split('\n').length > budget) errors.push(`${file}: exceeds ${budget} lines; move detail to its owning guide.`);
            const companion = companionFor(file);
            const state = inspect(directory, companion);
            if (state.kind === 'link' && state.target.replace(/\\/g, '/') === 'AGENTS.md') {
                safePath(directory, companion);
            } else if (state.kind === 'file' && indexedSymlink(directory, companion)) {
                errors.push(`${companion}: Git indexes a symbolic link, but the checkout is a regular file. Restore a real symlink or intentionally convert the index to a regular file before staging.`);
            } else if (state.kind === 'file' && (state.text === text || state.text === copyHeader + text)) {
                // Identical copies support Windows checkouts without symlink permission.
            } else errors.push(`${companion}: missing or stale; must match ${file}. Run npm run docs:instructions.`);
        } catch (error) { errors.push(`${file}: ${error.message}`); }
    }
    return errors;
}

function syncInstructions(directory, { copy = false } = {}) {
    const entries = instructionFiles(directory).map(file => ({ file, text: readText(directory, file), companion: companionFor(file) }));
    for (const entry of entries) {
        entry.state = inspect(directory, entry.companion);
        entry.indexedLink = indexedSymlink(directory, entry.companion);
        const state = entry.state;
        if (copy && entry.indexedLink) throw new Error(`${entry.companion}: Git indexes a symbolic link; convert its index type before generating a regular copy.`);
        if (state.kind === 'other' || state.kind === 'link' && state.target.replace(/\\/g, '/') !== 'AGENTS.md' || state.kind === 'file' && state.text.trim() !== 'AGENTS.md' && state.text !== entry.text && !state.text.startsWith(copyHeader)) {
            throw new Error(`${entry.companion}: independent instructions found; refusing to overwrite. Reconcile them with ${entry.file} first.`);
        }
    }
    const changed = [];
    for (const entry of entries) {
        if (!copy && entry.state.kind === 'link') continue;
        const target = path.join(directory, entry.companion);
        if (!entry.indexedLink && entry.state.kind === 'file' && (entry.state.text.startsWith(copyHeader) || entry.state.text === entry.text)) {
            const updated = copyHeader + entry.text;
            if (entry.state.text !== updated) { fs.writeFileSync(target, updated, 'utf8'); changed.push(entry.companion); }
            continue;
        }
        if (entry.state.kind !== 'missing') fs.unlinkSync(target);
        if (!copy) {
            try {
                fs.symlinkSync('AGENTS.md', target, 'file');
                changed.push(entry.companion);
                continue;
            } catch (error) {
                if (!['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) throw error;
                if (entry.indexedLink) {
                    fs.writeFileSync(target, entry.state.text, 'utf8');
                    throw new Error(`${entry.companion}: cannot restore the indexed symbolic link. Enable symlink checkout or intentionally convert the index type before staging a copy.`);
                }
            }
        }
        fs.writeFileSync(target, copyHeader + entry.text, 'utf8');
        changed.push(entry.companion);
    }
    return changed;
}

module.exports = { checkInstructions, syncInstructions };

if (require.main === module) {
    try {
        if (process.argv[2] !== 'sync' || process.argv.slice(3).some(arg => arg !== '--copy')) throw new Error('Usage: node tools/docs/instructions.cjs sync [--copy]');
        const changed = syncInstructions(root, { copy: process.argv.includes('--copy') });
        console.log(changed.length ? `Synchronized ${changed.length} instruction companions.` : 'Instruction companions are current.');
    } catch (error) { console.error(error.message); process.exitCode = 1; }
}
