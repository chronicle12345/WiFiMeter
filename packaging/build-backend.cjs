const path = require('node:path');
const { execFileSync } = require('node:child_process');

function buildBackend() {
    const root = path.resolve(__dirname, '..');
    const buildDirectory = process.platform === 'win32' ? 'build/windows' : 'build';
    execFileSync('cmake', ['-S', 'backend', '-B', buildDirectory, '-DCMAKE_BUILD_TYPE=Release'], { cwd: root, stdio: 'inherit' });
    execFileSync('cmake', ['--build', buildDirectory, '--target', 'wifimeter-backend', '--config', 'Release'], { cwd: root, stdio: 'inherit' });
}

module.exports = { buildBackend };

if (require.main === module) buildBackend();
