#!/bin/sh
CAST=$(command -v cast 2>/dev/null || true)
if [ -z "$CAST" ]; then for c in "$HOME/.local/bin/cast" "$HOME/.bun/bin/cast" /usr/local/bin/cast; do [ -x "$c" ] && CAST="$c" && break; done; fi
[ -n "$CAST" ] || exit 0
[ -n "${PASEO_AGENT_ID}${HERDR_PANE_ID}" ] || exit 0
"$CAST" register >/dev/null
"$CAST" relay --background >/dev/null 2>&1 </dev/null
exit 0
