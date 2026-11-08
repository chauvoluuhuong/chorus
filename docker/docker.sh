#!/usr/bin/env bash
# Chorus in a Docker box, opened in your browser (macOS and Linux). Served by the website next to install.sh:
#   curl -fsSL https://chorus-cli.web.app/docker.sh | bash                    (add -s -- --preview for preview)
# Asks three things (stable or preview, the folder to share, the port), then starts ghcr.io/chauvoluuhuong/chorus-box. Run it again to
# open Chorus again: the box is started if it is stopped, and nothing is asked. To start over: docker rm -f chorus
# Plan: docs/plans/2026-11-07-browser-everywhere-and-docker.md, part B. The image: docker/box/.
# Options (environment): CHORUS_CHANNEL=stable|preview, CHORUS_SHARE (folder, or several joined by ':'), CHORUS_PORT, CHORUS_NAME
# (default chorus), CHORUS_VOLUME (the box's home, default chorus-home), CHORUS_NO_OPEN=1, CHORUS_BOX_IMAGE (another image), CHORUS_BOX_DOCKER_ARGS (more `docker run` arguments, for testing).
set -euo pipefail

IMAGE="${CHORUS_BOX_IMAGE:-ghcr.io/chauvoluuhuong/chorus-box:latest}"
NAME="${CHORUS_NAME:-chorus}"
VOLUME="${CHORUS_VOLUME:-chorus-home}"
say() { printf '%s\n' "$*"; }
fail() { printf '\n✗ %s\n' "$*" >&2; exit 1; }

CHANNEL="${CHORUS_CHANNEL:-}"
for arg in "$@"; do
  case "$arg" in
    --preview) CHANNEL=preview ;;
    *) fail "Unknown option $arg. The only option is --preview." ;;
  esac
done

command -v docker >/dev/null 2>&1 || fail "Docker is not installed. Install Docker Desktop (https://docs.docker.com/get-docker/) or Docker Engine, then run this again."
docker info >/dev/null 2>&1 || fail "Docker is installed but not running. Start Docker Desktop (or the docker service), then run this again."

# questions come from the terminal even when this script is piped from curl; no terminal: the defaults
TTY=""
if [ -r /dev/tty ] && [ -w /dev/tty ] && { : < /dev/tty; } 2>/dev/null; then TTY=/dev/tty; fi
ask() { # ask <question> <default> → the answer, or the default on Enter or with no terminal
  local reply=""
  if [ -n "$TTY" ]; then printf '%s' "$1" > "$TTY"; IFS= read -r reply < "$TTY" || reply=""; fi
  printf '%s' "${reply:-$2}"
}

open_url() {
  [ -n "${CHORUS_NO_OPEN:-}" ] && return 0
  if command -v open >/dev/null 2>&1 && [ "$(uname -s)" = Darwin ]; then open "$1" >/dev/null 2>&1 || true
  elif command -v xdg-open >/dev/null 2>&1 && { [ -n "${DISPLAY:-}" ] || [ -n "${WAYLAND_DISPLAY:-}" ]; }; then xdg-open "$1" >/dev/null 2>&1 || true
  fi
}

# the address the box printed in this run (the log keeps earlier runs, whose token is gone); waits for it after a start
address() {
  local url="" i since
  since="$(docker inspect -f '{{.State.StartedAt}}' "$NAME")"
  for i in $(seq 1 240); do
    url="$(docker logs --since "$since" "$NAME" 2>&1 | sed -n 's/^chorus serve: //p' | tail -1)"
    [ -n "$url" ] && break
    [ "$(docker inspect -f '{{.State.Running}}' "$NAME" 2>/dev/null)" = true ] || break
    sleep 0.5
  done
  printf '%s' "$url"
}

show() {
  local url port
  url="$(address)"
  [ -n "$url" ] || { docker logs --tail 30 "$NAME" >&2 || true; fail "The box did not start Chorus. Its log is above (docker logs $NAME)."; }
  # the port this computer reaches it on (the same number inside and out)
  port="$(docker port "$NAME" 2>/dev/null | sed -n 's/.*127\.0\.0\.1:\([0-9]*\).*/\1/p' | head -1)"
  [ -n "$port" ] && url="$(printf '%s' "$url" | sed "s#^http://127\.0\.0\.1:[0-9]*#http://127.0.0.1:$port#")"
  say ""
  say "✓ Chorus is running in the box \"$NAME\". Open it in your browser:"
  say "  $url"
  say ""
  say "  Sign in the AI CLIs from this terminal:"
  say "    docker exec -it -u chorus $NAME claude auth login"
  say "    docker exec -it -u chorus $NAME codex login --device-auth"
  say "    docker exec -it -u chorus $NAME agy"
  say "  Stop: docker stop $NAME   ·   Open again: run this command again   ·   Start over: docker rm -f $NAME"
  open_url "$url"
}

