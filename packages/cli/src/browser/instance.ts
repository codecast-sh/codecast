/**
 * The managed browser instance: launch, attach, persist, tear down.
 *
 * One Chrome per machine, launched from a cloned profile (see profile.ts) with
 * CDP bound to loopback. Its pid/port live in a state file so every `cast
 * browser` invocation is a fresh short-lived process that re-attaches to the
 * SAME browser — the agent's Bash calls are independent, so the browser has to
 * be the thing that persists, not the CLI.
 *
 * Headed by default, unlike the workspace launcher. An agent driving the user's
 * real logged-in profile should be watchable: the human can see what it is
 * doing and take the wheel. `--headless` is available for unattended runs.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { spawn } from "../proc.js";
import { setTimeout as sleep } from "node:timers/promises";
import { isCdpAlive, listTargets, type CdpClient, type CdpTarget } from "./cdp.js";
import { enablePageDomains, TabUnresponsive, type EnablePatience } from "./recovery.js";
import { browserHome, clonePath, chromeUserDataRoot, type ChromeChannel } from "./profile.js";
import { findChromeBinary, chromeBinaryProbes, isPidAlive, ChromeNotFoundError } from "../workspace/chrome.js";

export interface InstanceState {
  pid: number;
  port: number;
  /**
   * The browser-level CDP socket, learned once at launch. Fixed for the life
   * of that Chrome, so every later command connects straight to it instead of
   * asking /json/version first — one HTTP round trip fewer per verb.
   */
  wsUrl?: string;
  userDataDir: string;
  headless: boolean;
  /** Which real Chrome profile this clone came from, for `status` output. */
  sourceProfile: string | null;
  channel: ChromeChannel;
  startedAt: number;
  /** Launched with Chrome's fake camera/mic (a test pattern and a tone), so
   *  getUserMedia works on machines with no devices. Launch-time only. */
  fakeMedia?: boolean;
  /**
   * Set when the browser runs on another machine, reached through an SSH port
   * forward. Its presence is what turns on credential provisioning: a local
   * clone already holds this machine's cookies, so injecting there is wasted
   * work and an unnecessary Keychain prompt.
   */
  remote?: { host: string; user: string; sshPid?: number };
  /**
   * The tab each SESSION is working in, keyed by session id.
   *
   * One browser serves every agent on the machine, so a single global "active
   * tab" made concurrent sessions fight: session A opens a page, session B
   * navigates the same tab to its own, and A's next command acts on B's page —
   * which looks exactly like the app under test misbehaving. Observed in
   * practice on 2026-08-13, where a hijacked tab made a working autocomplete
   * appear broken. Ownership by session keeps them out of each other's way
   * without needing a browser per agent.
   */
  tabsBySession?: Record<string, string>;
  /**
   * When each session in `tabsBySession` last ran a command.
   *
   * The sessions holding tabs are also the sessions holding the browser open:
   * `cast browser stop` only tears Chrome down when the caller is the last one
   * of them (see `planStop`). That needs a way to tell a session that is
   * merely quiet from one that died with its tab still open, or a single dead
   * agent could pin the browser forever. This stamp is that: a holder that has
   * not run anything in `HOLDER_STALE_MS` no longer counts.
   */
  sessionSeenAt?: Record<string, number>;
  /**
   * Viewport emulation per tab, so it survives between commands.
   *
   * `Emulation.setDeviceMetricsOverride` belongs to the CDP session that set
   * it, and each `cast browser` process detaches on exit — so an override
   * applied by one command is gone by the next, and the page silently snaps
   * back to the real window. Recording it here and re-applying on every attach
   * makes "the page is 390 wide" a property of the tab rather than of one
   * command, which is what anyone checking a breakpoint expects.
   */
  viewportByTab?: Record<string, { width: number; height: number; scale: number; mobile: boolean; userAgent?: string }>;
  /**
   * The last URL each tab was ASKED for, and where that request actually
   * landed.
   *
   * Comparing the request against `location.href` alone is not enough, because
   * apps move you: ask codecast for `/inbox` and it settles on `/`. The
   * requested URL then never matches where you are, so every repeat of the same
   * request reloads the whole application — measured at 12s a time — and lands
   * in exactly the same place it already was. Remembering the pair makes the
   * rule honest: repeating a request that already ran, from the page it landed
   * on, is a no-op. Ask for something else, or let the page move elsewhere, and
   * it navigates normally.
   */
  navByTab?: Record<string, { requested: string; landed: string }>;
  /**
   * When `login` last raised the window to the front, machine-wide.
   *
   * The raise steals focus from whatever the human is in, and one browser
   * serves every agent — so a caller re-running `login` (or several sessions
   * blocked on the same sign-in) must not turn into a raise every few seconds.
   * `loginAsPerson` raises at most once per cooldown against this stamp; the
   * command still reports the sign-in is pending, it just leaves focus alone.
   */
  loginRaisedAt?: number;
  /** Fallback for callers with no session (a human at a terminal). */
  activeTargetId: string | null;
}

