#!/usr/bin/env bash
# Chorus in a Docker box, opened in your browser (macOS and Linux). Served by the website next to install.sh:
#   curl -fsSL https://chorus-cli.web.app/docker.sh | bash                    (add -s -- --preview for preview)
#   curl -fsSL https://chorus-cli.web.app/docker.sh | bash -s -- --update     (the newest box and Chorus, for a box you have)
# The first time it asks two things (stable or preview, the folders to share), picks a free port and starts
# ghcr.io/chauvoluuhuong/chorus-box. Run it again to open Chorus again: a stopped box is started; nothing is asked or updated.
# --update gets the newest box image (with the AI CLIs) and the newest Chorus on the box's channel, and keeps its folders, port and
# home (Chorus's data and the sign-ins); with --preview or --stable it also switches the channel. To start over: docker rm -f chorus
# Feature: docs/features/docker-box.md. The image: docker/box/.
# Options (environment): CHORUS_CHANNEL=stable|preview, CHORUS_UPDATE=1 (as --update), CHORUS_SHARE (folder, or several joined by
# ':'), CHORUS_PORT, CHORUS_NAME (default chorus), CHORUS_VOLUME (the box's home, default chorus-home), CHORUS_NO_OPEN=1,
# CHORUS_BOX_IMAGE (another image), CHORUS_BOX_DOCKER_ARGS (more `docker run` arguments, for testing).
set -euo pipefail

IMAGE="${CHORUS_BOX_IMAGE:-ghcr.io/chauvoluuhuong/chorus-box:latest}"
NAME="${CHORUS_NAME:-chorus}"
VOLUME="${CHORUS_VOLUME:-chorus-home}"
say() { printf '%s\n' "$*"; }
fail() { printf '\n✗ %s\n' "$*" >&2; exit 1; }
DISK_FULL="Docker's disk is full. See what uses it with: docker system df. Free space with docker builder prune and docker image prune (Docker can download or build those again), or give Docker Desktop more disk in Settings → Resources. Then run this again."

# stable and production are one channel (the box's environment says production); '' is "not chosen"
channel() {
  case "$1" in
    preview) echo preview ;;
    stable|production) echo stable ;;
    '') echo '' ;;
    *) fail "CHORUS_CHANNEL is $1; it can be stable or preview." ;;
  esac
}
CHANNEL="$(channel "${CHORUS_CHANNEL:-}")"
UPDATE="${CHORUS_UPDATE:-}"
for arg in "$@"; do
  case "$arg" in
    --preview) CHANNEL=preview ;;
    --stable) CHANNEL=stable ;;
    --update) UPDATE=1 ;;
    *) fail "Unknown option $arg. The options are --update, --preview and --stable." ;;
  esac
done

command -v docker >/dev/null 2>&1 || fail "Docker is not installed. Install Docker Desktop (https://docs.docker.com/get-docker/) or Docker Engine, then run this again."
if ! info="$(docker info 2>&1)"; then
  case "$info" in
    *"permission denied"*) fail "Docker is running, but this user may not use it. Add yourself to the docker group (sudo usermod -aG docker \$USER, then log out and back in), then run this again." ;;
  esac
  fail "Docker is installed but not running. Start Docker Desktop (or the docker service), then run this again."
fi

# questions come from the terminal even when this script is piped from curl; no terminal: the defaults
TTY=""
if [ -r /dev/tty ] && [ -w /dev/tty ] && { : < /dev/tty; } 2>/dev/null; then TTY=/dev/tty; fi
ask() { # ask <question> <default> → the answer, or the default on Enter or with no terminal
  local reply=""
  # -e: line editing (arrow keys, backspace, Tab completes folder paths); the prompt goes to the terminal, not to the answer
  if [ -n "$TTY" ]; then IFS= read -e -r -p "$1" reply < "$TTY" 2> "$TTY" || reply=""; fi
  # whatever escape sequences a terminal without line editing let through
  reply="$(printf '%s' "$reply" | LC_ALL=C sed 's/\x1b\[[0-9;]*[A-Za-z]//g; s/^[[:space:]]*//; s/[[:space:]]*$//')"
  printf '%s' "${reply:-$2}"
}

