#!/usr/bin/env bash
set -euo pipefail

# Ubuntu 22.04 provides WebKitGTK 4.1 and keeps the release glibc baseline at 2.35.
# https://v2.tauri.app/start/prerequisites/#linux
sudo install -d -m 700 /etc/NetworkManager/system-connections
sudo apt-get update
sudo apt-get install -y --no-install-recommends \
  ca-certificates curl wget file cmake ninja-build g++ make pkg-config python3 clang-14 \
  libsqlite3-dev libelf-dev zlib1g-dev libwebkit2gtk-4.1-dev libxdo-dev libssl-dev \
  libayatana-appindicator3-dev librsvg2-dev patchelf libfuse2 squashfs-tools \
  libnss3 libxss1 libxtst6 libgbm1 libasound2 libatspi2.0-0 libsecret-1-0 libnotify4 \
  xdg-utils network-manager policykit-1 xvfb xauth dbus-x11 webkit2gtk-driver wmctrl openbox \
  rpm cpio dpkg-dev xz-utils

# Use the same fixed static libbpf dependency as the existing Linux compatibility build.
dependency_dir="$RUNNER_TEMP/tauri-native-deps"
mkdir -p "$dependency_dir/obj"
archive="$dependency_dir/libbpf.tar.gz"
curl --fail --location --retry 3 https://github.com/libbpf/libbpf/archive/refs/tags/v1.3.3.tar.gz -o "$archive"
echo "cfb8bcb2aa7d8645c69a093841a4e5ed483855bf7e403c27054da2c15bc7bbde  $archive" | sha256sum --check
tar -xzf "$archive" -C "$dependency_dir"
make -C "$dependency_dir/libbpf-1.3.3/src" -j2 BUILD_STATIC_ONLY=1 OBJDIR="$dependency_dir/obj" \
  DESTDIR="$dependency_dir/install" PREFIX=/usr LIBDIR=/usr/lib install
printf 'TAURI_LIBBPF_INCLUDE=%s/install/usr/include\nTAURI_LIBBPF_LIBRARY=%s/install/usr/lib/libbpf.a\n' \
  "$dependency_dir" "$dependency_dir" >> "$GITHUB_ENV"
getconf GNU_LIBC_VERSION
pkg-config --modversion webkit2gtk-4.1 sqlite3
