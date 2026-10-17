'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function fixture(t) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wifimeter-docs-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    return root;
}

test('document paths cannot escape the repository or follow an outside ancestor', t => {
    const { safePath } = require('./repository.cjs');
    const root = fixture(t);
    assert.throws(() => safePath(root, '../private.md'), /outside|escape|relative/i);
    assert.throws(() => safePath(root, path.resolve(root, '../private.md')), /outside|escape|relative/i);
    assert.equal(safePath(root, 'docs/new.md'), path.join(root, 'docs/new.md'));
});

test('hashes survive Windows checkouts while preserving meaningful whitespace', () => {
    const { digest, normalizeText } = require('./repository.cjs');
    assert.equal(digest('one\r\ntwo\r\n'), digest('one\ntwo\n'));
    assert.notEqual(digest('one\n'), digest('one \n'));
    assert.equal(normalizeText('a\r\nb'), 'a\nb');
});

test('source archives discover documentation without walking personal state and outputs', t => {
    const { markdownFiles } = require('./repository.cjs');
    const root = fixture(t);
    for (const file of ['README.md', 'docs/GUIDE.md', '.agents/notes/README.md', 'build/README.md', 'apps/desktop/node_modules/demo/README.md', '.agents/skills/private/README.md']) {
        fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
        fs.writeFileSync(path.join(root, file), '# Example\n');
    }
    assert.deepEqual(markdownFiles(root), ['.agents/notes/README.md', 'README.md', 'docs/GUIDE.md']);
});

test('a dangling symlink cannot redirect a new document record outside the repository', t => {
    const { safePath } = require('./repository.cjs');
    const root = fixture(t);
    const outside = fixture(t);
    const linked = path.join(root, 'new.i18n.json');
    try { fs.symlinkSync(path.join(outside, 'not-created.json'), linked, 'file'); }
    catch (error) {
        if (!['EPERM', 'EACCES'].includes(error.code)) throw error;
        t.skip('Creating symbolic links is unavailable on this Windows host.');
        return;
    }
    assert.throws(() => safePath(root, 'new.i18n.json'), /broken symbolic link|outside/i);
    assert.equal(fs.existsSync(path.join(outside, 'not-created.json')), false);
});
