// Claude Code's statusLine command -> codecast daemon, for LIVE account usage,
// and the one line the terminal gets back for it.
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
// Claude Code lays out a ROW for the status line whatever the command prints,
// and `padding: 0` does not remove it (measured on 2.1.263). A silent script
// therefore costs the user a blank line under the composer and gives nothing
// back, so the script draws the usage it is already parsing:
//
//   union · session 12%, resets in 4h 20m · week 32%, resets in 3d
//
// The account name is the profile this session was launched on. No colour and
// no emoji: the bar sits in whatever theme the user chose, and codecast does
// not get to guess it.
//
// Two properties this script must hold, because it runs several times a SECOND
// while a turn streams:
//
//   1. A tick it is not going to forward spawns NO subprocess. That rules out
//      `cat`, `date`, `jq` and a curl-then-throw-away. The payload's own
//      `total_duration_ms` is the clock, so the 15s throttle is decided with
//      shell builtins alone.
//   2. The line is drawn on EVERY tick, including those throttled ticks, or the
//      bar blinks empty between posts. Reset times in plain words need a real
//      wall clock, and the payload's clock is a per-session duration rather
//      than an epoch, so `date` is unavoidable to render them — which is why
//      the rendered line is cached in the stamp file and reprinted with
//      builtins. One `date` per interval, on the tick that was posting anyway;
//      the line a throttled tick reprints is at most one interval stale, which
//      is the cadence of the feed itself.
//
// Transport is the loopback port in ~/.codecast/hook-port, exactly as
// codecast-status.sh reads it, so there is one answer to "where is the daemon".
//
// The stamp that carries the throttle and the drawn line lives beside it, in
// ~/.codecast/statusline/, and never in $TMPDIR: it names the account and its
// usage, and on a shared Linux box /tmp is world readable and its paths are
// guessable. Under a 0700 directory nobody else can read it, plant a symlink at
// its path, or race the write.

/** File name under ~/.claude/hooks/. */
export const STATUSLINE_HOOK_FILE = "codecast-statusline.sh";

/** The daemon route the script posts to. */
export const STATUSLINE_HOOK_PATH = "/hook/statusline";

/** Where the per-session stamps live, under ~/.codecast. The script writes them
 *  and the daemon sweeps the stale ones — nothing else deletes them, and a
 *  shared /tmp is not an option for a file naming the user's account. */
export const STATUSLINE_STAMP_DIR = "statusline";

/** One post per session per this many seconds. The windows move in whole
 *  percentage points over minutes, so a faster feed buys nothing and a slower
 *  one would miss the burn that auto-switch needs to see coming. The drawn line
 *  is refreshed on the same tick, so it is never staler than this. */
export const STATUSLINE_MIN_POST_INTERVAL_S = 15;

