#!/usr/bin/env bash
# (in the container) restarts the Chorus window and its `chorus serve`, same temp CHORUS_HOME: picks up page or server edits in /work
source /tmp/session.env
pkill -x chorus-desktop; sleep 2
export HOME=/root SHELL=/bin/bash GTK_IM_MODULE=ibus XMODIFIERS=@im=ibus QT_IM_MODULE=ibus
export CHORUS_HOME=/tmp/chorus-home CHORUS_FAKE_AGENTS=1 CHORUS_DEBUG_INPUT=/out/input.log CHORUS_NOTIFICATIONS=0 CHORUS_UPDATES=0
export CHORUS_SERVE_CMD="node /work/src/cli/index.ts"
setsid /opt/chorus-desktop >/out/desktop-stdout.log 2>&1 < /dev/null &
sleep 8