function statePath(): string {
  return path.join(browserHome(), "instance.json");
}

export function readState(): InstanceState | null {
  try {
    return JSON.parse(fs.readFileSync(statePath(), "utf-8")) as InstanceState;
  } catch {
    return null;
  }
}

export function writeState(state: InstanceState): void {
  fs.mkdirSync(browserHome(), { recursive: true, mode: 0o700 });
  // Atomic: several agents read and write this file concurrently, and a reader
  // catching a half-written file concludes "no managed browser is running" —
  // which sends it off to start a second browser over the live one.
  const tmp = `${statePath()}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, statePath());
}

export function clearState(): void {
  try {
    fs.unlinkSync(statePath());
  } catch {
    /* ignore */
  }
}

export type Liveness = "live" | "unresponsive" | "dead";

/**
 * Three-state liveness, because "not answering" and "gone" demand opposite
 * reactions and conflating them is what caused the shared-browser restart
 * stampede of 2026-08-14: under machine load a single short CDP probe timed
 * out, every agent read that as "dead", and each ran the only recovery the CLI
 * offered — stop/start — killing the healthy browser under all the others.
 *
 * "dead" means the browser process is gone and relaunching is safe.
 * "unresponsive" means the process EXISTS but CDP did not answer within
 * `patienceMs`; the browser is probably just overloaded, and killing or
 * replacing it would destroy every other agent's tabs. Callers must not treat
 * "unresponsive" as permission to relaunch.
 */
export async function probeLiveness(state: InstanceState | null, patienceMs = 4000): Promise<Liveness> {
  if (!state || !isPidAlive(state.pid)) return "dead";
  const deadline = Date.now() + patienceMs;
  for (;;) {
    const left = deadline - Date.now();
    if (left <= 0) return "unresponsive";
    if (await isCdpAlive(state.port, Math.min(Math.max(left, 250), 2000))) return "live";
    if (!isPidAlive(state.pid)) return "dead";
    if (deadline - Date.now() > 0) await sleep(Math.min(400, deadline - Date.now()));
  }
}

/** Is the recorded instance actually alive and answering CDP? */
export async function isLive(state: InstanceState | null, patienceMs?: number): Promise<boolean> {
  return (await probeLiveness(state, patienceMs)) === "live";
}

function chromeBinaryFor(channel: ChromeChannel): string {
  if (channel === "canary") {
    const p = "/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary";
    if (fs.existsSync(p)) return p;
  }
  const bin = findChromeBinary();
  if (!bin) throw new ChromeNotFoundError(chromeBinaryProbes());
  return bin;
}

export interface LaunchOptions {
  userDataDir: string;
  port: number;
  headless?: boolean;
  channel?: ChromeChannel;
  /** Window size for the headed window; also the headless viewport. */
  windowSize?: { width: number; height: number };
  /** Fake camera/mic devices, for machines without real ones. Per-origin
   *  permission is separate: `cast browser grant camera microphone`. */
  fakeMedia?: boolean;
}

/** The Chrome command line for a managed launch. Pure, so the flag set is
 *  testable without spawning a browser. */
export function chromeLaunchArgs(opts: LaunchOptions): string[] {
  const size = opts.windowSize ?? { width: 1440, height: 900 };
  return [
    `--remote-debugging-port=${opts.port}`,
    "--remote-debugging-address=127.0.0.1",
    `--user-data-dir=${opts.userDataDir}`,
    `--window-size=${size.width},${size.height}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-background-networking",
    "--disable-sync",
    "--disable-default-apps",
    "--disable-features=Translate,InterestFeedContentSuggestions,ChromeWhatsNewUI",
    // Restore bubbles and crash bubbles overlay the page and eat clicks.
    "--disable-session-crashed-bubble",
    "--hide-crash-restore-bubble",
    // This window lives BEHIND the human's work by design (focusGuard.ts), and
    // a window another app fully covers reports visibilityState "hidden" —
    // Chrome then freezes requestAnimationFrame, so WebGL surfaces (maplibre,
    // three.js) never paint and screenshots of them come back blank. These
    // first two keep an occluded window's selected tab rendering. Normal timer
    // throttling stays enabled: this Chrome is shared across sessions, so
    // letting every hidden tab run timers at full speed exhausts the host.
    // A MINIMIZED window still freezes regardless (macOS treats minimize as
    // stronger than occlusion), which /json/activate can undo.
    "--disable-backgrounding-occluded-windows",
    "--disable-renderer-backgrounding",
    // A moving test pattern as the camera and a tone as the mic — getUserMedia
    // succeeds without hardware. The permission prompt is still real; the
    // second flag auto-accepts it browser-wide (fake-media launches are for
    // agent verification work, never a human's browsing).
    ...(opts.fakeMedia ? ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"] : []),
    ...(opts.headless ? ["--headless=new"] : []),
    "about:blank",
  ];
}

