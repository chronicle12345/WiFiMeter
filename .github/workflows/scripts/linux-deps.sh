#!/usr/bin/env bash
set -euo pipefail
# 只使用 Ubuntu 官方仓库的固定快照，不加入个人 PPA。
sudo install -d -m 700 /etc/NetworkManager/system-connections
sudo apt-get update --snapshot 20261001T000000Z
sudo apt-get install -y --no-install-recommends --snapshot 20261001T000000Z \
  cmake ninja-build g++ pkg-config libsqlite3-dev clang-18 libbpf-dev libelf-dev zlib1g-dev \
  libgtk-3-0t64 libnss3 libxss1 libxtst6 libgbm1 libasound2t64 libatspi2.0-0t64 \
  libuuid1 libsecret-1-0 libnotify4 libfuse2t64 xdg-utils network-manager pkexec \
  xvfb xauth dbus-x11 rpm cpio dpkg-dev xz-utils
getconf GNU_LIBC_VERSION
pkg-config --modversion libbpf sqlite3
# Electron 的 sandbox helper 使用标准 setuid 配置；不使用 --no-sandbox。
