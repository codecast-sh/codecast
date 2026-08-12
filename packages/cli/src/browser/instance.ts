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
import { CdpConnection, isCdpAlive, listTargets, type CdpTarget } from "./cdp.js";
import { browserHome, clonePath, chromeUserDataRoot, type ChromeChannel } from "./profile.js";
import { findChromeBinary, chromeBinaryProbes, isPidAlive, ChromeNotFoundError } from "../workspace/chrome.js";

export interface InstanceState {
  pid: number;
  port: number;
  userDataDir: string;
  headless: boolean;
  /** Which real Chrome profile this clone came from, for `status` output. */
  sourceProfile: string | null;
  channel: ChromeChannel;
  startedAt: number;
  /** The tab subsequent commands act on, unless --tab overrides it. */
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
  fs.writeFileSync(statePath(), JSON.stringify(state, null, 2), { mode: 0o600 });
}

export function clearState(): void {
  try {
    fs.unlinkSync(statePath());
  } catch {
    /* ignore */
  }
}

/** Is the recorded instance actually alive and answering CDP? */
export async function isLive(state: InstanceState | null): Promise<boolean> {
  if (!state) return false;
  if (!isPidAlive(state.pid)) return false;
  return isCdpAlive(state.port);
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
}

export async function launchManagedChrome(opts: LaunchOptions): Promise<number> {
  const channel = opts.channel ?? "chrome";
  const bin = chromeBinaryFor(channel);
  fs.mkdirSync(opts.userDataDir, { recursive: true, mode: 0o700 });

  const size = opts.windowSize ?? { width: 1440, height: 900 };
  const args = [
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
    ...(opts.headless ? ["--headless=new"] : []),
    "about:blank",
  ];

  const child = spawn(bin, args, { stdio: ["ignore", "ignore", "ignore"], detached: true });
  let spawnError: Error | null = null;
  child.on("error", (err) => {
    spawnError = err;
  });
  child.unref();
  if (!child.pid) throw new Error("Chrome spawn returned no pid");

  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (spawnError) throw new Error(`failed to spawn Chrome at '${bin}': ${(spawnError as Error).message}`);
    if (!isPidAlive(child.pid)) {
      throw new Error(
        `Chrome exited before CDP came up. The usual cause is a user-data-dir Chrome refuses to debug — ` +
          `since Chrome 136 the DEFAULT profile directory cannot be driven over CDP.`,
      );
    }
    if (await isCdpAlive(opts.port)) return child.pid;
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
  conn: CdpConnection;
  sessionId: string;
  targetId: string;
}

/** Attach to a target and turn on the domains every command needs. */
export async function attachToTarget(conn: CdpConnection, targetId: string): Promise<PageSession> {
  const { sessionId } = await conn.send<{ sessionId: string }>("Target.attachToTarget", {
    targetId,
    flatten: true,
  });
  await conn.send("Page.enable", {}, sessionId);
  await conn.send("DOM.enable", {}, sessionId);
  await conn.send("Runtime.enable", {}, sessionId);
  await conn.send("Accessibility.enable", {}, sessionId);
  await conn.send("Network.enable", {}, sessionId);
  return { conn, sessionId, targetId };
}

/**
 * Resolve which tab to act on: the explicit target, else the recorded active
 * tab if it still exists, else the most recently opened page.
 */
export async function resolveTarget(port: number, state: InstanceState, explicit?: string): Promise<CdpTarget> {
  const targets = await listTargets(port);
  if (!targets.length) throw new Error("the browser has no open tabs — run `cast browser open <url>`");
  if (explicit) {
    const match =
      targets.find((t) => t.targetId === explicit) ||
      targets.find((t) => t.targetId.startsWith(explicit)) ||
      targets.find((t) => t.url.includes(explicit));
    if (!match) throw new Error(`no tab matching '${explicit}'`);
    return match;
  }
  if (state.activeTargetId) {
    const match = targets.find((t) => t.targetId === state.activeTargetId);
    if (match) return match;
  }
  return targets[targets.length - 1];
}

export function setActiveTarget(state: InstanceState, targetId: string): void {
  if (state.activeTargetId === targetId) return;
  writeState({ ...state, activeTargetId: targetId });
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
export async function settle(
  page: PageSession,
  opts: { timeoutMs?: number; quietMs?: number; staleRequestMs?: number } = {},
): Promise<{ settled: boolean; reason: string }> {
  const timeoutMs = opts.timeoutMs ?? 15_000;
  const quietMs = opts.quietMs ?? 500;
  const staleRequestMs = opts.staleRequestMs ?? 5_000;

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
    .send(
      "Runtime.evaluate",
      {
        expression: `(() => {
          if (window.__castMut) { window.__castMut.n = 0; return; }
          const s = { n: 0 };
          new MutationObserver(() => { s.n++; }).observe(document, {
            childList: true, subtree: true, attributes: true, characterData: true,
          });
          window.__castMut = s;
        })()`,
      },
      page.sessionId,
    )
    .catch(() => {
      /* a page mid-navigation will reject; the next poll re-arms it */
    });

  const deadline = Date.now() + timeoutMs;
  let lastMutations = -1;
  let quietSince = 0;

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
      );
      [ready, mutations] = JSON.parse(r.result.value);
    } catch {
      // Navigating out from under us — reset and keep waiting.
      quietSince = 0;
      continue;
    }

    const domQuiet = mutations === lastMutations;
    lastMutations = mutations;
    const netQuiet = inflight.size === 0 && Date.now() - lastActivity > 150;

    if (ready === "complete" && netQuiet && domQuiet) {
      if (!quietSince) quietSince = Date.now();
      if (Date.now() - quietSince >= quietMs) {
        off();
        return { settled: true, reason: "quiet" };
      }
    } else {
      quietSince = 0;
    }
  }

  off();
  const why = inflight.size ? `${inflight.size} request(s) still in flight` : "the page kept mutating";
  return { settled: false, reason: why };
}

export { clonePath, chromeUserDataRoot };
