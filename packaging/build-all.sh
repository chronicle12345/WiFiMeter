#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# 在开始构建前校验两端参数，避免第二端参数无效时留下半套产物。
node -e 'const { buildOptions } = require(process.argv[1]);
    for (const platform of ["win32", "linux"]) buildOptions(platform, process.argv.slice(2));' \
    "$script_dir/targets.cjs" "$@"
"$script_dir/build-windows.sh" "$@"
exec "$script_dir/build-linux.sh" "$@"
