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
import { AGENT_ENV_UNSET_SH } from "./agentEnv.js";

export const WATCHDOG_HEARTBEAT_FILENAME = "watchdog.heartbeat";

// Where every watchdog form writes what it decided. Never daemon.log: the busy
// grace reads daemon.log's mtime as proof the DAEMON is running JS, and the
// compiled pass used to append its own "tick stale" lines there, so after one
// deferral the next pass read the watchdog's own line as the daemon being busy
// and could not kill until the tick was ten minutes stale.
export const WATCHDOG_LOG_FILENAME = "watchdog-shell.log";

// sysexits' EX_CONFIG. The daemon exits with it when the thing that stopped it
// is a configuration fact no restart can change (no HOME, an unusable
// ~/.codecast) — as opposed to a crash, where restarting is exactly right.
// A supervisor only sees "the process is gone", so the daemon also leaves the
// reason in daemonMarkers' exit stamp; both watchdog forms read that file and
// stop reviving instead of relaunching into the same failure every minute.
// launchd's KeepAlive cannot express "restart unless it exited 78", so the
// watchdog is the layer that honours it; a `cast start` after the user fixes
// the config clears the stamp and supervision resumes.
export const EXIT_DO_NOT_RESTART = 78;

// The file the exit stamp lives in, named here so the generated shell script and
// the one TypeScript reader (daemonMarkers' noRestartReason, which the compiled
// `_watchdog` pass calls) cannot drift apart.
export const DAEMON_EXIT_STAMP_FILE = "daemon-exit.json";

// The compiled `_watchdog` pass records when it last ran here (epoch ms). The
// shell loop's heartbeat stamp can't serve this purpose for the binary pass —
// the wrapper stamps it immediately before invoking the binary, so the binary
// would always read a seconds-old value. Its own start-to-start gap is what
// detects "the machine just slept" (see daemonTickStale).
export const WATCHDOG_PASS_STAMP_FILENAME = "watchdog.pass";

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

export function daemonLauncherMatchesCommand(launcher: string, executable: string, args: string[]): boolean {
  const command = [executable, ...args].map(shellEscapeForSh).join(" ");
  return launcher.split("\n").some((line) => line.trim() === `exec ${command}`);
}