open_url() {
  [ -n "${CHORUS_NO_OPEN:-}" ] && return 0
  if command -v open >/dev/null 2>&1 && [ "$(uname -s)" = Darwin ]; then open "$1" >/dev/null 2>&1 || true
  elif command -v xdg-open >/dev/null 2>&1 && { [ -n "${DISPLAY:-}" ] || [ -n "${WAYLAND_DISPLAY:-}" ]; }; then xdg-open "$1" >/dev/null 2>&1 || true
  fi
}

running() { [ "$(docker inspect -f '{{.State.Running}}' "$NAME" 2>/dev/null)" = true ]; }
# a variable the box was made with (docker run -e)
env_of() { docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' "$NAME" 2>/dev/null | sed -n "s/^$1=//p" | head -1; }
# the Chorus version installed in the box, like 2.7.0 ('' when the box is stopped or has none yet)
box_version() { docker exec "$NAME" readlink /home/chorus/.chorus/current 2>/dev/null | sed 's#.*/##' || true; }

# the newest box image; an older copy is used, with a warning, when the download fails
get_image() {
  say ""
  say "Getting the newest box ($IMAGE)…"
  if docker pull "$IMAGE"; then return 0; fi
  if docker image inspect "$IMAGE" >/dev/null 2>&1; then
    say ""
    say "⚠ Could not download the newest box; using the copy from $(docker image inspect -f '{{.Created}}' "$IMAGE" | cut -c1-10)."
    say "  Check the internet connection and Docker's free disk space (docker system df)."
  else
    fail "Could not download $IMAGE. Check the internet connection and Docker's free disk space (docker system df), then run this again."
  fi
}

# the address the box printed since <since> (the log keeps earlier runs, whose token is gone); waits while the box is starting
address() {
  local url="" i
  for i in $(seq 1 1200); do
    url="$(docker logs --since "$1" "$NAME" 2>&1 | sed -n 's/^chorus serve: //p' | tail -1)"
    [ -n "$url" ] && break
    running || break
    [ $((i % 120)) -eq 0 ] && say "  Still starting after $((i / 2)) s (docker logs $NAME shows what it is doing)…" >&2
    sleep 0.5
  done
  printf '%s' "$url"
}

show() {
  local url port lan since log version
  since="$(docker inspect -f '{{.State.StartedAt}}' "$NAME")"
  url="$(address "$since")"
  if [ -z "$url" ]; then
    log="$(docker logs --since "$since" "$NAME" 2>&1 | tail -30 || true)"
    printf '%s\n' "$log" >&2
    case "$log" in *"No space left on device"*) fail "$DISK_FULL" ;; esac
    if running; then fail "Chorus did not start in the box within 10 minutes. Its log is above (docker logs $NAME)."; fi
    fail "The box stopped before Chorus started. Its log is above (docker logs $NAME)."
  fi
  # the port this computer reaches it on (the same number inside and out)
  port="$(docker port "$NAME" 2>/dev/null | sed -n 's/.*:\([0-9][0-9]*\)$/\1/p' | head -1)"
  [ -n "$port" ] && url="$(printf '%s' "$url" | sed "s#^http://127\.0\.0\.1:[0-9]*#http://127.0.0.1:$port#")"
  # this computer's network address, for another computer's browser
  lan="$( (ipconfig getifaddr en0 || ipconfig getifaddr en1 || hostname -I | awk '{print $1}') 2>/dev/null | head -1)"
  version="$(box_version)"
  say ""
  say "✓ Chorus${version:+ $version} is running in the box \"$NAME\". Open it in your browser:"
  say "  $url"
  [ -n "$lan" ] && say "  From another computer: $(printf '%s' "$url" | sed "s#127\.0\.0\.1#$lan#")"
  say ""
  say "  Sign in to Claude Code, Codex and Antigravity in Chorus: click Log in next to each one."
  say "  Stop: docker stop $NAME   ·   Open again: run this command again   ·   Update: add --update   ·   Start over: docker rm -f $NAME"
  open_url "$url"
}