export async function launchManagedChrome(opts: LaunchOptions): Promise<number> {
  const channel = opts.channel ?? "chrome";
  const bin = chromeBinaryFor(channel);
  fs.mkdirSync(opts.userDataDir, { recursive: true, mode: 0o700 });
  const args = chromeLaunchArgs(opts);

  // On macOS, spawning an app bundle's binary makes the OS activate it, so a
  // launch yanks the screen away from whatever the human is doing. `open -g`
  // starts it without activating; `-n` allows our own instance alongside any
  // Chrome they already have open, and `--args` passes the flags through.
  // Everywhere else, spawning the binary directly is already unobtrusive.
  const useOpen = process.platform === "darwin" && !opts.headless && bin.includes(".app/");
  const appPath = useOpen ? bin.slice(0, bin.indexOf(".app/") + 4) : "";
  const child = useOpen
    ? spawn("open", ["-g", "-n", "-a", appPath, "--args", ...args], {
        stdio: ["ignore", "ignore", "ignore"],
        detached: true,
      })
    : spawn(bin, args, { stdio: ["ignore", "ignore", "ignore"], detached: true });
  let spawnError: Error | null = null;
  child.on("error", (err) => {
    spawnError = err;
  });
  child.unref();
  if (!child.pid) throw new Error("Chrome spawn returned no pid");

  // `open` is a launcher: it hands the request to the OS and exits, so its pid
  // is not Chrome's and dies within moments of a perfectly good launch. The
  // real browser has to be found by the profile directory it holds, which is
  // unique to this instance. Getting this wrong would make every launch look
  // like an immediate crash, and would record a pid that liveness checks read
  // as "the browser is gone" forever after.
  const ownPid = (): number | null => {
    if (!useOpen) return child.pid!;
    // The browser process is the one with no --type=; the rest are renderers
    // and helpers that inherit the flag but exit independently.
    for (const pid of strayPids(opts.userDataDir)) {
      try {
        const { execSync } = require("node:child_process") as typeof import("node:child_process");
        const cmd = execSync(`ps -o command= -p ${pid}`, { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] });
        if (!/--type=/.test(cmd)) return pid;
      } catch {
        /* the process went away between listing and inspecting it */
      }
    }
    return null;
  };

  // Generous, because a cold start on a large cloned profile is slow and the
  // failure mode of giving up early is nasty: Chrome keeps running and holds
  // the profile's singleton lock, so every later launch silently hands off to
  // the instance we already abandoned and appears to do nothing at all.
  const launchedAt = Date.now();
  const deadline = launchedAt + 45_000;
  while (Date.now() < deadline) {
    if (spawnError) throw new Error(`failed to spawn Chrome at '${bin}': ${(spawnError as Error).message}`);
    // Under `open` the launcher exiting is normal and says nothing about
    // Chrome, so the "did it die?" check has to look at the browser itself.
    const alive = useOpen ? strayPids(opts.userDataDir).length > 0 || Date.now() < launchedAt + 5000 : isPidAlive(child.pid);
    if (!alive) {
      // Diagnose honestly: the dominant cause is Chrome's profile singleton —
      // another Chrome still holds this user-data-dir, so our launch forwarded
      // its command line to that instance and exited. Reporting this as a
      // debugging restriction sent agents into destructive recovery (--wipe).
      const holders = strayPids(opts.userDataDir).filter((p) => p !== child.pid);
      if (holders.length) {
        throw new Error(
          `Chrome exited immediately: another Chrome (pid ${holders[0]}) already holds this profile directory, ` +
            `so the new launch handed its command line to that instance and quit. ` +
            `If it is a managed browser another agent just started, re-check with \`cast browser status\`; ` +
            `a leftover one can be cleared with \`cast browser stop\`.`,
        );
      }
      throw new Error(
        `Chrome exited before CDP came up. If this profile directory is Chrome's own default, that is expected — ` +
          `since Chrome 136 the default profile cannot be driven over CDP; clone it instead.`,
      );
    }
    if (await isCdpAlive(opts.port)) {
      const pid = ownPid();
      if (pid) return pid;
      // CDP answers but the process cannot be identified — vanishingly rare,
      // and returning a pid that is not Chrome's is worse than saying so.
      throw new Error("Chrome started and answered CDP, but its process could not be identified");
    }
    await sleep(200);
  }
  try {
    process.kill(child.pid, "SIGTERM");
  } catch {
    /* ignore */
  }
  throw new Error(`Chrome CDP port ${opts.port} never became reachable`);
}

