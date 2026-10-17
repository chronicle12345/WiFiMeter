'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const releaseHelper = require('./release.cjs');

const repository = 'chronicle12345/WiFiMeter';
const version = '1.3.2';
const tag = `v${version}`;
const repositoryUrl = `https://github.com/${repository}`;
const repoApi = `https://api.github.com/repos/${repository}`;
const releaseApi = `${repoApi}/releases/tags/${tag}`;
const token = 'fixture-api-token';
const repositoryId = 123456;
const cdn = `https://release-assets.githubusercontent.com/github-production-release-asset/${repositoryId}/11111111-2222-3333-4444-555555555555?sig=fixture-private-query`;
const names = releaseHelper.matrices.flatMap(([platform, arch]) => releaseHelper.assetNames(version, platform, arch));
const sourceFile = path.join(__dirname, 'verify-public-release.cjs');
const originalFetch = globalThis.fetch;
test.before(() => { globalThis.fetch = () => assert.fail('Tests must never access the real network.'); });
test.after(() => { globalThis.fetch = originalFetch; });

function implementation() {
    assert.ok(fs.existsSync(sourceFile), 'The public release verifier must be implemented.');
    return require(sourceFile);
}

function fixture(t) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wifimeter-public-release-test-'));
    t.after(() => {
        assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
        assert.ok(path.basename(root).startsWith('wifimeter-public-release-test-'));
        fs.rmSync(root, { recursive: true, force: true });
    });
    const directory = path.join(root, 'artifacts');
    const contents = new Map();
    for (const [platform, arch] of releaseHelper.matrices) {
        const target = path.join(directory, releaseHelper.artifactName(platform, arch));
        fs.mkdirSync(target, { recursive: true });
        const lines = [];
        for (const name of releaseHelper.assetNames(version, platform, arch)) {
            const bytes = Buffer.from(`Verified public ${name}\n`);
            contents.set(name, bytes);
            fs.writeFileSync(path.join(target, name), bytes);
            lines.push(`${createHash('sha256').update(bytes).digest('hex')}  ${name}`);
        }
        fs.writeFileSync(path.join(target, releaseHelper.checksumName(version, platform, arch)), lines.join('\n') + '\n');
    }
    const repo = { full_name: repository, html_url: repositoryUrl, private: false, id: repositoryId };
    const release = { tag_name: tag, html_url: `${repositoryUrl}/releases/tag/${tag}`, draft: false,
        prerelease: false, published_at: '2026-10-11T00:00:00Z', assets: names.map(name => ({
            name, state: 'uploaded', size: contents.get(name).length,
            digest: 'sha256:' + createHash('sha256').update(contents.get(name)).digest('hex'),
            browser_download_url: `${repositoryUrl}/releases/download/${tag}/${name}`
        })) };
    const calls = [];
    const fetch = async (input, init) => {
        const url = String(input);
        calls.push({ url, init });
        if (url === repoApi) return Response.json(repo);
        if (url === releaseApi) return Response.json(release);
        const asset = release.assets.find(asset => asset.browser_download_url === url);
        assert.ok(asset, 'Only exact official API and installer routes may be fetched.');
        return new Response(contents.get(asset.name), { headers: { 'content-length': String(asset.size) } });
    };
    return { root, directory, contents, repo, release, calls, fetch,
        options: { directory, version, tag, token, fetch } };
}

test('public verification streams the Windows x64 installer anonymously and binds its hash to the internal manifest', async t => {
    const f = fixture(t), verified = [];
    const result = await implementation().verifyPublicRelease({ ...f.options, onAsset: asset => verified.push(asset) });
    assert.equal(result.passed, true);
    assert.equal(result.tag, tag);
    assert.equal(result.installerCount, 1);
    assert.deepEqual(verified.map(asset => asset.name), names);
    assert.equal(result.totalBytes, [...f.contents.values()].reduce((sum, bytes) => sum + bytes.length, 0));
    assert.equal(f.calls.length, 3);
    for (const { url, init } of f.calls) {
        if (url.startsWith('https://api.github.com/')) {
            assert.equal(init.headers.Authorization, `Bearer ${token}`);
            assert.equal(init.redirect, 'error');
        } else {
            assert.equal(init.headers.Authorization, undefined);
            assert.equal(init.headers['Accept-Encoding'], 'identity');
            assert.equal(init.redirect, 'manual');
            assert.equal(init.credentials, 'omit');
        }
    }
    assert.deepEqual(fs.readdirSync(f.root), ['artifacts'], 'No downloaded binaries or URL reports may be written.');
});

