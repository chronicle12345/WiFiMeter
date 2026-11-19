'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { checkRepositoryPolicy } = require('./check.cjs');

test('shared instructions and Notes do not allow personal agent state into the repository', () => {
    assert.deepEqual(checkRepositoryPolicy('.', ['AGENTS.md', 'docs/AGENTS.md', 'CLAUDE.md', '.agents/notes/README.md', '.env.example']), []);
    for (const file of ['.agents/skills/private/SKILL.md', '.codex/session.json', 'AGENTS.override.md', 'CLAUDE.local.md', '.env.production', 'data/current.db-wal', 'build/report.md']) {
        assert.equal(checkRepositoryPolicy('.', [file]).length, 1, file);
    }
});