/** Pick a free loopback port by binding to 0 and reading it back. */
export async function freePort(): Promise<number> {
  const net = await import("node:net");
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      srv.close(() => (port ? resolve(port) : reject(new Error("could not allocate a port"))));
    });
  });
}

/** Pids of any Chrome process still holding this user-data-dir. */
export function strayPids(userDataDir: string): number[] {
  try {
    const { execSync } = require("node:child_process") as typeof import("node:child_process");
    // `--` before the pattern: it begins with `--user-data-dir`, which pgrep
    // would otherwise read as an option and reject — silently finding nothing.
    const out = execSync(`pgrep -f -- ${JSON.stringify(`--user-data-dir=${userDataDir}`)}`, {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return out
      .split("\n")
      .map((l) => parseInt(l.trim(), 10))
      .filter((pid) => pid && pid !== process.pid);
  } catch {
    // pgrep exits non-zero when nothing matches — that is the common case.
    return [];
  }
}

/**
 * Kill any Chrome still holding this user-data-dir.
 *
 * Chrome guards a profile directory with a singleton lock. A second launch
 * against a locked directory does not fail — it forwards its command line to
 * the running instance and exits, so the new `--remote-debugging-port` is
 * quietly dropped and the CLI waits out its deadline against a browser that was
 * never going to listen. Any orphan therefore has to go before we launch, or
 * the profile is wedged until the user finds it in Activity Monitor.
 *
 * Callers must only reach this after `probeLiveness` said "dead": on a loaded
 * machine a live shared browser answers CDP slowly, and killing it here is how
 * one agent's "recovery" destroyed five other agents' sessions.
 */
export function killStrayChrome(userDataDir: string, exceptPid?: number): number {
  let killed = 0;
  for (const pid of strayPids(userDataDir)) {
    if (pid === exceptPid) continue;
    try {
      process.kill(pid, "SIGTERM");
      killed++;
    } catch {
      /* already gone */
    }
  }
  return killed;
}

/**
 * Wait for the strays we just SIGTERMed to actually release the profile.
 * Launching while one is still exiting hands our command line to a dying
 * Chrome — the launch "succeeds" and nothing listens.
 */
export async function waitForStraysGone(userDataDir: string, timeoutMs = 5000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (strayPids(userDataDir).length === 0) return true;
    await sleep(200);
  }
  return strayPids(userDataDir).length === 0;
}

/**
 * Serialize browser (re)launches across agent processes.
 *
 * Without this, N agents that each concluded "no browser running" race the
 * check-kill-launch sequence: the first launch wins Chrome's profile singleton,
 * every later launch silently forwards its args to the winner and exits, and
 * each loser then reports a misleading failure and retries — restarting the
 * browser under whoever just started using it. Waiters block here, then
 * re-probe: almost always the winner's browser is up by then and they simply
 * reuse it.
 *
 * The lock is a pid-stamped file created with O_EXCL. It is stolen when its
 * holder is dead or has held it longer than a full launch could take.
 */
export async function acquireStartLock(
  waitMs = 75_000,
  onWait?: (holderPid: number) => void,
): Promise<() => void> {
  const lockFile = path.join(browserHome(), "start.lock");
  fs.mkdirSync(browserHome(), { recursive: true, mode: 0o700 });
  const staleMs = 90_000;
  const deadline = Date.now() + waitMs;
  let announced = false;
  for (;;) {
    try {
      const fd = fs.openSync(lockFile, "wx");
      fs.writeSync(fd, JSON.stringify({ pid: process.pid, at: Date.now() }));
      fs.closeSync(fd);
      const release = () => {
        try {
          fs.unlinkSync(lockFile);
        } catch {
          /* already released */
        }
      };
      // Release on the way out, not just on the normal path. The CLI reports
      // errors through a helper that calls process.exit, which does NOT run
      // `finally` — so a failed launch left the file behind. Reclaiming it
      // relies on the holder pid being dead, which is true immediately but
      // stops being true if that pid is reused, and then every start waits out
      // the staleness timeout for no reason. Observed after a remote start
      // failed on an unreachable host.
      process.once("exit", release);
      // Signals need their own handlers: Node's default disposition for
      // SIGINT/SIGTERM terminates WITHOUT running `exit` listeners, and agents
      // routinely wrap these commands in `timeout`, which sends SIGTERM. Re-
      // raise afterwards so the exit status stays conventional. SIGKILL cannot
      // be caught at all, which is what the staleness reclaim above is for.
      const signals: NodeJS.Signals[] = ["SIGINT", "SIGTERM", "SIGHUP"];
      const onSignal = (sig: NodeJS.Signals) => {
        release();
        cleanup();
        process.kill(process.pid, sig);
      };
      const handlers = signals.map((sig) => {
        const h = () => onSignal(sig);
        process.once(sig, h);
        return [sig, h] as const;
      });
      // bun-types narrows removeListener past Node's signal overloads; the
      // EventEmitter surface is what both runtimes actually implement.
      const emitter = process as NodeJS.EventEmitter;
      const cleanup = () => {
        emitter.removeListener("exit", release);
        for (const [sig, h] of handlers) emitter.removeListener(sig, h);
      };
      return () => {
        cleanup();
        release();
      };
    } catch {
      let holder: { pid?: number; at?: number } = {};
      try {
        holder = JSON.parse(fs.readFileSync(lockFile, "utf-8"));
      } catch {
        /* unreadable — treat as stale below */
      }
      const stale = !holder.pid || !isPidAlive(holder.pid) || !holder.at || Date.now() - holder.at > staleMs;
      if (stale) {
        try {
          fs.unlinkSync(lockFile);
        } catch {
          /* someone else removed it first */
        }
        continue;
      }
      if (Date.now() > deadline) {
        throw new Error(
          `another \`cast browser start\` (pid ${holder.pid}) has held the launch lock for over ${Math.round(waitMs / 1000)}s — ` +
            `if it is stuck, remove ${lockFile}`,
        );
      }
      // Say that we are queued behind another launch. A command that blocks in
      // silence is read as hung, and an agent's response to hung is to kill and
      // retry — the exact reflex this lock exists to prevent.
      if (!announced && holder.pid) {
        announced = true;
        onWait?.(holder.pid);
      }
      await sleep(300);
    }
  }
}

export async function stopInstance(state: InstanceState): Promise<void> {
  if (!isPidAlive(state.pid)) return;
  try {
    process.kill(state.pid, "SIGTERM");
  } catch {
    return;
  }
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (!isPidAlive(state.pid)) return;
    await sleep(150);
  }
  try {
    process.kill(state.pid, "SIGKILL");
  } catch {
    /* ignore */
  }
}

