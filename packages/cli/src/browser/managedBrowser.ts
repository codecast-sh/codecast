/**
 * The one managed Chrome on this machine.
 *
 * Launched from a clone of the human's Chrome profile (profile.ts) so agents
 * inherit their logins, on a debugging port recorded in the state file
 * (instance.ts), and — on macOS — without taking focus: it opens behind
 * whatever the human is doing. Both driver paths share it: the built-in CDP
 * driver drives its tabs directly, and the agent-browser engine attaches to it
 * over CDP with one pinned tab per session (engine.ts). Either way there is
 * exactly one browser window to look at, and the web's "open tab" link can
 * raise a tab in it (focusHttp.ts).
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { browserSocketUrl } from "./cdp.js";
import {
  acquireStartLock, freePort, killStrayChrome, launchManagedChrome, probeLiveness, readState,
  waitForStraysGone, writeState, type InstanceState,
} from "./instance.js";
import {
  chromeUserDataRoot, clonePath, cloneProfile, formatBytes, googleSessionSeparated, listRealProfiles, separateGoogleSession,
  type ChromeChannel, type SeparateReport,
} from "./profile.js";
import { sharesGoogleSession } from "./credentials.js";
import { startRemoteBrowser } from "./remote.js";
import { loadRemoteHost, type RemoteHost } from "../remote/session-move.js";
import { readHosts, ensureUp, toRemoteHost } from "./cloudHost.js";
import { fmt, icons } from "../colors.js";

const OK = `${fmt.success(icons.check)}`;
const WARN = `${fmt.warning("!")}`;

export const DEFAULT_CLONE = "default";

export interface StartOptions {
  profile?: string;
  channel: ChromeChannel;
  headless?: boolean;
  fresh?: boolean;
  resync?: boolean;
  size: string;
  /** Say less: for the implicit start inside `open`. */
  quiet?: boolean;
  /** Run the browser on a remote host (see `cast browser hosts`). */
  remote?: string | boolean;
}

export const DEFAULT_START: StartOptions = { channel: "chrome", size: "1440x900" };

function die(msg: string, hint?: string): never {
  console.error(`${fmt.error(icons.cross)} ${msg}`);
  if (hint) console.error(`  ${fmt.muted(hint)}`);
  process.exit(1);
}

/** One line on the clone's Google session being its own, not the human's.
 *  `kept` counts own-login cookies carried across a resync; -1 says the
 *  clone's existing Google login was its own and was left in place. */
function reportSeparation(d: SeparateReport, kept: number, quiet?: boolean): void {
  if (!quiet) {
    const dropped = d.cookies !== null ? `dropped ${d.cookies} shared Google cookie${d.cookies === 1 ? "" : "s"}` : "no shared cookies";
    const keptNote = kept > 0 ? `; kept the agent browser's own Google login (${kept} cookies)` : kept < 0 ? "; its Google login was its own and stays" : "";
    console.log(`${OK} Google session is the agent browser's own (${dropped}${keptNote})`);
    if (!kept) console.log(fmt.muted("  Chrome signs it in from your account on launch; if a Google page still lands on sign-in, `cast browser login`"));
  }
  for (const n of d.notes) console.log(`${WARN} ${n}`);
}

/** Told to the user when a start queues behind another agent's launch. */
export function waitingOnLaunch(holderPid: number): void {
  console.log(
    fmt.muted(`  another agent (pid ${holderPid}) is starting the browser — waiting for it, then reusing it`),
  );
}


/**
 * Start (or reuse) the local managed browser. Shared by `start` and by `open`'s
 * auto-start, and serialized under the launch lock: when several agents race
 * here, one launches and the rest wait, re-probe, and reuse the winner's
 * browser. Before the lock existed the losers' Chromes handed their command
 * lines to the winner's singleton and exited, each loser reported a cryptic
 * failure, and their retries restarted the browser under everyone else.
 */
