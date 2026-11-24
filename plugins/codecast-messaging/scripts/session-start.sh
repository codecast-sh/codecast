#!/bin/sh
command -v cast >/dev/null 2>&1 || exit 0
[ -n "${PASEO_AGENT_ID}${HERDR_PANE_ID}" ] || exit 0
cast register >/dev/null
cast relay --background >/dev/null 2>&1 </dev/null
exit 0
