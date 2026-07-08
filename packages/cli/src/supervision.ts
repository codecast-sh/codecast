// Daemon supervision wiring: the launchd plists, the watchdog shell script, and the
// pure predicates that decide when supervision needs repair. Kept strictly
// side-effect free so both the CLI (index.ts, imported eagerly) and the daemon
// (daemon.ts, imported lazily) can share one definition — and so every piece is
// unit-testable without booting the CLI (index.ts self-executes on import).
//
// Why a RESIDENT watchdog instead of launchd StartInterval:
// StartInterval timers do not fire across a macOS sleep and were observed wedged at
// runs=1 for 27h on a live machine — long enough that a cleanly-stopped daemon
// (e.g. mid-redeploy) stayed dead for hours while every other safety net was also
// asleep. A long-lived process is merely suspended on sleep and RESUMES its loop on
// wake, so it rechecks within one interval of the Mac being awake; KeepAlive
// relaunches it if the loop ever exits. This turns a multi-hour outage into a
// sub-minute one (we cannot run at all while the Mac is fully asleep — that is macOS).

export const WATCHDOG_HEARTBEAT_FILENAME = "watchdog.heartbeat";

// Both LaunchAgents must run through /bin/sh + a script in ~/.codecast, never point
// at the codecast binary directly. macOS Background Task Management identifies a
// login item by its executable's code-signing identity; our binary is ad-hoc signed
// (bun --compile), so its identity is its content hash — and every self-update that
// swaps the binary makes BTM treat the agent as a brand-new background item and
// re-notify the user ("codecast can run in the background"), several times a day at
// our release cadence. /bin/sh is Apple-signed and never changes, so the item's
// identity is stable no matter how often the script's target binary is replaced.
export const DAEMON_LAUNCHER_FILENAME = "daemon-launcher.sh";