# already made: start it if stopped, and show the address; nothing is asked again
if docker container inspect "$NAME" >/dev/null 2>&1; then
  if [ "$(docker inspect -f '{{.State.Running}}' "$NAME")" != true ]; then
    say "Starting the Chorus box \"$NAME\"…"
    docker start "$NAME" >/dev/null
  fi
  show
  exit 0
fi

say ""
say "Chorus in a Docker box: three questions (press Enter for the default)."
say ""

# 1. stable or preview
if [ -z "$CHANNEL" ]; then
  case "$(ask "1. Stable or preview? Preview gets every change as soon as it's merged and can break. [stable]: " stable)" in
    p|P|preview|Preview|2) CHANNEL=preview ;;
    *) CHANNEL=stable ;;
  esac
fi
case "$CHANNEL" in preview) ;; stable|production) CHANNEL=stable ;; *) fail "CHORUS_CHANNEL is $CHANNEL; it can be stable or preview." ;; esac

# 2. the folders to share: each appears inside the box at the same path
FOLDERS=()
add_folder() {
  local f="${1/#\~/$HOME}"
  [ -d "$f" ] || { say "   $f is not a folder; skipped."; return 1; }
  f="$(cd "$f" && pwd -P)"
  FOLDERS+=("$f")
}
if [ -n "${CHORUS_SHARE:-}" ]; then
  IFS=':' read -r -a given <<< "$CHORUS_SHARE"
  for f in "${given[@]}"; do add_folder "$f" || true; done
else
  until add_folder "$(ask "2. Folder to share with the agents [$HOME]: " "$HOME")"; do :; done
  while [ -n "$TTY" ]; do
    more="$(ask "   Share another folder? (Enter for no): " "")"
    [ -z "$more" ] && break
    add_folder "$more" || true
  done
fi
[ "${#FOLDERS[@]}" -gt 0 ] || fail "No folder to share."
for f in "${FOLDERS[@]}"; do
  if [ "$f" = "$(cd "$HOME" && pwd -P)" ]; then
    say "   Note: the agents can read and change anything in your home folder, keys and settings files included."
    say "   A projects folder is safer: docker rm -f $NAME, then run this again and choose one."
  fi
done

# 3. the port, on this computer only
free() { ! (exec 3<>"/dev/tcp/127.0.0.1/$1") 2>/dev/null; }
PORT="${CHORUS_PORT:-}"
if [ -z "$PORT" ]; then
  default=4318
  while ! free "$default"; do default=$((default + 1)); done
  PORT="$(ask "3. Port [$default]: " "$default")"
fi
case "$PORT" in ''|*[!0-9]*) fail "The port must be a number, like 4318." ;; esac
free "$PORT" || fail "Port $PORT is in use on this computer. Run this again and choose another."

say ""
say "Getting the box ($IMAGE)…"
docker pull "$IMAGE" >/dev/null 2>&1 || docker image inspect "$IMAGE" >/dev/null 2>&1 || fail "Could not download $IMAGE. Check your internet connection."

ARGS=(run -d --name "$NAME" -p "127.0.0.1:$PORT:$PORT" -v "$VOLUME:/home/chorus" -e "CHORUS_PORT=$PORT" -e "CHORUS_BOX_NAME=$NAME")
[ "$CHANNEL" = preview ] && ARGS+=(-e CHORUS_CHANNEL=preview) || ARGS+=(-e CHORUS_CHANNEL=production)
SHARED=""
for f in "${FOLDERS[@]}"; do ARGS+=(-v "$f:$f"); SHARED="${SHARED:+$SHARED:}$f"; done
ARGS+=(-e "CHORUS_SHARED=$SHARED")
# Linux: the box works as your user, so files the agents write stay yours (Docker Desktop on a Mac maps them already)
[ "$(uname -s)" = Linux ] && ARGS+=(-e "HOST_UID=$(id -u)" -e "HOST_GID=$(id -g)")
# shellcheck disable=SC2206
[ -n "${CHORUS_BOX_DOCKER_ARGS:-}" ] && ARGS+=(${CHORUS_BOX_DOCKER_ARGS})
docker "${ARGS[@]}" "$IMAGE" >/dev/null
say "Installing Chorus ($CHANNEL) in the box; the first start takes a minute…"
show
