'use strict';
// Match electron-builder's CLI: cleanup listeners must not turn a build failure into success.
function reportBuildFailure(error, runtime = process, logger = console.error) {
    logger(error.stack || error.message || String(error));
    runtime.exitCode = 1;
    runtime.on('exit', () => { runtime.exitCode = 1; });
}
module.exports = { reportBuildFailure };