// exec (not plain invocation) so the daemon replaces the shell and launchd tracks
// the daemon's pid as the job instance — kickstart, KeepAlive, and the mutual
// supervision pid checks all depend on that.
export function buildDaemonLauncherScript(opts: { daemonCommand: string }): string {
  return `#!/bin/sh
# A watchdog bootstrapped from inside a Claude Code session would hand that
# session's markers to every daemon it revives (agentEnv.ts).
${AGENT_ENV_UNSET_SH}
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
export const DAEMON_HEARTBEAT_STALE_MS = 180000; // 3 min = 6 missed 30s daemon heartbeats
export const DAEMON_HEARTBEAT_BUSY_GRACE_MS = 10 * 60 * 1000;

// A pass answers in under a second; its slowest honest work is a binary download
// (curl caps that at 180s). Anything past this is a hang, not work. It must end
// before WATCHDOG_HEARTBEAT_STALE_MS less one loop interval: the heartbeat is
// stamped once per cycle, so a longer pass reads as a wedged loop and the daemon
// kickstarts the watchdog out from under it.
const WATCHDOG_PASS_TIMEOUT_SECONDS = 200;

// Log rotation for both script forms. copytruncate (copy then truncate-in-place)
// keeps launchd's open append fd valid so it resumes writing at offset 0 after we
// shrink the file.
const ROTATE_LOGS_SH = `MAX_LOG_BYTES=52428800
rotate_log() {
  [ -f "\$1" ] || return 0
  sz=\$(wc -c < "\$1" 2>/dev/null | tr -d '[:space:]')
  [ "\${sz:-0}" -gt "\$MAX_LOG_BYTES" ] || return 0
  cp "\$1" "\$1.1" 2>/dev/null && : > "\$1" && log "rotated \$1 (\$sz bytes)"
}
rotate_logs() {
  for f in launchd.err.log launchd.out.log daemon.log; do
    rotate_log "\${HOME}/.codecast/\$f"
  done
}`;

// The daemon's heartbeat tick freezes during system sleep exactly like it does
// when the event loop is wedged — and the watchdog resumes its loop within
// seconds of wake, usually BEFORE the daemon's 30s stamp interval has fired
// again. Judging tick age alone therefore killed a healthy daemon on nearly
// every wake (observed: staleness values matching the wake_detected suspension
// durations, 10-20 forced restarts/day on a napping laptop). The watchdog's own
// gap since its previous pass is the sleep detector: while awake the loop runs
// every WATCHDOG_INTERVAL, so a gap much larger than that means the machine
// slept and the tick's age is meaningless — defer judgment one cycle. A truly
// wedged daemon stays stale while the gap normalizes, so detection is only
// delayed by a single interval.
export const WATCHDOG_AWAKE_GAP_MS = WATCHDOG_INTERVAL_SECONDS * 1000 + 30_000;

// Pure verdict shared by both watchdog forms (dev shell inline check, compiled
// `_watchdog` pass). gapMs is the watchdog's time since its own previous pass;
// null (first pass, missing stamp) defers — a fresh watchdog has no baseline.
export function daemonTickStale(
  tickAgeMs: number,
  gapMs: number | null,
  logAgeMs: number | null = null,
  thresholdMs: number = DAEMON_HEARTBEAT_STALE_MS,
  awakeGapMs: number = WATCHDOG_AWAKE_GAP_MS,
): boolean {
  if (tickAgeMs <= thresholdMs) return false;
  if (gapMs === null || gapMs < 0) return false;
  if (gapMs >= awakeGapMs) return false;
  if (tickAgeMs <= Math.max(thresholdMs, DAEMON_HEARTBEAT_BUSY_GRACE_MS) && logAgeMs !== null && logAgeMs >= 0 && logAgeMs <= thresholdMs) return false;
  return true;
}

// A wedged event loop is judged over TWO consecutive awake passes, not one. The
// hang marker (daemonMarkers.ts) is the reason: three days in a row on one
// machine (2026-09-11 to 09-13) the loop went silent for 50 to 138 seconds and
// came back on its own, and a single-pass rule would have SIGKILLed a daemon
// that was about to recover, throwing away every in-flight delivery with it.
// So the first wedged pass only ARMS: it stamps which daemon (pid) and which
// heartbeat value (tick) it saw. The next pass kills only when the same daemon
// still shows the same unmoved tick AND the marker does not claim the loop
// resumed in between. The marker is the evidence, not the clock: a daemon that
// ticked normally for HANG_SELF_RECOVERED_AFTER_MS rewrites its marker as
// self_recovered, and that rewrite is JS the loop ran, which a truly wedged loop
// cannot do. A pass the sleep guard defers (daemonTickStale false) is not a
// pass at all and clears the arm, so a wake from sleep never counts toward two.
export const WATCHDOG_WEDGED_STAMP_FILENAME = "watchdog.wedged";

// An arm older than this is forgotten: the watchdog itself was down (or the
// machine slept through several intervals) between the two passes, so the pair
// is not consecutive and the count restarts.
export const WATCHDOG_WEDGED_ARM_TTL_MS = 10 * 60 * 1000;

// Mirrors daemonMarkers' HANG_SELF_RECOVERED_AFTER_MS without importing it
// (daemonMarkers imports this module). The marker's detected_at is the END of
// the silence; the self_recovered rewrite lands this much later.
const HANG_RECOVERY_LAG_MS = 5_000;

export const WATCHDOG_KILL_RULE_TWO_PASSES = "two consecutive wedged passes, no self recovery in between";

export interface WedgedPassStamp {
  pid: number;
  tick: number;
  at: number;
}

/** The slice of a hang marker the verdict reads. Structural so the rule needs
 * no import from daemonMarkers. */
export interface HangEvidence {
  pid: number;
  detected_at: number;
  self_recovered: boolean;
}

export type WatchdogKillVerdict =
  | { action: "spare"; reason: string }
  | { action: "arm"; reason: string; stamp: WedgedPassStamp }
  | { action: "kill"; rule: string; reason: string };

export function parseWedgedPassStamp(content: string | null): WedgedPassStamp | null {
  if (content == null) return null;
  try {
    const parsed = JSON.parse(content) as Partial<WedgedPassStamp>;
    if (typeof parsed.pid !== "number" || typeof parsed.tick !== "number" || typeof parsed.at !== "number") return null;
    return { pid: parsed.pid, tick: parsed.tick, at: parsed.at };
  } catch {
    return null;
  }
}

/** True when the marker says the loop resumed on its own AFTER the arming pass
 * saw it wedged. A marker from an earlier stall, or one never rewritten as
 * recovered, is no evidence of recovery between the two passes. */
export function markerRecoveredSince(marker: HangEvidence | null, pid: number, armedAt: number): boolean {
  if (!marker || marker.pid !== pid || !marker.self_recovered) return false;
  return marker.detected_at + HANG_RECOVERY_LAG_MS >= armedAt;
}

/** The kill decision for one watchdog pass. `wedged` is daemonTickStale's
 * answer for this pass; everything else is what the previous pass left behind
 * and what the daemon wrote about itself. Pure, so both watchdog forms and the
 * tests share one rule. */
export function watchdogKillVerdict(input: {
  wedged: boolean;
  pid: number;
  tick: number;
  now: number;
  armed: WedgedPassStamp | null;
  marker: HangEvidence | null;
  armTtlMs?: number;
}): WatchdogKillVerdict {
  const { wedged, pid, tick, now, armed, marker } = input;
  const armTtlMs = input.armTtlMs ?? WATCHDOG_WEDGED_ARM_TTL_MS;
  if (!wedged) return { action: "spare", reason: "tick fresh, busy, or the pass followed a sleep" };
  const stamp: WedgedPassStamp = { pid, tick, at: now };
  const consecutive = armed !== null && armed.pid === pid && armed.tick === tick && now - armed.at >= 0 && now - armed.at <= armTtlMs;
  if (!consecutive) {
    return { action: "arm", reason: "first wedged pass for this stall; killing only if the next pass agrees", stamp };
  }
  if (markerRecoveredSince(marker, pid, armed!.at)) {
    return { action: "arm", reason: "hang marker says the loop resumed on its own after the first wedged pass; counting again from this pass", stamp };
  }
  return { action: "kill", rule: WATCHDOG_KILL_RULE_TWO_PASSES, reason: `tick unmoved since the pass ${Math.round((now - armed!.at) / 1000)}s ago and no recovery marker since` };
}

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
# A watchdog bootstrapped from inside a Claude Code session would hand that
# session's markers to every daemon it revives (agentEnv.ts).
${AGENT_ENV_UNSET_SH}
LOGFILE="\${HOME}/.codecast/${WATCHDOG_LOG_FILENAME}"
HEARTBEAT="\${HOME}/.codecast/${WATCHDOG_HEARTBEAT_FILENAME}"
log() { printf '[%s] %s\\n' "\$(date '+%Y-%m-%d %H:%M:%S')" "\$1" >> "\$LOGFILE"; }

# Resident KeepAlive supervisor loop (see supervision.ts header for why this is not
# a launchd StartInterval job). Suspends on sleep, resumes on wake, rechecks within
# WATCHDOG_INTERVAL of the Mac being awake.
WATCHDOG_INTERVAL=${WATCHDOG_INTERVAL_SECONDS}
${ROTATE_LOGS_SH}

check_once() {
  # Stamp liveness first so the daemon's mutual supervision can tell the loop is
  # alive (not merely launchd-loaded). Epoch ms matches daemon.state tick units.
  # The PREVIOUS stamp is kept as this cycle's sleep detector: a gap far beyond
  # the loop interval means the machine was suspended, and the daemon's tick age
  # is then meaningless (see daemonTickStale in supervision.ts).
  NOW_MS=\$(( \$(date +%s) * 1000 ))
  PREV_BEAT=\$(tr -cd '0-9' < "\$HEARTBEAT" 2>/dev/null)
  LOOP_GAP=-1
  [ -n "\$PREV_BEAT" ] && LOOP_GAP=\$(( NOW_MS - PREV_BEAT ))
  printf '%s' "\$NOW_MS" > "\$HEARTBEAT" 2>/dev/null

  rotate_logs

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
  ARMED=0
  WEDGED_FILE="\${HOME}/.codecast/${WATCHDOG_WEDGED_STAMP_FILENAME}"
  MARKER_FILE="\${HOME}/.codecast/daemon-hang.json"
  STATE_FILE="\${HOME}/.codecast/daemon.state"
  if [ "\$RUNNING" -eq 1 ] && [ -f "\$STATE_FILE" ]; then
    TICK=\$(sed -n 's/.*"lastHeartbeatTick"[[:space:]]*:[[:space:]]*\\([0-9][0-9]*\\).*/\\1/p' "\$STATE_FILE")
    [ -z "\$TICK" ] && TICK=\$(sed -n 's/.*"lastWatchdogCheck"[[:space:]]*:[[:space:]]*\\([0-9][0-9]*\\).*/\\1/p' "\$STATE_FILE")
    if [ -n "\$TICK" ] && [ "\$TICK" -gt 0 ]; then
      AGE=\$(( NOW_MS - TICK ))
      if [ "\$AGE" -gt ${DAEMON_HEARTBEAT_STALE_MS} ]; then
        # Only a stale tick observed across a continuously-awake cycle means a
        # wedged event loop. A large gap in our OWN loop = the machine slept and
        # the daemon may simply not have re-stamped yet — give it one cycle.
        if [ "\$LOOP_GAP" -ge 0 ] && [ "\$LOOP_GAP" -lt ${WATCHDOG_AWAKE_GAP_MS} ]; then
          # GNU stat takes -c, BSD stat takes -f; -f on GNU is file system mode and
          # prints several lines, so accept digits only or the age arithmetic aborts the shell.
          LOG_MTIME=\$(stat -c %Y "\${HOME}/.codecast/daemon.log" 2>/dev/null || stat -f %m "\${HOME}/.codecast/daemon.log" 2>/dev/null || echo 0)
          case "\$LOG_MTIME" in ''|*[!0-9]*) LOG_MTIME=0;; esac
          LOG_AGE=\$(( NOW_MS - LOG_MTIME * 1000 ))
          if [ "\$AGE" -le ${DAEMON_HEARTBEAT_BUSY_GRACE_MS} ] && [ "\$LOG_MTIME" -gt 0 ] && [ "\$LOG_AGE" -le ${DAEMON_HEARTBEAT_STALE_MS} ]; then
            log "Daemon tick stale (\${AGE}ms) but daemon.log written \${LOG_AGE}ms ago - busy, not wedged"
          else
            # Wedged on this pass. The kill needs the PREVIOUS pass to have seen
            # the same daemon with the same unmoved tick, and the hang marker to
            # show no self recovery since (watchdogKillVerdict in supervision.ts).
            DAEMON_PID=\$(tr -cd '0-9' < "\${HOME}/.codecast/daemon.pid" 2>/dev/null)
            DAEMON_PID=\${DAEMON_PID:-0}
            ARMED_PID=\$(sed -n 's/.*"pid"[[:space:]]*:[[:space:]]*\\([0-9][0-9]*\\).*/\\1/p' "\$WEDGED_FILE" 2>/dev/null)
            ARMED_TICK=\$(sed -n 's/.*"tick"[[:space:]]*:[[:space:]]*\\([0-9][0-9]*\\).*/\\1/p' "\$WEDGED_FILE" 2>/dev/null)
            ARMED_AT=\$(sed -n 's/.*"at"[[:space:]]*:[[:space:]]*\\([0-9][0-9]*\\).*/\\1/p' "\$WEDGED_FILE" 2>/dev/null)
            CONSECUTIVE=0
            if [ -n "\$ARMED_AT" ] && [ "\$ARMED_PID" = "\$DAEMON_PID" ] && [ "\$ARMED_TICK" = "\$TICK" ]; then
              ARM_AGE=\$(( NOW_MS - ARMED_AT ))
              [ "\$ARM_AGE" -ge 0 ] && [ "\$ARM_AGE" -le ${WATCHDOG_WEDGED_ARM_TTL_MS} ] && CONSECUTIVE=1
            fi
            RECOVERED=0
            if [ "\$CONSECUTIVE" -eq 1 ] && grep -q '"self_recovered"[[:space:]]*:[[:space:]]*true' "\$MARKER_FILE" 2>/dev/null; then
              M_PID=\$(sed -n 's/.*"pid"[[:space:]]*:[[:space:]]*\\([0-9][0-9]*\\).*/\\1/p' "\$MARKER_FILE")
              M_AT=\$(sed -n 's/.*"detected_at"[[:space:]]*:[[:space:]]*\\([0-9][0-9]*\\).*/\\1/p' "\$MARKER_FILE")
              [ "\$M_PID" = "\$DAEMON_PID" ] && [ -n "\$M_AT" ] && [ \$(( M_AT + ${HANG_RECOVERY_LAG_MS} )) -ge "\$ARMED_AT" ] && RECOVERED=1
            fi
            if [ "\$CONSECUTIVE" -eq 1 ] && [ "\$RECOVERED" -eq 0 ]; then
              STALE=1
              rm -f "\$WEDGED_FILE"
              printf '{"detected_at":%s,"pid":%s,"unresponsive_ms":%s,"hot_stacks":"","self_recovered":false,"watchdog_rule":"%s"}' \\
                "\$NOW_MS" "\$DAEMON_PID" "\$AGE" "${WATCHDOG_KILL_RULE_TWO_PASSES}" > "\$MARKER_FILE" 2>/dev/null
              log "Daemon alive but heartbeat stale (\${AGE}ms) on two consecutive passes and no recovery marker since - ${WATCHDOG_KILL_RULE_TWO_PASSES}, forcing restart"
            else
              ARMED=1
              printf '{"pid":%s,"tick":%s,"at":%s}' "\$DAEMON_PID" "\$TICK" "\$NOW_MS" > "\$WEDGED_FILE" 2>/dev/null
              if [ "\$RECOVERED" -eq 1 ]; then
                log "Daemon heartbeat stale (\${AGE}ms) but the hang marker says the loop resumed after the first wedged pass - counting again from this pass"
              else
                log "Daemon heartbeat stale (\${AGE}ms) - first wedged pass, killing only if the next pass agrees"
              fi
            fi
          fi
        else
          log "Daemon heartbeat stale (\${AGE}ms) but watchdog loop gap (\${LOOP_GAP}ms) implies system sleep - deferring one cycle"
        fi
      fi
    fi
  fi

  # Any pass that did not arm clears the arm: a fresh tick, a busy daemon, a
  # sleep wake, or a dead process all restart the count.
  [ "\$ARMED" -eq 0 ] && rm -f "\$WEDGED_FILE" 2>/dev/null

  [ "\$RUNNING" -eq 1 ] && [ "\$STALE" -eq 0 ] && return 0

  # The daemon can declare its own exit terminal (EXIT_DO_NOT_RESTART): no HOME,
  # an unusable ~/.codecast — facts a restart cannot change. Reviving it every
  # minute just reruns the same failure and buries the reason in the log. The
  # stamp is cleared by the next daemon that boots past the config gate, so
  # \`cast start\` after the fix re-arms this loop.
  EXIT_STAMP="\${HOME}/.codecast/${DAEMON_EXIT_STAMP_FILE}"
  if [ -f "\$EXIT_STAMP" ] && grep -q '"code"[[:space:]]*:[[:space:]]*${EXIT_DO_NOT_RESTART}' "\$EXIT_STAMP" 2>/dev/null; then
    REASON=\$(sed -n 's/.*"reason"[[:space:]]*:[[:space:]]*"\\([^"]*\\)".*/\\1/p' "\$EXIT_STAMP")
    log "Daemon exited ${EXIT_DO_NOT_RESTART} (do not restart): \${REASON:-config error} - fix it and run 'cast start'"
    return 0
  fi

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
# A watchdog bootstrapped from inside a Claude Code session would hand that
# session's markers to every daemon it revives (agentEnv.ts).
${AGENT_ENV_UNSET_SH}
LOGFILE="\${HOME}/.codecast/${WATCHDOG_LOG_FILENAME}"
HEARTBEAT="\${HOME}/.codecast/${WATCHDOG_HEARTBEAT_FILENAME}"
log() { printf '[%s] %s\\n' "\$(date '+%Y-%m-%d %H:%M:%S')" "\$1" >> "\$LOGFILE"; }
WATCHDOG_INTERVAL=${WATCHDOG_INTERVAL_SECONDS}
PASS_TIMEOUT=${WATCHDOG_PASS_TIMEOUT_SECONDS}
DL_HOST="https://dl.codecast.sh"
${ROTATE_LOGS_SH}

# One pass under a hard deadline. This loop is the only thing that revives a dead
# daemon, and it runs passes in the foreground, so a pass that never returns ends
# all supervision (2026-09-15 and 2026-09-20: daemon dead until a manual kickstart).
# A killed pass exits 137 and takes the same failed-pass path as any other.
run_pass() {
  "\$@" 2>>"\$LOGFILE" &
  PASS_PID=\$!
  WAITED=0
  while kill -0 "\$PASS_PID" 2>/dev/null; do
    if [ "\$WAITED" -ge "\$PASS_TIMEOUT" ]; then
      log "Watchdog pass still running after \${PASS_TIMEOUT}s - killing it so the loop keeps supervising"
      kill -9 "\$PASS_PID" 2>/dev/null
      break
    fi
    sleep 1
    WAITED=\$(( WAITED + 1 ))
  done
  wait "\$PASS_PID"
}

run_check() {
  # Stamp liveness first (see dev branch). Epoch ms matches daemon.state tick units.
  printf '%s' "\$(( \$(date +%s) * 1000 ))" > "\$HEARTBEAT" 2>/dev/null

  rotate_logs

  run_pass ${watchdogCommand} && return 0
  log "Watchdog failed (exit \$?), checking for update"

  LATEST="\$(curl -fsSL --connect-timeout 10 --max-time 30 "\$DL_HOST/latest.json" 2>/dev/null)" || { log "Failed to fetch latest.json"; return 1; }
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
  curl -fsSL --connect-timeout 10 --max-time 180 "\$DL_HOST/codecast-\$P-\$A" -o "\$TMP" 2>>"\$LOGFILE" || { rm -f "\$TMP"; log "Download failed"; return 1; }
  mv "\$TMP" "\$DIR/codecast" && chmod +x "\$DIR/codecast"
  printf '%s' "\$VERSION" > "\$LAST_DL_FILE"
  log "Installed v\$VERSION, retrying watchdog"

  run_pass "\$DIR/codecast" -- _watchdog || { log "Still failed after update"; return 1; }
}

while :; do
  run_check
  sleep "\$WATCHDOG_INTERVAL"
done
`;
}
