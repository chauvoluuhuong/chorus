#!/usr/bin/env bash
# Builds the chorus-linux-ime image (then run.sh, drive.sh): test/smoke/linux-ime/build.sh [<chorus-desktop linux binary>] [<node linux tarball>]
# Defaults: the release script's cached arm64 build (node_modules/.cache/chorus-release/desktop-linux-arm64/out/chorus-desktop of the
# main checkout) and its Node 22 tarball. Build the binary with `node scripts/release-downloads.mjs` if neither is there.
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
CACHE=${CHORUS_RELEASE_CACHE:-$HERE/../../../node_modules/.cache/chorus-release}
ARCH=$( [ "$(uname -m)" = x86_64 ] && echo x64 || echo arm64 )
BIN=${1:-$CACHE/desktop-linux-$ARCH/out/chorus-desktop}
NODE=${2:-$(ls "$CACHE"/node-v22*-linux-$ARCH.tar.xz | tail -1)}
CTX=$(mktemp -d)
trap 'rm -rf "$CTX"' EXIT
cp "$HERE/Dockerfile" "$HERE/inside.sh" "$CTX/"
cp "$BIN" "$CTX/chorus-desktop"
cp "$NODE" "$CTX/node.tar.xz"
docker build -t chorus-linux-ime "$CTX"
