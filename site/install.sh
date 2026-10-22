#!/bin/bash
# Chorus installer.
#   curl -fsSL https://chorus-cli.web.app/install.sh | bash
# Installs the `chorus` command (npm, from a tarball on this site) and Chorus.app (into /Applications,
# or ~/Applications when /Applications is not writable), then opens the app. Run it again to update.
# The files it downloads are written by scripts/release-downloads.mjs, which also sets VERSION below.
set -euo pipefail

VERSION="1.0.0"
BASE="${CHORUS_DOWNLOADS:-https://chorus-cli.web.app/dl}"
CLI_URL="$BASE/chorus-cli-$VERSION.tgz"
APP_URL="$BASE/Chorus-macOS-$VERSION.zip"

say() { printf '%s\n' "$*"; }
fail() { printf '\n✗ %s\n' "$*" >&2; exit 1; }

say ""
say "Chorus $VERSION"
say ""

[ "$(uname -s)" = "Darwin" ] || fail "Chorus runs on macOS only for now."
[ "$(uname -m)" = "arm64" ] || fail "This build of Chorus needs a Mac with Apple silicon (M1 or later). Intel Macs are not supported yet."

# Node.js 22.18 or later: the chorus command runs on it.
if ! command -v node >/dev/null 2>&1 || ! command -v npm >/dev/null 2>&1; then
  fail "Chorus needs Node.js 22.18 or later. Install it (for example: brew install node, or https://nodejs.org), then run this command again."
fi
if ! node -e 'const [a,b]=process.versions.node.split(".").map(Number); process.exit(a>22||(a===22&&b>=18)?0:1)'; then
  fail "Chorus needs Node.js 22.18 or later; this Mac has $(node -v). Update Node.js, then run this command again."
fi

say "1/3  Installing the chorus command…"
if ! npm install -g --no-fund --no-audit --loglevel=error "$CLI_URL"; then
  fail "npm could not install the chorus command. If it says EACCES (permission denied), see https://docs.npmjs.com/resolving-eacces-permissions-errors-when-installing-packages-globally and run this command again."
fi
command -v chorus >/dev/null 2>&1 || say "     Note: npm installed chorus in $(npm prefix -g)/bin, which is not on your PATH yet."

say "2/3  Installing Chorus.app…"
DEST="/Applications"
[ -w "$DEST" ] || { DEST="$HOME/Applications"; mkdir -p "$DEST"; }
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
curl -fsSL "$APP_URL" -o "$TMP/Chorus.zip" || fail "Could not download $APP_URL"
pkill -f "$DEST/Chorus.app/Contents/MacOS/" 2>/dev/null || true
rm -rf "$DEST/Chorus.app"
ditto -x -k "$TMP/Chorus.zip" "$DEST"
xattr -dr com.apple.quarantine "$DEST/Chorus.app" 2>/dev/null || true

say "3/3  Opening Chorus…"
open "$DEST/Chorus.app"

say ""
say "✓ Chorus is installed: $DEST/Chorus.app"
say "  Chorus uses the AI CLIs you already have: Claude Code (claude), Codex (codex) or Antigravity (agy)."
say "  In a terminal, \`chorus\` opens the same chats as the app."
say ""
