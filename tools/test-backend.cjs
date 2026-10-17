'use strict';

const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { buildBackend } = require('../packaging/build-backend.cjs');

function runBackendTests({ build = buildBackend, run = execFileSync, env = process.env } = {}) {
    const result = build({ buildTests: true });
    const ctest = env.CTEST_COMMAND || (path.isAbsolute(result.cmake)
        ? path.join(path.dirname(result.cmake), process.platform === 'win32' ? 'ctest.exe' : 'ctest') : 'ctest');
    run(ctest, ['--test-dir', result.buildDirectory, '-C', 'Release', '--output-on-failure', '--no-tests=error'], {
        cwd: result.root, stdio: 'inherit', windowsHide: true
    });
}

module.exports = { runBackendTests };

if (require.main === module) {
    try { runBackendTests(); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
