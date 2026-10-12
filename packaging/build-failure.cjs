'use strict';
// Cleanup listeners must not turn a failed Tauri build into success.
function reportBuildFailure(error, runtime = process, logger = console.error) {
    logger(error.stack || error.message || String(error));
    runtime.exitCode = 1;
    runtime.on('exit', () => { runtime.exitCode = 1; });
}
module.exports = { reportBuildFailure };
