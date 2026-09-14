/**
 * Real-Chrome mode: routing `cast browser` verbs at the user's own Chrome
 * through the extension bridge instead of the managed clone.
 *
 * Because the bridge host IS a CDP endpoint, this file holds no transport:
 * `CdpConnection.fromPort(bridgeEndpoint)`, `listTargets`, `attachToTarget`
 * and every verb work exactly as they do against the clone. What is left is
 * policy — which tab a session may act on — and it is stricter than the
 * clone's. These are the human's own tabs, so an agent session only ever
 * acts on a tab it opened (or one named explicitly with --tab); there is no
 * "fall back to some free tab". A human with no session id gets their focused
 * tab, which is what they mean.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { AsyncLocalStorage } from "node:async_hooks";
import { CdpConnection, listTargets, type CdpEndpoint, type CdpTarget, withSession } from "../cdp.js";
import { attachToTarget, type InstanceState, type PageSession } from "../instance.js";
import { browserHome } from "../profile.js";
import { isPidAlive } from "../../workspace/chrome.js";
import { armRecorder } from "../observe.js";
import { isRealSession, type EngineOptions } from "../engine.js";
import { fmt } from "../../colors.js";
import {
  bridgeEndpoint, bridgeWsUrl, ensureBridgeHost, proveBridgeHost, readBridgeState, waitForExtension, type BridgeHostStarter,
  type BridgeHostStatus, type BridgeState, type ProvenBridge,
} from "./host.js";
import { discardPairingPage, launchRealChrome, realChromeRunning, wakeExtension } from "./realChrome.js";

const cloneScope = new AsyncLocalStorage<boolean>();

export const isAdvancedClone = (): boolean => cloneScope.getStore() === true;
export const withAdvancedClone = <T>(run: () => T): T => cloneScope.run(true, run);

// ---------------------------------------------------------------------------
// Per-session state: which real tab is mine, and is real mode sticky
// ---------------------------------------------------------------------------

/**
 * Which browser a session's ordinary verbs drive. `real` is the human's
 * Chrome and the default; `clone` only ever comes from the advanced scope;
 * `pane` is the desktop app's browser pane opened for this session
 * (desktopPane.ts), chosen with `cast browser target pane`.
 */
export type StickyMode = "real" | "clone" | "pane";

interface RealState {
  /** Real-Chrome target (see protocol.ts targetIdOfTab) each session works in. */
  tabsBySession?: Record<string, string>;
  /** Sticky `cast browser target <mode>` choices, keyed like tabsBySession. */
  stickyBySession?: Record<string, StickyMode>;
  /** The desktop pane (registry paneId) each session last drove, so a pane
   *  the human closed is reported once as closed rather than as never had. */
  paneBySession?: Record<string, string>;
}

function realStatePath(): string {
  return path.join(browserHome(), "real.json");
}

function readRealState(): RealState {
  try {
    return JSON.parse(fs.readFileSync(realStatePath(), "utf-8")) as RealState;
  } catch {
    return {};
  }
}

