#!/bin/sh
command -v cast >/dev/null 2>&1 || exit 0
[ -n "${PASEO_AGENT_ID}${HERDR_PANE_ID}" ] || exit 0
cast unregister >/dev/null
exit 0