test('every GitHub CDN redirect remains anonymous and is bound to the original repository', async t => {
    const f = fixture(t);
    const first = f.release.assets[0];
    const calls = [];
    const result = await implementation().verifyPublicRelease({ ...f.options, fetch: async (input, init) => {
        const url = String(input);
        calls.push({ url, init });
        if (url === first.browser_download_url) return new Response(null, { status: 302, headers: { location: cdn } });
        if (url === cdn) return new Response(new ReadableStream({ start(controller) {
            const bytes = f.contents.get(first.name);
            controller.enqueue(bytes.subarray(0, 5));
            controller.enqueue(bytes.subarray(5));
            controller.close();
        } }));
        return f.fetch(input, init);
    } });
    assert.equal(result.installerCount, 1);
    assert.equal(calls.find(call => call.url === cdn).init.headers.Authorization, undefined);
    assert.ok(!JSON.stringify(result).includes('fixture-private-query'));
});

for (const mutation of ['wrong repository', 'private repository', 'wrong tag', 'draft', 'prerelease', 'missing publication',
    'missing installer', 'duplicate installer', 'extra checksum', 'wrong architecture', 'wrong asset URL', 'wrong API digest', 'wrong API size', 'pending asset']) {
    test(`metadata rejects ${mutation} before any installer download`, async t => {
        const f = fixture(t);
        if (mutation === 'wrong repository') f.repo.full_name = 'other/WiFiMeter';
        if (mutation === 'private repository') f.repo.private = true;
        if (mutation === 'wrong tag') f.release.tag_name = 'v1.3.1';
        if (mutation === 'draft') f.release.draft = true;
        if (mutation === 'prerelease') f.release.prerelease = true;
        if (mutation === 'missing publication') delete f.release.published_at;
        if (mutation === 'missing installer') f.release.assets.pop();
        if (mutation === 'duplicate installer') f.release.assets.push({ ...f.release.assets[0] });
        if (mutation === 'extra checksum') f.release.assets.push({ ...f.release.assets[0], name: 'SHA256SUMS.txt' });
        if (mutation === 'wrong architecture') f.release.assets[0].name = 'WiFiMeter-1.3.2-windows-mips-Tauri-Setup.exe';
        if (mutation === 'wrong asset URL') f.release.assets[0].browser_download_url = 'https://evil.example/file.exe?token=private';
        if (mutation === 'wrong API digest') f.release.assets[0].digest = 'sha256:' + '0'.repeat(64);
        if (mutation === 'wrong API size') f.release.assets[0].size++;
        if (mutation === 'pending asset') f.release.assets[0].state = 'new';
        await assert.rejects(implementation().verifyPublicRelease(f.options));
        assert.equal(f.calls.filter(call => !call.url.startsWith('https://api.github.com/')).length, 0);
    });
}

