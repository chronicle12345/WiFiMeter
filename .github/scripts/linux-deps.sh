#!/usr/bin/env bash
set -euo pipefail
sudo install -d -m 700 /etc/NetworkManager/system-connections
sudo apt-get update --snapshot 20261001T000000Z
sudo apt-get install -y --no-install-recommends --snapshot 20261001T000000Z \
  cmake ninja-build g++ pkg-config libsqlite3-dev clang-18 libbpf-dev libelf-dev zlib1g-dev \
  libwebkit2gtk-4.1-dev libayatana-appindicator3-dev librsvg2-dev libssl-dev webkit2gtk-driver \
  libnss3 libasound2t64 libgbm1 libxss1 libxtst6 xdg-utils network-manager pkexec \
  fonts-wqy-zenhei xvfb xauth dbus-x11 dpkg-dev xz-utils zip nsis gcc-mingw-w64-x86-64-posix
getconf GNU_LIBC_VERSION
pkg-config --modversion libbpf sqlite3 webkit2gtk-4.1
