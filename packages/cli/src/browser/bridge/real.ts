/**
 * Real-Chrome mode: routing `cast browser` verbs at the user's own Chrome
 * through the extension bridge instead of the managed clone.
 *
 * The clone stays the default — it is the safe place for unattended work.
 * Real mode exists for the cases the clone cannot serve: logins that drifted
 * since the clone was made, sites that fight fresh profiles, and work the
 * human wants to watch happen in their own browser.
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
import { CdpConnection, listTargets, type CdpEndpoint, type CdpTarget } from "../cdp.js";
import { attachToTarget, type InstanceState, type PageSession } from "../instance.js";
import { browserHome } from "../profile.js";
import { isPidAlive } from "../../workspace/chrome.js";
import { armRecorder } from "../observe.js";
import { isRealSession, type EngineOptions } from "../engine.js";
import {
  bridgeEndpoint, bridgeWsUrl, ensureBridgeHost, proveBridgeHost, readBridgeState, waitForExtension, type BridgeState,
  type ProvenBridge,
} from "./host.js";

// ---------------------------------------------------------------------------
// Per-session state: which real tab is mine, and is real mode sticky
// ---------------------------------------------------------------------------

interface RealState {
  /** Real-Chrome target (see protocol.ts targetIdOfTab) each session works in. */
  tabsBySession?: Record<string, string>;
  /** Sticky `cast browser target real` choices, keyed like tabsBySession. */
  stickyBySession?: Record<string, "real" | "clone">;
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

export function setStickyTarget(sessionKey: string | null, mode: "real" | "clone"): void {
  const s = readRealState();
  writeRealState({ ...s, stickyBySession: { ...(s.stickyBySession ?? {}), [keyOf(sessionKey)]: mode } });
}

/** The choice a session made with `cast browser target`, or null when it never did. */
export function explicitTarget(sessionKey: string | null): "real" | "clone" | null {
  return readRealState().stickyBySession?.[keyOf(sessionKey)] ?? null;
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
 * Which browser a session's verbs act on. An explicit `cast browser target`
 * wins. Otherwise the human's Chrome is the default whenever the extension is
 * connected, and the clone when it is not. With `settle` a real default is
 * written down as the session's choice, so a session that started in the
 * human's Chrome stays there if the extension drops; a clone default is not
 * written, so a session waiting on the clone moves over the moment the
 * extension is paired, which is the reason the human paired it.
 */
export function stickyTarget(sessionKey: string | null, opts: { settle?: boolean } = {}): "real" | "clone" {
  const chosen = explicitTarget(sessionKey);
  if (chosen) return chosen;
  const mode = extensionReady() ? "real" : "clone";
  if (opts.settle && mode === "real") setStickyTarget(sessionKey, mode);
  return mode;
}

/** Does this invocation act on the real Chrome? Flag beats sticky beats default. */
export function isRealMode(opts: { real?: boolean; clone?: boolean }, sessionKey: string | null): boolean {
  if (opts.real) return true;
  if (opts.clone) return false;
  return stickyTarget(sessionKey, { settle: true }) === "real";
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
export function splitTargetFlags(args: string[]): { real?: boolean; clone?: boolean; args: string[] } {
  const real = args.includes("--real") || undefined;
  const clone = args.includes("--clone") || undefined;
  return { real, clone, args: args.filter((a) => a !== "--real" && a !== "--clone") };
}

// ---------------------------------------------------------------------------
// The bridge as the engine's browser
// ---------------------------------------------------------------------------

/** The bridge config, or the setup instruction. Sync, for callers that only
 *  need the port and token (the host itself is started on `open`). */
export function requireBridgeConfigured(): BridgeState {
  const state = readBridgeState();
  if (!state?.token) {
    throw new Error("the extension bridge is not set up — run `cast browser extension setup` first");
  }
  return state;
}

/**
 * The bridge's CDP face for raw calls (reaper, pinned tab), or null when
 * there is nothing to reach: the bridge was never set up, its host is not
 * running, or what answers on the port cannot prove it is our host. Those
 * callers are courtesies that never start a host, so all three are "no".
 */
export async function bridgeEndpointIfConfigured(): Promise<CdpEndpoint | null> {
  const state = readBridgeState();
  if (!state?.token) return null;
  try {
    return bridgeEndpoint(await proveBridgeHost(state));
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
 */
export async function engineBrowserFor(session: string): Promise<EngineOptions & { session: string }> {
  if (!isRealSession(session)) return { session };
  const state = requireBridgeConfigured();
  return { session, cdp: bridgeWsUrl(await proveBridgeHost(state)) };
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

/** How long a host this process just started may wait for the extension to
 *  reconnect before it is declared absent. */
export const EXTENSION_RECONNECT_GRACE_MS = 8_000;

/**
 * A ready bridge: host up and the extension on the other end. Failing here,
 * with the setup instructions, beats failing on the first verb with less
 * context — a host with no extension can only ever answer errors.
 */
export async function requireRealBridge(): Promise<ProvenBridge> {
  requireBridgeConfigured();
  const state = await ensureBridgeHost();
  // A host that just came up has no extension yet: the extension finds it
  // within seconds on its own (host.ts waitForExtension), so the first real
  // command after a host restart waits instead of failing with the
  // instructions for a machine that was never paired.
  const status = await waitForExtension(state, state.started ? EXTENSION_RECONNECT_GRACE_MS : 0);
  if (!status.extensionConnected) {
    throw new Error(
      "the cast bridge extension is not connected to this machine's bridge host.\n" +
        "  In Chrome: check the extension is loaded (chrome://extensions), then run\n" +
        "  `cast browser extension setup`; it hands the extension the current token and port.",
    );
  }
  return state;
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