# makes the box from PORT, CHANNEL, FOLDERS and VOLUME
run_box() {
  local args shared="" f
  args=(run -d --name "$NAME" -p "$PORT:$PORT" -v "$VOLUME:/home/chorus" -e "CHORUS_PORT=$PORT" -e "CHORUS_BOX_NAME=$NAME")
  if [ "$CHANNEL" = preview ]; then args+=(-e CHORUS_CHANNEL=preview); else args+=(-e CHORUS_CHANNEL=production); fi
  for f in ${FOLDERS[@]+"${FOLDERS[@]}"}; do args+=(-v "$f:$f"); shared="${shared:+$shared:}$f"; done
  args+=(-e "CHORUS_SHARED=$shared")
  # Linux: the box works as your user, so files the agents write stay yours (Docker Desktop on a Mac maps them already)
  if [ "$(uname -s)" = Linux ]; then args+=(-e "HOST_UID=$(id -u)" -e "HOST_GID=$(id -g)"); fi
  # shellcheck disable=SC2206
  if [ -n "${CHORUS_BOX_DOCKER_ARGS:-}" ]; then args+=(${CHORUS_BOX_DOCKER_ARGS}); fi
  docker "${args[@]}" "$IMAGE" >/dev/null || fail "Docker could not start the box (its message is above)."
}

# --update on a box that exists: the newest image (the box is made again from it, same settings) or, when it has the newest image
# already, a restart, which installs the newest Chorus on its channel (docker/box/entrypoint.sh)
update_box() {
  local have="$1" before="" after old new
  running && before="$(box_version)"
  CHANNEL="${CHANNEL:-$have}"
  old="$(docker inspect -f '{{.Image}}' "$NAME")"
  get_image
  new="$(docker image inspect -f '{{.Id}}' "$IMAGE")"
  if [ "$new" != "$old" ] || [ "$CHANNEL" != "$have" ]; then
    PORT="$(env_of CHORUS_PORT)"; PORT="${PORT:-4318}"
    VOLUME="$(docker inspect -f '{{range .Mounts}}{{if eq .Destination "/home/chorus"}}{{if .Name}}{{.Name}}{{else}}{{.Source}}{{end}}{{end}}{{end}}' "$NAME")"
    IFS=':' read -r -a FOLDERS <<< "$(env_of CHORUS_SHARED)"
    say ""
    if [ "$new" != "$old" ]; then say "Making the box \"$NAME\" again from the newest image, on the $CHANNEL channel…"
    else say "Making the box \"$NAME\" again on the $CHANNEL channel…"; fi
    say "  Kept: its home ($VOLUME: Chorus's data and the sign-ins), port $PORT and shared folders. Chats running in it stop."
    docker rm -f "$NAME" >/dev/null
    run_box
    # the old image, unless another box still uses it: 2 GB each, and a full disk stops the box (2026-11-19)
    if [ "$new" != "$old" ]; then docker image rm "$old" >/dev/null 2>&1 || true; fi
  else
    say ""
    say "The box has the newest image. Restarting it to install the newest Chorus ($CHANNEL); chats running in it stop…"
    docker restart "$NAME" >/dev/null
  fi
  show
  after="$(box_version)"
  if [ -n "$before" ] && [ "$before" != "$after" ]; then say "  Updated Chorus $before → $after."
  else say "  Chorus $after is the newest on the $CHANNEL channel."; fi
}

# a box that exists: open it (start it if stopped), or update it with --update; nothing is asked
if docker container inspect "$NAME" >/dev/null 2>&1; then
  HAVE="$(channel "$(env_of CHORUS_CHANNEL)")"; HAVE="${HAVE:-stable}"
  if [ -n "$UPDATE" ]; then update_box "$HAVE"; exit 0; fi
  if [ -n "$CHANNEL" ] && [ "$CHANNEL" != "$HAVE" ]; then
    say "The box \"$NAME\" is on the $HAVE channel. To switch it to $CHANNEL, run this again with: --update --$CHANNEL"
  fi
  if ! running; then
    say "Starting the Chorus box \"$NAME\"…"
    docker start "$NAME" >/dev/null
  fi
  show
  exit 0
fi
[ -n "$UPDATE" ] && say "There is no box \"$NAME\" yet: making one."

# yes <question>: true for yes (Enter, y, yes), false for no (n, no); asks again otherwise. No terminal: yes.
yes() {
  local a
  while :; do
    a="$(ask "$1 [Y/n] " y)"
    case "$a" in [Yy]|[Yy][Ee][Ss]) return 0 ;; [Nn]|[Nn][Oo]) return 1 ;; *) say "   Type y for yes or n for no (Enter is yes)." ;; esac
  done
}

