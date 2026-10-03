'use strict';
// 清理监听器不能把失败的构建变成成功。
function reportBuildFailure(error, runtime = process, logger = console.error) {
    logger(error.stack || error.message || String(error));
    runtime.exitCode = 1;
    runtime.on('exit', () => { runtime.exitCode = 1; });
}
module.exports = { reportBuildFailure };