function writeRealState(state: RealState): void {
  fs.mkdirSync(browserHome(), { recursive: true, mode: 0o700 });
  const tmp = `${realStatePath()}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, realStatePath());
}

/** Sessions with no key share one slot, same as the clone's activeTargetId. */
const keyOf = (sessionKey: string | null): string => sessionKey ?? "global";

export function setStickyTarget(sessionKey: string | null, mode: StickyMode): void {
  const s = readRealState();
  writeRealState({ ...s, stickyBySession: { ...(s.stickyBySession ?? {}), [keyOf(sessionKey)]: mode } });
}

/** The choice a session made with `cast browser target`, or null when it never did. */
export function explicitTarget(sessionKey: string | null): StickyMode | null {
  return readRealState().stickyBySession?.[keyOf(sessionKey)] ?? null;
}

export function rememberDesktopPane(sessionKey: string | null, paneId: string): void {
  const s = readRealState();
  if (s.paneBySession?.[keyOf(sessionKey)] === paneId) return;
  writeRealState({ ...s, paneBySession: { ...(s.paneBySession ?? {}), [keyOf(sessionKey)]: paneId } });
}

export function rememberedDesktopPane(sessionKey: string | null): string | null {
  return readRealState().paneBySession?.[keyOf(sessionKey)] ?? null;
}

export function forgetDesktopPane(sessionKey: string | null): void {
  const s = readRealState();
  if (!s.paneBySession?.[keyOf(sessionKey)]) return;
  const panes = { ...s.paneBySession };
  delete panes[keyOf(sessionKey)];
  writeRealState({ ...s, paneBySession: panes });
}

/** Has the extension ever proved itself to this machine's bridge host? */
export function extensionPaired(): boolean {
  const state = readBridgeState();
  return !!state?.token && !!state.extensionSeenAt;
}

/**
 * Is the human's Chrome reachable right now: a live host holding a proven
 * extension connection. Read off the state file the host maintains, so every
 * verb can ask without a round trip.
 */
export function extensionReady(): boolean {
  const state = readBridgeState();
  return !!state?.token && !!state.hostPid && isPidAlive(state.hostPid) && state.extensionConnected === true;
}

/**
 * Ordinary commands use the human's Chrome. Clone scope lasts one invocation.
 * A session that chose its desktop pane keeps it until it chooses again or
 * the pane is reported closed (desktopPane.ts resolveDesktopPane).
 */
export function stickyTarget(sessionKey: string | null, opts: { settle?: boolean } = {}): StickyMode {
  if (isAdvancedClone()) return "clone";
  if (explicitTarget(sessionKey) === "pane") return "pane";
  if (opts.settle) setStickyTarget(sessionKey, "real");
  return "real";
}

export interface TargetFlags {
  real?: boolean;
  clone?: boolean;
  pane?: boolean;
}

export function isRealMode(opts: TargetFlags, sessionKey: string | null): boolean {
  if (opts.clone) throw new Error("The --clone shortcut is no longer supported. Ordinary browser commands use the human's Chrome; a disconnected extension is not permission to launch another browser.");
  if (opts.real) return true;
  if (opts.pane) return false;
  return stickyTarget(sessionKey, { settle: true }) === "real";
}

/**
 * Whether this verb drives the desktop pane: asked for with `--pane`, or the
 * session's sticky choice. `--real` on the line overrides the sticky pane for
 * one verb, the same way it overrides everything else.
 */
export function isPaneMode(opts: TargetFlags, sessionKey: string | null): boolean {
  if (opts.real || opts.clone || isAdvancedClone()) return false;
  return opts.pane === true || explicitTarget(sessionKey) === "pane";
}

/**
 * What a session on the clone should hear when it meets a sign-in wall: the
 * human's Chrome already holds that login, and the one step that reaches it
 * from where the bridge stands. Null when the session is already there.
 */
export function realModeHint(sessionKey: string | null): string | null {
  if (stickyTarget(sessionKey) === "real") return null;
  if (extensionReady()) {
    return "your real Chrome is paired and holds this login: `cast browser target real` moves this session there (`open --real <url>` for one verb)";
  }
  if (extensionPaired()) {
    return "your real Chrome holds this login, but the codecast extension is not connected right now: open Chrome (or reload the extension), then `cast browser target real`";
  }
  return "your real Chrome holds this login: pair the codecast extension once with `cast browser extension setup`, and sessions use your Chrome by default from then on";
}

/**
 * Pull `--real` / `--clone` out of a raw argument list. Passthrough verbs
 * accept unknown options and forward them to the engine, so these two must
 * be taken off the line here or the engine would receive them.
 */
export function splitTargetFlags(args: string[]): TargetFlags & { args: string[] } {
  const real = args.includes("--real") || undefined;
  const clone = args.includes("--clone") || undefined;
  const pane = args.includes("--pane") || undefined;
  return { real, clone, pane, args: args.filter((a) => a !== "--real" && a !== "--clone" && a !== "--pane") };
}

// ---------------------------------------------------------------------------
// The bridge as the engine's browser
// ---------------------------------------------------------------------------

/** The bridge config, or the setup instruction. Sync, for callers that only
 *  need the port and token (the host itself is started on `open`). */
export function requireBridgeConfigured(): BridgeState {
  const state = readBridgeState();
  if (!state?.token) {
    throw new Error("the extension bridge is not set up — the human must run `cast browser extension setup` in their Chrome. No separate browser was started.");
  }
  return state;
}

/**
 * The bridge's CDP face for raw calls (reaper, pinned tab), or null when
 * there is nothing to reach: the bridge was never set up, its host is not
 * running, or what answers on the port cannot prove it is our host. Those
 * callers are courtesies that never start a host, so all three are "no".
 */
export async function bridgeEndpointIfConfigured(session?: string | null): Promise<CdpEndpoint | null> {
  const state = readBridgeState();
  if (!state?.token) return null;
  try {
    return bridgeEndpoint(await proveBridgeHost(state), session);
  } catch {
    return null;
  }
}

/**
 * The engine options that reach the browser behind a session key: a `-real`
 * key (engine.ts realSessionKey) drives the bridge, any other key drives the
 * managed Chrome, which runEngine reaches on its own. Every engine call for a
 * session must go through this so the flags never differ between calls —
 * the daemon resets its tab when they do. The bridge URL carries the token,
 * so the host is proven (host.ts probeHost) before the URL is ever built.
 *
 * Bare, this never starts a host: a down host is an error, which is what the
 * reaper and other courtesies want. A verb about to act passes the bridge
 * `requireRealBridge` returned, which started the host if it had to and saw
 * the extension on it.
 */
export async function engineBrowserFor(session: string, bridge?: ProvenBridge): Promise<EngineOptions & { session: string }> {
  if (!isRealSession(session)) return { session };
  // The session rides on the socket URL: the host scopes what this engine
  // discovers to the tabs granted to that session (bridge/host.ts).
  const state = bridge ?? (await proveBridgeHost(requireBridgeConfigured()));
  return { session, cdp: withSession(bridgeWsUrl(state), bridgeEndpoint(state, session)) };
}

export function rememberRealTab(sessionKey: string | null, targetId: string): void {
  const s = readRealState();
  const tabs = { ...(s.tabsBySession ?? {}) };
  if (tabs[keyOf(sessionKey)] === targetId) return;
  tabs[keyOf(sessionKey)] = targetId;
  writeRealState({ ...s, tabsBySession: tabs });
}

export function ownedRealTab(sessionKey: string | null): string | undefined {
  return readRealState().tabsBySession?.[keyOf(sessionKey)];
}

/** Drop claims on tabs that no longer exist. */
export function pruneRealTabs(live: Set<string>): void {
  const s = readRealState();
  const tabs = s.tabsBySession ?? {};
  const kept = Object.fromEntries(Object.entries(tabs).filter(([, id]) => live.has(id)));
  if (Object.keys(kept).length !== Object.keys(tabs).length) {
    writeRealState({ ...s, tabsBySession: kept });
  }
}

export function realTabOwnership(sessionKey: string | null): { mine?: string; others: Set<string> } {
  const tabs = readRealState().tabsBySession ?? {};
  const mine = tabs[keyOf(sessionKey)];
  const others = new Set(
    Object.entries(tabs)
      .filter(([k]) => k !== keyOf(sessionKey))
      .map(([, id]) => id),
  );
  return { mine, others };
}

// ---------------------------------------------------------------------------
// Reaching the real browser
// ---------------------------------------------------------------------------

/**
 * URLs chrome.debugger may not drive, so no extension can: Chrome's own pages
 * and the Chrome Web Store, its developer dashboard included. Page.navigate
 * to one answers "Not allowed" after the tab was already attached, which read
 * as a broken bridge; naming the wall up front sends the human to click it
 * themselves instead. Null when the URL is fine.
 */
export function walledOffFromExtension(url: string): string | null {
  let u: URL;
  try {
    u = new URL(url.includes("://") ? url : `https://${url}`);
  } catch {
    return null;
  }
  if (u.protocol === "chrome:" || u.protocol === "chrome-extension:" || u.protocol === "devtools:") {
    return `Chrome does not let an extension drive ${u.protocol}// pages`;
  }
  const host = u.hostname.toLowerCase();
  if (host === "chromewebstore.google.com" || (host === "chrome.google.com" && u.pathname.toLowerCase().startsWith("/webstore"))) {
    return "Chrome does not let an extension drive the Chrome Web Store or its developer dashboard";
  }
  return null;
}

