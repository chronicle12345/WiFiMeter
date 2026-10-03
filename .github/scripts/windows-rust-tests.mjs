// Stage Linux-cross-compiled Rust tests, or run the staged executables on Windows.
import assert from 'node:assert/strict';
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
const [command, directory, log] = process.argv.slice(2);
if (command === 'stage') {
    const artifacts = readFileSync(log, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line));
    const tests = artifacts.filter(item => item.reason === 'compiler-artifact' && item.profile.test && item.executable);
    assert.ok(tests.length > 0, 'Cargo produced no test executables');
    mkdirSync(path.join(directory, 'deps'), { recursive: true });
    for (const item of tests) copyFileSync(item.executable, path.join(directory, 'deps', path.basename(item.executable)));
    const fixture = artifacts.find(item => item.reason === 'compiler-artifact' && item.target.name === 'protocol-fixture' && !item.profile.test && item.executable);
    assert.ok(fixture, 'Missing protocol fixture');
    copyFileSync(fixture.executable, path.join(directory, 'protocol-fixture.exe'));
    writeFileSync(path.join(directory, 'tests.json'), JSON.stringify(tests.map(item => path.basename(item.executable))));
} else if (command === 'run') {
    assert.equal(process.platform, 'win32');
    const tests = JSON.parse(readFileSync(path.join(directory, 'tests.json'), 'utf8'));
    assert.ok(tests.length > 0);
    for (const name of tests) {
        const result = spawnSync(path.resolve(directory, 'deps', name), ['--include-ignored'], { stdio: 'inherit', timeout: 120000 });
        if (result.error) throw result.error;
        assert.equal(result.status, 0, `${name} failed`);
    }
} else throw Error('Use stage <directory> <cargo-json-log> or run <directory>');