export function shellEscapeForSh(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

// exec (not plain invocation) so the daemon replaces the shell and launchd tracks
// the daemon's pid as the job instance — kickstart, KeepAlive, and the mutual
// supervision pid checks all depend on that.
export function buildDaemonLauncherScript(opts: { daemonCommand: string }): string {
  return `#!/bin/sh
# Codecast daemon launcher. The LaunchAgent runs this via /bin/sh so the login
# item's identity stays stable across binary self-updates (see supervision.ts).
exec ${opts.daemonCommand}
`;
}

// The resident watchdog stamps the heartbeat file every loop. Mutual supervision
// treats a stale stamp as "watchdog wedged" even when launchd still lists the job as
// loaded — the gap that let a runs=1 zombie watchdog look healthy. 5 min tolerates a
// missed 60s tick or two (and the post-wake re-stamp) without false restarts.
export const WATCHDOG_HEARTBEAT_STALE_MS = 5 * 60 * 1000;

// The watchdog's own poll cadence and the daemon-staleness threshold it enforces,
// kept here so the shell script and any future native watchdog agree on one number.
const WATCHDOG_INTERVAL_SECONDS = 60;
const DAEMON_HEARTBEAT_STALE_MS = 180000; // 3 min; mirrors HEARTBEAT_STALE_THRESHOLD_MS in daemon.ts

export function buildDaemonPlistXml(opts: { scriptPath: string; configDir: string }): string {
  const { scriptPath, configDir } = opts;
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>sh.codecast.daemon</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/sh</string>
    <string>${scriptPath}</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ThrottleInterval</key>
  <integer>10</integer>
  <key>StandardOutPath</key>
  <string>${configDir}/launchd.out.log</string>
  <key>StandardErrorPath</key>
  <string>${configDir}/launchd.err.log</string>
</dict>
</plist>
`;
}

// Resident KeepAlive watchdog (NOT StartInterval — see file header).
export function buildWatchdogPlistXml(opts: { scriptPath: string; configDir: string }): string {
  const { scriptPath, configDir } = opts;
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>sh.codecast.watchdog</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/sh</string>
    <string>${scriptPath}</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ThrottleInterval</key>
  <integer>10</integer>
  <key>StandardOutPath</key>
  <string>${configDir}/watchdog.out.log</string>
  <key>StandardErrorPath</key>
  <string>${configDir}/watchdog.err.log</string>
</dict>
</plist>
`;
}

// A watchdog plist needs replacing if it predates the /bin/sh wrapper (legacy
// direct-binary form) OR is still StartInterval-based (pre-resident-loop). Either
// way ensureAutostart rewrites it to the current KeepAlive resident-loop form, so
// existing installs migrate themselves on the next daemon start.
export function watchdogPlistNeedsUpgrade(content: string): boolean {
  return !content.includes("/bin/sh") || content.includes("<key>StartInterval</key>");
}

// A daemon plist that still points launchd directly at the codecast binary (or at
// bun/node in dev) predates the stable /bin/sh launcher and must be replaced — it
// is the form that re-triggers a macOS "can run in the background" notification on
// every binary self-update (see DAEMON_LAUNCHER_FILENAME).
export function daemonPlistNeedsUpgrade(content: string): boolean {
  return !content.includes("<string>/bin/sh</string>");
}

// Pull the ProgramArguments strings out of an existing plist so the daemon's
// self-migration can preserve exactly the command the install already runs
// (compiled binary, dev bun+daemon.ts, whatever) inside the new launcher script.
// Matches the writer's symmetry: values are emitted raw, so they are read raw.
export function extractPlistProgramArguments(content: string): string[] {
  const arrayMatch = content.match(/<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/);
  if (!arrayMatch) return [];
  const args: string[] = [];
  for (const m of arrayMatch[1].matchAll(/<string>([\s\S]*?)<\/string>/g)) {
    args.push(m[1]);
  }
  return args;
}

// Age of the watchdog heartbeat stamp in ms (now - stamp), or null when the stamp is
// missing or unparseable. Pure for testability.
export function watchdogHeartbeatAge(content: string | null, now: number): number | null {
  if (content == null) return null;
  const tick = parseInt(content.trim(), 10);
  if (!Number.isFinite(tick) || tick <= 0) return null;
  return now - tick;
}

// True when a loaded watchdog has stopped stamping its heartbeat (loop dead/wedged).
// A missing stamp returns false — a freshly-(re)installed watchdog has not stamped
// yet, and we would rather wait for it than thrash-restart a healthy new process.
export function watchdogHeartbeatStale(
  content: string | null,
  now: number,
  thresholdMs: number = WATCHDOG_HEARTBEAT_STALE_MS,
): boolean {
  const age = watchdogHeartbeatAge(content, now);
  if (age === null) return false;
  return age > thresholdMs;
}

// The watchdog shell script. `isBinary` picks the production form (invoke the
// compiled `_watchdog` pass with a self-update fallback) vs the dev/from-source form
// (do the health check inline in shell). Both run as a resident loop that stamps the
// heartbeat each cycle so the daemon can see the watchdog is alive, not just loaded.
export function buildWatchdogShellScript(opts: { isBinary: boolean; watchdogCommand: string }): string {
  const { isBinary, watchdogCommand } = opts;

  if (!isBinary) {
    return `#!/bin/sh
LOGFILE="\${HOME}/.codecast/watchdog-shell.log"
HEARTBEAT="\${HOME}/.codecast/${WATCHDOG_HEARTBEAT_FILENAME}"
log() { printf '[%s] %s\\n' "\$(date '+%Y-%m-%d %H:%M:%S')" "\$1" >> "\$LOGFILE"; }

# Resident KeepAlive supervisor loop (see supervision.ts header for why this is not
# a launchd StartInterval job). Suspends on sleep, resumes on wake, rechecks within
# WATCHDOG_INTERVAL of the Mac being awake.
WATCHDOG_INTERVAL=${WATCHDOG_INTERVAL_SECONDS}
MAX_LOG_BYTES=52428800

# Rotate oversized logs. copytruncate (copy then truncate-in-place) keeps launchd's
# open append fd valid so it resumes writing at offset 0 after we shrink the file.
rotate_log() {
  [ -f "\$1" ] || return 0
  sz=\$(wc -c < "\$1" 2>/dev/null | tr -d '[:space:]')
  [ "\${sz:-0}" -gt "\$MAX_LOG_BYTES" ] || return 0
  cp "\$1" "\$1.1" 2>/dev/null && : > "\$1" && log "rotated \$1 (\$sz bytes)"
}

check_once() {
  # Stamp liveness first so the daemon's mutual supervision can tell the loop is
  # alive (not merely launchd-loaded). Epoch ms matches daemon.state tick units.
  printf '%s' "\$(( \$(date +%s) * 1000 ))" > "\$HEARTBEAT" 2>/dev/null

  for f in launchd.err.log launchd.out.log daemon.log; do
    rotate_log "\${HOME}/.codecast/\$f"
  done

  LAUNCHD_UID="gui/\$(id -u)"
  DAEMON_LABEL="sh.codecast.daemon"
  DAEMON_PLIST="\${HOME}/Library/LaunchAgents/sh.codecast.daemon.plist"
  PRINT="\$(launchctl print "\$LAUNCHD_UID/\$DAEMON_LABEL" 2>/dev/null)"
  LOADED=0
  RUNNING=0
  [ -n "\$PRINT" ] && LOADED=1
  printf '%s' "\$PRINT" | grep -q 'state = running' && RUNNING=1

  # A "running" launchd job is not proof of health. The daemon's setInterval-based
  # self-recovery (sleep detector, watchdog, event-loop monitor) does not survive a
  # long macOS sleep: the timers stop firing and never re-arm, so the process stays
  # alive but stops self-healing. Detect that via lastHeartbeatTick, which a healthy
  # daemon rewrites every ~30s, and force a restart when it goes stale.
  STALE=0
  STATE_FILE="\${HOME}/.codecast/daemon.state"
  if [ "\$RUNNING" -eq 1 ] && [ -f "\$STATE_FILE" ]; then
    TICK=\$(sed -n 's/.*"lastHeartbeatTick"[[:space:]]*:[[:space:]]*\\([0-9][0-9]*\\).*/\\1/p' "\$STATE_FILE")
    [ -z "\$TICK" ] && TICK=\$(sed -n 's/.*"lastWatchdogCheck"[[:space:]]*:[[:space:]]*\\([0-9][0-9]*\\).*/\\1/p' "\$STATE_FILE")
    if [ -n "\$TICK" ] && [ "\$TICK" -gt 0 ]; then
      AGE=\$(( \$(date +%s) * 1000 - TICK ))
      if [ "\$AGE" -gt ${DAEMON_HEARTBEAT_STALE_MS} ]; then
        STALE=1
        log "Daemon alive but heartbeat stale (\${AGE}ms) - event loop wedged, forcing restart"
      fi
    fi
  fi

  [ "\$RUNNING" -eq 1 ] && [ "\$STALE" -eq 0 ] && return 0

  # Not healthy. A cast stop / upgrade / login race can leave the job booted-out
  # (removed from launchd entirely), in which case kickstart alone fails forever
  # because there is no target. Re-register it from the plist first, then force a
  # fresh start.
  if [ "\$LOADED" -eq 0 ]; then
    if [ -f "\$DAEMON_PLIST" ]; then
      log "daemon launchd job not loaded - bootstrapping from plist"
      launchctl bootstrap "\$LAUNCHD_UID" "\$DAEMON_PLIST" >>"\$LOGFILE" 2>&1 || log "bootstrap failed"
    else
      log "daemon plist missing at \$DAEMON_PLIST - run 'cast setup' to restore supervision"
    fi
  fi
  [ "\$RUNNING" -eq 0 ] && log "watchdog reviving daemon (loaded=\$LOADED stale=\$STALE)"
  launchctl kickstart -k "\$LAUNCHD_UID/\$DAEMON_LABEL" >>"\$LOGFILE" 2>&1 || log "Failed to kickstart daemon"
}

while :; do
  check_once
  sleep "\$WATCHDOG_INTERVAL"
done
`;
  }

  // Binary/production form: a resident loop that invokes the compiled `_watchdog`
  // health pass each cycle, falling back to a self-update when a pass fails. Loops
  // in-process (not via StartInterval) for the same sleep-survival reasons; a failed
  // pass returns to the loop and retries next interval instead of killing the loop.
  return `#!/bin/sh
LOGFILE="\${HOME}/.codecast/watchdog-shell.log"
HEARTBEAT="\${HOME}/.codecast/${WATCHDOG_HEARTBEAT_FILENAME}"
log() { printf '[%s] %s\\n' "\$(date '+%Y-%m-%d %H:%M:%S')" "\$1" >> "\$LOGFILE"; }
WATCHDOG_INTERVAL=${WATCHDOG_INTERVAL_SECONDS}
DL_HOST="https://dl.codecast.sh"

run_check() {
  # Stamp liveness first (see dev branch). Epoch ms matches daemon.state tick units.
  printf '%s' "\$(( \$(date +%s) * 1000 ))" > "\$HEARTBEAT" 2>/dev/null

  ${watchdogCommand} 2>>"\$LOGFILE" && return 0
  log "Watchdog failed (exit \$?), checking for update"

  LATEST="\$(curl -fsSL "\$DL_HOST/latest.json" 2>/dev/null)" || { log "Failed to fetch latest.json"; return 1; }
  VERSION="\$(printf '%s' "\$LATEST" | sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\\([^"]*\\)".*/\\1/p')"
  [ -z "\$VERSION" ] && { log "Could not parse version"; return 1; }

  LAST_DL_FILE="\${HOME}/.codecast/last_download_version"
  LAST_DL="\$(cat "\$LAST_DL_FILE" 2>/dev/null || true)"
  if [ "\$VERSION" = "\$LAST_DL" ]; then
    log "v\$VERSION already tried and failed, waiting for new release"
    return 1
  fi

  OS="\$(uname -s)"; ARCH="\$(uname -m)"
  case "\$OS" in Darwin*) P="darwin";; Linux*) P="linux";; *) log "Unsupported OS: \$OS"; return 1;; esac
  case "\$ARCH" in x86_64|amd64) A="x64";; arm64|aarch64) A="arm64";; *) log "Unsupported arch: \$ARCH"; return 1;; esac

  DIR="\${HOME}/.local/bin"; mkdir -p "\$DIR"
  TMP="\$(mktemp)"
  log "Downloading codecast v\$VERSION (\$P-\$A)"
  curl -fsSL "\$DL_HOST/codecast-\$P-\$A" -o "\$TMP" 2>>"\$LOGFILE" || { rm -f "\$TMP"; log "Download failed"; return 1; }
  mv "\$TMP" "\$DIR/codecast" && chmod +x "\$DIR/codecast"
  printf '%s' "\$VERSION" > "\$LAST_DL_FILE"
  log "Installed v\$VERSION, retrying watchdog"

  "\$DIR/codecast" -- _watchdog 2>>"\$LOGFILE" || { log "Still failed after update"; return 1; }
}

while :; do
  run_check
  sleep "\$WATCHDOG_INTERVAL"
done
`;
}