/**
 * The waits on the way to a connected extension, each the time the previous
 * rung needs to work. The worker reconnects to a fresh host within seconds
 * on its own (GRACE). When Chrome is not running at all, it is started, and
 * a cold Chrome on a loaded machine takes a while to load its extensions
 * (LAUNCH). When Chrome runs but the worker has not called in, the worker's
 * own 30 s alarm (background.js) gets its chance first (ALARM), and only
 * then is it woken from outside, which the worker answers within a few
 * seconds of the page opening (WAKE).
 */
export const EXTENSION_RECONNECT_GRACE_MS = 8_000;
export const EXTENSION_ALARM_MS = 35_000;
export const EXTENSION_WAKE_WAIT_MS = 25_000;
export const CHROME_LAUNCH_WAIT_MS = 60_000;

export type ExtensionWaits = { grace: number; alarm: number; wake: number; launch: number };

/** Test seams for the rungs, and where progress lines go. */
export interface RealChromeDeps {
  chromeRunning?: () => boolean;
  launchChrome?: () => boolean;
  wakeExtension?: () => boolean;
  /** Progress, on stderr by default so a `--json` stdout stays clean. */
  note?: (line: string) => void;
  waits?: Partial<ExtensionWaits>;
}

/**
 * The bridge with its host up, and whether the extension is on it. Nothing
 * on the way is reported when it can be done instead: a host that is not
 * running is started; a Chrome that is not running is started, in the
 * background; a worker that Chrome ended is given its own alarm's time to
 * come back and then woken from its options page. Each rung runs only when
 * the extension has paired with this machine before, because a wake needs
 * the extension installed, and until then the setup steps are the answer.
 * Every question about the real Chrome's reachability goes through here,
 * whether it wants the answer (status) or a bridge to act on
 * (requireRealBridge). `start` is the test seam for bringing the host up.
 */
