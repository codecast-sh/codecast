/**
 * `cast browser` — drive a real Chrome from the command line.
 *
 * Why a CLI and not an MCP server: codecast agents run under four different
 * harnesses (Claude Code, Codex, Cursor, opencode) and the one thing all of
 * them have is a shell. A CLI verb works everywhere the moment the snippet
 * lands in CLAUDE.md, with no per-harness server configuration, and it composes
 * with the rest of `cast`.
 *
 * The process model that follows from that: every invocation is a new process
 * that re-attaches to a browser which outlives it. Nothing may be held in
 * memory between calls — the tab pointer lives in a state file, and the console
 * recorder lives inside the page.
 *
 * Output is written for a reader who has one screen of context: each action
 * reports what it did and what changed, so an agent does not have to spend a
 * second call asking.
 */

import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Command } from "commander";
import { browserSocketUrl, CdpConnection, listTargets, type CdpClient, type CdpTarget } from "./cdp.js";
import { shortTabId, tabLine } from "./tabId.js";
import {
  acquireStartLock, attachToTarget, clearState, freePort, killStrayChrome, launchManagedChrome, pickTarget,
  probeLiveness, pruneTabOwnership, readState, recordNavigation, setActiveTarget, settle, stopInstance,
  waitForStraysGone, writeState,
  type InstanceState, type PageSession,
} from "./instance.js";
import { describeHolders, planStop, releaseSession } from "./refcount.js";
import { openDriver, type BrowserDriver } from "./driver.js";
import { BrowserNotLive, explainConnectionLoss, isTabUnresponsive } from "./recovery.js";
import {
  browserHome, clonePath, cloneProfile, formatBytes, keepsOwnLogin, listRealProfiles, type ChromeChannel,
} from "./profile.js";
import { matchRefs, nearMatches, snapshotPage } from "./snapshot.js";
import {
  clearViewport, click, clickAt, DEVICES, evaluate, focus, hover, locate, pressKey,
  screenshot, scroll, selectOption, setViewport, type, uploadFiles,
} from "./actions.js";
import { armRecorder, clearRecording, readRecording } from "./observe.js";
import { emitFailureContext } from "./capture.js";
import { pageViewportCapture, parseViewport, runViewportRow, ViewportArgError, viewportChoices } from "./viewports.js";
import { writeShotFile } from "./shotFile.js";
import { autoShotsEnabled, cdpAutoShotSource, clearAutoShots, maybeAutoShot, pruneHashes, setAutoShots } from "./autoShot.js";
import { ownerKey } from "./owner.js";
import { registerEngineCommands } from "./cliEngine.js";
import { DEFAULT_CLONE, resolveRemote, startLocalBrowser, startManagedBrowser, waitingOnLaunch, type StartOptions } from "./managedBrowser.js";
import { ENGINE_MIN_VERSION, ENGINE_PACKAGE, engineFitness, findEngine } from "./engine.js";
import { sameDocument } from "./url.js";
import { loadSitePolicy } from "./policy.js";
import { auditLanding, refuseNavigation, signInLandingNote } from "./siteGuard.js";
import { registerAuditCommand } from "./auditCommand.js";
import { runBatch, type BatchContext } from "./batch.js";
import { provisionCredentials } from "./credentials.js";
import { bridgeEndpoint } from "./bridge/host.js";
import { registerBridgeCommands, targetFlags } from "./bridge/commands.js";
import {
  isRealMode, listRealTargets, ownedRealTab, realTabOwnership, rememberRealTab, requireRealBridge,
  resolveRealTarget, withRealPage,
} from "./bridge/real.js";
import { startRemoteBrowser, stopRemoteBrowser } from "./remote.js";
import { loadRemoteHost, type RemoteHost } from "../remote/session-move.js";
import { readHosts, ensureUp, toRemoteHost, stopHost, hostState, upsertHost, type CloudHost } from "./cloudHost.js";
import { downscaleWithSips, uploadOne } from "../imageCommand.js";
import { inlineImageMarker } from "../inlineImage.js";
import { MAX_IMAGE_SIZE } from "../syncService.js";
import type { PublishDeps } from "../publish.js";
import { fmt, icons } from "../colors.js";

// colors.ts exposes semantic helpers, not raw colour names.
const OK = `${fmt.success(icons.check)}`;
const BAD = `${fmt.error(icons.cross)}`;
const WARN = `${fmt.warning("!")}`;


function die(msg: string, hint?: string): never {
  console.error(`${BAD} ${msg}`);
  if (hint) console.error(`  ${fmt.muted(hint)}`);
  process.exit(1);
}

/**
 * Insist on a live browser and hand back a driver to it. "gone" and "not
 * answering" get different messages on purpose: a dead browser should be
 * restarted, while an overloaded one must NOT be — the recovery agents reach
 * for on "no browser is running" is stop/start, which kills every other
 * agent's tabs. Reporting a busy browser as absent is what set off the
 * 2026-08-14 restart stampede. The words live in recovery.ts.
 */
async function requireDriver(): Promise<BrowserDriver> {
  try {
    return await openDriver();
  } catch (err) {
    if (err instanceof BrowserNotLive) die(err.problem.message, err.problem.hint);
    die(explainConnectionLoss((err as Error).message));
  }
}

/** Every acting command needs a live browser and an attached tab. */
async function withPage<T>(
  opts: { tab?: string; capture?: boolean },
  fn: (page: PageSession, state: InstanceState, conn: CdpClient) => Promise<T>,
  sessionId?: string | null,
): Promise<T> {
  const driver = await requireDriver();
  // Held outside the try so the failure path below can read the page's console,
  // network and pixels at the moment things went wrong.
  let page: PageSession | null = null;
  try {
    const target = pickTarget(await driver.targets(), driver.state, opts.tab, sessionId);
    // Attached, domains on, recorder armed, viewport applied — done once and
    // remembered by the resident driver, or done here on the direct path.
    page = await driver.attach(target.targetId);
    setActiveTarget(driver.state, target.targetId, sessionId);
    return await fn(page, driver.state, driver.conn);
  } catch (err) {
    const msg = explainConnectionLoss((err as Error).message);
    // The debugging trio — console errors, failed requests, a screenshot —
    // gathered at the moment of failure, so the thread shows why the step
    // failed without a second round of commands. The error itself prints last,
    // under the context, the way compilers end with the verdict.
    await emitFailureContext(page, msg, { disabled: opts.capture === false });
    // A stack trace tells an agent nothing it can act on; the message does.
    die(msg);
  } finally {
    driver.close();
  }
}

/**
 * Arguments for every tab this driver opens.
 *
 * `background: true` is the whole point: without it Chrome brings its window
 * forward when a tab appears, so a fleet of agents working in parallel keeps
 * snatching the screen from whatever the human is doing. An agent's browsing
 * should be visible when you go looking for it, never in your way.
 */
const NEW_TAB = { url: "about:blank", background: true } as const;

/** The URL a tab is on, or null if it cannot say. */
async function currentUrl(page: PageSession): Promise<string | null> {
  try {
    const r = await page.conn.send<any>(
      "Runtime.evaluate",
      { expression: "location.href", returnByValue: true },
      page.sessionId,
      3000,
    );
    return typeof r.result?.value === "string" ? r.result.value : null;
  } catch {
    return null;
  }
}

/**
 * One tab per line. `*` marks the caller's own tab and `~` one owned by another
 * agent — the browser is shared, so knowing which pages are somebody else's is
 * what stops a hijacked tab from being mistaken for a broken app.
 */
function describeTab(t: CdpTarget, mine: boolean, otherOwner: boolean): string {
  const mark = mine ? fmt.success("*") : otherOwner ? fmt.warning("~") : " ";
  return `${mark} ${fmt.muted(shortTabId(t.targetId))}  ${(t.title || "(untitled)").slice(0, 46).padEnd(46)} ${fmt.muted(t.url.slice(0, 66))}`;
}

/** Split live tabs into "mine" and "another agent's" for display. */
function ownership(state: InstanceState, sessionId: string | null) {
  const map = state.tabsBySession ?? {};
  const mine = sessionId ? map[sessionId] : state.activeTargetId;
  const others = new Set(Object.entries(map).filter(([sid]) => sid !== sessionId).map(([, id]) => id));
  return { mine, others };
}

/** Print the page header every action shares, so the agent always knows where it is. */
function pageLine(url: string, title: string): string {
  return `${fmt.highlight(title || "(untitled)")}\n${fmt.muted(url)}`;
}


