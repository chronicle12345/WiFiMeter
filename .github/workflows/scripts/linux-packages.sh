#!/usr/bin/env bash
set -euo pipefail
root="$PWD"
arch="$1"
version="$(node -p "require('./apps/desktop/package.json').version")"
deb_arch="$arch"
rpm_arch="$arch"
if [[ "$arch" == x64 ]]; then deb_arch=amd64; rpm_arch=x86_64; else rpm_arch=aarch64; fi
for format in deb rpm AppImage; do
  artifact_arch="$arch"
  if [[ "$format" == rpm ]]; then artifact_arch="$rpm_arch"; fi
  if [[ "$format" == AppImage && "$arch" == x64 ]]; then artifact_arch=x86_64; fi
  name="WiFiMeter-${version}-linux-${artifact_arch}.${format}"
  if [[ "$format" == deb ]]; then name="WiFiMeter-${version}-linux-${deb_arch}.deb"; fi
  artifact="$root/$OUTPUT_DIR/$name"
  test -s "$artifact"
  extracted="$(mktemp -d "$RUNNER_TEMP/wifimeter-${format}-XXXXXX")"
  case "$format" in
    deb)
      test "$(dpkg-deb -f "$artifact" Version)" = "$version"
      test "$(dpkg-deb -f "$artifact" Architecture)" = "$deb_arch"
      dpkg-deb -x "$artifact" "$extracted"
      ;;
    rpm)
      test "$(rpm -qp --qf '%{ARCH}' "$artifact")" = "$rpm_arch"
      # 最终版本再由包内后端 --version 与 metadata 严格比较。
      (cd "$extracted"; rpm2cpio "$artifact" | cpio -idm --quiet --no-absolute-filenames)
      ;;
    AppImage)
      chmod +x "$artifact"
      (cd "$extracted"; "$artifact" --appimage-extract > "$RUNNER_TEMP/appimage-extract.log")
      ;;
  esac
  mapfile -t binaries < <(find "$extracted" -type f -name wifimeter)
  test "${#binaries[@]}" -eq 1
  binary="${binaries[0]}"
  node .github/workflows/scripts/ci.cjs directory linux "$arch" "$(dirname "$binary")"
  sudo chown root:root "$(dirname "$binary")/chrome-sandbox"
  sudo chmod 4755 "$(dirname "$binary")/chrome-sandbox"
  export WIFIMETER_EXECUTABLE="$binary"
  export WIFIMETER_BACKEND="$(dirname "$binary")/resources/wifimeter-backend"
  export PLAYWRIGHT_JSON_OUTPUT_NAME="$RUNNER_TEMP/ui-package-${format}.json"
  dbus-run-session -- xvfb-run -a npm --prefix apps/desktop run test:ui -- \
    desktop.spec.js --grep '@packaged-smoke' --reporter=list,json --output "$RUNNER_TEMP/playwright-package-${format}"
  node .github/workflows/scripts/ci.cjs ui-report "$PLAYWRIGHT_JSON_OUTPUT_NAME"
done