export async function connectRealBridge(
  start?: BridgeHostStarter,
  deps: RealChromeDeps = {},
): Promise<{ bridge: ProvenBridge & { started: boolean }; status: BridgeHostStatus }> {
  requireBridgeConfigured();
  const bridge = await ensureBridgeHost(start);
  const w: ExtensionWaits = { grace: EXTENSION_RECONNECT_GRACE_MS, alarm: EXTENSION_ALARM_MS, wake: EXTENSION_WAKE_WAIT_MS, launch: CHROME_LAUNCH_WAIT_MS, ...deps.waits };
  const note = deps.note ?? ((line: string) => console.error(fmt.muted(`  ${line}`)));
  let status = await waitForExtension(bridge, w.grace);
  if (status.extensionConnected || !extensionPaired()) return { bridge, status };

  if (!(deps.chromeRunning ?? realChromeRunning)()) {
    note("Chrome is not running; starting it in the background and waiting for the extension…");
    if ((deps.launchChrome ?? launchRealChrome)()) status = await waitForExtension(bridge, w.launch);
    else note("no Chrome binary found to start");
    return { bridge, status };
  }

  note(`the Chrome extension has not reconnected yet; giving it up to ${Math.round(w.alarm / 1000)}s…`);
  status = await waitForExtension(bridge, Math.max(0, w.alarm - w.grace));
  if (status.extensionConnected) return { bridge, status };
  if ((deps.wakeExtension ?? wakeExtension)()) {
    note("waking the extension from its options page…");
    try {
      status = await waitForExtension(bridge, w.wake);
    } finally {
      discardPairingPage();
    }
  }
  return { bridge, status };
}

