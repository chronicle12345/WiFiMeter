#!/usr/bin/env bash
set -euo pipefail
arch="$1"
version="$(node -p "require('./apps/desktop/package.json').version")"
artifact="$OUTPUT_DIR/WiFiMeter-${version}-linux-${arch}.deb"
deb_arch="$arch"
if [[ "$arch" == x64 ]]; then deb_arch=amd64; fi
test "$(dpkg-deb -f "$artifact" Version)" = "$version"
test "$(dpkg-deb -f "$artifact" Architecture)" = "$deb_arch"
extracted="$(mktemp -d "$RUNNER_TEMP/wifimeter-deb-XXXXXX")"
trap 'rm -rf "$extracted"' EXIT
dpkg-deb -x "$artifact" "$extracted"
node .github/scripts/ci.cjs directory linux "$arch" "$extracted/usr"
export WIFIMETER_EXECUTABLE="$extracted/usr/bin/wifimeter"
# Used to seed fixtures, then removed by --packaged before launching the application.
export WIFIMETER_BACKEND="$extracted/usr/lib/WiFiMeter/wifimeter-backend"
dbus-run-session -- xvfb-run -a node apps/desktop/tests/e2e/smoke-linux.mjs --packaged
