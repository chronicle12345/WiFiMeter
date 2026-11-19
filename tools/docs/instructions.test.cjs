'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

function fixture(t) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wifimeter-instructions-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    fs.writeFileSync(path.join(root, 'AGENTS.md'), '# Rules\n\nRead the project guides.\n');
    return root;
}

test('a Windows Git symlink stub is rejected and can be repaired as a portable copy', t => {
    const { checkInstructions, syncInstructions } = require('./instructions.cjs');
    const root = fixture(t);
    fs.writeFileSync(path.join(root, 'CLAUDE.md'), 'AGENTS.md');
    assert.ok(checkInstructions(root).length);
    syncInstructions(root, { copy: true });
    assert.deepEqual(checkInstructions(root), []);
    fs.appendFileSync(path.join(root, 'AGENTS.md'), '\nA new rule.\n');
    assert.match(checkInstructions(root).join('\n'), /stale|match|同步/i);
    syncInstructions(root, { copy: true });
    assert.deepEqual(checkInstructions(root), []);
});

test('synchronization preserves independent CLAUDE instructions instead of overwriting them', t => {
    const { syncInstructions } = require('./instructions.cjs');
    const root = fixture(t);
    const companion = path.join(root, 'CLAUDE.md');
    fs.writeFileSync(companion, '# My separate instructions\n');
    assert.throws(() => syncInstructions(root, { copy: true }), /independent|独立|overwrite/i);
    assert.equal(fs.readFileSync(companion, 'utf8'), '# My separate instructions\n');
});

test('an orphan instruction companion is reported', t => {
    const { checkInstructions } = require('./instructions.cjs');
    const root = fixture(t);
    fs.mkdirSync(path.join(root, 'docs'));
    fs.writeFileSync(path.join(root, 'docs/CLAUDE.md'), 'AGENTS.md');
    assert.match(checkInstructions(root).join('\n'), /orphan|missing.*AGENTS|缺少/i);
});

test('a copied Windows checkout cannot stage an instruction body as a symlink target', t => {
    const { checkInstructions, syncInstructions } = require('./instructions.cjs');
    const root = fixture(t);
    const git = (args, options = {}) => execFileSync('git', args, { cwd: root, encoding: 'utf8', windowsHide: true, ...options });
    git(['init', '--quiet']);
    const blob = git(['hash-object', '-w', '--stdin'], { input: 'AGENTS.md' }).trim();
    git(['update-index', '--add', '--cacheinfo', `120000,${blob},CLAUDE.md`]);
    const companion = path.join(root, 'CLAUDE.md');
    fs.writeFileSync(companion, 'AGENTS.md');
    assert.throws(() => syncInstructions(root, { copy: true }), /symlink|symbolic link/i);
    assert.equal(fs.readFileSync(companion, 'utf8'), 'AGENTS.md');
    fs.writeFileSync(companion, fs.readFileSync(path.join(root, 'AGENTS.md')));
    assert.match(checkInstructions(root).join('\n'), /symlink|symbolic link/i);
});

test('synchronization preserves an existing generated copy across platforms', t => {
    const { syncInstructions } = require('./instructions.cjs');
    const root = fixture(t);
    syncInstructions(root, { copy: true });
    fs.appendFileSync(path.join(root, 'AGENTS.md'), '\nUpdated rule.\n');
    syncInstructions(root);
    assert.equal(fs.lstatSync(path.join(root, 'CLAUDE.md')).isSymbolicLink(), false);
    assert.match(fs.readFileSync(path.join(root, 'CLAUDE.md'), 'utf8'), /Updated rule/);
});
