'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { findValidatedRun, main } = require('./tauri-validated-run.cjs');

const repository = 'example/WiFiMeter';
const sha = 'a'.repeat(40);
const requiredNames = [
    'Workflow checks and Tauri release metadata',
    'Windows browser UI shard 1/2', 'Windows browser UI shard 2/2',
    'Linux browser UI shard 1/2', 'Linux browser UI shard 2/2',
    'Windows x64 Tauri', 'Windows ia32 Tauri', 'Windows arm64 Tauri',
    'Linux x64 Tauri', 'Linux arm64 Tauri', 'Required Tauri checks'
];

function fixtures() {
    return {
        workflow: { id: 123, path: '.github/workflows/tauri.yml', state: 'active' },
        run: {
            id: 456, workflow_id: 123, path: '.github/workflows/tauri.yml', event: 'push',
            head_branch: 'main', head_sha: sha, status: 'completed', conclusion: 'success',
            repository: { id: 789, full_name: repository }, head_repository: { id: 789, full_name: repository }
        },
        jobs: [...requiredNames, 'Publish verified multi-platform Tauri v1.3 release'].map((name, index) => ({
            id: 1000 + index, run_id: 456, head_sha: sha, name, status: 'completed',
            conclusion: name.startsWith('Publish ') ? 'skipped' : 'success'
        })),
        artifacts: ['tauri-release-windows-x64', 'tauri-release-windows-ia32', 'tauri-release-windows-arm64',
            'tauri-release-linux-x64', 'tauri-release-linux-arm64'].map((name, index) => ({
            id: 2000 + index, name, size_in_bytes: 1024, expired: false,
            workflow_run: { id: 456, head_sha: sha, repository_id: 789, head_repository_id: 789, head_branch: 'main' }
        }))
    };
}

function api(data, { runs = [data.run], jobsPages = [data.jobs], artifactsPages = [data.artifacts] } = {}) {
    return async (url, options) => {
        const request = new URL(url);
        assert.equal(request.origin, 'https://api.github.com');
        assert.equal(options.method, 'GET');
        assert.equal(options.redirect, 'error');
        assert.equal(options.headers.Authorization, 'Bearer fixture-token');
        let body;
        if (request.pathname === '/repos/example/WiFiMeter/actions/workflows/tauri.yml') body = data.workflow;
        else if (request.pathname === '/repos/example/WiFiMeter/actions/workflows/123/runs') {
            assert.equal(request.searchParams.get('event'), 'push');
            assert.equal(request.searchParams.get('branch'), 'main');
            assert.equal(request.searchParams.get('head_sha'), sha);
            assert.equal(request.searchParams.get('status'), 'success');
            body = { total_count: runs.length, workflow_runs: request.searchParams.get('page') === '1' ? runs : [] };
        } else if (request.pathname.endsWith('/artifacts')) {
            assert.equal(request.pathname, '/repos/example/WiFiMeter/actions/runs/456/artifacts');
            const page = Number(request.searchParams.get('page'));
            body = { total_count: artifactsPages.flat().length, artifacts: artifactsPages[page - 1] || [] };
        } else {
            assert.equal(request.pathname, '/repos/example/WiFiMeter/actions/runs/456/jobs');
            assert.equal(request.searchParams.get('filter'), 'latest');
            const page = Number(request.searchParams.get('page'));
            body = { total_count: jobsPages.flat().length, jobs: jobsPages[page - 1] || [] };
        }
        return { ok: true, json: async () => structuredClone(body) };
    };
}

function find(fetchImpl, overrides = {}) {
    return findValidatedRun({ repository, sha, refType: 'tag', token: 'fixture-token', fetchImpl, ...overrides });
}

test('a tag reuses only its same-commit main run with all eleven required jobs successful', async () => {
    const data = fixtures();
    assert.equal(await find(api(data)), '456');
});

test('branch and pull request execution never contacts GitHub', async () => {
    for (const refType of ['branch', '', undefined]) {
        let requests = 0;
        assert.equal(await find(async () => { requests++; throw new Error('unexpected network'); }, { refType }), '');
        assert.equal(requests, 0);
    }
});

test('malformed repository, commit or missing token falls back without a request', async () => {
    for (const overrides of [
        { repository: '../other/repo' }, { repository: 'owner/repo\n' },
        { sha: '../main' }, { sha: 'a'.repeat(39) }, { sha: `${sha}\n` }, { token: '' }
    ]) {
        let requests = 0;
        assert.equal(await find(async () => { requests++; throw new Error('unexpected network'); }, overrides), '');
        assert.equal(requests, 0);
    }
});

test('wrong workflow lookup cannot select a successful run from another workflow', async () => {
    for (const patch of [{ path: '.github/workflows/desktop.yml' }, { id: '../123' }]) {
        const data = fixtures();
        Object.assign(data.workflow, patch);
        assert.equal(await find(api(data)), '');
    }
});

test('wrong SHA, PR, tag, fork, workflow or unfinished run cannot bypass the matrix', async () => {
    for (const patch of [
        { head_sha: 'b'.repeat(40) }, { event: 'pull_request' }, { event: 'workflow_dispatch' },
        { head_branch: 'v1.3.1' }, { status: 'in_progress' }, { conclusion: 'failure' },
        { workflow_id: 321 }, { path: '.github/workflows/desktop.yml' },
        { repository: { id: 789, full_name: 'other/WiFiMeter' } },
        { head_repository: { id: 321, full_name: 'fork/WiFiMeter' } },
        { head_repository: { id: 321, full_name: repository } }, { id: '456\n' }
    ]) {
        const data = fixtures();
        Object.assign(data.run, patch);
        assert.equal(await find(api(data)), '');
    }
});