/**
 * A ready bridge: host up and the extension on the other end. Failing here,
 * with the setup instructions, beats failing on the first verb with less
 * context — a host with no extension can only ever answer errors.
 */
export async function requireRealBridge(start?: BridgeHostStarter, deps?: RealChromeDeps): Promise<ProvenBridge> {
  const { bridge, status } = await connectRealBridge(start, deps);
  if (!status.extensionConnected) {
    throw new Error(
      (extensionPaired()
        ? "the cast bridge extension did not connect to this machine's bridge host, after Chrome was started or the extension was woken.\n" +
          "  Check the extension is enabled at chrome://extensions and reload it there.\n"
        : "the cast bridge extension has not been paired with this machine's bridge host.\n") +
        "  If it still does not connect, run `cast browser extension setup` to pair it again.\n" +
        "  Tell the human if it remains disconnected. No separate browser was started.",
    );
  }
  return bridge;
}

/** Live page targets in the real Chrome; also prunes stale ownership. */
export async function listRealTargets(state: ProvenBridge): Promise<CdpTarget[]> {
  const targets = await listTargets(bridgeEndpoint(state));
  pruneRealTabs(new Set(targets.map((t) => t.targetId)));
  return targets;
}

export function resolveRealTarget(
  targets: CdpTarget[],
  explicit: string | undefined,
  sessionKey: string | null,
): CdpTarget {
  if (!targets.length) throw new Error("the real browser reports no drivable tabs");

  if (explicit) {
    const match =
      targets.find((t) => t.targetId === explicit.toUpperCase()) ||
      targets.find((t) => t.targetId.startsWith(explicit.toUpperCase())) ||
      targets.find((t) => t.url.includes(explicit)) ||
      targets.find((t) => t.title.toLowerCase().includes(explicit.toLowerCase()));
    if (!match) throw new Error(`no real-browser tab matching '${explicit}' — see \`cast browser tabs --real\``);
    return match;
  }

  const owned = ownedRealTab(sessionKey);
  if (owned) {
    const match = targets.find((t) => t.targetId === owned);
    if (match) return match;
  }

  // An agent session never helps itself to the human's tabs: it either owns
  // one or opens one. A human at a bare shell gets the most recent tab.
  if (sessionKey) {
    throw new Error(
      "this session has no tab of its own in the real browser.\n" +
        "  Open one with `cast browser open --real <url>`, or name one explicitly with --tab —\n" +
        "  the other tabs there are the human's, and acting on them uninvited is off limits.",
    );
  }
  return targets[targets.length - 1];
}

/**
 * A stand-in for the clone's InstanceState, so command bodies with the shared
 * (page, state, conn) signature run unchanged. Real mode has no managed
 * process behind it, which is exactly what the zeros say.
 */
export function realStateStub(state: BridgeState): InstanceState {
  return {
    pid: state.hostPid ?? 0,
    port: state.port,
    userDataDir: "",
    headless: false,
    sourceProfile: "real Chrome (extension bridge)",
    channel: "chrome",
    startedAt: state.startedAt ?? Date.now(),
    activeTargetId: null,
  };
}

/** The real-mode counterpart of cli.ts's withPage. Throws; the caller renders. */
export async function withRealPage<T>(
  opts: { tab?: string },
  fn: (page: PageSession, state: InstanceState, conn: CdpConnection) => Promise<T>,
  sessionKey: string | null,
): Promise<T> {
  const bridge = await requireRealBridge();
  const conn = await CdpConnection.fromPort(bridgeEndpoint(bridge));
  try {
    const target = resolveRealTarget(await listRealTargets(bridge), opts.tab, sessionKey);
    const page = await attachToTarget(conn, target.targetId);
    rememberRealTab(sessionKey, target.targetId);
    // Same re-arm the clone path does: console/network capture lives in the
    // page, and only tabs the agent drives ever get it.
    await armRecorder(page);
    return await fn(page, realStateStub(bridge), conn);
  } finally {
    conn.close();
  }
}
