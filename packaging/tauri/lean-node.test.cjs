'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { createHash } = require('node:crypto');
const { createRequire } = require('node:module');

const filename = path.join(__dirname, 'lean-node.cjs');
const localRequire = createRequire(filename);
const propsContents = fs.readFileSync(path.join(__dirname, 'windows/node-size.props'));
const sha256 = contents => createHash('sha256').update(contents).digest('hex');

function fixture(t, platform) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'wifimeter-lean-node-cache-'));
    t.after(() => {
        assert.equal(path.dirname(directory), path.resolve(os.tmpdir()));
        assert.ok(path.basename(directory).startsWith('wifimeter-lean-node-cache-'));
        fs.rmSync(directory, { recursive: true, force: true });
    });
    const helperDirectory = path.join(directory, 'helper');
    const props = path.join(helperDirectory, 'windows/node-size.props');
    if (platform === 'win32') {
        fs.mkdirSync(path.dirname(props), { recursive: true });
        fs.writeFileSync(props, propsContents);
    }
    const configuration = { arch: 'x64', jobs: 2, output: path.join(directory, 'runtime'), sourceRoot: path.join(directory, 'source') };
    const executable = path.join(configuration.output, platform === 'win32' ? 'node.exe' : 'node');
    const manifestPath = path.join(configuration.output, 'runtime-manifest.json');
    const calls = [];
    const sourceRequests = [];
    const rebuild = Error('source requested; compilation must not run in cache tests');
    const module = { exports: {} };
    const require = name => name === 'node:child_process' ? {
        execFileSync(command, args, options) {
            assert.equal(command, executable);
            assert.equal(options.windowsHide, true);
            calls.push(Array.from(args));
            if (calls.length === 1) {
                assert.deepEqual(calls[0], ['-p', 'process.versions.node']);
                return `${module.exports.VERSION}\n`;
            }
            assert.equal(calls.length, 2);
            assert.deepEqual(calls[1], [path.join(helperDirectory, 'lean-node-check.cjs'), '--lean']);
            assert.equal(options.stdio[0], 'ignore');
        }
    } : localRequire(name);
    vm.runInNewContext(fs.readFileSync(filename, 'utf8') + '\nsource = async configuration => { sourceRequested(configuration); throw rebuild; };', {
        module, require, __dirname: helperDirectory, Buffer, console, rebuild,
        sourceRequested: value => sourceRequests.push(value),
        process: { platform, arch: 'x64', env: {}, stdout: { write() {} } }
    }, { filename });
    const helper = module.exports;
    const originalProfile = helper.CONFIGURE_FLAGS.join(' ');
    const currentProfile = originalProfile + (platform === 'win32' ? ` msvc-release-minspace-size:${sha256(propsContents)}` : '');
    const header = Buffer.alloc(256);
    if (platform === 'win32') {
        header.write('MZ'); header.writeUInt32LE(128, 0x3c);
        header.write('PE\0\0', 128); header.writeUInt16LE(0x8664, 132);
    } else {
        header.write('\x7fELF', 'binary'); header[4] = 2; header[5] = 1;
        header.writeUInt16LE(62, 18);
    }
    fs.mkdirSync(configuration.output);
    fs.writeFileSync(executable, header);
    fs.writeFileSync(path.join(configuration.output, 'LICENSE'), 'public test license');
    function cache(profile) {
        fs.writeFileSync(manifestPath, JSON.stringify({ version: helper.VERSION, sourceSha256: helper.SOURCE_SHA256,
            profile, platform, arch: configuration.arch, sha256: sha256(header), bytes: header.length }));
    }
    async function expectRebuild() {
        await assert.rejects(helper.build(configuration), error => error === rebuild);
        assert.deepEqual(sourceRequests, [configuration]);
        assert.equal(calls.length, 0);
    }
    async function expectCached() {
        const before = fs.readFileSync(manifestPath, 'utf8');
        const result = await helper.build(configuration);
        assert.equal(result.nodeExecutable, executable);
        assert.equal(result.bytes, header.length);
        assert.equal(sourceRequests.length, 0);
        assert.equal(calls.length, 2);
        assert.equal(fs.readFileSync(manifestPath, 'utf8'), before);
    }
    return { props, originalProfile, currentProfile, cache, expectRebuild, expectCached };
}

test('Windows cache from the previous optimization profile rebuilds before runtime validation', async t => {
    const runtime = fixture(t, 'win32');
    runtime.cache(runtime.originalProfile);
    await runtime.expectRebuild();
});

test('matching Windows size optimization cache still validates the cached runtime', async t => {
    const runtime = fixture(t, 'win32');
    runtime.cache(runtime.currentProfile);
    await runtime.expectCached();
});

test('changing Windows optimization props invalidates a previously matching cache', async t => {
    const runtime = fixture(t, 'win32');
    runtime.cache(runtime.currentProfile);
    fs.writeFileSync(runtime.props, propsContents.toString('utf8').replace('MinSpace', 'MaxSpeed'));
    await runtime.expectRebuild();
});

test('Linux cache keeps its original profile and validates without Windows props', async t => {
    const runtime = fixture(t, 'linux');
    assert.equal(fs.existsSync(runtime.props), false);
    runtime.cache(runtime.originalProfile);
    await runtime.expectCached();
});