/**
 * Should the engine drive, or our built-in CDP driver?
 *
 * The engine wins whenever it is present, and `cast browser start` installs it,
 * so in practice it always is. `CAST_BROWSER_LEGACY=1` forces the built-in
 * driver — kept as an escape hatch for diagnosing an engine problem without
 * uninstalling anything, and as the honest answer for a machine that cannot
 * install it at all.
 */
function useEngine(): boolean {
  if (process.env.CAST_BROWSER_LEGACY === "1") return false;
  const fit = engineFitness();
  if (fit.ok) return true;
  // Say why, once, on stderr — so a machine quietly running the older driver is
  // diagnosable without anyone having to read this function. "missing" is the
  // ordinary first-run state and needs no announcement; a version we refuse to
  // drive does.
  if (fit.reason === "too-old") {
    process.stderr.write(
      `  ${fmt.warning("!")} browser engine ${fit.version} is older than ${ENGINE_MIN_VERSION}; using the built-in driver.\n` +
        `    Upgrade with: npm install -g ${ENGINE_PACKAGE}@latest\n`,
    );
  }
  return false;
}


export function registerBrowserCommand(program: Command, deps: PublishDeps): void {
  // Which agent is calling. Tabs are owned per session so parallel agents on
  // one machine do not drive each other's pages; a human at a terminal has no
  // session and falls back to the last tab touched.
  const me = (): string | null => ownerKey(deps.detectCurrentSessionId);
  /**
   * Dispatch on target: the managed clone (default) or the user's real Chrome
   * through the extension bridge. Both hand the callback a PageSession whose
   * conn speaks CdpClient, which is why one command body serves both.
   */
  const act = <T>(
    opts: { tab?: string; real?: boolean; clone?: boolean },
    fn: (page: PageSession, state: InstanceState, conn: CdpClient) => Promise<T>,
  ) =>
    isRealMode(opts, me())
      ? withRealPage(opts, fn, me()).catch((err) => die((err as Error).message))
      : withPage(opts, fn, me());

  const br = program
    .command("browser")
    .alias("br")
    .description("Drive a real Chrome: snapshot pages, click, type, screenshot, read console");

  // The agent-browser engine drives everything it covers, which is nearly all
  // of it. Our own CDP driver stays behind it as a fallback for a machine that
  // cannot install the engine — no npm, no network — so `cast browser` keeps
  // working rather than failing on a dependency the agent cannot fix.
  //
  // The choice is made once, at registration, because two implementations of
  // the same verb cannot both be registered and a per-call decision would make
  // the help text lie about what is going to run.
  const hosts = br.command("hosts").description("Remote machines a browser can run on");

  hosts
    .command("ls", { isDefault: true })
    .description("List remote hosts, what they cost, and whether they are awake")
    .action(() => {
      const rows = readHosts();
      if (!rows.length) {
        console.log(fmt.muted("no remote hosts registered — `cast browser hosts add --help`"));
        return;
      }
      for (const h of rows) {
        let line: string;
        try {
          const s = hostState(h);
          const mark = s.state === "running" ? fmt.success("awake") : s.state === "stopped" ? fmt.muted("asleep") : fmt.warning(s.state);
          line = `${mark.padEnd(18)} ${s.address ?? fmt.muted("(no address until it wakes)")}`;
        } catch (err) {
          line = fmt.warning(`state unknown — ${(err as Error).message}`);
        }
        console.log(`  ${h.id.padEnd(22)} ${h.provider.padEnd(13)} ${line}`);
      }
      console.log(
        fmt.muted(
          "\n  A Linux host sleeps when idle and then costs only its disk, about a dollar a month.\n" +
            "  An Apple silicon Mac cannot sleep — Apple's licence sets a 24-hour minimum lease, so it\n" +
            "  bills continuously (~EUR75/month) until deleted. Use one only for work that needs macOS.",
        ),
      );
    });

  hosts
    .command("add <instanceId>")
    .description("Register an existing EC2 instance as a browser host")
    .requiredOption("--key <path>", "SSH private key for it")
    .option("--region <name>", "AWS region", "us-west-2")
    .option("--user <name>", "SSH user for the image", "ubuntu")
    .action((instanceId: string, o: { key: string; region: string; user: string }) => {
      const host: CloudHost = {
        id: instanceId, provider: "aws", region: o.region, user: o.user,
        keyPath: path.resolve(o.key),
      };
      const s = hostState(host);
      if (s.state === "missing") die(`${instanceId} was not found in ${o.region}`);
      upsertHost({ ...host, address: s.address });
      console.log(`${OK} registered ${instanceId} (${s.state})`);
    });

  hosts
    .command("provision [id]")
    .description("Set up a Linux host as a full remote service: display, live stream, idle auto-stop, codecast daemon")
    .option("--idle <minutes>", "Auto-stop after this many idle minutes (0 disables)", "20")
    .option("--no-daemon", "Skip the codecast daemon (browser + stream only; sessions cannot move there)")
    .action(async (id: string | undefined, o: { idle: string; daemon: boolean }) => {
      const rows = readHosts();
      const h = id ? rows.find((r) => r.id === id) : rows.find((r) => r.provider === "aws");
      if (!h) die(id ? `no host ${id}` : "no linux host registered", "`cast browser hosts add <instance-id> --key <pem>` first");
      const idle = parseInt(o.idle, 10);
      const { provisionLinuxHost } = await import("./provisionLinux.js");
      console.log(`provisioning ${h.id} (${h.region})…`);
      const up = await ensureUp(h, (m) => console.log(fmt.muted(`  ${m}`)));
      try {
        const report = await provisionLinuxHost(toRemoteHost(up), { idleStopMinutes: idle, skipDaemon: !o.daemon }, (m) =>
          console.log(fmt.muted(`  ${m}`)),
        );
        upsertHost({ ...up, idleStopMinutes: idle });
        console.log(`${OK} ${h.id} is a full remote service`);
        console.log(`  chrome:   ${report.chrome.trim()}`);
        console.log(`  cast:     ${report.cast.trim()}`);
        console.log(`  claude:   ${report.claude.trim()}`);
        console.log(`  services: ${report.services.trim()}`);
        console.log(`  daemon:   ${report.device.trim()}`);
        console.log(fmt.muted(`  idle auto-stop: ${idle ? `${idle}m` : "disabled"} — it powers itself off and costs only its disk`));
        console.log(fmt.muted(`  watch it: cast browser hosts view`));
      } catch (err) {
        die((err as Error).message);
      }
    });

  hosts
    .command("view [id]")
    .description("Live view of the host's screen — VLC (RTSP) or any browser (HLS), over an SSH tunnel")
    .option("--vlc", "Open it in VLC")
    .action(async (id: string | undefined, o: { vlc?: boolean }) => {
      const rows = readHosts();
      const h = id ? rows.find((r) => r.id === id) : rows.find((r) => r.provider === "aws");
      if (!h) die(id ? `no host ${id}` : "no linux host registered");
      const up = await ensureUp(h, (m) => console.log(fmt.muted(`  ${m}`)));
      const { ensureViewTunnel } = await import("./liveView.js");
      try {
        const v = await ensureViewTunnel(toRemoteHost(up));
        console.log(`${OK} live view is up${v.tunnelPid ? ` (tunnel pid ${v.tunnelPid})` : " (reusing the existing tunnel)"}`);
        console.log(`  VLC:     ${fmt.highlight(v.rtsp)}`);
        console.log(`  browser: ${fmt.highlight(v.hls)}`);
        console.log(fmt.muted("  the stream only encodes while someone is watching; closing the player stops it"));
        if (o.vlc) {
          try {
            execFileSync("open", ["-a", "VLC", v.rtsp], { stdio: "ignore", timeout: 10_000 });
            console.log(`${OK} opened in VLC`);
          } catch {
            console.log(fmt.warning("  VLC is not installed — `brew install --cask vlc`, or open the browser URL"));
          }
        }
      } catch (err) {
        die((err as Error).message);
      }
    });

  hosts
    .command("vnc [id]")
    .description("Interactive view of the host's whole screen (noVNC in your browser) — for anything outside the agent's tab")
    .option("--no-open", "Print the URL without opening it")
    .action(async (id: string | undefined, o: { open: boolean }) => {
      const rows = readHosts();
      const h = id ? rows.find((r) => r.id === id) : rows.find((r) => r.provider === "aws");
      if (!h) die(id ? `no host ${id}` : "no linux host registered");
      const up = await ensureUp(h, (m) => console.log(fmt.muted(`  ${m}`)));
      const { ensureVncTunnel } = await import("./liveView.js");
      try {
        const v = await ensureVncTunnel(toRemoteHost(up));
        console.log(`${OK} VNC is up${v.tunnelPid ? ` (tunnel pid ${v.tunnelPid})` : " (reusing the existing tunnel)"}`);
        console.log(`  ${fmt.highlight(v.url)}`);
        console.log(fmt.muted("  the whole display, with mouse and keyboard — for a page's own sign-in, prefer the CONTROL button in the session's browser view"));
        if (o.open) {
          try { execFileSync("open", [v.url], { stdio: "ignore", timeout: 10_000 }); } catch { /* headless shell */ }
        }
      } catch (err) {
        die((err as Error).message);
      }
    });

  hosts
    .command("shot [id]")
    .description("One screenshot of the host's screen, saved locally")
    .action(async (id: string | undefined) => {
      const rows = readHosts();
      const h = id ? rows.find((r) => r.id === id) : rows.find((r) => r.provider === "aws");
      if (!h) die(id ? `no host ${id}` : "no linux host registered");
      const up = await ensureUp(h, (m) => console.log(fmt.muted(`  ${m}`)));
      const { machineShot } = await import("./liveView.js");
      try {
        const file = machineShot(toRemoteHost(up));
        console.log(file);
      } catch (err) {
        die((err as Error).message);
      }
    });

  hosts
    .command("sleep [id]")
    .description("Stop a host so it stops costing money")
    .action((id: string | undefined) => {
      const rows = readHosts();
      const h = id ? rows.find((r) => r.id === id) : rows.find((r) => r.provider === "aws");
      if (!h) die(id ? `no host ${id}` : "no stoppable host registered");
      try {
        stopHost(h);
        console.log(`${OK} ${h.id} is stopping — it will cost only its disk until something wakes it`);
      } catch (err) {
        die((err as Error).message);
      }
    });

  if (useEngine()) {
    registerEngineCommands(br, deps);
    return;
  }

  // ---------------------------------------------------------------- lifecycle

  br.command("profiles")
    .description("List the Chrome profiles on this machine")
    .option("--channel <name>", "chrome | canary | chromium", "chrome")
    .action((o: { channel: ChromeChannel }) => {
      const profiles = listRealProfiles(o.channel);
      if (!profiles.length) die(`no Chrome profiles found for channel '${o.channel}'`);
      for (const p of profiles) {
        const tag = p.lastUsed ? fmt.success(" (last used)") : "";
        console.log(`  ${p.dir.padEnd(12)} ${fmt.highlight(p.name)}${p.email ? fmt.muted(` <${p.email}>`) : ""}${tag}`);
      }
      console.log(fmt.muted(`\nclone one with: cast browser start --profile "<dir>"`));
    });

  br.command("start")
    .description("Launch the managed browser (clones a Chrome profile so logins carry over)")
    .option("--profile <dir>", "Chrome profile directory to clone (see `cast browser profiles`)")
    .option("--channel <name>", "chrome | canary | chromium", "chrome")
    .option("--headless", "Run without a visible window")
    .option("--fresh", "Start from an empty profile — no cookies, no logins")
    .option("--resync", "Re-copy the profile even if a clone already exists")
    .option("--size <WxH>", "Window size", "1440x900")
    .option("--remote [host]", "Run the browser on a remote Mac, reached over SSH")
    .action(async (o: { profile?: string; channel: ChromeChannel; headless?: boolean; fresh?: boolean; resync?: boolean; size: string; remote?: string | boolean }) => {
      await startManagedBrowser(o);
    });

  br.command("status")
    .description("Is the managed browser running, and on what")
    .action(async () => {
      const state = readState();
      if (!state) return console.log(`${fmt.muted(icons.dot)} not started — \`cast browser start\``);
      const live = await probeLiveness(state);
      if (live === "dead") {
        console.log(`${WARN} recorded instance (pid ${state.pid}) is gone — \`cast browser start\` to relaunch`);
        return;
      }
      if (live === "unresponsive") {
        console.log(
          `${WARN} browser pid ${state.pid} is running but CDP is not answering — ` +
            `likely overloaded; retry shortly rather than restarting it`,
        );
        return;
      }
      const mins = Math.round((Date.now() - state.startedAt) / 60000);
      console.log(`${OK} running  pid ${state.pid}  port ${state.port}  up ${mins}m${state.headless ? "  headless" : ""}`);
      console.log(`  profile: ${state.sourceProfile ? `clone of ${state.sourceProfile}` : "fresh"}  ${fmt.muted(state.userDataDir)}`);
      const driver = await requireDriver();
      try {
        const targets = await driver.targets();
        const { mine, others } = ownership(state, me());
        console.log(`  ${targets.length} tab(s):`);
        for (const t of targets) console.log(`  ${describeTab(t, t.targetId === mine, others.has(t.targetId))}`);
        const holders = Object.keys(state.tabsBySession ?? {}).length;
        console.log(
          fmt.muted(`  driver: ${driver.kind === "resident" ? "resident in the daemon" : "direct (daemon not reachable)"}  ·  ${holders} session(s) holding tabs`),
        );
      } finally {
        driver.close();
      }
    });

  br.command("stop")
    .description("Release your tabs; shuts the browser down when you are the last session using it")
    .option("--wipe", "Also delete the cloned profile and its cookies (implies --force)")
    .option("--force", "Shut it down even if other sessions still have tabs in it")
    .action(async (o: { wipe?: boolean; force?: boolean }) => {
      const state = readState();
      if (!state) return console.log("nothing to stop");
      if (state.remote) {
        const host = loadRemoteHost();
        await stopRemoteBrowser(host, state.remote.sshPid);
        clearState();
        console.log(`${OK} remote browser stopped and its profile wiped`);
        return;
      }
      // One browser serves every agent on this machine, so "stop" is not a
      // private action. The caller gives up its own tabs; only the last session
      // holding any takes Chrome down. Which tabs still exist decides who still
      // counts as a holder, so ask the browser when it can answer.
      const driver = await openDriver().catch(() => null);
      let liveTargetIds: Set<string> | undefined;
      try {
        if (driver) liveTargetIds = new Set((await driver.targets().catch(() => [])).map((t) => t.targetId));
        const plan = planStop(state, me(), { force: !!(o.force || o.wipe), liveTargetIds });
        const who = describeHolders;

        if (plan.action === "refuse") {
          die(
            `${plan.others.length} agent session(s) still have tabs in this browser: ${who(plan.others)}`,
            "this shell has no session identity to release tabs for — `cast browser stop --force` shuts it down for everyone",
          );
        }
        if (plan.action === "release") {
          if (driver) {
            for (const id of plan.myTabs) {
              await driver.detach(id);
              await driver.conn.send("Target.closeTarget", { targetId: id }, undefined, 5000).catch(() => {});
            }
          }
          releaseSession(state, me()!);
          console.log(
            `${OK} released your ${plan.myTabs.length} tab(s); the browser stays up for ${plan.others.length} other session(s): ${who(plan.others)}`,
          );
          console.log(fmt.muted("  `cast browser stop --force` shuts it down for everyone"));
          return;
        }
        if (plan.others.length) {
          console.log(
            `${WARN} ${plan.others.length} other agent session(s) have tabs in this browser — stopping it kills their work too: ${who(plan.others)}`,
          );
        }
      } finally {
        driver?.close();
      }
      await stopInstance(state);
      clearState();
      console.log(`${OK} stopped`);
      if (o.wipe) {
        fs.rmSync(path.join(browserHome(), "profiles"), { recursive: true, force: true });
        console.log(`${OK} wiped the cloned profile`);
      }
    });

  // ------------------------------------------------------- real-Chrome bridge

  registerBridgeCommands(br, { me });

  // ------------------------------------------------------------- navigation

  /**
   * Run a real-mode command body against the bridge's CDP endpoint. Every
   * error is rendered the same way; the body only decides what to do.
   */
  async function inReal<T>(fn: (bridge: Awaited<ReturnType<typeof requireRealBridge>>, conn: CdpConnection) => Promise<T>): Promise<T> {
    let bridge;
    try {
      bridge = await requireRealBridge();
    } catch (err) {
      die((err as Error).message);
    }
    const conn = await CdpConnection.fromPort(bridgeEndpoint(bridge)).catch((err) => die((err as Error).message));
    try {
      return await fn(bridge, conn);
    } catch (err) {
      die(explainConnectionLoss((err as Error).message));
    } finally {
      conn.close();
    }
  }

  /** `open` in real mode: create or reuse this session's own tab and navigate it. */
  async function openReal(url: string, o: { newTab?: boolean; wait: boolean }): Promise<void> {
    const sessionKey = me();
    await inReal(async (bridge, conn) => {
      const targets = await listRealTargets(bridge);
      const owned = ownedRealTab(sessionKey);
      let targetId: string;
      let created = false;
      if (!o.newTab && owned && targets.some((t) => t.targetId === owned)) {
        targetId = owned;
      } else {
        // Never navigate a tab this session does not own: the rest are the
        // human's. A fresh tab costs nothing and is visibly the agent's.
        targetId = (await conn.send<{ targetId: string }>("Target.createTarget", { url })).targetId;
        created = true;
      }
      const page = await attachToTarget(conn, targetId);
      rememberRealTab(sessionKey, targetId);
      await armRecorder(page);
      if (!created) await conn.send("Page.navigate", { url }, page.sessionId);
      if (o.wait !== false) {
        const r = await settle(page);
        if (!r.settled) console.log(fmt.muted(`  (did not fully settle: ${r.reason})`));
      }
      const snap = await snapshotPage(page, { maxChars: 1 });
      console.log(pageLine(snap.url, snap.title));
      console.log(fmt.muted(`  real tab ${shortTabId(targetId)} — Chrome shows its debugging banner while cast drives it`));
    });
  }

  targetFlags(br.command("open <url>"))
    .description("Open a URL (starts the browser if needed)")
    .option("--new-tab", "Open in a new tab instead of the current one")
    .option("--no-wait", "Return without waiting for the page to settle")
    .option("--reload", "Load the page again even if the tab is already on it")
    .option("--no-capture", "Skip the automatic failure context (console, network, screenshot)")
    .option("--no-shot", "Skip the automatic screenshot")
    .action(async (url: string, o: { newTab?: boolean; wait: boolean; reload?: boolean; capture: boolean; shot?: boolean; real?: boolean; clone?: boolean }) => {
      if (!/^[a-z]+:\/\//i.test(url)) url = `https://${url}`;
      if (isRealMode(o, me())) return openReal(url, o);

      // The site policy gate. Before any browser work at all — a refused
      // navigation must not even auto-start Chrome. This binds only THIS
      // session's commands; other agents' tabs are never touched.
      const policy = loadSitePolicy();
      const deny = refuseNavigation(url, me(), "open", policy);
      if (deny) die(deny.message, deny.hint);

      let driver: BrowserDriver;
      try {
        driver = await openDriver();
      } catch (err) {
        if (!(err instanceof BrowserNotLive)) die(explainConnectionLoss((err as Error).message));
        if (err.liveness !== "dead") die(err.problem.message, err.problem.hint);
        // Keep the command's promise ("starts the browser if needed"). The
        // launch lock makes this safe under contention: concurrent auto-starts
        // collapse into one launch that everyone reuses.
        console.log(fmt.muted("  no managed browser is running — starting one"));
        await startLocalBrowser({ channel: "chrome", size: "1440x900" });
        driver = await openDriver().catch(() => {
          die("the browser did not come up after auto-start", "try `cast browser start` directly");
        });
      }
      const s = driver.state;
      const sessionId = me();
      const conn = driver.conn;
      // Outside the try so the failure path can capture the page's context.
      let page: PageSession | null = null;
      try {
        let targetId: string;
        const targets = await driver.targets();
        const blank = targets.find((t) => t.url === "about:blank");
        const mine = sessionId ? s.tabsBySession?.[sessionId] : null;
        if (o.newTab || !targets.length) {
          const res = await conn.send<{ targetId: string }>("Target.createTarget", NEW_TAB);
          targetId = res.targetId;
        } else if (mine && targets.some((t) => t.targetId === mine)) {
          // Reuse the tab this session already owns rather than the last tab
          // anyone touched — otherwise two agents navigating at once trade
          // pages under each other.
          targetId = mine;
        } else if (blank) {
          targetId = blank.targetId;
        } else {
          // No tab of our own and none spare: take a new one instead of
          // commandeering a page another agent may be mid-flow on.
          const res = await conn.send<{ targetId: string }>("Target.createTarget", NEW_TAB);
          targetId = res.targetId;
        }

        // A wedged tab must not block a navigation request. `open` means "get me
        // to this URL", so if the tab we picked has stopped answering we say so
        // and go to a fresh one rather than failing the whole command — the
        // agent asked for a page, not for that particular tab.
        // The attach also arms the recorder BEFORE we navigate, so it sees the
        // page's own boot logs — the errors an agent is usually looking for
        // happen during startup.
        try {
          page = await driver.attach(targetId);
        } catch (err) {
          // isTabUnresponsive, not instanceof: the verdict may have been
          // raised across a process boundary and revived by name (recovery.ts).
          if (!isTabUnresponsive(err)) throw err;
          console.log(fmt.muted(`  ${tabLine(targetId, "was not responding, opening a new one")}`));
          const res = await conn.send<{ targetId: string }>("Target.createTarget", NEW_TAB);
          targetId = res.targetId;
          page = await driver.attach(targetId);
        }
        // Carry this machine's login for the site we are about to open. Only
        // for a remote browser, and only when it has none of its own — see
        // credentials.ts for why navigation is what picks the sites.
        if (s.remote) {
          const cred = await provisionCredentials(page, url, s.userDataDir).catch(
            (err) => ({ injected: 0, host: url, reason: (err as Error).message }),
          );
          if (cred.injected) {
            console.log(fmt.muted(`  carried ${cred.injected} cookie(s) for ${cred.host} from this machine`));
          }
        }

        // Don't reload a page we are already on.
        //
        // `open` reads as "get me to this URL", and an agent re-running it to
        // re-orient — or a batch that opens before acting — should not throw
        // away a loaded page. Reloading costs seconds, discards scroll position
        // and any state the agent just built up, and on a heavy app it is the
        // difference between instant and unusable. `--reload` forces it.
        const already = await currentUrl(page);
        const lastNav = s.navByTab?.[targetId];
        // Either we are already on the page asked for, or this exact request
        // has already run in this tab and the page has not moved since — in
        // which case running it again would land in the same place at the cost
        // of a full load.
        const requestAlreadyRan =
          !!lastNav && already !== null && sameDocument(lastNav.requested, url) && sameDocument(lastNav.landed, already);
        const sameUrl = !o.reload && already !== null && (sameDocument(already, url) || requestAlreadyRan);
        if (sameUrl) {
          const detail = sameDocument(already!, url) ? "" : ` (it redirected here last time)`;
          console.log(fmt.muted(`  already on this page${detail} — reusing it (--reload to load it again)`));
        } else {
          await conn.send("Page.navigate", { url }, page.sessionId);
        }
        setActiveTarget(s, targetId, sessionId);

        if (o.wait !== false && !sameUrl) {
          const r = await settle(page);
          if (!r.settled) console.log(fmt.muted(`  (did not fully settle: ${r.reason})`));
        }
        const snap = await snapshotPage(page, { maxChars: 1 });
        if (!sameUrl) recordNavigation(targetId, url, snap.url);
        console.log(pageLine(snap.url, snap.title));
        // Audit where the tab actually LANDED — a redirect can differ from
        // what was asked for, and if it left the allowlist, say so loudly.
        const landed = auditLanding({ url: snap.url, tab: targetId, session: me(), via: "open", policy });
        if (landed) console.log(`${WARN} ${landed}`);
        const signIn = signInLandingNote(snap.url, keepsOwnLogin);
        if (signIn) console.log(`${WARN} ${signIn}`);
        console.log(fmt.muted(`  ${tabLine(targetId, "next: cast browser snapshot")}`));
        await emitAutoShot(page, o.shot);
      } catch (err) {
        const msg = explainConnectionLoss((err as Error).message);
        await emitFailureContext(page, msg, { disabled: o.capture === false });
        die(msg);
      } finally {
        driver.close();
      }
    });

  for (const [name, desc, method] of [
    ["back", "Go back in history", "back"],
    ["forward", "Go forward in history", "forward"],
  ] as const) {
    targetFlags(br.command(name))
      .description(desc)
      .option("--no-shot", "Skip the automatic screenshot")
      .option("--tab <id>", "Act on a specific tab")
      .action(async (o: { shot?: boolean; tab?: string }) => {
        await act(o, async (page) => {
          const hist = await page.conn.send<any>("Page.getNavigationHistory", {}, page.sessionId);
          const idx = method === "back" ? hist.currentIndex - 1 : hist.currentIndex + 1;
          const entry = hist.entries[idx];
          if (!entry) die(`nothing to go ${method === "back" ? "back" : "forward"} to`);
          await page.conn.send("Page.navigateToHistoryEntry", { entryId: entry.id }, page.sessionId);
          await settle(page);
          const snap = await snapshotPage(page, { maxChars: 1 });
          console.log(pageLine(snap.url, snap.title));
          const landed = auditLanding({ url: snap.url, tab: page.targetId, session: me(), via: "history", policy: loadSitePolicy() });
          if (landed) console.log(`${WARN} ${landed}`);
          await emitAutoShot(page, o.shot);
        });
      });
  }

  targetFlags(br.command("reload"))
    .description("Reload the page")
    .option("--hard", "Bypass the cache")
    .option("--no-shot", "Skip the automatic screenshot")
    .option("--tab <id>", "Act on a specific tab")
    .action(async (o: { hard?: boolean; shot?: boolean; tab?: string }) => {
      await act(o, async (page) => {
        await page.conn.send("Page.reload", { ignoreCache: !!o.hard }, page.sessionId);
        await settle(page);
        const snap = await snapshotPage(page, { maxChars: 1 });
        console.log(pageLine(snap.url, snap.title));
        const landed = auditLanding({ url: snap.url, tab: page.targetId, session: me(), via: "reload", policy: loadSitePolicy() });
        if (landed) console.log(`${WARN} ${landed}`);
        await emitAutoShot(page, o.shot);
      });
    });

  // ------------------------------------------------------------------- tabs

  targetFlags(br.command("tabs"))
    .description("List open tabs")
    .action(async (o: { real?: boolean; clone?: boolean }) => {
      if (isRealMode(o, me())) {
        await inReal(async (bridge) => {
          const targets = await listRealTargets(bridge);
          const { mine, others } = realTabOwnership(me());
          for (const t of targets) console.log(describeTab(t, t.targetId === mine, others.has(t.targetId)));
          console.log(
            fmt.muted("\n  your real Chrome, via the cast extension. Unmarked tabs are the human's — do not drive them uninvited."),
          );
        });
        return;
      }
      const driver = await requireDriver();
      try {
        const state = driver.state;
        const targets = await driver.targets();
        const { mine, others } = ownership(state, me());
        for (const t of targets) console.log(describeTab(t, t.targetId === mine, others.has(t.targetId)));
        if (others.size) {
          console.log(fmt.muted(`\n  ~ = another agent's tab. Yours is marked *; pass --tab to be explicit.`));
        }
        const liveIds = new Set(targets.map((t) => t.targetId));
        pruneTabOwnership(state, liveIds);
        pruneHashes(liveIds);
      } finally {
        driver.close();
      }
    });

  targetFlags(br.command("tab <id>"))
    .description("Switch the active tab (id prefix or a substring of its URL)")
    .option("--show", "Also raise the browser window (steals focus)")
    .action(async (id: string, o: { real?: boolean; clone?: boolean; show?: boolean }) => {
      if (isRealMode(o, me())) {
        await inReal(async (bridge, conn) => {
          const target = resolveRealTarget(await listRealTargets(bridge), id, me());
          rememberRealTab(me(), target.targetId);
          await conn.send("Target.activateTarget", { targetId: target.targetId });
          console.log(`${OK} active real tab: ${target.title || target.url}`);
        });
        return;
      }
      const driver = await requireDriver();
      try {
        const target = pickTarget(await driver.targets(), driver.state, id, me());
        setActiveTarget(driver.state, target.targetId, me());
        // Raising the window is opt-in. Doing it on every `tab` pulled Chrome in
        // front of whatever the human was working in, and with a fleet of agents
        // switching tabs that means the browser is constantly taking the screen.
        if (o.show) {
          const page = await driver.attach(target.targetId);
          await driver.conn.send("Page.bringToFront", {}, page.sessionId).catch(() => {});
        }
        console.log(`${OK} active tab: ${target.title || target.url}`);
      } catch (err) {
        die(explainConnectionLoss((err as Error).message));
      } finally {
        driver.close();
      }
    });

  targetFlags(br.command("close"))
    .description("Close a tab")
    .option("--tab <id>", "Which tab (default: the active one)")
    .action(async (o: { tab?: string; real?: boolean; clone?: boolean }) => {
      if (isRealMode(o, me())) {
        await inReal(async (bridge, conn) => {
          const target = resolveRealTarget(await listRealTargets(bridge), o.tab, me());
          await conn.send("Target.closeTarget", { targetId: target.targetId });
          console.log(`${OK} closed real tab ${shortTabId(target.targetId)} (${target.title || target.url})`);
        });
        return;
      }
      const driver = await requireDriver();
      try {
        const state = driver.state;
        const target = pickTarget(await driver.targets(), state, o.tab);
        await driver.detach(target.targetId);
        await driver.conn.send("Target.closeTarget", { targetId: target.targetId });
        if (state.activeTargetId === target.targetId) writeState({ ...state, activeTargetId: null });
        console.log(`${OK} closed ${target.title || target.url}`);
      } catch (err) {
        die(explainConnectionLoss((err as Error).message));
      } finally {
        driver.close();
      }
    });

  br.command("shots [mode]")
    .description("Automatic screenshots after page-changing commands: on | off | default | status")
    .action((mode?: string) => {
      if (!mode || mode === "status") {
        console.log(
          autoShotsEnabled()
            ? `${OK} auto screenshots are on — page-changing commands inline a small capture (\`--no-shot\` skips one)`
            : `${fmt.muted(icons.dot)} auto screenshots are off${ownerKey() ? " (the default for agent sessions)" : ""} — \`cast browser shots on\` enables them`,
        );
        return;
      }
      if (mode === "default") {
        clearAutoShots();
        console.log(`${OK} auto screenshots follow the default again: on at a terminal, off for agent sessions`);
        return;
      }
      if (mode !== "on" && mode !== "off") die(`'${mode}' is not a mode`, "use: cast browser shots on | off | default | status");
      setAutoShots(mode === "on");
      console.log(`${OK} auto screenshots ${mode} (machine-wide; \`cast browser shots default\` restores the per-audience default)`);
    });

  // -------------------------------------------------------------- perception

  targetFlags(br.command("snapshot"))
    .alias("snap")
    .description("Print the page as an accessibility tree with #eNN refs to act on")
    .option("--interactive", "Only clickable/typable elements — much cheaper")
    .option("--max-chars <n>", "Truncate beyond this many characters", "40000")
    .option("--no-frames", "Skip child frames")
    .option("--tab <id>", "Act on a specific tab")
    .action(async (o: { interactive?: boolean; maxChars: string; frames: boolean; tab?: string }) => {
      await act(o, async (page) => {
        const snap = await snapshotPage(page, {
          interactiveOnly: o.interactive,
          maxChars: parseInt(o.maxChars, 10),
          frames: o.frames,
        });
        console.log(pageLine(snap.url, snap.title));
        console.log("");
        console.log(snap.text || fmt.muted("(nothing in the accessibility tree — the page may still be loading)"));
        if (snap.truncated) {
          console.log(fmt.muted(`\n… truncated at ${o.maxChars} chars. Narrow with --interactive, or raise --max-chars.`));
        }
        console.log(fmt.muted(`\n${snap.refs.length} refs · ${snap.nodes} nodes · ${snap.ms}ms`));
      });
    });

  targetFlags(br.command("find <text>"))
    .description("Find refs whose accessible name matches")
    .option("--tab <id>", "Act on a specific tab")
    .action(async (text: string, o: { tab?: string }) => {
      await act(o, async (page) => {
        const snap = await snapshotPage(page);
        const hits = matchRefs(snap.refs, text);
        if (!hits.length) {
          console.log(`no element matching ${JSON.stringify(text)} (${snap.refs.length} refs on the page)`);
          const near = nearMatches(snap.refs, text);
          if (near.length) {
            console.log("closest:");
            for (const h of near) console.log(`  ${h.role} ${JSON.stringify(h.name)} #e${h.ref}`);
          }
          console.log(fmt.muted("see everything: cast browser snapshot"));
          return;
        }
        for (const h of hits.slice(0, 25)) console.log(`  ${h.role} ${JSON.stringify(h.name)} #e${h.ref}`);
        if (hits.length > 25) console.log(fmt.muted(`  … and ${hits.length - 25} more`));
      });
    });

  targetFlags(br.command("text"))
    .description("Print the page's visible text (for reading, not acting)")
    .option("--tab <id>", "Act on a specific tab")
    .option("--max-chars <n>", "Truncate beyond this", "20000")
    .action(async (o: { tab?: string; maxChars: string }) => {
      await act(o, async (page) => {
        const max = parseInt(o.maxChars, 10);
        const text = (await evaluate(page, `document.body ? document.body.innerText : ""`)) as string;
        console.log(text.slice(0, max));
        if (text.length > max) console.log(fmt.muted(`\n… ${text.length - max} more chars`));
      });
    });

  targetFlags(br.command("shot"))
    .description("Screenshot the page")
    .option("--full", "Whole scroll height, not just the viewport")
    .option("--ref <n>", "Just this element (does not combine with --viewports)")
    .option("--out <path>", "Where to write it (--viewports adds the name before the extension)")
    .option("--viewports <list>", "Capture at each viewport (desktop,mobile,1024x768,…) as one comparison row, then restore")
    .option("--share", "Upload and print a URL that renders inline in the thread")
    .option("--alt <text>", "Caption for the shared image — say what it shows")
    .option("--no-inline", "Do not show the image in the conversation")
    .option("--jpeg", "JPEG instead of PNG — much smaller for photos")
    .option("--tab <id>", "Act on a specific tab")
    .action(async (o: { full?: boolean; ref?: string; out?: string; viewports?: string; share?: boolean; alt?: string; jpeg?: boolean; inline?: boolean; tab?: string; real?: boolean; clone?: boolean }) => {
      await act(o, async (page, state) => {
        if (o.viewports) {
          // One shot per named viewport, emitted together so the thread renders
          // them as a single side-by-side comparison row. Restores what the tab
          // had before: its pinned emulation, or the real window.
          if (o.ref) die("--ref does not combine with --viewports", "an element ref is only meaningful at the viewport it was snapshotted in");
          return runViewportRow(pageViewportCapture(page), o.viewports, state.viewportByTab?.[page.targetId], o, deps)
            .catch((err) => die(err.message, err instanceof ViewportArgError ? err.hint : undefined));
        }
        const buf = await screenshot(page, {
          fullPage: o.full,
          ref: o.ref ? parseInt(o.ref.replace(/^#?e/, ""), 10) : undefined,
          format: o.jpeg ? "jpeg" : "png",
        });
        const out =
          o.out ??
          path.join(os.tmpdir(), `cast-shot-${Date.now()}.${o.jpeg ? "jpg" : "png"}`);
        // Puts the picture in the conversation under this command's output,
        // the way an extension screenshot appears. `--no-inline` opts out.
        const abs = writeShotFile(buf, out, o);
        if (abs) console.log(inlineImageMarker(abs));
        if (o.share) {
          // Same upload path as `cast image`, so the URL renders inline for the
          // human instead of being a dead local path. The alt text becomes the
          // caption under the image, so it should describe what is being shown
          // — the page title is only a fallback for when the agent says nothing.
          const snap = await snapshotPage(page, { maxChars: 1 });
          const img = await uploadOne(deps, out, o.alt || snap.title || "screenshot");
          console.log(img.markdown);
        }
      });
    });

  // ------------------------------------------------------------------ acting

  const refOf = (raw: string): number => {
    const n = parseInt(String(raw).replace(/^#?e/i, ""), 10);
    if (!Number.isFinite(n)) die(`'${raw}' is not a ref — refs look like #e1234 and come from \`cast browser snapshot\``);
    return n;
  };

  /** Auto shot after a page-changing command: capture, dedupe, inline. Quiet —
   *  the only output is the image itself, and only when the page changed. */
  async function emitAutoShot(page: PageSession, shotFlag?: boolean): Promise<void> {
    const shot = await maybeAutoShot(cdpAutoShotSource(page), shotFlag);
    if (shot) console.log(inlineImageMarker(shot));
  }

  /** Report what an action changed, so the agent rarely needs a second call. */
  async function reportAfter(
    page: PageSession,
    before: { url: string; title: string },
    shotFlag?: boolean,
  ): Promise<void> {
    const r = await settle(page, { timeoutMs: 8000 });
    const snap = await snapshotPage(page, { maxChars: 1 });
    if (snap.url !== before.url) {
      console.log(`  → navigated to ${fmt.highlight(snap.title || snap.url)}`);
      console.log(`    ${fmt.muted(snap.url)}`);
      // An in-page action carried the tab somewhere new. By now the page is
      // already there, and yanking it back would break a shared browser's
      // flows — so this path warns and records rather than blocking.
      const landed = auditLanding({ url: snap.url, tab: page.targetId, session: me(), via: "action", policy: loadSitePolicy() });
      if (landed) console.log(`${WARN} ${landed}`);
    } else if (!r.settled) {
      console.log(fmt.muted(`  (page still busy: ${r.reason})`));
    }
    await emitAutoShot(page, shotFlag);
  }

  targetFlags(br.command("click <ref>"))
    .description("Click an element by ref")
    .option("--force", "Click even if something is on top of it")
    .option("--right", "Right click")
    .option("--double", "Double click")
    .option("--no-capture", "Skip the automatic failure context (console, network, screenshot)")
    .option("--no-shot", "Skip the automatic screenshot")
    .option("--tab <id>", "Act on a specific tab")
    .action(async (ref: string, o: { force?: boolean; right?: boolean; double?: boolean; shot?: boolean; tab?: string }) => {
      await act(o, async (page) => {
        const before = await snapshotPage(page, { maxChars: 1 });
        const pt = await click(page, refOf(ref), {
          force: o.force,
          button: o.right ? "right" : "left",
          clickCount: o.double ? 2 : 1,
        });
        console.log(`${OK} clicked #e${refOf(ref)} at ${Math.round(pt.x)},${Math.round(pt.y)}`);
        await reportAfter(page, before, o.shot);
      });
    });

  targetFlags(br.command("click-at <x> <y>"))
    .description("Click raw viewport coordinates (escape hatch when no ref fits)")
    .option("--no-capture", "Skip the automatic failure context (console, network, screenshot)")
    .option("--no-shot", "Skip the automatic screenshot")
    .option("--tab <id>", "Act on a specific tab")
    .action(async (x: string, y: string, o: { shot?: boolean; tab?: string }) => {
      await act(o, async (page) => {
        const before = await snapshotPage(page, { maxChars: 1 });
        await clickAt(page, { x: parseFloat(x), y: parseFloat(y) });
        console.log(`${OK} clicked ${x},${y}`);
        await reportAfter(page, before, o.shot);
      });
    });

  targetFlags(br.command("type <ref> <text>"))
    .description("Type into a field")
    .option("--clear", "Replace what is there")
    .option("--submit", "Press Enter afterwards")
    .option("--per-key", "One key event per character — needed for autocompletes")
    .option("--delay <ms>", "Delay between keys with --per-key", "20")
    .option("--no-capture", "Skip the automatic failure context (console, network, screenshot)")
    .option("--no-shot", "Skip the automatic screenshot")
    .option("--tab <id>", "Act on a specific tab")
    .action(async (ref: string, text: string, o: any) => {
      await act(o, async (page) => {
        const before = await snapshotPage(page, { maxChars: 1 });
        await type(page, refOf(ref), text, {
          clear: o.clear, submit: o.submit, perKey: o.perKey, delayMs: parseInt(o.delay, 10),
        });
        console.log(`${OK} typed ${JSON.stringify(text.slice(0, 60))} into #e${refOf(ref)}${o.submit ? " and submitted" : ""}`);
        // Keystrokes into a field are mid-flow — the page that matters is the
        // one a submit produces, so a plain `type` takes no auto shot.
        await reportAfter(page, before, o.submit ? o.shot : false);
      });
    });

  targetFlags(br.command("press <key>"))
    .description('Press a key: Enter, Escape, Tab, ArrowDown, "cmd+a", "/"')
    .option("--no-capture", "Skip the automatic failure context (console, network, screenshot)")
    .option("--no-shot", "Skip the automatic screenshot")
    .option("--tab <id>", "Act on a specific tab")
    .action(async (key: string, o: { shot?: boolean; tab?: string }) => {
      await act(o, async (page) => {
        const before = await snapshotPage(page, { maxChars: 1 });
        await pressKey(page, key);
        console.log(`${OK} pressed ${key}`);
        await reportAfter(page, before, o.shot);
      });
    });

  targetFlags(br.command("hover <ref>"))
    .description("Hover an element (reveals menus and tooltips)")
    .option("--tab <id>", "Act on a specific tab")
    .action(async (ref: string, o: { tab?: string }) => {
      await act(o, async (page) => {
        const pt = await hover(page, refOf(ref));
        console.log(`${OK} hovered #e${refOf(ref)} at ${Math.round(pt.x)},${Math.round(pt.y)}`);
      });
    });

  targetFlags(br.command("focus <ref>"))
    .description("Focus an element without clicking it")
    .option("--tab <id>", "Act on a specific tab")
    .action(async (ref: string, o: { tab?: string }) => {
      await act(o, async (page) => {
        await focus(page, refOf(ref));
        console.log(`${OK} focused #e${refOf(ref)}`);
      });
    });

  targetFlags(br.command("select <ref> <value>"))
    .description("Choose an option in a <select>")
    .option("--no-capture", "Skip the automatic failure context (console, network, screenshot)")
    .option("--no-shot", "Skip the automatic screenshot")
    .option("--tab <id>", "Act on a specific tab")
    .action(async (ref: string, value: string, o: { shot?: boolean; tab?: string }) => {
      await act(o, async (page) => {
        const before = await snapshotPage(page, { maxChars: 1 });
        await selectOption(page, refOf(ref), value);
        console.log(`${OK} selected ${JSON.stringify(value)}`);
        await reportAfter(page, before, o.shot);
      });
    });

  // `--up` rather than a negative amount: commander parses a leading "-" as an
  // option, so `scroll -900` fails with "unknown option" before the action ever
  // runs. Both forms are accepted anyway — the amount is read from the raw argv
  // when commander has swallowed it — because the obvious thing an agent types
  // should not be an error.
  targetFlags(br.command("scroll [amount]"))
    .description("Scroll the page (default one screen). Use --up, or a negative amount, to go up")
    .option("--up", "Scroll up instead of down")
    .option("--tab <id>", "Act on a specific tab")
    .allowUnknownOption(true)
    .action(async (amount: string | undefined, o: { up?: boolean; tab?: string }) => {
      const negative = process.argv.find((a) => /^-\d+$/.test(a));
      const magnitude = amount ? Math.abs(parseFloat(amount)) : negative ? Math.abs(parseFloat(negative)) : 600;
      const dy = o.up || negative ? -magnitude : magnitude;
      await act(o, async (page) => {
        const r = await scroll(page, dy);
        const where = r.max === 0 ? "page does not scroll" : `at ${r.y} of ${r.max}`;
        if (!r.moved) {
          console.log(`${WARN} did not move (${where}) — already at the ${dy > 0 ? "bottom" : "top"}, or the page handles wheel itself`);
        } else {
          console.log(`${OK} scrolled ${dy > 0 ? "down" : "up"} — ${where}`);
        }
      });
    });

  targetFlags(br.command("viewport [size]"))
    .description("Resize the page, or emulate a device: desktop, laptop, wide, tablet, mobile, mobile-small")
    .option("--reset", "Back to the real window size")
    .option("--tab <id>", "Act on a specific tab")
    .action(async (size: string | undefined, o: { reset?: boolean; tab?: string }) => {
      await act(o, async (page) => {
        if (o.reset || size === "reset") {
          await clearViewport(page);
          const cur = readState();
          if (cur?.viewportByTab?.[page.targetId]) {
            const rest = { ...cur.viewportByTab };
            delete rest[page.targetId];
            writeState({ ...cur, viewportByTab: rest });
          }
          return console.log(`${OK} viewport reset to the real window`);
        }
        if (!size) {
          const cur = await evaluate(
            page,
            `JSON.stringify([innerWidth, innerHeight, devicePixelRatio, "ontouchstart" in window])`,
          );
          const [w, h, dpr, touch] = JSON.parse(cur as string);
          console.log(`${w}x${h} @${dpr}x${touch ? ", touch" : ""}`);
          console.log(fmt.muted(`  presets: ${Object.keys(DEVICES).join(", ")}  ·  or a size like 1024x768`));
          return;
        }
        const parsed = parseViewport(size);
        if (!parsed) die(`unknown size '${size}'`, `use ${viewportChoices()}`);
        const device = parsed.device;
        await setViewport(page, device);
        // Remember it so every later command sees the same page size.
        const cur = readState();
        if (cur) {
          writeState({
            ...cur,
            viewportByTab: { ...(cur.viewportByTab ?? {}), [page.targetId]: device },
          });
        }
        console.log(
          `${OK} ${size} — ${device.width}x${device.height} @${device.scale}x${device.mobile ? ", touch" : ""}`,
        );
        // Layout only reflows once the page reacts to the new metrics.
        await settle(page, { timeoutMs: 5000 });
      });
    });

  targetFlags(br.command("upload <ref> <files...>"))
    .description("Attach files to a file input, with no OS picker")
    .option("--no-shot", "Skip the automatic screenshot")
    .option("--tab <id>", "Act on a specific tab")
    .action(async (ref: string, files: string[], o: { shot?: boolean; tab?: string }) => {
      const abs = files.map((f) => path.resolve(f));
      for (const f of abs) if (!fs.existsSync(f)) die(`no such file: ${f}`);
      await act(o, async (page) => {
        await uploadFiles(page, refOf(ref), abs);
        console.log(`${OK} attached ${abs.length} file(s) to #e${refOf(ref)}`);
        await emitAutoShot(page, o.shot);
      });
    });

  targetFlags(br.command("eval <expression>"))
    .description("Run JavaScript in the page and print the result")
    .option("--no-capture", "Skip the automatic failure context (console, network, screenshot)")
    .option("--tab <id>", "Act on a specific tab")
    .action(async (expression: string, o: { tab?: string }) => {
      await act(o, async (page) => {
        const v = await evaluate(page, expression);
        console.log(typeof v === "string" ? v : JSON.stringify(v, null, 2));
      });
    });

  targetFlags(br.command("wait"))
    .description("Wait for the page to settle, or for text to appear")
    .option("--text <s>", "Wait until this text is on the page")
    .option("--ref <n>", "Wait until this element exists")
    .option("--ms <n>", "Just wait this long")
    .option("--timeout <ms>", "Give up after this", "15000")
    .option("--no-capture", "Skip the automatic failure context (console, network, screenshot)")
    .option("--tab <id>", "Act on a specific tab")
    .action(async (o: { text?: string; ref?: string; ms?: string; timeout: string; tab?: string; capture: boolean; real?: boolean; clone?: boolean }) => {
      await act(o, async (page) => {
        const timeout = parseInt(o.timeout, 10);
        if (o.ms) {
          await new Promise((r) => setTimeout(r, parseInt(o.ms!, 10)));
          return console.log(`${OK} waited ${o.ms}ms`);
        }
        if (o.text) {
          const deadline = Date.now() + timeout;
          while (Date.now() < deadline) {
            const found = await evaluate(page, `!!document.body && document.body.innerText.includes(${JSON.stringify(o.text)})`);
            if (found) return console.log(`${OK} found ${JSON.stringify(o.text)}`);
            await new Promise((r) => setTimeout(r, 250));
          }
          // Throw rather than die: withPage's catch owns failure reporting and
          // adds the console/network/screenshot context a timeout needs most.
          throw new Error(`${JSON.stringify(o.text)} never appeared within ${timeout}ms`);
        }
        if (o.ref) {
          const deadline = Date.now() + timeout;
          const ref = refOf(o.ref);
          while (Date.now() < deadline) {
            try {
              await locate(page, ref);
              return console.log(`${OK} #e${ref} is present`);
            } catch {
              await new Promise((r) => setTimeout(r, 250));
            }
          }
          throw new Error(`#e${ref} never appeared within ${timeout}ms`);
        }
        const r = await settle(page, { timeoutMs: timeout });
        console.log(r.settled ? `${OK} settled` : `${WARN} still busy: ${r.reason}`);
      });
    });

  targetFlags(br.command("do [steps...]"))
    .description("Run several steps in one go — much faster than separate commands")
    .option("--keep-going", "Carry on after a step fails")
    .option("--no-capture", "Skip the automatic failure context (console, network, screenshot)")
    .option("--no-shot", "Skip the automatic screenshots after page-changing steps")
    .option("--tab <id>", "Act on a specific tab")
    .addHelpText(
      "after",
      `
Steps use the same verbs as the commands:
  cast browser do "open example.com" "find Sign in" click shot

Or one per line from stdin, which keeps long flows readable:
  cast browser do - <<'EOF'
  open https://example.com
  find "Sign in"
  click
  wait --text "Password"
  type #e42 "hunter2" --submit
  shot
  EOF

A step with no ref uses whatever the last \`find\` matched.`,
    )
    .action(async (steps: string[], o: { keepGoing?: boolean; shot?: boolean; tab?: string; capture: boolean }) => {
      // `-` reads the flow from stdin, the same convention as `cast send -`.
      let plan = steps;
      if (steps.length === 1 && steps[0] === "-") {
        const stdin = await new Promise<string>((resolve) => {
          let buf = "";
          process.stdin.setEncoding("utf-8");
          process.stdin.on("data", (d) => (buf += d));
          process.stdin.on("end", () => resolve(buf));
        });
        plan = stdin.split("\n").map((l) => l.trim()).filter(Boolean);
      }
      if (!plan.length) die("no steps given", 'try: cast browser do "open example.com" snapshot');

      await act(o, async (page, state, conn) => {
        const started = Date.now();
        // Auto shots taken at step boundaries, in order. Kept separate from
        // ctx.shots: those are files the agent asked for and got paths back.
        const autoShots: string[] = [];
        const policy = loadSitePolicy();
        const ctx: BatchContext = {
          page,
          shots: [],
          // A click inside a batch can navigate just like a click command; this
          // runs after each settling step so those landings are audited too.
          afterSettle: async () => {
            const snap = await snapshotPage(page, { maxChars: 1 });
            return auditLanding({ url: snap.url, tab: page.targetId, session: me(), via: "batch", policy });
          },
          autoShot: async () => {
            const shot = await maybeAutoShot(cdpAutoShotSource(page), o.shot);
            if (shot) autoShots.push(shot);
          },
          // Reuse the same capture and navigate paths the single commands use,
          // so a batched shot behaves identically — downscale, inline marker.
          capture: async (args) => {
            const buf = await screenshot(page, { fullPage: args.includes("--full") });
            const out = path.join(os.tmpdir(), `cast-shot-${Date.now()}.png`);
            let bytes = buf;
            if (bytes.length > MAX_IMAGE_SIZE) {
              const smaller = downscaleWithSips(bytes, "image/png");
              if (smaller && smaller.length < bytes.length) bytes = smaller;
            }
            fs.writeFileSync(out, bytes);
            return out;
          },
          navigate: async (url) => {
            const target = /^[a-z]+:\/\//i.test(url) ? url : `https://${url}`;
            // Same gate as `open` — a batched navigation is still explicit.
            const deny = refuseNavigation(target, me(), "batch", policy);
            if (deny) {
              throw new Error(`${deny.message}\n    ${deny.hint.replace(/\n/g, "\n    ")}`);
            }
            // Same reuse rule as the `open` command: a batch that starts with
            // `open` to be explicit about where it is working should not throw
            // away the page it is already on.
            const already = await currentUrl(page);
            if (already !== null && sameDocument(already, target)) {
              const snap = await snapshotPage(page, { maxChars: 1 });
              return `already on ${snap.title || snap.url}`;
            }
            await conn.send("Page.navigate", { url: target }, page.sessionId);
            await settle(page);
            const snap = await snapshotPage(page, { maxChars: 1 });
            const landed = auditLanding({ url: snap.url, tab: page.targetId, session: me(), via: "batch", policy });
            return `${snap.title || "(untitled)"} — ${snap.url}${landed ? `\n! ${landed}` : ""}`;
          },
        };

        const results = await runBatch(ctx, plan, { keepGoing: o.keepGoing });
        for (const r of results) {
          if (r.ok) {
            console.log(`${OK} ${fmt.highlight(r.step)}`);
            if (r.output) console.log(r.output.split("\n").map((l) => `    ${l}`).join("\n"));
          } else {
            console.log(`${BAD} ${fmt.highlight(r.step)}`);
            console.log(`    ${r.error}`);
          }
        }

        for (const shot of ctx.shots) console.log(inlineImageMarker(path.resolve(shot)));
        for (const shot of autoShots) console.log(inlineImageMarker(path.resolve(shot)));

        // A viewport set inside a batch has to outlive it, like one set by the
        // command — otherwise the next command silently snaps back.
        if (ctx.viewport) {
          const cur = readState();
          if (cur) {
            writeState({
              ...cur,
              viewportByTab: { ...(cur.viewportByTab ?? {}), [page.targetId]: ctx.viewport },
            });
          }
        }

        const failed = results.filter((r) => !r.ok).length;
        const skipped = plan.length - results.length;
        console.log(
          fmt.muted(
            `\n${results.length - failed}/${plan.length} steps in ${((Date.now() - started) / 1000).toFixed(1)}s` +
              (skipped ? ` — ${skipped} not attempted after the failure` : ""),
          ),
        );
        if (failed) {
          process.exitCode = 1;
          // The batch reports per-step results itself rather than dying, so the
          // failure context is attached here, keyed to the first failing step.
          const firstError = results.find((r) => !r.ok)?.error ?? "step failed";
          await emitFailureContext(page, firstError, { disabled: o.capture === false });
        }
      });
    });

  // -------------------------------------------------------------- diagnostics

  targetFlags(br.command("console"))
    .description("What the page logged")
    .option("--errors", "Errors and warnings only")
    .option("--clear", "Empty the buffer instead of printing it")
    .option("-n <count>", "How many lines", "50")
    .option("--tab <id>", "Act on a specific tab")
    .action(async (o: any) => {
      await act(o, async (page) => {
        if (o.clear) {
          await clearRecording(page);
          return console.log(`${OK} cleared`);
        }
        const rec = await readRecording(page);
        if (!rec.armed) {
          console.log(`${WARN} could not read this page's console (the recorder did not install).`);
          return;
        }
        if (rec.late) {
          console.log(
            fmt.muted("  (capture started after this page had already run — earlier logs are missing; `cast browser reload` catches the whole load)"),
          );
        }
        const wanted = o.errors ? rec.console.filter((c) => c.level === "error" || c.level === "warn") : rec.console;
        const n = parseInt(o.n, 10);
        for (const e of wanted.slice(-n)) {
          const tag = e.level === "error" ? fmt.error("ERR") : e.level === "warn" ? fmt.warning("WRN") : fmt.muted(e.level.toUpperCase().slice(0, 3));
          console.log(`${fmt.muted(`+${(e.t / 1000).toFixed(1)}s`)} ${tag} ${e.text}`);
        }
        for (const e of rec.errors.slice(-n)) {
          console.log(`${fmt.muted(`+${(e.t / 1000).toFixed(1)}s`)} ${fmt.error("UNCAUGHT")} ${e.text}`);
          if (e.stack) console.log(fmt.muted(e.stack.split("\n").slice(1, 4).map((l) => `    ${l.trim()}`).join("\n")));
        }
        for (const d of rec.dialogs ?? []) {
          console.log(`${fmt.muted(`+${(d.t / 1000).toFixed(1)}s`)} ${fmt.warning("DIALOG")} ${d.kind}: ${d.message}`);
        }
        if (!wanted.length && !rec.errors.length && !(rec.dialogs ?? []).length) {
          console.log(fmt.muted("(nothing logged)"));
        }
      });
    });

  targetFlags(br.command("dialogs"))
    .description("Modal dialogs the page tried to open (answered without blocking)")
    .option("--tab <id>", "Act on a specific tab")
    .action(async (o: { tab?: string }) => {
      await act(o, async (page) => {
        const rec = await readRecording(page);
        if (!rec.dialogs?.length) return console.log(fmt.muted("(the page opened no dialogs)"));
        for (const d of rec.dialogs) {
          console.log(`${fmt.muted(`+${(d.t / 1000).toFixed(1)}s`)} ${d.kind.padEnd(12)} ${d.message}`);
        }
        console.log(
          fmt.muted(
            "\n  These were answered automatically (confirm→OK, prompt→default) so they could not\n" +
              "  freeze the tab. Drive the real flow with clicks if the answer matters.",
          ),
        );
      });
    });

  targetFlags(br.command("network"))
    .description("What the page requested")
    .option("--failed", "Only failures and 4xx/5xx")
    .option("-n <count>", "How many rows", "40")
    .option("--tab <id>", "Act on a specific tab")
    .action(async (o: any) => {
      await act(o, async (page) => {
        const rec = await readRecording(page);
        if (!rec.armed) {
          console.log(`${WARN} could not read this page's network (the recorder did not install).`);
          return;
        }
        if (rec.late) {
          console.log(
            fmt.muted("  (capture started after this page had already run — earlier requests are missing; `cast browser reload` catches the whole load)"),
          );
        }
        let rows = rec.network;
        if (o.failed) rows = rows.filter((r) => r.error || (r.status !== null && (r.status === 0 || r.status >= 400)));
        const n = parseInt(o.n, 10);
        for (const r of rows.slice(-n)) {
          const status = r.error ? fmt.error("ERR") : r.status === null ? "  -" : String(r.status).padStart(3);
          const colored = !r.error && r.status !== null && r.status >= 400 ? fmt.error(status) : status;
          console.log(`${colored} ${r.method.padEnd(6)} ${String(r.ms).padStart(5)}ms ${r.url.slice(0, 110)}${r.error ? fmt.error(` ${r.error}`) : ""}`);
        }
        if (!rows.length) console.log(fmt.muted(o.failed ? "(no failed requests)" : "(no requests recorded)"));
      });
    });

  registerAuditCommand(br, me);
}