for (const location of [
    'http://github.com/chronicle12345/WiFiMeter/releases/download/v1.3.2/file.exe',
    'https://evil.example/file.exe?sig=private',
    'https://github.com/other/WiFiMeter/releases/download/v1.3.2/file.exe',
    'https://release-assets.githubusercontent.com/github-production-release-asset/999999/11111111-2222-3333-4444-555555555555?sig=private',
    'https://user:password@release-assets.githubusercontent.com/github-production-release-asset/123456/11111111-2222-3333-4444-555555555555',
    'https://objects.githubusercontent.com/unrelated/123456/file.exe',
    'https://github.com/chronicle12345/WiFiMeter/releases/download/v1.3.1/file.exe'
]) test('untrusted redirects are never fetched and never appear in errors', async t => {
    const f = fixture(t), first = f.release.assets[0];
    const calls = [];
    await assert.rejects(implementation().verifyPublicRelease({ ...f.options, fetch: async (input, init) => {
        const url = String(input); calls.push(url);
        if (url === first.browser_download_url) return new Response(null, { status: 302, headers: { location } });
        return f.fetch(input, init);
    } }), error => {
        assert.doesNotMatch(error.message, /evil\.example|sig=private|password|token=private/);
        return true;
    });
    assert.equal(calls.filter(url => !url.startsWith('https://api.github.com/')).length, 1);
});

for (const kind of ['short stream', 'oversized stream', 'changed bytes', 'wrong HTTP length', 'encoded response', 'failed stream']) {
    test(`public stream rejects ${kind} without returning success`, async t => {
        const f = fixture(t), first = f.release.assets[0];
        await assert.rejects(implementation().verifyPublicRelease({ ...f.options, fetch: async (input, init) => {
            if (String(input) !== first.browser_download_url) return f.fetch(input, init);
            const bytes = f.contents.get(first.name);
            if (kind === 'short stream') return new Response(bytes.subarray(1));
            if (kind === 'oversized stream') return new Response(Buffer.concat([bytes, Buffer.from('x')]));
            if (kind === 'changed bytes') return new Response(Buffer.alloc(bytes.length));
            if (kind === 'wrong HTTP length') return new Response(bytes, { headers: { 'content-length': String(bytes.length + 1) } });
            if (kind === 'encoded response') return new Response(bytes, { headers: { 'content-encoding': 'gzip' } });
            return new Response(new ReadableStream({ start(controller) { controller.error(Error(`stream ${cdn}`)); } }));
        } }), error => {
            assert.doesNotMatch(error.message, /fixture-private-query|fixture-api-token/);
            return true;
        });
    });
}

test('internal manifest corruption fails before any API request', async t => {
    const f = fixture(t);
    const [platform, arch] = releaseHelper.matrices[0];
    const file = path.join(f.directory, releaseHelper.artifactName(platform, arch), names[0]);
    fs.writeFileSync(file, 'modified');
    await assert.rejects(implementation().verifyPublicRelease(f.options));
    assert.equal(f.calls.length, 0);
});

test('network errors cannot expose API tokens or signed download URLs', async t => {
    const f = fixture(t);
    await assert.rejects(implementation().verifyPublicRelease({ ...f.options, fetch: async () => {
        throw Error(`${token} ${cdn}`);
    } }), error => {
        assert.doesNotMatch(error.message, /fixture-api-token|fixture-private-query/);
        return true;
    });
});

for (const kind of ['redirect loop', 'too many redirects', 'missing location', 'unexpected automatic redirect']) {
    test(`public downloads reject ${kind}`, async t => {
        const f = fixture(t), first = f.release.assets[0];
        let requests = 0;
        await assert.rejects(implementation().verifyPublicRelease({ ...f.options, fetch: async (input, init) => {
            const url = String(input);
            if (url.startsWith('https://api.github.com/')) return f.fetch(input, init);
            requests++;
            if (kind === 'unexpected automatic redirect') {
                const response = new Response(f.contents.get(first.name));
                Object.defineProperty(response, 'redirected', { value: true });
                return response;
            }
            const headers = kind === 'missing location' ? {} : { location: kind === 'redirect loop'
                ? first.browser_download_url : cdn.replace('sig=fixture-private-query', `sig=hop${requests}`) };
            return new Response(null, { status: 302, headers });
        } }));
        assert.equal(requests, kind === 'too many redirects' ? 6 : 1);
    });
}