export async function startLocalBrowser(o: StartOptions): Promise<InstanceState> {
  const release = await acquireStartLock(undefined, waitingOnLaunch);
  try {
    const existing = readState();
    // Patient on purpose: this is the one probe whose false "dead" leads to
    // killing a live browser. 8s of waiting is cheap; the stampede was not.
    const live = await probeLiveness(existing, 8000);
    if (live === "live") {
      if (!o.quiet) {
        console.log(`${OK} already running on port ${existing!.port} (pid ${existing!.pid})`);
        console.log(fmt.muted("  `cast browser stop` first if you want a different profile"));
      }
      return existing!;
    }
    if (live === "unresponsive") {
      die(
        `a managed browser (pid ${existing!.pid}) exists but CDP is not answering`,
        "it is likely overloaded, not dead — retry shortly, or `cast browser stop` to replace it deliberately",
      );
    }

    const userDataDir = clonePath(DEFAULT_CLONE);
    let sourceProfile: string | null = null;

    if (o.fresh) {
      fs.rmSync(userDataDir, { recursive: true, force: true });
      fs.mkdirSync(userDataDir, { recursive: true, mode: 0o700 });
      if (!o.quiet) console.log(`${OK} fresh profile (logged out of everything)`);
    } else {
      const profiles = listRealProfiles(o.channel);
      const pick = o.profile ?? profiles.find((p) => p.lastUsed)?.dir ?? "Default";
      const known = profiles.find((p) => p.dir === pick);
      sourceProfile = pick;
      const needsClone = o.resync || !fs.existsSync(path.join(userDataDir, "Default", "Cookies"));
      if (needsClone) {
        if (!o.quiet) console.log(`  cloning ${fmt.highlight(known?.name ?? pick)}${known?.email ? fmt.muted(` <${known.email}>`) : ""}…`);
        const res = cloneProfile({ sourceDir: pick, destRoot: userDataDir, channel: o.channel });
        if (!o.quiet) console.log(`${OK} cloned ${res.files} items, ${formatBytes(res.bytes)}`);
        reportSeparation(res.separate, res.ownLoginsKept, o.quiet);
        if (!res.cookiesFound) {
          console.log(
            `${WARN} no cookie store was copied — the browser will start logged out.\n` +
              `  ${fmt.muted("Chrome may have been mid-write; try `cast browser start --resync` with Chrome closed.")}`,
          );
        }
      } else if (!o.quiet) {
        console.log(`  reusing existing clone ${fmt.muted(userDataDir)} ${fmt.muted("(--resync re-copies your Chrome's logins; the agent browser's own Google login is kept)")}`);
      }
    }

    // An abandoned Chrome still holding this profile would swallow the launch.
    // Safe to kill here: the probe above said no live managed browser exists,
    // and the lock keeps another agent's mid-launch Chrome out of this window.
    const strays = killStrayChrome(userDataDir);
    if (strays) {
      console.log(fmt.muted(`  cleared ${strays} stray Chrome process(es) holding the profile`));
      // SIGTERM is not instant; launching while one is still exiting hands our
      // command line to a dying Chrome and nothing ever listens.
      await waitForStraysGone(userDataDir);
    }

    // A clone made before the rule may still hold copies of the human's Google
    // session. Drop them once, now that nothing has the profile open; the
    // stamp keeps this from touching a later, own login.
    if (sourceProfile && !googleSessionSeparated(userDataDir)) {
      const realRoot = chromeUserDataRoot(o.channel);
      const shared = !realRoot || sharesGoogleSession(realRoot, userDataDir, sourceProfile);
      reportSeparation(separateGoogleSession(userDataDir, { dropCookies: shared }), shared ? 0 : -1, o.quiet);
    }

    const [w, h] = o.size.split("x").map((n) => parseInt(n, 10));
    const port = await freePort();
    let pid: number;
    try {
      pid = await launchManagedChrome({
        userDataDir,
        port,
        headless: o.headless,
        channel: o.channel,
        windowSize: { width: w || 1440, height: h || 900 },
      });
    } catch (err) {
      die((err as Error).message);
    }

    const state: InstanceState = {
      pid, port, userDataDir,
      wsUrl: await browserSocketUrl(port).catch(() => undefined),
      headless: !!o.headless,
      sourceProfile,
      channel: o.channel,
      startedAt: Date.now(),
      activeTargetId: null,
    };
    writeState(state);
    console.log(`${OK} browser up — pid ${pid}, CDP 127.0.0.1:${port}${o.headless ? ", headless" : ""}`);
    if (!o.quiet) {
      if (!o.fresh) {
        console.log(
          fmt.muted("  This is a COPY of your profile. The agent's browsing never touches your real Chrome,\n") +
            fmt.muted("  and the copy holds live session cookies — `cast browser stop --wipe` removes it."),
        );
      }
      console.log(fmt.muted("  next: cast browser open <url>"));
    }
    return state;
  } finally {
    release();
  }
}