// ---------------------------------------------------------------------------
// Page sessions
// ---------------------------------------------------------------------------

export interface PageSession {
  conn: CdpClient;
  sessionId: string;
  targetId: string;
}

// The wedge classification lives in recovery.ts so the daemon-resident driver
// and this direct path share one implementation; re-exported for callers that
// import it from here.
export { TabUnresponsive };

/**
 * Attach to a target and turn on the domains every command needs.
 *
 * The enables are bounded well below the default. Each one needs the renderer
 * to answer, so a wedged tab hangs here rather than anywhere interesting, and
 * ten seconds is long enough for any healthy page. A blocked tab must fail fast
 * and say how to recover, because the agent cannot see the window.
 */
export async function attachToTarget(conn: CdpClient, targetId: string, patience?: EnablePatience): Promise<PageSession> {
  const { sessionId } = await conn.send<{ sessionId: string }>("Target.attachToTarget", {
    targetId,
    flatten: true,
  });
  await enablePageDomains(conn, sessionId, targetId, patience);
  return { conn, sessionId, targetId };
}

/**
 * Resolve which tab to act on: the explicit target, else the recorded active
 * tab if it still exists, else the most recently opened page.
 */
export async function resolveTarget(
  port: number,
  state: InstanceState,
  explicit?: string,
  sessionId?: string | null,
): Promise<CdpTarget> {
  return pickTarget(await listTargets(port), state, explicit, sessionId);
}

