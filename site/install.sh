#!/bin/bash
# Chorus installer.
#   curl -fsSL https://chorus-cli.web.app/install.sh | bash
# Downloads one ready-made package for this computer (macOS Apple silicon, Linux arm64 or x64). It carries its own Node.js and
# node-pty already built, so nothing has to be installed first: no Node.js, npm, sudo or compiler.
#   ~/.chorus/versions/<version>/   the package      ~/.chorus/current   the version in use
#   ~/.local/bin/chorus             the command (a link into current); ~/.local/bin is added to PATH in your shell's startup files
# macOS also gets Chorus.app (into /Applications, or ~/Applications when /Applications is not writable), which is then opened.
# Linux: `chorus desktop` opens the same window in the browser (no native Linux app yet).
# Run it again to update. Options (environment): CHORUS_INSTALL_DIR (default ~/.chorus), CHORUS_BIN_DIR (default ~/.local/bin),
# CHORUS_NO_MODIFY_PATH=1, CHORUS_NO_DOCTOR=1, CHORUS_NO_OPEN=1, CHORUS_APP_DIR, CHORUS_DOWNLOADS (another download address).
# The files it downloads are written by scripts/release-downloads.mjs, which also sets VERSION below.
set -euo pipefail

VERSION="1.0.4"
BASE="${CHORUS_DOWNLOADS:-https://chorus-cli.web.app/dl}"
ROOT="${CHORUS_INSTALL_DIR:-$HOME/.chorus}"
BIN="${CHORUS_BIN_DIR:-$HOME/.local/bin}"

say() { printf '%s\n' "$*"; }
fail() { printf '\n✗ %s\n' "$*" >&2; exit 1; }

say ""
say "Chorus $VERSION"
say ""

OS="$(uname -s)"
ARCH="$(uname -m)"
case "$OS-$ARCH" in
  Darwin-arm64) TARGET="darwin-arm64" ;;
  Darwin-*) fail "This build of Chorus needs a Mac with Apple silicon (M1 or later). Intel Macs are not supported yet." ;;
  Linux-aarch64|Linux-arm64) TARGET="linux-arm64" ;;
  Linux-x86_64|Linux-amd64) TARGET="linux-x64" ;;
  Linux-*) fail "Chorus runs on Linux x86_64 and arm64; this is $ARCH." ;;
  *) fail "Chorus runs on macOS and Linux. On Windows, use WSL." ;;
esac
if [ "$OS" = "Linux" ] && ls /lib/ld-musl-* /usr/lib/ld-musl-* >/dev/null 2>&1; then
  fail "This Linux uses musl (for example Alpine); Chorus needs a glibc system such as Ubuntu, Debian, Fedora or Arch."
fi
for t in curl tar; do command -v "$t" >/dev/null 2>&1 || fail "Chorus needs '$t' to install; install it with your package manager, then run this command again."; done

sha256() { if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | cut -d' ' -f1; else shasum -a 256 "$1" | cut -d' ' -f1; fi; }

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
# download a file of this release into $TMP and check it against SHA256SUMS
fetch() {
  local name="$1" want got
  curl -fSL --progress-bar "$BASE/$name" -o "$TMP/$name" || fail "Could not download $BASE/$name"
  want="$(awk -v f="$name" '$2 == f { print $1 }' "$TMP/SHA256SUMS")"
  [ -n "$want" ] || fail "$name is not listed in $BASE/SHA256SUMS"
  got="$(sha256 "$TMP/$name")"
  [ "$got" = "$want" ] || fail "$name did not download correctly (checksum differs). Run this command again."
}

STEPS=2; [ "$OS" = "Darwin" ] && STEPS=3
say "1/$STEPS  Installing the chorus command ($TARGET)…"
curl -fsSL "$BASE/SHA256SUMS" -o "$TMP/SHA256SUMS" || fail "Could not download $BASE/SHA256SUMS"
PKG="chorus-$TARGET-$VERSION.tar.gz"
fetch "$PKG"

mkdir -p "$ROOT/versions" "$BIN"
rm -rf "$ROOT/versions/$VERSION.new"
mkdir "$ROOT/versions/$VERSION.new"
tar -xzf "$TMP/$PKG" -C "$ROOT/versions/$VERSION.new" --strip-components 1 2> >(grep -v 'unknown extended header' >&2) || fail "Could not unpack $PKG"
rm -rf "$ROOT/versions/$VERSION"
mv "$ROOT/versions/$VERSION.new" "$ROOT/versions/$VERSION"
ln -sfn "versions/$VERSION" "$ROOT/current"
# older versions go, except the one before this
ls -1t "$ROOT/versions" 2>/dev/null | tail -n +3 | while read -r old; do rm -rf "$ROOT/versions/$old"; done