/**
 * Turn `--remote [name]` into a reachable host, whichever cloud it lives in.
 *
 * Two backends, deliberately different in character:
 *
 *   linux  — an EC2 instance. Stops in seconds and costs only its disk when
 *            idle, so it is the default and the right answer for browser work.
 *   mac    — a Scaleway Apple silicon Mac. Cannot stop at all: Apple's licence
 *            imposes a 24-hour minimum lease, so it bills until deleted. Worth
 *            it only for work that genuinely needs macOS.
 *
 * `ensureUp` hides the difference at the call site — asking for a host is one
 * act whether or not the machine happens to be awake.
 */
export async function resolveRemote(name: string | boolean): Promise<{ host: RemoteHost; label: string; canSleep: boolean }> {
  const wanted = typeof name === "string" ? name.toLowerCase() : "";
  const hosts = readHosts();

  // "mac" (or a Scaleway host id) goes to the Apple silicon registry.
  const wantsMac = wanted === "mac" || wanted === "darwin" || wanted === "scaleway";
  if (wantsMac || (wanted && hosts.every((h) => h.id !== wanted && h.provider !== wanted))) {
    if (wantsMac || !hosts.length) {
      const host = loadRemoteHost(wantsMac ? undefined : wanted || undefined);
      return { host, label: `mac ${host.user}@${host.address}`, canSleep: false };
    }
  }

  const picked =
    hosts.find((h) => h.id === wanted) ??
    hosts.find((h) => h.provider === (wanted === "linux" ? "aws" : wanted)) ??
    hosts.find((h) => h.provider === "aws") ??
    hosts[0];
  if (!picked) {
    die(
      "no remote hosts are registered",
      "add one with `cast browser hosts add` — a Linux box costs about a dollar a month idle",
    );
  }
  const up = await ensureUp(picked, (m) => console.log(fmt.muted(`  ${m}`)));
  return { host: toRemoteHost(up), label: `${up.provider} ${up.id}`, canSleep: true };
}

/**
 * A browser on another machine, reached through an SSH port forward. Its
 * profile starts empty and gains logins as pages are visited (credentials.ts),
 * so nothing of yours is copied there.
 */
export async function startRemoteManagedBrowser(o: StartOptions): Promise<InstanceState> {
  const release = await acquireStartLock(undefined, waitingOnLaunch);
  try {
    const existingRemote = readState();
    const remoteLive = await probeLiveness(existingRemote, 8000);
    if (remoteLive === "live") {
      die("a browser is already running", "`cast browser stop` first");
    }
    if (remoteLive === "unresponsive") {
      die(
        `a managed browser (pid ${existingRemote!.pid}) exists but CDP is not answering`,
        "it is likely overloaded, not dead — retry shortly, or `cast browser stop` to replace it deliberately",
      );
    }
    const resolved = await resolveRemote(o.remote!);
    const host = resolved.host;
    const [rw, rh] = o.size.split("x").map((n) => parseInt(n, 10));
    console.log(`  starting Chrome on ${fmt.highlight(`${host.user}@${host.address}`)}…`);
    let rb;
    try {
      rb = await startRemoteBrowser(host, {
        localPort: await freePort(),
        windowSize: { width: rw || 1440, height: rh || 900 },
      });
    } catch (err) {
      die((err as Error).message);
    }
    writeState({
      pid: rb.sshPid, port: rb.localPort,
      userDataDir: clonePath(DEFAULT_CLONE),   // the LOCAL profile we read cookies from
      headless: true, sourceProfile: null, channel: o.channel,
      startedAt: Date.now(), activeTargetId: null,
      remote: { host: host.address, user: host.user, sshPid: rb.sshPid },
    });
    console.log(`${OK} remote browser up — ${rb.chromeVersion.trim()}`);
    console.log(fmt.muted(`  CDP tunnelled to 127.0.0.1:${rb.localPort}; its profile starts signed out.`));
    console.log(fmt.muted(`  Logins are carried over per site as you navigate — no list to maintain.`));
    return readState()!;
  } finally {
    release();
  }
}

/** Start (or reuse) the managed browser, local or remote. */
export async function startManagedBrowser(o: StartOptions): Promise<InstanceState> {
  return o.remote ? startRemoteManagedBrowser(o) : startLocalBrowser(o);
}