say ""
say "Chorus in a Docker box. A few yes/no questions: Enter means yes."
say ""
N=0  # questions are numbered as they are asked (--preview skips the first)

# 1. stable or preview
if [ -z "$CHANNEL" ]; then
  say "$((N += 1)). Which version of Chorus?"
  say "   Stable is the released version. Preview has every change as soon as it's merged, and can break."
  if yes "   Use the stable version?"; then CHANNEL=stable; else CHANNEL=preview; fi
  say ""
fi
say "   Chorus version: $CHANNEL"
say ""

# 2. the folders to share: each appears inside the box at the same path
FOLDERS=()
HOME_REAL="$(cd "$HOME" && pwd -P)"
add_folder() {
  local f="${1/#\~/$HOME}"
  [ -n "$f" ] && [ -d "$f" ] || { say "   \"$1\" is not a folder on this computer. Type a folder's path (Tab completes it)."; return 1; }
  f="$(cd "$f" && pwd -P)"
  FOLDERS+=("$f")
}
# browse: a folder browser drawn in the terminal, so it works the same on macOS, Linux (a server over SSH too) and WSL; it only needs
# the terminal (bash 3.2 or later, ANSI codes). Starts at <dir> with "Share this folder" selected, so Enter right away shares it.
# ↑↓ move · Enter or → open (or choose) · ← up · / type a path · a letter jumps to it. Prints the chosen folder. (owner, 2026-11-19)
browse() {
  local dir="$1" sel=0 top=0 drawn=0 key rest i n size rows cols line name path
  local -a items
  # the terminal's size; a terminal that reports none (0 0) gets 24 x 80
  size="$(stty size < "$TTY" 2>/dev/null || true)"
  case "$size" in [1-9]*\ [1-9]*) ;; *) size='24 80' ;; esac
  rows=$(( ${size% *} - 8 )); [ "$rows" -gt 12 ] && rows=12; [ "$rows" -lt 3 ] && rows=3
  cols=$(( ${size#* } - 1 )); [ "$cols" -lt 30 ] && cols=30
  printf '\033[?25l' > "$TTY"
  while :; do
    # the entries: choose, up, then the folders here (hidden ones left out: type / for them)
    items=("✓ Share this folder" "..")
    while IFS= read -r line; do items+=("${line##*/}/"); done < <(find "$dir" -mindepth 1 -maxdepth 1 -type d ! -name '.*' 2>/dev/null | LC_ALL=C sort -f)
    n=${#items[@]}
    [ "$sel" -ge "$n" ] && sel=$((n - 1))
    [ "$sel" -lt "$top" ] && top=$sel
    [ "$sel" -ge $((top + rows)) ] && top=$((sel - rows + 1))
    # draw over the previous drawing
    [ "$drawn" -gt 0 ] && printf '\033[%dA' "$drawn" > "$TTY"
    drawn=0
    line="   Folder: $dir"; printf '\033[2K%s\n' "${line:0:$cols}" > "$TTY"; drawn=$((drawn + 1))
    for ((i = top; i < top + rows; i++)); do
      if [ "$i" -lt "$n" ]; then
        line="${items[$i]}"
        if [ "$i" -eq "$sel" ]; then printf '\033[2K \033[7m › %s \033[0m\n' "${line:0:$((cols - 6))}" > "$TTY"
        else printf '\033[2K   %s\n' "${line:0:$((cols - 4))}" > "$TTY"; fi
      else printf '\033[2K\n' > "$TTY"; fi
      drawn=$((drawn + 1))
    done
    line="   ↑↓ move · Enter open or choose · ← back · / type a path$([ "$n" -gt $((top + rows)) ] && printf ' · %d more' $((n - top - rows)))"
    printf '\033[2K\033[2m%s\033[0m\n' "${line:0:$cols}" > "$TTY"; drawn=$((drawn + 1))

    IFS= read -rsn1 key < "$TTY" || key=q
    # an arrow is ESC [ A (or ESC O A in keypad mode); a lone Esc times out
    if [ "$key" = $'\033' ]; then IFS= read -rsn2 -t 1 rest < "$TTY" || rest=""; key="ESC${rest/O/[}"; fi
    case "$key" in
      ESC\[A|k) [ "$sel" -gt 0 ] && sel=$((sel - 1)) ;;
      ESC\[B|j) [ "$sel" -lt $((n - 1)) ] && sel=$((sel + 1)) ;;
      ESC\[D|$'\177'|$'\b') dir="$(cd "$dir/.." && pwd -P)"; sel=0; top=0 ;;
      ''|ESC\[C)
        if [ "$sel" -eq 0 ]; then
          [ "$key" = '' ] && break
        elif [ "$sel" -eq 1 ]; then dir="$(cd "$dir/.." && pwd -P)"; sel=0; top=0
        else
          name="${items[$sel]%/}"
          if path="$(cd "$dir/$name" 2>/dev/null && pwd -P)"; then dir="$path"; sel=0; top=0; fi
        fi ;;
      /|'~')
        printf '\033[?25h' > "$TTY"
        path="$(ask "   Path: " "")"
        path="${path/#\~/$HOME}"
        printf '\033[?25l\033[1A\033[2K' > "$TTY"
        if [ -n "$path" ] && path="$(cd "$path" 2>/dev/null && pwd -P)"; then dir="$path"; sel=0; top=0; fi ;;
      q|ESC*) ;;
      *)
        # a letter: the next folder starting with it
        for ((i = 1; i <= n; i++)); do
          rest=$(( (sel + i) % n ))
          [ "$rest" -ge 2 ] || continue
          name="${items[$rest]}"
          if [ "$(printf '%s' "${name:0:1}" | tr '[:upper:]' '[:lower:]')" = "$(printf '%s' "$key" | tr '[:upper:]' '[:lower:]')" ]; then sel=$rest; break; fi
        done ;;
    esac
  done
  # leave one line saying what was chosen in place of the browser
  printf '\033[%dA' "$drawn" > "$TTY"
  for ((i = 0; i < drawn; i++)); do printf '\033[2K\n' > "$TTY"; done
  printf '\033[%dA\033[?25h' "$drawn" > "$TTY"
  printf '%s' "$dir"
}
# no <question>: true for yes (y, yes), false for no (Enter, n, no); no terminal: no
no() {
  local a
  while :; do
    a="$(ask "$1 [y/N] " n)"
    case "$a" in [Yy]|[Yy][Ee][Ss]) return 1 ;; [Nn]|[Nn][Oo]) return 0 ;; *) say "   Type y for yes or n for no (Enter is no)." ;; esac
  done
}
if [ -n "${CHORUS_SHARE:-}" ]; then
  IFS=':' read -r -a given <<< "$CHORUS_SHARE"
  for f in "${given[@]}"; do add_folder "$f" || true; done