test('every required platform, metadata and final gate must exist exactly once and pass', async () => {
    for (const name of requiredNames) {
        for (const invalid of ['missing', 'duplicate', 'skipped', 'failure', 'cancelled', 'in_progress']) {
            const data = fixtures();
            const job = data.jobs.find(value => value.name === name);
            if (invalid === 'missing') data.jobs = data.jobs.filter(value => value !== job);
            else if (invalid === 'duplicate') data.jobs.push({ ...job, id: 9999 });
            else if (invalid === 'in_progress') job.status = invalid;
            else job.conclusion = invalid;
            assert.equal(await find(api(data)), '', `${name}: ${invalid}`);
        }
    }
});

test('jobs from another run or commit cannot prove successful validation', async () => {
    for (const patch of [{ run_id: 999 }, { head_sha: 'b'.repeat(40) }]) {
        const data = fixtures();
        Object.assign(data.jobs[1], patch);
        assert.equal(await find(api(data)), '');
    }
});

test('all job pages are checked so a later failed duplicate invalidates reuse', async () => {
    const data = fixtures();
    const extra = { ...data.jobs[1], id: 9999, conclusion: 'failure' };
    assert.equal(await find(api(data, { jobsPages: [data.jobs, [extra]] })), '');
    assert.equal(await find(api(data, { jobsPages: [data.jobs.slice(0, 3), data.jobs.slice(3)] })), '456');
});

test('an invalid newest run does not hide an earlier valid main run for the same commit', async () => {
    const data = fixtures();
    const wrong = { ...data.run, id: 999, event: 'pull_request' };
    assert.equal(await find(api(data, { runs: [wrong, data.run] })), '456');
});

test('each of the five release artifacts must be present, nonempty, unique and unexpired', async () => {
    for (let index = 0; index < 5; index++) {
        for (const invalid of ['missing', 'duplicate', 'expired', 'empty', 'invalid-id']) {
            const data = fixtures();
            const artifact = data.artifacts[index];
            if (invalid === 'missing') data.artifacts.splice(index, 1);
            else if (invalid === 'duplicate') data.artifacts.push({ ...artifact, id: 9999 });
            else if (invalid === 'expired') artifact.expired = true;
            else if (invalid === 'empty') artifact.size_in_bytes = 0;
            else artifact.id = '2000\n';
            assert.equal(await find(api(data)), '', `${artifact.name}: ${invalid}`);
        }
    }
});

test('artifact workflow metadata cannot refer to a different run, commit, repository or branch', async () => {
    for (const patch of [{ id: 999 }, { head_sha: 'b'.repeat(40) },
        { repository_id: 321 }, { head_repository_id: 321 }, { head_branch: 'feature' }]) {
        const data = fixtures();
        Object.assign(data.artifacts[0].workflow_run, patch);
        assert.equal(await find(api(data)), '');
    }
});

test('missing source metadata or an empty main-run search falls back to the full matrix', async () => {
    const data = fixtures();
    assert.equal(await find(api(data, { runs: [] })), '');
    delete data.artifacts[0].workflow_run;
    assert.equal(await find(api(data)), '');
});

test('unexpected release artifacts on any page reject reuse while diagnostics do not', async () => {
    const data = fixtures();
    const extra = { ...data.artifacts[0], id: 9999, name: 'tauri-release-windows-unknown' };
    assert.equal(await find(api(data, { artifactsPages: [data.artifacts, [extra]] })), '');
    extra.name = 'tauri-diagnostics-linux-x64-1';
    assert.equal(await find(api(data, { artifactsPages: [data.artifacts, [extra]] })), '456');
});

test('HTTP failures, malformed responses and exceptions safely fall back without exposing data', async () => {
    const messages = [];
    const original = { log: console.log, error: console.error, warn: console.warn };
    for (const key of Object.keys(original)) console[key] = (...args) => messages.push(args);
    let errorBodyReads = 0;
    try {
        for (const fetchImpl of [
            async () => { throw new Error('fixture-token response secret'); },
            async () => ({ ok: false, json: () => { errorBodyReads++; return { secret: 'private response' }; } }),
            async () => ({ ok: true, json: async () => { throw new Error('private response'); } }),
            async () => ({ ok: true, json: async () => null })
        ]) assert.equal(await find(fetchImpl), '');
    } finally {
        Object.assign(console, original);
    }
    assert.equal(errorBodyReads, 0);
    assert.deepEqual(messages, []);
});

test('CLI output is a numeric run ID or empty fallback without storing credentials', async t => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'wifimeter-validated-run-test-'));
    t.after(() => {
        assert.equal(path.dirname(directory), path.resolve(os.tmpdir()));
        fs.rmSync(directory, { recursive: true, force: true });
    });
    const output = path.join(directory, 'output.txt');
    const env = { GITHUB_REPOSITORY: repository, GITHUB_SHA: sha, GITHUB_REF_TYPE: 'tag', GH_TOKEN: 'fixture-token', GITHUB_OUTPUT: output };
    await main(env, api(fixtures()));
    await main({ ...env, GITHUB_REF_TYPE: 'branch' }, () => assert.fail('branch network request'));
    assert.equal(fs.readFileSync(output, 'utf8'), 'source_run_id=456\nsource_run_id=\n');
});
