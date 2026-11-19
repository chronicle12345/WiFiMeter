'use strict';

const { root, repositoryFiles } = require('./repository.cjs');
const { checkPairs } = require('./i18n.cjs');
const { checkMarkdown } = require('./markdown.cjs');
const { checkNotes } = require('./notes.cjs');
const { checkInstructions } = require('./instructions.cjs');

function checkRepositoryPolicy(directory, files = repositoryFiles(directory)) {
    const errors = [];
    for (const file of files) {
        if (/^(?:\.aws|\.codex|\.zcode|\.agent|\.claude|\.gemini|\.vscode|\.idea|\.workbuddy-ai|node_modules|build|dist|del|artifacts|\.cross-build)\//.test(file)
            || file.startsWith('.agents/') && !file.startsWith('.agents/notes/')
            || /(?:^|\/)(?:AGENTS\.override\.md|CLAUDE\.local\.md|GEMINI\.md|credentials\.json|secrets\.json|\.npmrc|\.netrc)$/.test(file)
            || /(?:^|\/)\.env(?:\..+)?$/.test(file) && !file.endsWith('/.env.example') && file !== '.env.example'
            || /\.(?:db|sqlite|sqlite3)(?:-(?:wal|shm|journal))?$/.test(file)
            || /\.(?:pem|key|pfx|p12|dmp|stackdump)$/.test(file)) {
            errors.push(`${file}: personal state, credentials, runtime data or generated output must remain local.`);
        }
    }
    return errors;
}

function checkDocumentation(directory) {
    const { checkBudgets } = require('./budgets.cjs');
    const checks = { pairs: checkPairs, links: checkMarkdown, notes: checkNotes, instructions: checkInstructions, budgets: checkBudgets, files: checkRepositoryPolicy };
    const errors = [];
    for (const [name, check] of Object.entries(checks)) {
        try { errors.push(...check(directory).map(message => `[${name}] ${message}`)); }
        catch (error) { errors.push(`[${name}] ${error.message}`); }
    }
    return errors;
}

module.exports = { checkRepositoryPolicy, checkDocumentation };

if (require.main === module) {
    const errors = checkDocumentation(root);
    if (errors.length) { console.error(errors.join('\n')); process.exitCode = 1; }
    else console.log('Documentation pairs, links, Notes, instructions, word budgets and repository file policy passed.');
}