for (const kind of ['oversized JSON', 'malformed JSON', 'automatic API redirect']) {
    test(`metadata rejects ${kind} without public downloads`, async t => {
        const f = fixture(t);
        await assert.rejects(implementation().verifyPublicRelease({ ...f.options, fetch: async (input, init) => {
            if (String(input) !== releaseApi) return f.fetch(input, init);
            if (kind === 'oversized JSON') return new Response('x'.repeat(1024 * 1024 + 1));
            if (kind === 'malformed JSON') return new Response(`invalid ${token} ${cdn}`);
            const response = Response.json(f.release);
            Object.defineProperty(response, 'redirected', { value: true });
            return response;
        } }), error => {
            assert.doesNotMatch(error.message, /fixture-api-token|fixture-private-query/);
            return true;
        });
        assert.equal(f.calls.filter(call => !call.url.startsWith('https://api.github.com/')).length, 0);
    });
}

function writeMetadata(f) {
    for (const file of ['package.json', 'apps/desktop/package.json', 'apps/desktop/src-tauri/tauri.conf.json']) {
        const destination = path.join(f.root, file);
        fs.mkdirSync(path.dirname(destination), { recursive: true });
        fs.writeFileSync(destination, JSON.stringify({ version }));
    }
    fs.writeFileSync(path.join(f.root, 'apps/desktop/src-tauri/Cargo.toml'), `[package]\nversion = "${version}"\n`);
    fs.mkdirSync(path.join(f.root, 'docs/releases'), { recursive: true });
    fs.writeFileSync(path.join(f.root, `docs/releases/${tag}.md`), '## 中文\n\n说明。\n\n## English\n\nRelease notes.\n');
    for (const file of ['README.md', 'README.zh-CN.md']) {
        fs.writeFileSync(path.join(f.root, file), `<a href="docs/releases/${tag}.md"><img src="https://img.shields.io/badge/version-${version}-6366F1" alt="Version ${version}" /></a>\n`);
    }
    return { GITHUB_ACTIONS: 'true', RUNNER_ENVIRONMENT: 'github-hosted',
        GITHUB_REPOSITORY: repository, GITHUB_REF_TYPE: 'tag', GITHUB_REF_NAME: tag, GH_TOKEN: token };
}

test('CLI uses the current tag and bilingual metadata before verifying public files', async t => {
    const f = fixture(t), env = writeMetadata(f), output = [];
    const result = await implementation().main([f.directory], { env, root: f.root, fetch: f.fetch,
        onAsset: asset => output.push(asset) });
    assert.equal(result.installerCount, 1);
    assert.equal(output.length, 1);
});

for (const kind of ['local execution', 'self-hosted runner', 'fork', 'branch', 'wrong tag', 'missing English', 'missing Chinese', 'version mismatch', 'stale README']) {
    test(`CLI rejects ${kind} before accessing the network`, async t => {
        const f = fixture(t), env = writeMetadata(f);
        if (kind === 'local execution') delete env.GITHUB_ACTIONS;
        if (kind === 'self-hosted runner') env.RUNNER_ENVIRONMENT = 'self-hosted';
        if (kind === 'fork') env.GITHUB_REPOSITORY = 'other/WiFiMeter';
        if (kind === 'branch') env.GITHUB_REF_TYPE = 'branch';
        if (kind === 'wrong tag') env.GITHUB_REF_NAME = 'v1.3.1';
        if (kind === 'missing English') fs.writeFileSync(path.join(f.root, `docs/releases/${tag}.md`), '## 中文\n\n说明。\n');
        if (kind === 'missing Chinese') fs.writeFileSync(path.join(f.root, `docs/releases/${tag}.md`), '## English\n\nRelease notes.\n');
        if (kind === 'version mismatch') fs.writeFileSync(path.join(f.root, 'package.json'), '{"version":"1.3.1"}');
        if (kind === 'stale README') fs.writeFileSync(path.join(f.root, 'README.zh-CN.md'), 'Previous version.\n');
        await assert.rejects(implementation().main([f.directory], { env, root: f.root, fetch: f.fetch, onAsset() {} }));
        assert.equal(f.calls.length, 0);
    });
}
