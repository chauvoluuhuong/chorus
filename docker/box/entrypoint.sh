#!/usr/bin/env bash
# The Chorus box's start (docker/box/Dockerfile; plan docs/plans/2026-11-07-browser-everywhere-and-docker.md, part B):
#   1. as root: give the `chorus` user your user and group id (HOST_UID, HOST_GID: the launcher sets them on a Linux host, so files
#      the agents write in a shared folder stay yours), then drop to that user. Agents never run as root.
#   2. stable or preview: CHORUS_CHANNEL, else the answer kept in the volume, else asked once (docker run -it), else stable.
#   3. install Chorus with the official install.sh on that channel, or update it on later starts.
#   4. chorus serve --host 0.0.0.0 on CHORUS_PORT (4318), and print the address to open in your browser.
# Testing: CHORUS_INSTALL_URL (another install.sh), CHORUS_DOWNLOADS (another download address, read by install.sh).
set -euo pipefail

if [ "$(id -u)" = 0 ]; then
  if [ -n "${HOST_GID:-}" ] && [ "$HOST_GID" != "$(id -g chorus)" ]; then groupmod -o -g "$HOST_GID" chorus; fi
  if [ -n "${HOST_UID:-}" ] && [ "$HOST_UID" != "$(id -u chorus)" ]; then usermod -o -u "$HOST_UID" chorus; fi
  # the home volume: Chorus, its data and the CLIs' sign-ins (only what is not ours yet, so a restart stays quick)
  find /home/chorus -xdev \( ! -user chorus -o ! -group chorus \) -exec chown -h chorus:chorus {} + 2>/dev/null || true
  exec setpriv --reuid=chorus --regid=chorus --init-groups env HOME=/home/chorus USER=chorus LOGNAME=chorus "$0" "$@"
fi

say() { printf '%s\n' "$*"; }
STATE="$HOME/.chorus-box"
mkdir -p "$STATE"
PORT="${CHORUS_PORT:-4318}"
NAME="${CHORUS_BOX_NAME:-chorus}"
CHORUS="$HOME/.chorus/current/bin/chorus"

# 2. the channel
CHANNEL="${CHORUS_CHANNEL:-}"
if [ -z "$CHANNEL" ] && [ -f "$STATE/channel" ]; then CHANNEL="$(cat "$STATE/channel")"; fi
if [ -z "$CHANNEL" ] && [ -t 0 ] && [ -t 1 ]; then
  say ""
  say "Which Chorus do you want?"
  say "  1) Stable   the released version (recommended)"
  say "  2) Preview  every change as soon as it's merged; it can break"
  read -r -p "Choose 1 or 2 [1]: " answer || answer=""
  case "$answer" in 2|p|preview|Preview) CHANNEL=preview ;; *) CHANNEL=production ;; esac
fi
case "${CHANNEL:-production}" in
  preview) CHANNEL=preview ;;
  production|stable|"") CHANNEL=production ;;
  *) say "CHORUS_CHANNEL is $CHANNEL; it can be stable (production) or preview."; exit 2 ;;
esac
printf '%s\n' "$CHANNEL" > "$STATE/channel"

# 3. install or update on that channel
say ""
say "Chorus box: $([ "$CHANNEL" = preview ] && echo preview || echo stable) channel. AI CLIs: Claude Code ${CHORUS_BOX_CLAUDE:-?}, Codex ${CHORUS_BOX_CODEX:-?}, Antigravity ${CHORUS_BOX_AGY:-?}."
if ! curl -fsSL "${CHORUS_INSTALL_URL:-https://chorus-cli.web.app/install.sh}" | CHORUS_CHANNEL="$CHANNEL" CHORUS_NO_OPEN=1 CHORUS_NO_MODIFY_PATH=1 bash; then
  if [ -x "$CHORUS" ]; then say "Could not update Chorus (offline?); starting the version already here."
  else say "Could not install Chorus. Check this computer's internet connection and start the box again."; exit 1
  fi
fi

# 4. serve for your browser. The folder the box starts in: the first shared folder (CHORUS_SHARED, set by the launcher), else home.
SHARED="${CHORUS_SHARED:-}"
FIRST="${SHARED%%:*}"
if [ -n "$FIRST" ] && [ -d "$FIRST" ]; then cd "$FIRST"; fi
OUT="$STATE/serve.out"
: > "$OUT"
"$CHORUS" serve --host 0.0.0.0 --port "$PORT" > >(tee -a "$OUT") 2>&1 &
pid=$!
trap 'kill -TERM "$pid" 2>/dev/null; wait "$pid"' TERM INT HUP

for _ in $(seq 1 60); do
  grep -q '^chorus serve: ' "$OUT" 2>/dev/null && break
  kill -0 "$pid" 2>/dev/null || break
  sleep 0.5
done
URL="$(sed -n 's/^chorus serve: //p' "$OUT" | head -1)"
if [ -n "$URL" ]; then
  say ""
  if ! grep -q '^Listening on 0.0.0.0' "$OUT"; then
    say "This Chorus version can't be reached from outside the box yet (it needs serve --host). Choose preview:"
    say "  docker rm -f $NAME, then start the box again with preview."
  fi
  say "Open Chorus in your browser:"
  say "  $URL"
  say ""
  say "Sign in the AI CLIs from your computer's terminal:"
  say "  docker exec -it -u chorus $NAME claude auth login"
  say "  docker exec -it -u chorus $NAME codex login --device-auth"
  say "  docker exec -it -u chorus $NAME agy"
  say "The address again: docker logs $NAME"
  [ -n "$SHARED" ] && say "Shared with the box: ${SHARED//:/, }"
fi
wait "$pid"
