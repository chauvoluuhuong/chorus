#!/usr/bin/env bash
# (in the container) drives the Chorus window with real X keystrokes through IBus + Bamboo:
#   drive.sh sentence telex|vni     types the test sentence "Tiếng Việt có dấu: người, được, khoẻ, Đà Nẵng" key by key
#   drive.sh enter-mid telex|vni    types a word ("Tiếng") with no space after it and presses Enter while Bamboo still shows it
#   drive.sh click X Y · drive.sh key <xdotool key> · drive.sh text <ascii> · drive.sh shot <name>
# Bamboo's method is set when the container starts (run.sh Telex|VNI). Learned on the way (2026-11-20):
# - `ibus restart` while the window is up stops clicks from reaching it: one container per method.
# - after `xdotool key ctrl+…` or typing into a field, the X pointer may stop moving (xdotool moves are queued): start a chat
#   with the Send button, clear a field with BackSpace, and start a new container when clicks stop landing.
# - the New chat view takes focus back from a dialog on its next redraw (about 15 s): type into a dialog right after opening it.
set -euo pipefail
source /tmp/session.env
TELEX='Tieengs Vieetj cos daaus: nguwowfi, dduwowcj, khoer, DDaf Nawxng'
VNI='Tie6ng1 Vie65t co1 da6u1: ngu7o72i, d9u7o75c, khoe3, D9a2 Na8ng4'
case "$1" in
  sentence) xdotool type --delay 90 "$([ "$2" = vni ] && echo "$VNI" || echo "$TELEX")" ;;
  enter-mid) xdotool type --delay 90 "$([ "$2" = vni ] && echo 'Tie6ng1' || echo 'Tieengs')"; sleep 0.3; xdotool key Return ;;
  click) xdotool mousemove "$2" "$3" click 1; sleep 0.4 ;;
  key) xdotool key "$2"; sleep 0.3 ;;
  text) xdotool type --delay 60 "$2" ;;
  shot) import -window root "/out/$2.png" ;;
esac