export const CODECAST_STATUSLINE_HOOK = `#!/bin/sh
# Forwards Claude Code's live rate_limits to the codecast daemon and draws them
# as one plain line: account, session window, weekly window, reset times.

# Every file this script creates is the stamp, and it carries the account name
# and its usage. Set once, with a builtin, so the file is 0600 the moment it is
# created — a chmod afterwards would leave a window and cost a process.
umask 077

payload=
while IFS= read -r cc_line || [ -n "$cc_line" ]; do
  payload="\${payload}\${cc_line}"
done
[ -n "$payload" ] || exit 0

# The account this session was launched on (accountSourcePrefix exports it).
# Empty means the session runs on the machine's keychain login, which is what
# the daemon assumes when the field is absent. Anything that could not be a
# profile name is dropped rather than sanitized: it goes in a URL and on screen.
case "\${CODECAST_CC_ACCOUNT:-}" in
  ''|*[!A-Za-z0-9._-]*) cc_account= ;;
  *) cc_account=$CODECAST_CC_ACCOUNT ;;
esac
# Bounded so the drawn line stays inside the cache guard below: a line longer
# than that is rejected when it is read back, and the tick that reprints it
# would render again — one wall clock read per tick instead of per interval.
[ \${#cc_account} -le 32 ] || cc_account=

# The throttle and the drawn line are per session, and the stamp is a file name,
# so an id that is not a plain id is dropped rather than sanitized.
cc_sid=\${payload#*'"session_id"'}
cc_sid=\${cc_sid#*'"'}
cc_sid=\${cc_sid%%'"'*}
case "$cc_sid" in
  ''|*[!A-Za-z0-9._-]*) exit 0 ;;
esac
[ \${#cc_sid} -le 128 ] || exit 0

# Three lines: when we last posted, when we last rendered, and what we rendered.
# A symlink at our path is somebody else's file, so it is neither read (it would
# print a stranger's bytes to the terminal) nor written (it would clobber
# whatever it points at). The tick just goes without a cache.
cc_dir="$HOME/.codecast/${STATUSLINE_STAMP_DIR}"
cc_stamp="$cc_dir/$cc_sid"
cc_cache=1
[ -L "$cc_stamp" ] && cc_cache=
cc_posted=
cc_drawn=
cc_text=
if [ -n "$cc_cache" ] && [ -f "$cc_stamp" ]; then
  { IFS= read -r cc_posted; IFS= read -r cc_drawn; IFS= read -r cc_text; } <"$cc_stamp" 2>/dev/null || :
fi
# A leading zero reads as octal inside $(( )), and an invalid constant is FATAL
# in dash — the script would die before rewriting its stamp and wedge the feed.
# Only canonical decimals are used as a clock; anything else fails open.
case "$cc_posted" in 0|[1-9]|[1-9][0-9]*) ;; *) cc_posted= ;; esac
case "$cc_drawn" in 0|[1-9]|[1-9][0-9]*) ;; *) cc_drawn= ;; esac
[ \${#cc_posted} -le 15 ] || cc_posted=
[ \${#cc_drawn} -le 15 ] || cc_drawn=
# The stamp's third line is printed to a terminal, so a line carrying control
# characters is treated as not ours even though the directory is owner only.
case "$cc_text" in *[[:cntrl:]]*) cc_text= ;; esac
[ \${#cc_text} -le 200 ] || cc_text=

# What the bar shows: the rendered line, or the account alone when this session
# has never reported a window (an API-billed session never does), or nothing.
cc_draw() {
  if [ -n "$cc_text" ]; then
    printf '%s\\n' "$cc_text"
  elif [ -n "$cc_account" ]; then
    printf '%s\\n' "$cc_account"
  fi
}

# rate_limits appears only on subscriber sessions, and only once an API
# response has landed. Every other tick redraws and stops, before any
# subprocess.
case "$payload" in
  *'"rate_limits"'*) ;;
  *) cc_draw; exit 0 ;;
esac

# The payload's own clock. Reading it instead of calling \`date\` is what keeps a
# throttled tick free of subprocesses. It counts from the start of the session,
# so it orders ticks but never dates them.
cc_now=
cc_epoch=
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
if [ -z "$cc_now" ]; then
  cc_now=$(date +%s 2>/dev/null) || cc_now=
  cc_epoch=$cc_now
fi
case "$cc_now" in 0|[1-9]|[1-9][0-9]*) ;; *) cc_now= ;; esac

# One render per interval. Between renders the cached line is reprinted, so a
# throttled tick runs entirely on builtins.
cc_render=1
if [ -n "$cc_now" ] && [ -n "$cc_drawn" ] && [ -n "$cc_text" ]; then
  cc_since=$((cc_now - cc_drawn))
  if [ "$cc_since" -ge 0 ] && [ "$cc_since" -lt ${STATUSLINE_MIN_POST_INTERVAL_S} ]; then
    cc_render=
  fi
fi

# The first whole number after "key": inside $1, or empty if it is missing or is
# not a number (a null, a string, a schema change).
cc_num() {
  cc_val=
  case "$1" in *"\\"$2\\""*) ;; *) return 0 ;; esac
  cc_val=\${1#*"\\"$2\\""}
  cc_val=\${cc_val#*:}
  cc_val=\${cc_val#"\${cc_val%%[![:space:]]*}"}
  cc_val=\${cc_val%%[!0-9]*}
  [ \${#cc_val} -le 15 ] || cc_val=
  case "$cc_val" in 0|[1-9]|[1-9][0-9]*) ;; *) cc_val= ;; esac
}

# How long until $1, in the two largest units that carry information. Empty
# without a wall clock, or once the window has already reset.
cc_until() {
  cc_words=
  [ -n "$cc_epoch" ] || return 0
  case "$1" in 0|[1-9]|[1-9][0-9]*) ;; *) return 0 ;; esac
  cc_secs=$(($1 - cc_epoch))
  [ "$cc_secs" -gt 0 ] || return 0
  cc_dd=$((cc_secs / 86400))
  cc_hh=$((cc_secs % 86400 / 3600))
  cc_mm=$((cc_secs % 3600 / 60))
  if [ "$cc_dd" -gt 0 ]; then
    cc_words="\${cc_dd}d"
    [ "$cc_hh" -gt 0 ] && cc_words="$cc_words \${cc_hh}h"
  elif [ "$cc_hh" -gt 0 ]; then
    cc_words="\${cc_hh}h"
    [ "$cc_mm" -gt 0 ] && cc_words="$cc_words \${cc_mm}m"
  else
    cc_words="$(((cc_secs + 59) / 60))m"
  fi
  return 0
}

# One window: "$3 N%" plus its reset time. $1 is the window's key and $2 the
# other one's, which bounds the scan — so a window missing a percentage reads as
# missing rather than borrowing its neighbour's.
cc_window() {
  cc_seg=$payload
  case "$cc_seg" in *"\\"$1\\""*) cc_seg=\${cc_seg#*"\\"$1\\""} ;; *) return 0 ;; esac
  case "$cc_seg" in *"\\"$2\\""*) cc_seg=\${cc_seg%%"\\"$2\\""*} ;; esac
  cc_num "$cc_seg" used_percentage
  [ -n "$cc_val" ] || return 0
  cc_part="$3 \${cc_val}%"
  cc_num "$cc_seg" resets_at
  cc_until "$cc_val"
  [ -n "$cc_words" ] && cc_part="$cc_part, resets in $cc_words"
  if [ -n "$cc_text" ]; then cc_text="$cc_text · $cc_part"; else cc_text=$cc_part; fi
  return 0
}

if [ -n "$cc_render" ]; then
  # The reset words need a real date, which the payload does not carry. This is
  # the tick that posts, so it is the tick that can afford one process.
  if [ -z "$cc_epoch" ]; then
    cc_epoch=$(date +%s 2>/dev/null) || cc_epoch=
    case "$cc_epoch" in 0|[1-9]|[1-9][0-9]*) ;; *) cc_epoch= ;; esac
  fi
  cc_text=
  cc_window five_hour seven_day session
  cc_window seven_day five_hour week
  if [ -n "$cc_account" ]; then
    if [ -n "$cc_text" ]; then cc_text="$cc_account · $cc_text"; else cc_text=$cc_account; fi
  fi
  cc_drawn=$cc_now
fi

cc_draw

cc_post=1
if [ -n "$cc_now" ] && [ -n "$cc_posted" ]; then
  cc_elapsed=$((cc_now - cc_posted))
  if [ "$cc_elapsed" -ge 0 ] && [ "$cc_elapsed" -lt ${STATUSLINE_MIN_POST_INTERVAL_S} ]; then
    cc_post=
  fi
fi

cc_port=
if [ -n "$cc_post" ]; then
  [ -f "$HOME/.codecast/hook-port" ] && IFS= read -r cc_port <"$HOME/.codecast/hook-port" 2>/dev/null
  case "$cc_port" in
    [1-9]|[1-9][0-9]*) ;;
    # Stamped only once a post is certain, so a tick skipped for a missing
    # daemon never pushes the next allowed post further out.
    *) cc_post= ;;
  esac
fi
[ -n "$cc_post" ] && [ -n "$cc_now" ] && cc_posted=$cc_now

if [ -n "$cc_cache" ] && { [ -n "$cc_render" ] || [ -n "$cc_post" ]; }; then
  # Only ever on a tick that is already spawning: after the first run of the
  # first session the directory is there, and [ -d ] is a builtin.
  [ -d "$cc_dir" ] || mkdir -p "$cc_dir" 2>/dev/null
  printf '%s\\n%s\\n%s\\n' "$cc_posted" "$cc_drawn" "$cc_text" >"$cc_stamp" 2>/dev/null
fi

[ -n "$cc_post" ] || exit 0
printf '%s' "$payload" | curl -s -X POST \\
  "http://127.0.0.1:\${cc_port}${STATUSLINE_HOOK_PATH}?account=\${cc_account}" \\
  --connect-timeout 1 --max-time 2 \\
  -H "Content-Type: application/json" \\
  --data-binary @- -o /dev/null 2>/dev/null || true
exit 0
`;
