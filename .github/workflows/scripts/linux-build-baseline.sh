#!/usr/bin/env bash
set -euo pipefail
arch="$1"
[[ "$arch" == x64 || "$arch" == arm64 ]]
export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y --no-install-recommends ca-certificates tzdata curl cmake ninja-build g++ make pkg-config python3 clang-14 libelf-dev zlib1g-dev libsqlite3-dev binutils
test -s /usr/share/zoneinfo/Asia/Shanghai
mkdir -p /opt/wifimeter-deps/obj
curl --fail --location --retry 3 https://github.com/libbpf/libbpf/archive/refs/tags/v1.3.3.tar.gz -o /opt/wifimeter-deps/libbpf.tar.gz
echo 'cfb8bcb2aa7d8645c69a093841a4e5ed483855bf7e403c27054da2c15bc7bbde  /opt/wifimeter-deps/libbpf.tar.gz' | sha256sum --check
tar -xzf /opt/wifimeter-deps/libbpf.tar.gz -C /opt/wifimeter-deps
make -C /opt/wifimeter-deps/libbpf-1.3.3/src -j2 BUILD_STATIC_ONLY=1 OBJDIR=/opt/wifimeter-deps/obj DESTDIR=/opt/wifimeter-deps/install PREFIX=/usr LIBDIR=/usr/lib install
build_dir=build
[[ "$arch" == x64 ]] || build_dir="build/linux-$arch"
cmake -S backend -B "$build_dir" -G Ninja -DCMAKE_BUILD_TYPE=Release -DWIFIMETER_BUILD_TESTS=ON -DWIFIMETER_LINUX_APP_CAPTURE=ON \
  -DWIFIMETER_BPF_CLANG=/usr/bin/clang-14 \
  -DWIFIMETER_LIBBPF_INCLUDE_DIR=/opt/wifimeter-deps/install/usr/include \
  -DWIFIMETER_LIBBPF_LIBRARY=/opt/wifimeter-deps/install/usr/lib/libbpf.a
cmake --build "$build_dir" --parallel 2
ctest --test-dir "$build_dir" --output-on-failure --no-tests=error -E '^linux_app_capture_smoke$'
"$build_dir/app/wifimeter-backend" --version
for binary in "$build_dir/app/wifimeter-backend" "$build_dir/app/wifimeter-app-capture"; do
  max_glibc=$(readelf --version-info "$binary" | grep -oE 'GLIBC_[0-9]+\.[0-9]+' | sort -Vu | tail -1)
  [[ $(printf '%s\n' "${max_glibc#GLIBC_}" 2.35 | sort -V | tail -1) == 2.35 ]] || { echo "glibc baseline too new: $max_glibc"; exit 1; }
  ldd "$binary"
done
# The host builds packages from these exact binaries; it must not recompile with a newer libc.
chmod -R a+rX "$build_dir"
if [[ -n "${HOST_UID:-}" && -n "${HOST_GID:-}" ]]; then chown -R "$HOST_UID:$HOST_GID" "$build_dir"; fi