/**
 * The tab-choice policy itself, over an already-fetched tab list. Pure, so the
 * daemon-resident driver (which lists tabs over its own socket) applies exactly
 * the same rules as the direct path.
 */
export function pickTarget(
  targets: CdpTarget[],
  state: InstanceState,
  explicit?: string,
  sessionId?: string | null,
): CdpTarget {
  if (!targets.length) throw new Error("the browser has no open tabs — run `cast browser open <url>`");
  if (explicit) {
    const match =
      targets.find((t) => t.targetId === explicit) ||
      targets.find((t) => t.targetId.toLowerCase().startsWith(explicit.toLowerCase())) ||
      targets.find((t) => t.url.includes(explicit));
    if (!match) throw new Error(`no tab matching '${explicit}'`);
    return match;
  }
  // This session's own tab first — never whichever tab another agent touched
  // most recently.
  const owned = sessionId ? state.tabsBySession?.[sessionId] : undefined;
  if (owned) {
    const match = targets.find((t) => t.targetId === owned);
    if (match) return match;
  }

  // No tab of our own. Falling back to "the most recent tab" is what caused
  // agents to steal each other's pages: the most recent tab is very often the
  // one somebody else just opened. So consider only tabs nobody has claimed,
  // and if there are none, say so rather than trespassing — an agent with no
  // tab should open one, which costs nothing.
  const claimedByOthers = new Set(
    Object.entries(state.tabsBySession ?? {})
      .filter(([sid]) => sid !== sessionId)
      .map(([, id]) => id),
  );
  const free = targets.filter((t) => !claimedByOthers.has(t.targetId));

  if (sessionId && free.length === 0) {
    throw new Error(
      "every open tab belongs to another agent — run `cast browser open --new-tab <url>` to get your own.\n" +
        "  This browser is shared by every agent on the machine; acting on someone else's tab breaks their work.",
    );
  }
  if (!sessionId && state.activeTargetId) {
    const match = targets.find((t) => t.targetId === state.activeTargetId);
    if (match) return match;
  }
  return (free.length ? free : targets)[Math.max(0, (free.length ? free : targets).length - 1)];
}