else
  say "$((N += 1)). Which folders can the agents work in?"
  say "   The agents in the box see only the folders you share, at the same path as on this computer."
  if [ -n "$TTY" ]; then
    # Enter right away shares the home folder (owner, 2026-11-19)
    while :; do
      f="$(browse "$HOME_REAL")"
      add_folder "$f" || true
      say "   ✓ $f"
      no "   Share another folder too?" && break
    done
  else
    FOLDERS+=("$HOME_REAL")
  fi
  for f in "${FOLDERS[@]}"; do
    if [ "$f" = "$HOME_REAL" ]; then say "   Note: the agents can read and change anything in your home folder, keys and settings files included."; fi
  done
  say ""
fi
[ "${#FOLDERS[@]}" -gt 0 ] || fail "No folder to share."
say "   Shared: ${FOLDERS[*]}"

# the port: 4318, or the next free one (CHORUS_PORT picks another). Open on every address of this computer, so other computers
# reach Chorus too; the address carries a token, required on every request, until Chorus has a login (owner's decision, 2026-11-08)
free() { ! (exec 3<>"/dev/tcp/127.0.0.1/$1") 2>/dev/null; }
PORT="${CHORUS_PORT:-}"
if [ -z "$PORT" ]; then
  PORT=4318
  while ! free "$PORT"; do PORT=$((PORT + 1)); done
fi
case "$PORT" in ''|*[!0-9]*) fail "The port must be a number, like 4318." ;; esac
free "$PORT" || fail "Port $PORT is in use on this computer. Run this again and choose another."

get_image
run_box
say ""
say "Installing Chorus ($CHANNEL) in the box; the first start takes a minute…"
show
