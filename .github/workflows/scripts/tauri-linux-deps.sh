#!/usr/bin/env bash
set -euo pipefail

mode="${1:-all}"
case "$mode" in all|system|libbpf) ;; *) echo "Unsupported Linux dependency mode: $mode" >&2; exit 1 ;; esac

# Ubuntu 22.04 provides WebKitGTK 4.1 and keeps the release glibc baseline at 2.35.
# https://v2.tauri.app/start/prerequisites/#linux
if [[ "$mode" != libbpf ]]; then
  sudo install -d -m 700 /etc/NetworkManager/system-connections
  sudo apt-get update
  sudo apt-get install -y --no-install-recommends \
    ca-certificates curl wget file cmake ninja-build g++ make pkg-config python3 clang-14 \
    libsqlite3-dev libelf-dev zlib1g-dev libwebkit2gtk-4.1-dev libxdo-dev libssl-dev \
    libayatana-appindicator3-dev librsvg2-dev patchelf libfuse2 squashfs-tools \
    libnss3 libxss1 libxtst6 libgbm1 libasound2 libatspi2.0-0 libsecret-1-0 libnotify4 \
    xdg-utils network-manager policykit-1 xvfb xauth dbus-x11 webkit2gtk-driver wmctrl openbox \
    rpm cpio dpkg-dev xz-utils libarchive-tools
fi
if [[ "$mode" == system ]]; then exit 0; fi

# Use the same fixed static libbpf dependency as the existing Linux compatibility build.
dependency_dir="$RUNNER_TEMP/tauri-native-deps"
cache_helper=.github/workflows/scripts/tauri-linux-cache.cjs
if node "$cache_helper" libbpf "$dependency_dir/install"; then
  echo 'Using the verified libbpf installation cache.'
else
  node "$cache_helper" archive "$dependency_dir"
  mkdir -p "$dependency_dir/obj"
  archive="$dependency_dir/libbpf.tar.gz"
  libbpf_version=$(node -p "require('./$cache_helper').libbpfVersion")
  libbpf_sha256=$(node -p "require('./$cache_helper').libbpfSha256")
  curl --fail --location --retry 3 "https://github.com/libbpf/libbpf/archive/refs/tags/v$libbpf_version.tar.gz" -o "$archive"
  echo "$libbpf_sha256  $archive" | sha256sum --check
  tar -xzf "$archive" -C "$dependency_dir"
  make -C "$dependency_dir/libbpf-$libbpf_version/src" -j2 CC=gcc AR=ar LD=ld BUILD_STATIC_ONLY=1 OBJDIR="$dependency_dir/obj" \
    DESTDIR="$dependency_dir/install" PREFIX=/usr LIBDIR=/usr/lib install
  node "$cache_helper" libbpf "$dependency_dir/install"
fi
printf 'TAURI_LIBBPF_INCLUDE=%s/install/usr/include\nTAURI_LIBBPF_LIBRARY=%s/install/usr/lib/libbpf.a\n' \
  "$dependency_dir" "$dependency_dir" >> "$GITHUB_ENV"
getconf GNU_LIBC_VERSION
pkg-config --modversion webkit2gtk-4.1 sqlite3