/**
 * Record which tab this session is working in.
 *
 * Read-modify-write against the file rather than the caller's copy: several
 * agents write this concurrently, and merging into a stale in-memory snapshot
 * would drop whichever claim landed in between.
 */
export function setActiveTarget(state: InstanceState, targetId: string, sessionId?: string | null, now = Date.now()): void {
  const current = readState() ?? state;
  const tabs = { ...(current.tabsBySession ?? {}) };
  const seen = { ...(current.sessionSeenAt ?? {}) };
  if (sessionId) tabs[sessionId] = targetId;
  // The liveness stamp is what keeps this session counted as a holder, but a
  // write on every command is needless churn on a file every agent reads —
  // refresh it once a minute, which is far finer than the staleness window.
  const stampDue = !!sessionId && now - (seen[sessionId] ?? 0) > 60_000;
  if (sessionId && stampDue) seen[sessionId] = now;
  const unchanged =
    current.activeTargetId === targetId &&
    (!sessionId || tabs[sessionId] === current.tabsBySession?.[sessionId]) &&
    !stampDue;
  if (unchanged) return;
  writeState({ ...current, activeTargetId: targetId, tabsBySession: tabs, sessionSeenAt: seen });
}

/** Record where a navigation was aimed and where it ended up. */
export function recordNavigation(targetId: string, requested: string, landed: string): void {
  const cur = readState();
  if (!cur) return;
  writeState({ ...cur, navByTab: { ...(cur.navByTab ?? {}), [targetId]: { requested, landed } } });
}

/** Drop tabs that no longer exist, so the map cannot grow without bound. */
export function pruneTabOwnership(state: InstanceState, liveTargetIds: Set<string>): void {
  const tabs = state.tabsBySession ?? {};
  const kept = Object.fromEntries(Object.entries(tabs).filter(([, id]) => liveTargetIds.has(id)));
  // The per-tab maps are keyed by target id, so a closed tab leaves an entry
  // that can never be reached again. Prune them alongside ownership, or the
  // state file grows for the life of the browser.
  const byTab = <T,>(m: Record<string, T> | undefined) =>
    Object.fromEntries(Object.entries(m ?? {}).filter(([id]) => liveTargetIds.has(id)));
  const nav = byTab(state.navByTab);
  const vp = byTab(state.viewportByTab);
  const shrank =
    Object.keys(kept).length !== Object.keys(tabs).length ||
    Object.keys(nav).length !== Object.keys(state.navByTab ?? {}).length ||
    Object.keys(vp).length !== Object.keys(state.viewportByTab ?? {}).length;
  if (shrank) {
    const seen = Object.fromEntries(Object.entries(state.sessionSeenAt ?? {}).filter(([sid]) => sid in kept));
    writeState({ ...state, tabsBySession: kept, navByTab: nav, viewportByTab: vp, sessionSeenAt: seen });
  }
}

/**
 * Wait until the page has stopped changing.
 *
 * `document.readyState === "complete"` is NOT enough and this is the single
 * biggest source of flaky agent runs: a React app fires it before hydration,
 * so a snapshot taken then shows the shell and none of the content. Measured
 * against github.com/microsoft/playwright-mcp/issues, readyState alone yielded
 * a 94-line snapshot with the entire issue list missing.
 *
 * So we require three things to hold together: the document is complete, no
 * network request has been in flight for `quietMs`, and the DOM has stopped
 * mutating. Requests that never finish (analytics beacons, hanging sockets,
 * long-poll subscriptions) would otherwise pin us open forever, so a request is
 * forgiven once it has been outstanding longer than `staleRequestMs`.
 */
// Counts DOM changes in the page so `settle` can read one number instead of
// diffing the tree. Re-installed after every navigation, since a new document
// gets a new execution context and the old observer goes with the old one.
const OBSERVER_SOURCE = `(() => {
  if (window.__castMut) { window.__castMut.n = 0; return; }
  const s = { n: 0 };
  new MutationObserver(() => { s.n++; }).observe(document, {
    childList: true, subtree: true, attributes: true, characterData: true,
  });
  window.__castMut = s;
})()`;

