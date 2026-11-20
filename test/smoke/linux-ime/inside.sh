#!/usr/bin/env bash
# Runs in the container: Xvfb + Openbox + dbus + IBus (Bamboo engine), then the Chorus desktop window over `chorus serve` from the
# mounted worktree (/work) with fake TUI agents and a temp CHORUS_HOME. Every byte a chat gets goes to /out/input.log
# (CHORUS_DEBUG_INPUT). The container then stays up for `docker exec` (xdotool typing, screenshots: see drive.sh and run.sh).
set -u
export DISPLAY=:99 HOME=/root SHELL=/bin/bash
export GTK_IM_MODULE=ibus XMODIFIERS=@im=ibus QT_IM_MODULE=ibus
Xvfb :99 -screen 0 1400x900x24 >/out/xvfb.log 2>&1 &
sleep 1
eval "$(dbus-launch --sh-syntax)"
echo "export DBUS_SESSION_BUS_ADDRESS='$DBUS_SESSION_BUS_ADDRESS' DISPLAY=:99" > /tmp/session.env
openbox >/out/openbox.log 2>&1 &
# Bamboo reads its settings when IBus starts: BAMBOO_METHOD=Telex|VNI; Flags 5 writes the new tone style ("khoẻ", "hoà")
mkdir -p "$HOME/.config/ibus-bamboo"
echo "{\"InputMethod\":\"${BAMBOO_METHOD:-Telex}\",\"DefaultInputMode\":1,\"Flags\":5}" > "$HOME/.config/ibus-bamboo/ibus-bamboo.config.json"
ibus-daemon -drx >/out/ibus.log 2>&1
for i in $(seq 1 30); do ibus engine >/dev/null 2>&1 && break; sleep 0.5; done
ibus engine Bamboo
echo "ibus engine: $(ibus engine)"
export CHORUS_HOME=/tmp/chorus-home CHORUS_FAKE_AGENTS=1 CHORUS_DEBUG_INPUT=/out/input.log CHORUS_NOTIFICATIONS=0 CHORUS_UPDATES=0
export CHORUS_SERVE_CMD="node /work/src/cli/index.ts"
mkdir -p "$CHORUS_HOME"
/opt/chorus-desktop >/out/desktop-stdout.log 2>&1 &
echo "desktop pid $!"
sleep infinity
