'use strict';

const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { buildOptions } = require('./targets.cjs');
const { reportBuildFailure } = require('./build-failure.cjs');

try {
    const args = process.argv.slice(2);
    // 在下载或编译前检查两端目标；当前两端一起构建使用 Linux x64 / WSL 工具链。
    buildOptions('win32', args);
    buildOptions('linux', args);
    for (const platform of ['windows', 'linux']) {
        const result = spawnSync(process.execPath, [path.join(__dirname, `build-${platform}.cjs`), ...args], {
            cwd: path.resolve(__dirname, '..'), stdio: 'inherit'
        });
        if (result.error) throw result.error;
        if (result.status !== 0) {
            process.exitCode = result.status ?? 1;
            break;
        }
    }
} catch (error) {
    reportBuildFailure(error);
}