if [ -e "$BIN/chorus" ] && [ ! -L "$BIN/chorus" ]; then
  fail "$BIN/chorus exists and is not a link made by this installer. Move it away, then run this command again."
fi
ln -sf "$ROOT/current/bin/chorus" "$BIN/chorus"

# Chorus 1.0.3 and earlier came from npm (a global install): remove that copy so the old command does not come first on the PATH.
# A checkout linked with `npm link` (development) is a symlink and is left alone.
if command -v npm >/dev/null 2>&1; then
  NPM_PREFIX="${NPM_CONFIG_PREFIX:-${npm_config_prefix:-$(npm prefix -g 2>/dev/null || true)}}"
  for pkg in "@chauvoluuhuong/chorus" "chorus-cli"; do
    dir="$NPM_PREFIX/lib/node_modules/$pkg"
    if [ -n "$NPM_PREFIX" ] && [ -d "$dir" ] && [ ! -L "$dir" ] && grep -q '"Work across AI coding CLIs' "$dir/package.json" 2>/dev/null; then
      npm uninstall -g --loglevel=error "$pkg" >/dev/null 2>&1 || say "     Note: an older npm copy of Chorus is in $dir; remove it with: npm uninstall -g $pkg"
    fi
  done
fi

# put $BIN on the PATH for new terminals (and for Chorus.app, which asks a login shell for it)
if [ -z "${CHORUS_NO_MODIFY_PATH:-}" ]; then
  case "$BIN" in "$HOME"/*) BIN_EXPR="\$HOME/${BIN#"$HOME"/}" ;; *) BIN_EXPR="$BIN" ;; esac
  LINE="export PATH=\"$BIN_EXPR:\$PATH\"  # added by Chorus"
  case "$(basename "${SHELL:-/bin/sh}")" in
    zsh) RCS="$HOME/.zprofile $HOME/.zshrc" ;;
    bash) if [ -f "$HOME/.bash_profile" ]; then RCS="$HOME/.bashrc $HOME/.bash_profile"; else RCS="$HOME/.bashrc $HOME/.profile"; fi ;;
    *) RCS="$HOME/.profile" ;;
  esac
  for rc in $RCS; do
    grep -qs "# added by Chorus" "$rc" 2>/dev/null || printf '\n%s\n' "$LINE" >> "$rc"
  done
fi

CHORUS="$ROOT/current/bin/chorus"

# The doctor: a few seconds, no model calls; it asks before installing a missing CLI or testing a new version
# (docs/doctor.md). It needs the terminal: with `curl … | bash` stdin is the script, so it reads /dev/tty.
doctor() {
  if [ -z "${CHORUS_NO_DOCTOR:-}" ] && (exec </dev/tty) 2>/dev/null; then
    "$CHORUS" doctor </dev/tty || true
  else
    "$CHORUS" doctor </dev/null || true
  fi
}

finish() {
  if [ "$(command -v chorus 2>/dev/null || true)" != "$BIN/chorus" ]; then
    say "  To use chorus in this terminal now:  export PATH=\"$BIN:\$PATH\"   (new terminals have it already)"
  fi
}

if [ "$OS" = "Linux" ]; then
  say "2/2  Checking your AI CLIs…"
  doctor
  say ""
  say "✓ The chorus command is installed."
  say "  chorus desktop   opens Chorus in your browser"
  say "  chorus           opens the same chats in this terminal"
  say "  Chorus uses the AI CLIs you already have: Claude Code (claude), Codex (codex) or Antigravity (agy)."
  finish
  say ""
  exit 0
fi

say "2/3  Installing Chorus.app…"
DEST="${CHORUS_APP_DIR:-/Applications}"   # CHORUS_APP_DIR: another folder, for testing the installer
[ -w "$DEST" ] || { DEST="$HOME/Applications"; mkdir -p "$DEST"; }
APP_ZIP="Chorus-macOS-$VERSION.zip"
fetch "$APP_ZIP"
pkill -f "$DEST/Chorus.app/Contents/MacOS/" 2>/dev/null || true
rm -rf "$DEST/Chorus.app"
ditto -x -k "$TMP/$APP_ZIP" "$DEST"
xattr -dr com.apple.quarantine "$DEST/Chorus.app" 2>/dev/null || true

say "3/3  Checking your AI CLIs…"
doctor

if [ -z "${CHORUS_NO_OPEN:-}" ]; then
  say "Opening Chorus…"
  open "$DEST/Chorus.app"
fi

say ""
say "✓ Chorus is installed: $DEST/Chorus.app"
say "  Chorus uses the AI CLIs you already have: Claude Code (claude), Codex (codex) or Antigravity (agy)."
say "  In a terminal, \`chorus\` opens the same chats as the app."
finish
say ""
