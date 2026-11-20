#!/usr/bin/env bash
# Starts the chorus-linux-ime container on this worktree: test/smoke/linux-ime/run.sh [Telex|VNI] [<out dir>]
# Fake TUI agents, a temp CHORUS_HOME inside the container, every byte a chat gets in <out>/input.log. Each chat's fake agent
# asks one question card (card-script.json), for the card's boxes. One container per input method: switching Bamboo's method
# needs an IBus restart, after which the window no longer gets clicks.
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
W=$(cd "$HERE/../../.." && pwd)
OUT=${2:-$W/.chorus/proof/linux-ime}
mkdir -p "$OUT"
docker rm -f chorus-linux-ime >/dev/null 2>&1 || true
docker run -d --name chorus-linux-ime --shm-size=1g -e BAMBOO_METHOD="${1:-Telex}" \
  -e CHORUS_FAKE_SCRIPT=/work/test/smoke/linux-ime/card-script.json \
  -v "$W":/work:ro -v "$W/../chorus-core":/chorus-core:ro --mount type=volume,dst=/work/node_modules/node-pty -v "$OUT":/out \
  chorus-linux-ime bash -c 'cp -r /opt/pty/node_modules/node-pty/. /work/node_modules/node-pty/ && /opt/inside.sh' >/dev/null
sleep 15
D="docker exec chorus-linux-ime bash /work/test/smoke/linux-ime/drive.sh"
$D click 627 755; $D click 125 100; sleep 1; $D click 898 686 # welcome: Keep Community, New chat, skip the agents check
sleep 3; $D click 583 840 # "Got it" on the Doctor tip
echo "up: $OUT (drive: $D …)"