export async function settle(
  page: PageSession,
  opts: { timeoutMs?: number; quietMs?: number; staleRequestMs?: number; domOnlyQuietMs?: number } = {},
): Promise<{ settled: boolean; reason: string }> {
  const timeoutMs = opts.timeoutMs ?? 15_000;
  const quietMs = opts.quietMs ?? 500;
  const staleRequestMs = opts.staleRequestMs ?? 5_000;
  const domOnlyQuietMs = opts.domOnlyQuietMs ?? 1_500;

  const inflight = new Map<string, number>();
  let lastActivity = Date.now();

  const off = page.conn.on((ev) => {
    if (ev.sessionId !== page.sessionId) return;
    const id = (ev.params as any)?.requestId as string | undefined;
    if (ev.method === "Network.requestWillBeSent" && id) {
      inflight.set(id, Date.now());
      lastActivity = Date.now();
    } else if (
      id &&
      (ev.method === "Network.loadingFinished" ||
        ev.method === "Network.loadingFailed" ||
        ev.method === "Network.requestServedFromCache")
    ) {
      inflight.delete(id);
      lastActivity = Date.now();
    }
  });

  // A MutationObserver in the page is the cheapest DOM-quiet signal there is:
  // no polling of the tree, just a counter we read.
  await page.conn
    .send("Runtime.evaluate", { expression: OBSERVER_SOURCE }, page.sessionId, 2_000)
    .catch(() => {
      /* mid-navigation this never answers; the poll below re-arms it */
    });

  const deadline = Date.now() + timeoutMs;
  let lastMutations = -1;
  let quietSince = 0;
  let domQuietSince = 0;

  while (Date.now() < deadline) {
    await sleep(120);

    // Forgive requests that have hung around too long to be part of the load.
    const now = Date.now();
    for (const [id, started] of inflight) {
      if (now - started > staleRequestMs) inflight.delete(id);
    }

    let ready = "loading";
    let mutations = -1;
    try {
      const r = await page.conn.send<any>(
        "Runtime.evaluate",
        {
          expression: `JSON.stringify([document.readyState, (window.__castMut&&window.__castMut.n)||0])`,
          returnByValue: true,
        },
        page.sessionId,
        2_000,
      );
      [ready, mutations] = JSON.parse(r.result.value);
    } catch {
      // Navigating out from under us. The old execution context is gone along
      // with its observer, so re-arm and keep waiting rather than counting the
      // new document's first paint as quiet.
      quietSince = 0;
      domQuietSince = 0;
      lastMutations = -1;
      await page.conn
        .send("Runtime.evaluate", { expression: OBSERVER_SOURCE }, page.sessionId, 2_000)
        .catch(() => {});
      continue;
    }

    const domQuiet = mutations === lastMutations;
    lastMutations = mutations;
    const netQuiet = inflight.size === 0 && Date.now() - lastActivity > 150;

    if (ready === "complete" && domQuiet) {
      if (!domQuietSince) domQuietSince = Date.now();
    } else {
      domQuietSince = 0;
    }

    if (ready === "complete" && netQuiet && domQuiet) {
      if (!quietSince) quietSince = Date.now();
      if (Date.now() - quietSince >= quietMs) {
        off();
        return { settled: true, reason: "quiet" };
      }
    } else {
      quietSince = 0;
    }

    // A page can be finished while its network never is. Anything that polls —
    // GitHub, Gmail, any app with live updates — keeps requests in flight for
    // as long as it is open, so waiting for network silence there means always
    // waiting the full timeout and then reporting failure on a page that
    // rendered seconds ago. A DOM that has not changed for a good while is the
    // honest signal that rendering is done.
    if (domQuietSince && Date.now() - domQuietSince >= domOnlyQuietMs) {
      off();
      return { settled: true, reason: "render quiet (network still active)" };
    }
  }

  off();
  const why = inflight.size ? `${inflight.size} request(s) still in flight` : "the page kept mutating";
  return { settled: false, reason: why };
}

export { clonePath, chromeUserDataRoot };
