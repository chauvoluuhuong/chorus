#!/bin/bash
# Chorus installer.
#   curl -fsSL https://chorus-cli.web.app/install.sh | bash
# macOS (Apple silicon): installs the `chorus` command (npm, from a tarball on this site) and Chorus.app
# (into /Applications, or ~/Applications when /Applications is not writable), then opens the app.
# Linux: installs the `chorus` command; `chorus desktop` opens the same window in the browser (no native
# Linux app yet). npm builds node-pty there, so it needs python3, make and a C++ compiler.
# Run it again to update.
# The files it downloads are written by scripts/release-downloads.mjs, which also sets VERSION below.
set -euo pipefail

VERSION="1.0.3"
BASE="${CHORUS_DOWNLOADS:-https://chorus-cli.web.app/dl}"
CLI_URL="$BASE/chorus-cli-$VERSION.tgz"
APP_URL="$BASE/Chorus-macOS-$VERSION.zip"

say() { printf '%s\n' "$*"; }
fail() { printf '\n✗ %s\n' "$*" >&2; exit 1; }

say ""
say "Chorus $VERSION"
say ""

OS="$(uname -s)"
case "$OS" in
  Darwin) [ "$(uname -m)" = "arm64" ] || fail "This build of Chorus needs a Mac with Apple silicon (M1 or later). Intel Macs are not supported yet." ;;
  Linux) ;;
  *) fail "Chorus runs on macOS and Linux. On Windows, use WSL." ;;
esac

# Node.js 22.18 or later: the chorus command runs on it.
if ! command -v node >/dev/null 2>&1 || ! command -v npm >/dev/null 2>&1; then
  fail "Chorus needs Node.js 22.18 or later. Install it (for example: brew install node, or https://nodejs.org), then run this command again."
fi
if ! node -e 'const [a,b]=process.versions.node.split(".").map(Number); process.exit(a>22||(a===22&&b>=18)?0:1)'; then
  fail "Chorus needs Node.js 22.18 or later; this Mac has $(node -v). Update Node.js, then run this command again."
fi

if [ "$OS" = "Linux" ]; then
  missing=""
  for t in python3 make; do command -v "$t" >/dev/null 2>&1 || missing="$missing $t"; done
  command -v c++ >/dev/null 2>&1 || command -v g++ >/dev/null 2>&1 || missing="$missing g++"
  if [ -n "$missing" ]; then
    hint="your package manager"
    command -v apt-get >/dev/null 2>&1 && hint="sudo apt-get install -y python3 make g++"
    command -v dnf >/dev/null 2>&1 && hint="sudo dnf install -y python3 make gcc-c++"
    command -v pacman >/dev/null 2>&1 && hint="sudo pacman -S --needed python make gcc"
    fail "Chorus needs build tools to install on Linux (missing:$missing). Install them with: $hint, then run this command again."
  fi
fi

STEPS=3; [ "$OS" = "Linux" ] && STEPS=1
say "1/$STEPS  Installing the chorus command…"
# Chorus 1.0.1 and earlier were the npm package "chorus-cli" (a name that belongs to someone else on npm): remove ours
# so the new package can own the `chorus` command; a different package of that name is left alone
# npm masks UUID-like text in its own output, so a prefix set in the environment is used as it is
PREFIX="${NPM_CONFIG_PREFIX:-${npm_config_prefix:-$(npm prefix -g)}}"
OLD="$PREFIX/lib/node_modules/chorus-cli/package.json"
if [ -f "$OLD" ] && grep -q '"Work across AI coding CLIs' "$OLD"; then
  npm uninstall -g --loglevel=error chorus-cli >/dev/null 2>&1 || true
fi
if ! npm install -g --no-fund --no-audit --loglevel=error "$CLI_URL"; then
  fail "npm could not install the chorus command. If it says EACCES (permission denied), see https://docs.npmjs.com/resolving-eacces-permissions-errors-when-installing-packages-globally and run this command again."
fi
command -v chorus >/dev/null 2>&1 || say "     Note: npm installed chorus in $PREFIX/bin, which is not on your PATH yet."

# the chorus npm just installed
CHORUS="$PREFIX/bin/chorus"
[ -x "$CHORUS" ] || CHORUS="$(command -v chorus || echo chorus)"

# The doctor: a few seconds, no model calls; it asks before installing a missing CLI or testing a new version
# (docs/doctor.md). It needs the terminal: with `curl … | bash` stdin is the script, so it reads /dev/tty.
doctor() {
  if [ -z "${CHORUS_NO_DOCTOR:-}" ] && (exec </dev/tty) 2>/dev/null; then
    "$CHORUS" doctor </dev/tty || true
  else
    "$CHORUS" doctor </dev/null || true
  fi
}

if [ "$OS" = "Linux" ]; then
  doctor
  say ""
  say "✓ The chorus command is installed."
  say "  chorus desktop   opens Chorus in your browser"
  say "  chorus           opens the same chats in this terminal"
  say "  Chorus uses the AI CLIs you already have: Claude Code (claude), Codex (codex) or Antigravity (agy)."
  say ""
  exit 0
fi

say "2/3  Installing Chorus.app…"
DEST="${CHORUS_APP_DIR:-/Applications}"   # CHORUS_APP_DIR: another folder, for testing the installer
[ -w "$DEST" ] || { DEST="$HOME/Applications"; mkdir -p "$DEST"; }
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
curl -fsSL "$APP_URL" -o "$TMP/Chorus.zip" || fail "Could not download $APP_URL"
pkill -f "$DEST/Chorus.app/Contents/MacOS/" 2>/dev/null || true
rm -rf "$DEST/Chorus.app"
ditto -x -k "$TMP/Chorus.zip" "$DEST"
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
say ""
