// Claude Code's statusLine command -> codecast daemon, for LIVE account usage.
//
// Claude Code pipes a JSON blob to the configured `statusLine` command on every
// turn, and since 2.1.80 that blob carries `rate_limits` — the account's 5h and
// 7d windows as the Messages API just reported them. Forwarding it gives the
// daemon a usage reading per turn, for free, where the OAuth usage endpoint is
// polled once every five minutes on a tight budget. Verified on 2.1.263:
//
//   "cost": { "total_duration_ms": 17462, ... },
//   "rate_limits": {
//     "five_hour": { "used_percentage": 0,  "resets_at": 1788759000 },
//     "seven_day": { "used_percentage": 32, "resets_at": 1789016400 }
//   }
//
// `resets_at` is epoch SECONDS here (the usage endpoint answers ISO strings);
// the daemon converts. `total_duration_ms` is nested under `cost`, which the
// text scan below does not care about.
//
// Two properties this script must hold, because it runs several times a SECOND
// while a turn streams:
//
//   1. It prints nothing, so codecast never appears in the user's terminal.
//      Measured on 2.1.263: Claude Code still lays out a ROW for the status
//      line, so a silent command costs one blank line under the composer.
//      `padding: 0` does not remove it. That is the price of the feed, and it
//      is why the install refuses to touch a status line the user configured.
//   2. A tick it is not going to forward spawns NO subprocess. That rules out
//      `cat`, `date`, `jq` and a curl-then-throw-away. The payload's own
//      `total_duration_ms` is the clock, so the 15s throttle is decided with
//      shell builtins alone; `date` is only a fallback for a schema change.
//
// Transport is the loopback port in ~/.codecast/hook-port, exactly as
// codecast-status.sh reads it, so there is one answer to "where is the daemon".

/** File name under ~/.claude/hooks/. */
export const STATUSLINE_HOOK_FILE = "codecast-statusline.sh";

/** The daemon route the script posts to. */
export const STATUSLINE_HOOK_PATH = "/hook/statusline";

/** One post per session per this many seconds. The windows move in whole
 *  percentage points over minutes, so a faster feed buys nothing and a slower
 *  one would miss the burn that auto-switch needs to see coming. */
export const STATUSLINE_MIN_POST_INTERVAL_S = 15;

export const CODECAST_STATUSLINE_HOOK = `#!/bin/sh
# Forwards Claude Code's live rate_limits to the codecast daemon.
# Prints nothing: codecast never appears in the user's terminal.

payload=
while IFS= read -r cc_line || [ -n "$cc_line" ]; do
  payload="\${payload}\${cc_line}"
done
[ -n "$payload" ] || exit 0

# rate_limits appears only on subscriber sessions, and only once an API
# response has landed. Every other tick stops here, before any subprocess.
case "$payload" in
  *'"rate_limits"'*) ;;
  *) exit 0 ;;
esac

# The payload's own clock. Reading it instead of calling \`date\` is what keeps a
# throttled tick free of subprocesses.
cc_now=
case "$payload" in
  *'"total_duration_ms"'*)
    cc_ms=\${payload#*'"total_duration_ms"'}
    cc_ms=\${cc_ms#*:}
    cc_ms=\${cc_ms#"\${cc_ms%%[![:space:]]*}"}
    cc_ms=\${cc_ms%%[!0-9]*}
    case "$cc_ms" in
      0|[1-9]|[1-9][0-9]*) [ \${#cc_ms} -le 15 ] && cc_now=$((cc_ms / 1000)) ;;
    esac
    ;;
esac
[ -n "$cc_now" ] || cc_now=$(date +%s 2>/dev/null) || cc_now=
# A leading zero reads as octal inside $(( )), and an invalid constant is FATAL
# in dash — the script would die before rewriting its stamp and wedge the feed.
# Only canonical decimals are used as a clock; anything else fails open to
# posting rather than to dying.
case "$cc_now" in 0|[1-9]|[1-9][0-9]*) ;; *) cc_now= ;; esac

# The throttle is per session, and the stamp is a file name, so an id that is
# not a plain id is dropped rather than sanitized.
cc_sid=\${payload#*'"session_id"'}
cc_sid=\${cc_sid#*'"'}
cc_sid=\${cc_sid%%'"'*}
case "$cc_sid" in
  ''|*[!A-Za-z0-9._-]*) exit 0 ;;
esac
[ \${#cc_sid} -le 128 ] || exit 0

cc_stamp="\${TMPDIR:-/tmp}/codecast-statusline-\${cc_sid}"
if [ -n "$cc_now" ] && [ -f "$cc_stamp" ]; then
  cc_last=
  IFS= read -r cc_last <"$cc_stamp" 2>/dev/null || :
  case "$cc_last" in 0|[1-9]|[1-9][0-9]*) ;; *) cc_last= ;; esac
  [ \${#cc_last} -le 15 ] || cc_last=
  if [ -n "$cc_last" ]; then
    cc_elapsed=$((cc_now - cc_last))
    if [ "$cc_elapsed" -ge 0 ] && [ "$cc_elapsed" -lt ${STATUSLINE_MIN_POST_INTERVAL_S} ]; then
      exit 0
    fi
  fi
fi

cc_port=
[ -f "$HOME/.codecast/hook-port" ] && IFS= read -r cc_port <"$HOME/.codecast/hook-port" 2>/dev/null
case "$cc_port" in
  [1-9]|[1-9][0-9]*) ;;
  *) exit 0 ;;
esac

# Stamped only once a post is certain, so a tick skipped for a missing daemon
# never pushes the next allowed post further out.
[ -n "$cc_now" ] && printf '%s' "$cc_now" >"$cc_stamp" 2>/dev/null

# The account this session was launched on (accountSourcePrefix exports it).
# Empty means the session runs on the machine's keychain login, which is what
# the daemon assumes when the field is absent.
case "\${CODECAST_CC_ACCOUNT:-}" in
  ''|*[!A-Za-z0-9._-]*) cc_account= ;;
  *) cc_account=$CODECAST_CC_ACCOUNT ;;
esac

printf '%s' "$payload" | curl -s -X POST \\
  "http://127.0.0.1:\${cc_port}${STATUSLINE_HOOK_PATH}?account=\${cc_account}" \\
  --connect-timeout 1 --max-time 2 \\
  -H "Content-Type: application/json" \\
  --data-binary @- -o /dev/null 2>/dev/null || true
exit 0
`;
