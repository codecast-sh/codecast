/**
 * The bridge host: a loopback server that presents the user's REAL Chrome as
 * an ordinary Chrome DevTools endpoint, with the cast extension doing the
 * actual driving through chrome.debugger.
 *
 * Why this process exists at all: the extension must connect OUT (an extension
 * cannot listen), and each `cast browser` invocation is a fresh process that
 * exits in seconds — so something long-lived has to hold the extension's
 * socket. That is this.
 *
 * Why it speaks CDP to clients instead of a protocol of its own: measured
 * against both our built-in driver and agent-browser (`--cdp`), a CDP client
 * needs five browser-scope methods — Browser.getVersion, Target.getTargets,
 * Target.setDiscoverTargets, Target.attachToTarget, Target.createTarget — and
 * everything else is tab-scoped, which is exactly what chrome.debugger offers.
 * Emulating those five means every engine drives the real Chrome unchanged,
 * and this host never needs to learn a verb.
 *
 * Why WebSocket and not Chrome native messaging: native messaging inverts the
 * lifecycle (Chrome spawns and owns the host), needs an OS-level manifest
 * naming the extension's ID installed per user in a browser-specific
 * directory, and still leaves N short-lived CLI processes needing a local
 * socket to share one connection. A WS server is
 * that socket with one moving part fewer, and an open WebSocket keeps the MV3
 * service worker alive (Chrome 116+).
 *
 * Tab groups are the one thing added on top of CDP. `Target.createTarget`
 * takes two extra params: `background` (open without activating, which the
 * extension maps to `active: false`) and `castGroup` ({title, color}), which
 * puts the tab in a Chrome tab group so a session's tabs sit together and
 * the extension has a title to animate while it works. The group is per
 * client socket: once a client creates a grouped tab, or attaches to one,
 * every later `Target.createTarget` from that socket with no `castGroup`
 * lands in the same group. `castGroup` never reaches a client: replies and
 * target infos carry only what real Chrome would send.
 *
 * Threat model. Loopback is reachable by every local process and by JavaScript
 * on any web page. Against pages: the token lives in a 0600 file a page cannot
 * read, an upgrade carrying an http(s) Origin is refused before the token is
 * even checked (pages always send one; the extension sends chrome-extension://
 * and the CLI none), and the HTTP face rejects any Host other than loopback,
 * which is what defeats DNS rebinding. Against other local users: the token,
 * and the fact that it never crosses the wire in the clear on the extension
 * face. Any local account can bind this port while no host is running (after
 * a reboot, a crash, `extension revoke`), so nothing trusts a server for
 * answering: the extension and the host prove the token to each other with
 * HMACs over fresh nonces (protocol.ts bridgeProof), and the CLI demands the
 * same proof from /healthz before it presents the token anywhere. A group is
 * a grouping hint and nothing more: it grants no access to the tabs already
 * in it, and every tab still needs its own attach.
 */

import { launchdJobPlistXml, startLaunchdJob } from "../../launchdJob.js";
import * as fs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { WebSocket } from "ws";
import { serveBridge, type BridgeSocket } from "./transport.js";
import { spawn, spawnSync } from "../../proc.js";
import { isPidAlive } from "../../workspace/chrome.js";
import { browserHome } from "../profile.js";
import { withSession, type CdpEndpoint } from "../cdp.js";
import {
  BRIDGE_DEFAULT_PORT, BRIDGE_PROTOCOL, BRIDGE_STORE_URL, bridgeProof, CLOSE_BAD_TOKEN, CLOSE_EXTENSION_STANDBY, CLOSE_HANDSHAKE_TIMEOUT, CLOSE_SESSIONS_DROPPED, isNonce, isWebAuthnMethod, randomNonce, secretMatches, tabIdOfTarget,
  targetIdOfTab, WEBAUTHN_REFUSAL, type BridgeGroup, type BridgeReply, type BridgeTab,
} from "./protocol.js";
import { eventMessage, RawJson, readEventFrame, readReplyFrame, replyId, replyMessage, TrafficMeter, UNRELAYED_EVENTS } from "./frames.js";
import { FrameSessions, type FrameOut, type FrameRoute } from "./frameSessions.js";
import { COOKIE_READS, filterCookieReply, methodRefusal, needsScope, scopeRefusal, webHost } from "./guardrails.js";
import { checkUrl, isInternalUrl, loadMachinePolicy, loadSitePolicy, type SitePolicy } from "../policy.js";
import { humanInput } from "../humanInput.js";
import { hashHostToken, matchHostClient, newHostClient, scopedSession, visibleSessions, type HostClients } from "./hostClients.js";
import { extensionProfiles } from "./chromeProfiles.js";
import { LEGACY_LINK_KEY, Links, TabIds, type ExtLink } from "./links.js";
import { currentBuild, formatBuild, shouldReplaceHost } from "./hostBuild.js";
import { fetchBridge, RETIRING_HEADER } from "./retiring.js";
import {
  consumePairingCode, hasPendingCodes, hmacHex, isProfileKey, issueProfileKey, matchPendingCode, pairingPath, profileSlug, readPairing, recordPairingFailure, xorHex, type ProfileRecord,
} from "./pairing.js";

// ---------------------------------------------------------------------------
// Config and lifecycle (used by the CLI)
// ---------------------------------------------------------------------------

export interface BridgeState {
  port: number;
  token: string;
  hostPid?: number;
  startedAt?: number;
  /** Is the extension on the socket right now? Written by the host process,
   *  true only while it holds a proven extension connection. */
  extensionConnected?: boolean;
  /** When the extension last proved itself: "paired" means this is set. */
  extensionSeenAt?: number;
  /** The Chrome profile directory ("Default", "Profile 2") the extension was
   *  last paired in. Pages for the extension and Chrome launches name it
   *  (chromeProfiles.ts), so they never land in a profile without it. */
  profile?: string;
  /** Which agent tabs each session may see (host.ts sessionTabs), with the
   *  URL each was last seen at, so a restarted host restores the partition
   *  before any engine reconnects and re-pins. */
  sessionTabs?: SessionTabs;
  /** Tabs the human took back from each session (toolbar Take back), so a
   *  restarted host still answers that session's saved binding with the
   *  reason instead of a fresh tab. */
  takenBack?: TakenBack;
  /** The Chrome profile (links.ts id) each session works in; a session stays in its profile. */
  sessionProfiles?: Record<string, string>;
  /** Cloud hosts allowed to drive this Chrome as CDP clients, each by the
   *  hash of a token minted for it alone (hostClients.ts). */
  hostClients?: HostClients;
}

/** One tab the host remembers: the host's id, and which profile's Chrome tab it is (links.ts TabIds). */
export interface RememberedTab {
  tabId: number;
  /** The profile's short id; absent in state written before profiles, which then belongs to the first profile to connect. */
  profile?: string;
  /** Chrome's own id for the tab, when it differs from the host's. */
  chromeTabId?: number;
}

/** session key → the tabs granted to it, each with its last known URL. */
export type SessionTabs = Record<string, Array<RememberedTab & { url: string }>>;

/** session key → the tabs the human took back from it. */
export type TakenBack = Record<string, RememberedTab[]>;

export function bridgeStatePath(): string {
  return path.join(browserHome(), "bridge.json");
}

export function readBridgeState(): BridgeState | null {
  try {
    return JSON.parse(fs.readFileSync(bridgeStatePath(), "utf-8")) as BridgeState;
  } catch {
    return null;
  }
}

/** Atomic for the same reason as instance.json: concurrent CLI readers. */
export function writeBridgeState(state: BridgeState): void {
  fs.mkdirSync(browserHome(), { recursive: true, mode: 0o700 });
  const tmp = `${bridgeStatePath()}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, bridgeStatePath());
}

export function updateBridgeHostState(
  owner: Pick<BridgeState, "port" | "token"> & { hostPid: number },
  patch: Partial<Pick<BridgeState, "extensionConnected" | "extensionSeenAt" | "sessionTabs" | "takenBack" | "sessionProfiles">>,
): boolean {
  const current = readBridgeState();
  if (!current || current.port !== owner.port || current.token !== owner.token || current.hostPid !== owner.hostPid) return false;
  writeBridgeState({ ...current, ...patch });
  return true;
}

function defaultPort(): number {
  const env = parseInt(process.env.CAST_BRIDGE_PORT ?? "", 10);
  return Number.isFinite(env) && env > 0 ? env : BRIDGE_DEFAULT_PORT;
}

/** Create the token+port config on first use; never regenerates an existing token. */
export function ensureBridgeConfig(): BridgeState {
  const existing = readBridgeState();
  if (existing?.token) return existing;
  const state: BridgeState = {
    port: existing?.port ?? defaultPort(),
    token: crypto.randomBytes(32).toString("hex"),
  };
  writeBridgeState({ ...existing, ...state });
  return state;
}

/** Replace the token. Every holder of the old one is locked out on next connect. */
export function rotateBridgeToken(): BridgeState {
  const state = ensureBridgeConfig();
  const next = { ...state, token: crypto.randomBytes(32).toString("hex") };
  writeBridgeState(next);
  return next;
}

/**
 * A fresh token for one host's link, held by `holder`; only its hash is
 * stored. Refused while another
 * live process holds that host's link: replacing its token would cut its
 * clients, and its own exit would then revoke the new one.
 */
export function mintHostClientToken(hostId: string, label: string, holder = process.pid): { token: string } | { heldBy: number } {
  const state = ensureBridgeConfig();
  const cur = state.hostClients?.[hostId]?.holder;
  if (cur && cur !== holder && isPidAlive(cur)) return { heldBy: cur };
  const { token, record } = newHostClient(label, Date.now(), holder);
  writeBridgeState({ ...state, hostClients: { ...(state.hostClients ?? {}), [hostId]: record } });
  return { token };
}

/** Forget one host's token (only if it is still `hash`, when given); the running bridge host drops its sockets within seconds. */
export function revokeHostClient(hostId: string, hash?: string): boolean {
  const state = readBridgeState();
  const rec = state?.hostClients?.[hostId];
  if (!state || !rec || (hash && rec.hash !== hash)) return false;
  // The running host rewrites this file for its own fields from what it last
  // read, so a revoke that lands in that window could be undone: write until
  // a read-back shows it gone.
  for (let i = 0; i < 5; i++) {
    const cur = readBridgeState();
    if (!cur?.hostClients?.[hostId] || cur.hostClients[hostId].hash !== rec.hash) return true;
    const rest = { ...cur.hostClients };
    delete rest[hostId];
    writeBridgeState({ ...cur, hostClients: rest });
  }
  return !readBridgeState()?.hostClients?.[hostId];
}

/**
 * A bridge config whose host has just proved it holds the token (probeHost).
 * Everything that presents the token to the port takes this type, so the
 * compiler makes "verify before you present" impossible to skip: a squatter
 * on the port never sees the token, only a nonce it cannot answer.
 */
export type ProvenBridge = BridgeState & { readonly proven: true };

/**
 * The Chrome profile this invocation asked for (`--browser <id>`, or
 * CAST_BROWSER_PROFILE): every endpoint built from here on carries it, and
 * the host opens the session's new tabs there and keeps the session in it.
 */
let requestedProfile: string | null = process.env.CAST_BROWSER_PROFILE?.trim() || null;
export function requestBrowserProfile(id: string | null | undefined): void {
  requestedProfile = id?.trim() || null;
}

/** The CDP HTTP face of the bridge, for listTargets/CdpConnection.fromPort. */
export function bridgeEndpoint(state: ProvenBridge, session?: string | null): Exclude<CdpEndpoint, number> {
  return { port: state.port, token: state.token, ...(session ? { session } : {}), ...(requestedProfile ? { profile: requestedProfile } : {}) };
}

/**
 * Let a session see (and so drive) one agent tab it did not open: the
 * explicit share. The host refuses a tab that is not an agent's, so the
 * human's tabs stay out of reach whatever id is named. Every command in
 * real mode also re-grants the session's own pinned tab this way, which is
 * how a session finds its tab again after the host was restarted.
 */
export async function grantTab(
  state: { port: number; token: string },
  session: string,
  targetId: string,
  opts: { own?: boolean } = {},
): Promise<boolean> {
  const url = new URL(`http://127.0.0.1:${state.port}/grant`);
  url.searchParams.set("token", state.token);
  url.searchParams.set("session", session);
  url.searchParams.set("target", targetId);
  if (opts.own) url.searchParams.set("own", "1");
  // A profile this invocation asked for: the host refuses it when the session works in another.
  if (requestedProfile) url.searchParams.set("profile", requestedProfile);
  // The project this session works in: the host loads its site allowlist
  // from there (policy.ts) and holds every tab granted to the session to it.
  url.searchParams.set("cwd", process.cwd());
  // Every real-mode verb passes through here; a host starved on a loaded
  // machine answers late, not never, and 5 s read that as "timed out". The
  // host answers a grant with a tab listing from the worker, so the wait
  // covers the worker's frozen process too, and a timeout is named as the
  // stall it is (stall.ts retries it once).
  const GRANT_TIMEOUT_MS = 45_000;
  let res: Response;
  try {
    res = await fetchBridge(url, { method: "POST", signal: AbortSignal.timeout(GRANT_TIMEOUT_MS) });
  } catch (err) {
    const name = (err as { name?: string } | null)?.name;
    if (name === "TimeoutError" || name === "AbortError") {
      throw new Error(`/grant did not answer within ${GRANT_TIMEOUT_MS}ms (the bridge host verifies a grant through the extension, whose process runs at background priority and was not scheduled)`);
    }
    throw err;
  }
  if (res.ok) return true;
  // The session's own saved tab is gone (404), or the host cannot tell
  // whether it is an agent's (403: the extension lost its ownership marks on
  // a reload, or the id now names a human's tab). Either way the binding is
  // no good and the caller drops it and makes a fresh tab; the doubtful tab
  // is never adopted, which is the whole of the rule (ct-51311).
  if (opts.own && (res.status === 404 || res.status === 403)) return false;
  let body: { error?: string; takenBack?: boolean } = {};
  try {
    body = (await res.json()) as typeof body;
  } catch {}
  const detail = String(body.error ?? "");
  if (opts.own && res.status === 409 && body.takenBack) throw new TabTakenBackError(detail || `the human took tab ${targetId} back from agents`, targetId);
  throw new Error(detail || `bridge host answered ${res.status}`);
}

/** The session's own saved tab was taken back by the human from the toolbar (/grant answered 409). */
export class TabTakenBackError extends Error {
  constructor(message: string, readonly targetId: string) {
    super(message);
    this.name = "TabTakenBackError";
  }
}

/** The browser-level CDP socket, for any client that takes a URL (agent-browser's cdp option). */
export function bridgeWsUrl(state: ProvenBridge): string {
  return `ws://127.0.0.1:${state.port}/devtools/browser/${state.token}`;
}

/**
 * What a probe of the bridge port found. "busy" is a port that accepted the
 * connection but did not answer in time: something is listening, and on a
 * loaded machine that something is usually our own host with a starved
 * event loop. It is not "down" — a caller that spawned a second host on a
 * busy port only crashed it against EADDRINUSE (144 times in one log).
 */
export type HostProbe = "alive" | "impostor" | "down" | "busy";

/**
 * What answers on the bridge port: a host that proved it holds our token, a
 * server that answers like one but cannot prove it, or nothing. No token
 * leaves this process: the host is challenged with a nonce and must return
 * HMAC(token, "healthz:" + nonce).
 */
export async function probeHost(state: Pick<BridgeState, "port" | "token">, timeoutMs = 1200): Promise<HostProbe> {
  const nonce = randomNonce();
  let body: string;
  try {
    const res = await fetch(`http://127.0.0.1:${state.port}/healthz?nonce=${nonce}`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return "down";
    body = await res.text();
  } catch (err) {
    const name = (err as { name?: unknown } | null)?.name;
    return name === "TimeoutError" || name === "AbortError" ? "busy" : "down";
  }
  if (!body.startsWith("cast-bridge")) return "down";
  const proof = /\bproof=([0-9a-f]{64})\b/.exec(body)?.[1];
  const alive = secretMatches(bridgeProof(state.token, "healthz", nonce), proof);
  if (alive) probedBuilds.set(state.port, /\bbuild=(\S+)/.exec(body)?.[1]);
  return alive ? "alive" : "impostor";
}

const retireAsked = new Set<number>();

/**
 * "The host on this port is busy; do not ask it to retire before `until`",
 * shared by every cast process: with a live engine socket a host stays busy
 * for hours, and each new process asking again would be a request per
 * command for nothing. The swap happens on the first command after the TTL
 * that finds the host idle.
 */
const RETIRE_BUSY_TTL_MS = 60_000;
const retireBusyPath = (): string => path.join(browserHome(), "retire-busy.json");
export function retireBusyNow(port: number, build: string | undefined, now = Date.now()): boolean {
  try {
    const b = JSON.parse(fs.readFileSync(retireBusyPath(), "utf-8")) as { port?: number; build?: string; until?: number };
    return b.port === port && b.build === build && typeof b.until === "number" && b.until > now;
  } catch {
    return false;
  }
}
function markRetireBusy(port: number, build: string | undefined, busy: boolean): void {
  try {
    if (!busy) return fs.rmSync(retireBusyPath(), { force: true });
    fs.mkdirSync(browserHome(), { recursive: true, mode: 0o700 });
    const tmp = `${retireBusyPath()}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ port, build, until: Date.now() + RETIRE_BUSY_TTL_MS }), { mode: 0o600 });
    fs.renameSync(tmp, retireBusyPath());
  } catch { /* the next process asks again; nothing depends on the stamp */ }
}

/** The build each proven host stamped on its last /healthz (hostBuild.ts); undefined for a host from before stamps. */
const probedBuilds = new Map<number, string | undefined>();

/**
 * Ask a host whose build is older than this CLI's to make way. It answers at
 * once: yes when idle (no client connected, nothing in flight, quiet for a
 * moment), and then exits, which this waits out; else 409. "busy" leaves it
 * running: the command uses it as it is, never waiting on the swap, and no
 * process asks again until the busy stamp lapses.
 */
export async function retireOlderHost(state: BridgeState, note?: (line: string) => void): Promise<"retired" | "busy" | "kept"> {
  const theirs = probedBuilds.get(state.port);
  if (process.env.CAST_BRIDGE_NO_SWAP === "1" || !shouldReplaceHost(theirs)) return "kept";
  // Once per process: a command looks the bridge up several times, and a
  // busy host would cost it the drain on every lookup. The next command asks again.
  if (retireAsked.has(state.port) || retireBusyNow(state.port, theirs)) return "busy";
  retireAsked.add(state.port);
  let res: Response;
  try {
    res = await fetch(`http://127.0.0.1:${state.port}/retire?token=${encodeURIComponent(state.token)}`, { method: "POST", signal: AbortSignal.timeout(3_000) });
  } catch {
    return "busy";
  }
  markRetireBusy(state.port, theirs, res.status === 409);
  if (!res.ok) return res.status === 409 ? "busy" : "kept";
  note?.(`replacing the bridge host (build ${theirs}) with this cast's (build ${formatBuild(currentBuild())}); the extension reconnects on its own…`);
  const gone = Date.now() + 10_000;
  while (Date.now() < gone && (await probeHost(state, 500)) !== "down") await sleep(150);
  return "retired";
}

/** The config as a proven host, or the reason the port cannot be trusted. */
export async function proveBridgeHost(state: BridgeState, timeoutMs = 1200): Promise<ProvenBridge> {
  const probe = await probeHost(state, timeoutMs);
  if (probe === "alive") return { ...state, proven: true };
  throw unprovenHostError(state, probe, timeoutMs);
}

/**
 * Why the port cannot be used. A busy host is named as busy and nothing else:
 * an agent told its host was "stalled", with a pid, killed it, and every
 * session's in-flight command and tab attachment died with it while the
 * machine stayed exactly as loaded.
 */
function unprovenHostError(state: BridgeState, probe: Exclude<HostProbe, "alive">, waitedMs: number): Error {
  return new Error(
    probe === "impostor"
      ? `something on 127.0.0.1:${state.port} answers like a bridge host but cannot prove it holds the token — ` +
          `stop it, or set CAST_BRIDGE_PORT to move the bridge`
      : probe === "busy"
        ? `the bridge host on 127.0.0.1:${state.port} is up but did not answer within ${Math.round(waitedMs / 1000)}s — ` +
          `it is busy (the machine is loaded, or a tab is streaming heavy traffic; its log names the traffic: ${bridgeHostLogPath()}). ` +
          `Retry the command; do not kill the host, which drops every session's tabs and changes nothing about the load`
        : `no bridge host is answering on 127.0.0.1:${state.port}`,
  );
}

/**
 * A probe with patience for a busy host: re-asked, with a longer timeout
 * each time, until it answers or `budgetMs` runs out. A refusal ("down") is
 * final at once — nothing is listening, waiting would not change that.
 */
const PATIENT_PROBE_MS = 15_000;

export async function probeHostPatiently(state: Pick<BridgeState, "port" | "token">, budgetMs = PATIENT_PROBE_MS): Promise<HostProbe> {
  const deadline = Date.now() + budgetMs;
  let timeout = 1200;
  let probe = await probeHost(state, timeout);
  while (probe === "busy" && Date.now() < deadline) {
    timeout = Math.min(timeout * 2, Math.max(300, deadline - Date.now()));
    probe = await probeHost(state, timeout);
  }
  return probe;
}

/** The host's own stdout and stderr. Append-only, so a host that died says why. */
export function bridgeHostLogPath(): string {
  return path.join(browserHome(), "bridge-host.log");
}

/** Brings a host up for ensureBridgeHost: the detached respawn, or an in-process host in tests. */
export type BridgeHostStarter = (state: BridgeState) => void | Promise<void>;

/** The host's plist; the job runs at Interactive priority (see launchdJob.ts for why). */
export const bridgeHostPlistXml = launchdJobPlistXml;

/**
 * Respawn ourselves as the host, detached, writing to bridgeHostLogPath().
 * Under bun/node the entry script must be repeated; in the compiled binary
 * process.execPath IS the cast binary.
 */
const respawnDetached: BridgeHostStarter = (state) => {
  const base = path.basename(process.execPath).toLowerCase();
  const viaRuntime = base.includes("bun") || base.includes("node");
  const args = viaRuntime ? [process.argv[1], "browser", "bridge-host"] : ["browser", "bridge-host"];
  fs.mkdirSync(browserHome(), { recursive: true, mode: 0o700 });
  if (startLaunchdJob({ label: `sh.codecast.bridge-host.${state.port}`, argv: [process.execPath, ...args], plistPath: path.join(browserHome(), "bridge-host.plist"), logPath: bridgeHostLogPath() })) return;
  const log = fs.openSync(bridgeHostLogPath(), "a", 0o600);
  try {
    const child = spawn(process.execPath, args, { detached: true, stdio: ["ignore", log, log] });
    child.unref();
  } finally {
    fs.closeSync(log);
  }
};

/**
 * Make sure a host is running, starting one detached if not. Mirrors the
 * managed browser's auto-start: callers should not have to know the host is a
 * separate process. An impostor on the port is named rather than raced: a
 * host we start could not bind anyway.
 */
/** How long a freshly started host gets to bind and answer: a bun parsing the whole CLI from source took 65 s at load 400. */
export const HOST_START_WAIT_MS = 90_000;

export async function ensureBridgeHost(
  start: BridgeHostStarter = respawnDetached,
  deps: { staleHostPids?: (port: number) => number[]; kill?: (pid: number) => void; note?: (line: string) => void } = {},
): Promise<ProvenBridge & { started: boolean }> {
  const state = ensureBridgeConfig();
  // Patient on purpose: a host whose loop is starved on a loaded machine
  // reads as "busy", and the right move is to wait for it, never to spawn a
  // second one against its port.
  let probe = await probeHostPatiently(state);
  if (probe === "alive" && (await retireOlderHost(state, deps.note)) === "retired") probe = await probeHost(state, 500);
  if (probe === "alive") return { ...state, proven: true, started: false };
  if (probe === "impostor") {
    // A bridge host of ours that holds another token: left behind by a
    // config this machine no longer has (a removed state file, a test that
    // ran against the real home, a second CODECAST_DIR on the default port).
    // It is our own program on our own port, so it is stopped and replaced
    // rather than reported for a person to hunt down. Anything else on the
    // port is not ours to touch and is named as before.
    const stale = (deps.staleHostPids ?? bridgeHostPidsOnPort)(state.port);
    if (!stale.length) return { ...(await proveBridgeHost(state)), started: false };
    for (const pid of stale) {
      try {
        (deps.kill ?? ((p) => process.kill(p, "SIGTERM")))(pid);
      } catch {}
    }
    const gone = Date.now() + 5_000;
    while (Date.now() < gone && (await probeHost(state, 500)) !== "down") await sleep(150);
    probe = await probeHost(state, 500);
    if (probe !== "down") return { ...(await proveBridgeHost(state)), started: false };
  } else if (probe === "busy") {
    // Already waited out probeHostPatiently's whole budget: report that wait,
    // not a fresh one-second probe that says less.
    throw unprovenHostError(state, probe, PATIENT_PROBE_MS);
  }

  await start(state);

  // Generous on purpose: run from source, the detached host is a fresh bun
  // parsing the whole CLI, which on a loaded machine takes far longer than
  // the host itself needs to bind; and a host that has bound but answers
  // late ("busy") is up, not absent. Each probe gets a few seconds, so a
  // late answer still counts within the budget. Waiting beats failing: a
  // verb that gives up here hands the human a problem the next second
  // would have solved.
  const startedAt = Date.now();
  const deadline = startedAt + HOST_START_WAIT_MS;
  let noted = false;
  while (Date.now() < deadline) {
    const p = await probeHost(state, 3_000);
    if (p === "alive") return { ...(readBridgeState() ?? state), proven: true, started: true };
    if (p === "impostor") return { ...(await proveBridgeHost(state)), started: false };
    if (p === "down") await sleep(150);
    if (!noted && deps.note && Date.now() - startedAt > 5_000) {
      noted = true;
      deps.note(`waiting for the bridge host to start (a fresh cast process, slow on a loaded machine; up to ${HOST_START_WAIT_MS / 1000}s)…`);
    }
  }
  throw new Error(
    `the bridge host did not come up on 127.0.0.1:${state.port} within ${HOST_START_WAIT_MS / 1000}s — ` +
      `its log is ${bridgeHostLogPath()}; is another process on that port? Set CAST_BRIDGE_PORT to move it.`,
  );
}

/**
 * Pids of `cast … browser bridge-host` processes listening on the port: our
 * own program, whichever config it was started from. `lsof` on macOS and
 * Linux; a machine without it reports none, and the impostor is then named
 * rather than stopped.
 */
export function bridgeHostPidsOnPort(port: number): number[] {
  const out: number[] = [];
  try {
    const listing = spawnSync("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"], { encoding: "utf-8", timeout: 5_000 }).stdout ?? "";
    for (const line of listing.split("\n")) {
      const pid = parseInt(line.trim(), 10);
      if (!Number.isFinite(pid) || pid <= 0 || pid === process.pid) continue;
      const cmd = spawnSync("ps", ["-p", String(pid), "-o", "command="], { encoding: "utf-8", timeout: 3_000 }).stdout ?? "";
      if (/\bbrowser bridge-host\b/.test(cmd)) out.push(pid);
    }
  } catch {
    /* no lsof, or it timed out: nothing is stopped */
  }
  return out;
}

export function stopBridgeHost(): boolean {
  const state = readBridgeState();
  if (!state?.hostPid || !isPidAlive(state.hostPid)) return false;
  try {
    process.kill(state.hostPid, "SIGTERM");
    return true;
  } catch {
    return false;
  }
}

export interface BridgeHostStatus {
  extensionConnected: boolean;
  extensionVersion?: string;
  extensionProtocol?: number;
  /** The host's own protocol; differs from the extension's while a store update is in review. */
  protocol?: number;
  /** Every connected Chrome profile, the default flagged. Absent from a host that predates profiles. */
  profiles?: BridgeProfileStatus[];
  /** The host's build (hostBuild.ts). */
  build?: string;
}

export interface BridgeProfileStatus {
  id: string;
  name: string;
  dir?: string;
  default: boolean;
  /** Still on the machine's shared token: a store build from before profiles. */
  legacy: boolean;
  version?: string;
  protocol?: number;
  connectedAt: number;
  /** Sessions working in it. */
  sessions: number;
}

/** Ask a running host whether the extension is connected. */
export async function bridgeStatus(state: ProvenBridge): Promise<BridgeHostStatus> {
  const res = await fetchBridge(`http://127.0.0.1:${state.port}/status?token=${encodeURIComponent(state.token)}`, {
    signal: AbortSignal.timeout(3000),
  });
  if (!res.ok) throw new Error(`bridge host answered ${res.status} — token mismatch? re-run \`cast browser extension setup\``);
  return (await res.json()) as BridgeHostStatus;
}

/**
 * Ask the extension to reload itself. It answers before it goes; the caller
 * then waits for it to come back (waitForExtension). An extension from before
 * the op exists answers "unknown op", which the host relays as the error.
 */
export async function reloadExtension(state: ProvenBridge): Promise<void> {
  const res = await fetchBridge(`http://127.0.0.1:${state.port}/reload?token=${encodeURIComponent(state.token)}`, {
    method: "POST",
    signal: AbortSignal.timeout(8000),
  });
  if (res.ok) return;
  let detail = "";
  try {
    detail = String(((await res.json()) as { error?: string }).error ?? "");
  } catch {}
  if (res.status === 404) detail = "this bridge host predates the reload route — stop it (cast browser extension revoke rotates the token; or kill the hostPid in bridge.json) and run any verb to start a fresh one";
  throw new Error(`bridge host answered ${res.status}${detail ? ` — ${detail}` : ""}`);
}

/**
 * The host's status once the extension is connected, or the last status seen
 * when `timeoutMs` passes first. The extension reconnects on its own a few
 * seconds after a host comes up (background.js retries at 1 s, 2 s and 5 s,
 * then every 30 s), so a caller that just started the host, or just handed
 * the extension a token, asks here instead of declaring it absent at once.
 */
export async function waitForExtension(
  state: ProvenBridge,
  timeoutMs: number,
  opts: { note?: (line: string) => void; noteAfterMs?: number } = {},
): Promise<BridgeHostStatus> {
  const deadline = Date.now() + timeoutMs;
  const noteAt = Date.now() + (opts.noteAfterMs ?? 2_000);
  let noted = false;
  let last: BridgeHostStatus = { extensionConnected: false };
  for (;;) {
    try {
      last = await bridgeStatus(state);
    } catch (err) {
      // A host too busy to answer /status in time is not an absent
      // extension; the question is asked again until the budget is spent.
      if (Date.now() >= deadline) throw err;
    }
    if (last.extensionConnected || Date.now() >= deadline) return last;
    if (!noted && opts.note && Date.now() >= noteAt) {
      noted = true;
      opts.note(`waiting for the Chrome extension to reconnect (up to ${Math.round(timeoutMs / 1000)}s)…`);
    }
    await sleep(250);
  }
}

/**
 * The first connected profile `match` accepts, within `timeoutMs`; null when
 * none arrives. What `setup` waits on after handing Chrome a pairing code.
 */
export async function waitForPairedProfile(state: ProvenBridge, timeoutMs: number, match: (p: BridgeProfileStatus) => boolean): Promise<BridgeProfileStatus | null> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const s = await bridgeStatus(state).catch(() => null);
    const hit = s?.profiles?.find(match);
    if (hit) return hit;
    if (Date.now() >= deadline) return null;
    await sleep(250);
  }
}

// ---------------------------------------------------------------------------
// The server
// ---------------------------------------------------------------------------

export interface RunningHost {
  port: number;
  close(): Promise<void>;
  extensionConnected(): boolean;
  /** The connected profiles' ids, in connection order. */
  profiles(): string[];
}

/** One CDP client (a `cast` process, an agent-browser daemon…). */
interface Client {
  ws: BridgeSocket;
  /** sessionId → tabId for the tabs this client has attached. */
  sessions: Map<string, number>;
  discover: boolean;
  /** The group of the last tab this client created with one or attached to; later creates join it. */
  group: BridgeGroup | null;
  /** The cast session on this socket (`?session=` on the upgrade). A socket
   *  with none is a tool of the human's or of cast itself and sees every
   *  agent tab; a session's socket sees only the tabs granted to it. */
  session: string | null;
  /** `?raise=1` on the upgrade: this socket brings tabs to the front on
   *  purpose. Every other socket's raises are dropped. */
  raise: boolean;
  /** Tabs this socket has been told about, so a later grant of a tab it
   *  already knows is not announced twice. */
  announced: Set<number>;
  /** The cloud host whose token opened this socket (hostClients.ts), or null for this machine's own token. */
  host: string | null;
  /** `?profile=` on the upgrade: the Chrome profile (links.ts id) this socket's new tabs open in. */
  profile: string | null;
}

interface PendingExt {
  resolve: (r: BridgeReply) => void;
  reject: (e: Error) => void;
  /** What the request was, for the traffic log: the op, or the CDP method of a `cdp` op. */
  label: string;
  /** A successful reply resolves with its result as JSON bytes (`raw`), never decoded. */
  raw: boolean;
  /** The profile's link the request went to; its close fails what it still owes. */
  link: ExtLink;
}

/** Events the host reads for child sessions (frameSessions.ts); the two Target ones are never relayed as Chrome sent them. */
const FRAME_EVENTS: ReadonlySet<string> = new Set(["Target.attachedToTarget", "Target.detachedFromTarget", "Page.frameNavigated"]);

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);

/** The HTTP routes a cloud host's token reaches (hostClients.ts): what a CDP client asks, and the status that says whether the extension is there. */
const HOST_CLIENT_SWEEP_MS = 2_000;
const HOST_CLIENT_ROUTES = new Set(["/json/version", "/json/version/", "/json", "/json/list", "/json/list/", "/status", "/grant"]);

/** How long a fresh extension socket may stay silent before its hello is due. */
const HELLO_TIMEOUT_MS = 15_000;

/**
 * The largest message this socket will hold. It exists for what the extension
 * sends BACK — a full-page screenshot is the biggest thing on this wire — and
 * it used to be 256 MiB, which is two orders of magnitude past any capture and
 * a large amount of memory to hand an unauthenticated local client.
 */
const MAX_MESSAGE_BYTES = 64 * 1024 * 1024;

/**
 * How large a hello may be. /ext is the one face that authenticates AFTER the
 * upgrade, so until the hello is proven this is what the socket is allowed;
 * a real hello is a few hundred bytes.
 *
 * Enforced on the first message rather than on the raw socket: under bun an
 * upgraded socket delivers nothing to an extra "data" listener, so a byte
 * counter there would be a control that is not one. MAX_MESSAGE_BYTES is what
 * bounds the buffering underneath it.
 */
const PRE_AUTH_MAX_BYTES = 256 * 1024;

/** How many unproven /ext sockets may be mid-handshake at once. The real
 *  extension opens one. */
const MAX_PENDING_EXT_HANDSHAKES = 4;

/**
 * Origins a legitimate bridge client may present on an upgrade.
 *
 * The extension worker and our own CDP clients send NO Origin; a browser
 * extension page sends `chrome-extension://…`. Everything else is a document,
 * and a document has no business here — including the literal `null` an
 * opaque origin sends (a sandboxed iframe, a data: or file: document), which
 * used to be admitted because only http(s) was refused. Refusing before the
 * token check means a probing page learns nothing, not even whether a stolen
 * token would have worked.
 */
export function bridgeUpgradeOriginAllowed(origin: string | string[] | undefined): boolean {
  if (origin === undefined) return true;
  if (typeof origin !== "string") return false;
  return /^(chrome|moz)-extension:\/\/[a-z0-9-]+\/?$/i.test(origin);
}

/**
 * How long the extension may go silent before its socket is declared dead:
 * a worker that is gone while Chrome's network process still holds the TCP
 * side open would otherwise keep every command waiting on a socket nobody
 * reads. Silence alone is weak evidence of that. Chrome runs the worker's
 * process at background priority, and on a loaded Mac it can go a minute
 * or more without CPU while alive and holding tabs (background.js holdSelf
 * keeps Chrome from ending it). Cutting that socket failed every command in
 * flight for no gain, because a truly dead worker is replaced sooner anyway:
 * its successor connects within the 30 s alarm and a newer connection wins.
 * So the budget matches Chrome's own limit for one request, five minutes.
 */
const EXTENSION_SILENCE_MS = 5 * 60_000;

/** `castGroup` as a client may send it; anything else is treated as absent. */
function parseGroup(raw: unknown): BridgeGroup | null {
  if (!raw || typeof raw !== "object") return null;
  const { title, color } = raw as Record<string, unknown>;
  if (typeof title !== "string" || !title.trim() || typeof color !== "string") return null;
  return { title, color: color as BridgeGroup["color"] };
}

/** CDP-shaped error reply. -32601 is what Chrome uses for an unknown method. */
function cdpError(id: number, message: string, code = -32000) {
  return { id, error: { code, message } };
}

/**
 * Start the server in-process. `runBridgeHost` (the CLI entry) wraps this
 * with state-file bookkeeping and signal handling; tests call it directly.
 */
export async function startBridgeHost(opts: {
  port: number;
  token: string;
  /** The extension came (true) or went (false); the host process records it.
   *  `detail` says which worker and why (hello) or how the socket ended (close). */
  onExtension?: (connected: boolean, detail: string) => void;
  /** The session → tab partition a previous host left behind; pruned against
   *  Chrome's live tabs when the extension connects. */
  sessionTabs?: SessionTabs;
  /** Called with the partition whenever it changes, for the host process to persist. */
  onSessionTabs?: (tabs: SessionTabs) => void;
  /** A line naming the traffic of a minute heavy enough to load the host (frames.ts TrafficMeter). */
  onTraffic?: (line: string) => void;
  /** Keepalive cadence and the silence after which the extension socket is dropped; tests shorten both. */
  pingIntervalMs?: number;
  extensionSilenceMs?: number;
  /** A second extension was turned away because the current one still answers (CLOSE_EXTENSION_STANDBY). */
  onStandby?: (detail: string) => void;
  /** How long the current extension has to answer a ping before a newcomer replaces it; tests shorten it. */
  incumbentProbeMs?: number;
  /** The cloud hosts' token records as they stand now (hostClients.ts); read on every auth, so a revoke binds at once. */
  hostClients?: () => HostClients | undefined;
  /** A line for the log when a cloud host's client connects, leaves or is cut off. */
  onHostClient?: (line: string) => void;
  /** Take-back marks and each session's profile, as a previous host left them. */
  takenBack?: TakenBack;
  sessionProfiles?: Record<string, string>;
  /** Called with all the tab state whenever any of it changes, for the host process to persist. */
  onTabState?: (state: Pick<BridgeState, "sessionTabs" | "takenBack" | "sessionProfiles">) => void;
  /** The paired profiles as they stand now (pairing.ts); read on every hello and swept for revokes. */
  profiles?: () => Record<string, ProfileRecord> | undefined;
  /** Profile keys revoked one by one (pairing.ts): the shared token never migrates one back in. */
  revokedProfiles?: () => Record<string, number> | undefined;
  /** The Chrome profile directory setup paired last: the default profile's. */
  pinnedProfile?: () => string | undefined;
  /** A profile was paired or migrated on this host, or a hello was refused; for the log. */
  onProfile?: (line: string) => void;
  /** The display name of a Chrome profile directory (chromeProfiles.ts), for naming a migrated profile. */
  profileName?: (dir: string) => string | undefined;
  /** This host's build (hostBuild.ts), answered on /healthz so a newer CLI can replace it. */
  build?: string;
  /** Asked to make way for a newer build, once idle: the host process exits after the reply. */
  onRetire?: () => void;
  /** How long the host must have been quiet to count as idle; tests shorten it. */
  idleQuietMs?: number;
}): Promise<RunningHost> {
  const { port, token, onExtension } = opts;
  /** Each live cloud-host socket and the hash of the token that opened it. */
  const hostClientTokens = new Map<Client, string>();
  /** Who a presented CDP token belongs to: this machine (host null), one cloud host, or nobody. */
  const clientOf = (presented: string | null | undefined): { host: string | null } | null => {
    if (secretMatches(token, presented)) return { host: null };
    const host = matchHostClient(opts.hostClients?.(), presented);
    return host ? { host } : null;
  };

  // One link per connected Chrome profile (links.ts), and the host's own tab
  // ids over every profile's Chrome ids.
  const links = new Links();
  const tabIds = new TabIds();
  let nextExtId = 1;
  const extPending = new Map<number, PendingExt>();
  const clients = new Set<Client>();
  const traffic = new TrafficMeter(opts.onTraffic);
  /** Requests being served right now, and when the last one ended: what "idle" means for a retire (/retire). */
  let inFlight = 0;
  let lastActivityAt = Date.now();
  const busy = <T>(work: Promise<T>): Promise<T> => {
    inFlight++;
    return work.finally(() => {
      inFlight--;
      lastActivityAt = Date.now();
    });
  };
  const defaultLink = (): ExtLink | undefined => links.default(opts.pinnedProfile?.());
  const notConnected = (): Error =>
    new Error(
      `the cast bridge extension is not connected (Codecast, ${BRIDGE_STORE_URL}): \`cast browser extension status\` puts the pairing card in front of the person when it is missing`,
    );

  const sendJson = (ws: BridgeSocket, msg: unknown): void => {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
  };
  const sendFrames = (outs: FrameOut<Client>[]): void => {
    for (const o of outs) sendJson(o.client.ws, o.msg);
  };

  // ------------------------------------------------------------ extension

  /**
   * A request to one profile's extension. A `tabId` in the payload is the
   * host's id: it names the profile and is translated to that Chrome's own
   * id on the way out. A request with no tab goes to `via`, else the default
   * profile.
   */
  const extRequest = (op: string, payload: Record<string, unknown> = {}, timeoutMs = 30_000, raw = false, via?: ExtLink): Promise<BridgeReply> => {
    let link = via;
    let out = payload;
    if (typeof payload.tabId === "number") {
      const at = tabIds.chrome(payload.tabId);
      if (at) {
        link = links.get(at.link);
        out = { ...payload, tabId: at.tab };
        if (!link) return Promise.reject(new Error(`tab ${targetIdOfTab(payload.tabId)} is in Chrome profile "${at.link}", which is not connected`));
      } else {
        // A tab no listing has named yet: with one profile its id is Chrome's own.
        const all = links.list();
        if (all.length > 1) return Promise.reject(new Error(`No target with given id found (tab ${targetIdOfTab(payload.tabId)})`));
        link = all[0];
      }
    }
    link ??= defaultLink();
    if (!link || link.ws.readyState !== WebSocket.OPEN) return Promise.reject(notConnected());
    const to = link;
    return new Promise((resolve, reject) => {
      const id = nextExtId++;
      const timer = setTimeout(() => {
        extPending.delete(id);
        // Not a lost connection: the socket is open and the worker's last
        // message is dated below. Chrome runs the extension's process at
        // background priority, which macOS schedules on the efficiency cores
        // only; a worker that has not answered has not been given CPU.
        reject(
          new Error(
            `${op} did not answer within ${timeoutMs}ms (extension${links.list().length > 1 ? ` in ${to.id}` : ""} last heard ${Date.now() - to.heardAt}ms ago; ` +
              `Chrome runs the extension at background priority, so its worker was not scheduled, not lost)`,
          ),
        );
      }, timeoutMs);
      extPending.set(id, {
        label: op === "cdp" && typeof payload.method === "string" ? payload.method : op,
        raw,
        link: to,
        resolve: (r) => {
          clearTimeout(timer);
          resolve(r);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
      sendJson(to.ws, { id, op, ...out });
    });
  };

  const extCall = async (op: string, payload: Record<string, unknown> = {}, timeoutMs?: number, raw = false, via?: ExtLink): Promise<BridgeReply> => {
    const r = await extRequest(op, payload, timeoutMs, raw, via);
    if (!r.ok) throw new Error(String(r.error ?? `${op} failed`));
    return r;
  };

  // Every tab in the human's Chrome, cast tabs first. `/json/list` serves this
  // whole list so `cast browser tabs` can name where a session's tabs sit.
  // Tabs this host created for a client, known the moment tabs.create answers:
  // the extension stamps ownership a beat after Chrome fires the created event,
  // so the event alone can arrive looking like the human's.
  const castTabs = new Set<number>();
  // Persisted through `onSessionTabs`, restored from `opts.sessionTabs`: an
  // engine daemon outlives the host and reconnects on its own, and one that
  // discovers no tab of its own pins a fresh one — so the partition must be
  // back before the first reconnect, not rebuilt as commands arrive. Each
  // entry keeps the tab's last URL: Chrome reuses tab ids across its own
  // restarts, so on the extension's next hello a remembered tab is kept only
  // if it still exists at that URL (or the extension itself still marks it as
  // an agent's); anything else is dropped rather than risk claiming a tab
  // the human opened.
  const sessionTabs = new Map<string, Map<number, string>>();
  // Tabs the human took back from each session that held them (toolbar Take
  // back). The session's saved binding still names the tab, and its next
  // command must say why it lost it rather than quietly bind another tab
  // (/grant answers 409). Cleared when the session is granted the tab again.
  // Persisted with the rest of the tab state, so a host restart does not
  // forget that the human took a tab back.
  const takenBack = new Map<string, Set<number>>();
  // The profile each session works in (links.ts id): its first tab's, or the
  // one it asked for. A session stays there; it never sees another's tabs.
  const sessionProfiles = new Map<string, string>(Object.entries(opts.sessionProfiles ?? {}));
  const restored = opts.sessionTabs ?? {};
  // Restored tabs whose profile is not known yet (state from before
  // profiles): the first profile to list its tabs claims them.
  const unclaimed = new Set<number>();
  const seedRemembered = (t: RememberedTab): void => {
    if (t.profile) tabIds.seed(t.tabId, t.profile, t.chromeTabId ?? t.tabId);
    else unclaimed.add(t.tabId);
  };
  for (const [session, tabs] of Object.entries(restored)) {
    sessionTabs.set(session, new Map(tabs.map((t) => [t.tabId, t.url])));
    tabs.forEach(seedRemembered);
  }
  for (const [session, tabs] of Object.entries(opts.takenBack ?? {})) {
    takenBack.set(session, new Set(tabs.map((t) => t.tabId)));
    for (const t of tabs) if (t.profile) tabIds.seed(t.tabId, t.profile, t.chromeTabId ?? t.tabId);
  }
  /** Profiles whose first listing has checked the restored partition against their live tabs. */
  const prunedLinks = new Set<string>();
  const remembered = (tabId: number): RememberedTab => {
    const at = tabIds.chrome(tabId);
    return { tabId, ...(at ? { profile: at.link, ...(at.tab !== tabId ? { chromeTabId: at.tab } : {}) } : {}) };
  };
  const persist = (): void => {
    const out: SessionTabs = {};
    for (const [session, tabs] of sessionTabs) {
      if (tabs.size) out[session] = [...tabs].map(([tabId, url]) => ({ ...remembered(tabId), url }));
    }
    const back: TakenBack = {};
    for (const [session, tabs] of takenBack) if (tabs.size) back[session] = [...tabs].map(remembered);
    opts.onSessionTabs?.(out);
    opts.onTabState?.({ sessionTabs: out, takenBack: back, sessionProfiles: Object.fromEntries(sessionProfiles) });
  };
  const grantedTo = (session: string): Map<number, string> => {
    let tabs = sessionTabs.get(session);
    if (!tabs) sessionTabs.set(session, (tabs = new Map()));
    return tabs;
  };
  const sessionsOf = (tabId: number): string[] => [...sessionTabs].filter(([, tabs]) => tabs.has(tabId)).map(([k]) => k);
  const isCast = (t: BridgeTab) => castTabs.has(t.tabId) || (t.owned ?? !!t.group) || sessionsOf(t.tabId).length > 0;
  /**
   * A session's socket sees the tabs granted to it. A socket that names none
   * sees every agent tab, and a cloud host's only those of its own sessions
   * (hostClients.ts scopedSession): never a laptop session's, never the human's.
   */
  const canSee = (client: Pick<Client, "session" | "host">, tabId: number): boolean =>
    client.session ? grantedTo(client.session).has(tabId)
      : !client.host || visibleSessions(client, sessionsOf(tabId)).length > 0;
  // The site allowlist each session's project sets (policy.ts), loaded from
  // the working directory its CLI names on every /grant, so an edit to the
  // list binds from the next command. A tab answers to the policy of every
  // session it is granted to; a tab no session with a known policy holds
  // answers to the machine's own list (~/.codecast/config.json).
  const sessionPolicies = new Map<string, SitePolicy | null>();
  const policiesOf = (sessions: string[]): SitePolicy[] => {
    const known = sessions.filter((s) => sessionPolicies.has(s)).map((s) => sessionPolicies.get(s) ?? null);
    return (known.length ? known : [loadMachinePolicy()]).filter((p): p is SitePolicy => !!p);
  };
  /** Why `url` is off a policy that binds these sessions' tabs, or null. */
  const offPolicy = (sessions: string[], url: string): string | null => {
    for (const p of policiesOf(sessions)) {
      const v = checkUrl(p, url);
      if (!v.allowed) return v.reason ?? `${url} is not in the site allowlist`;
    }
    return null;
  };
  // Cross-origin iframes as child sessions (frameSessions.ts). A frame is
  // offered only when its own URL is a web page the tab's site policy allows.
  const frames = new FrameSessions<Client>({
    rootSessions: (tabId) => {
      const out: Array<[Client, string]> = [];
      for (const c of clients) for (const [sid, t] of c.sessions) if (t === tabId) out.push([c, sid]);
      return out;
    },
    mint: () => crypto.randomBytes(16).toString("hex").toUpperCase(),
    // A frame not committed yet ("" or about:blank) is admitted; its commands are checked against where it lands.
    admit: (tabId, url) => url === "" || url === "about:blank" || (webHost(url) !== null && !offPolicy(sessionsOf(tabId), url)),
  });
  /** Target.attachedToTarget, Target.detachedFromTarget and a child's own navigation, from Chrome's side. */
  const onFrameEvent = (tabId: number, session: string | undefined, method: string, params: any): void => {
    if (method === "Target.attachedToTarget") sendFrames(frames.attached(tabId, session ?? null, params));
    else if (method === "Target.detachedFromTarget") sendFrames(frames.detached(tabId, String(params?.sessionId ?? "")));
    else if (session && method === "Page.frameNavigated" && params?.frame && !params.frame.parentId) sendFrames(frames.navigated(tabId, session, String(params.frame.url ?? "")));
  };
  /** Each tab's URL as its last tab event, attach or listing gave it: what clientHosts reads instead of listing every profile per call. */
  const tabUrls = new Map<number, string>();
  /** The hostnames of the web pages this client's attached tabs show: the reach of its cookie and storage calls. */
  const clientHosts = async (client: Client): Promise<string[]> => {
    const mine = [...new Set(client.sessions.values())];
    if (mine.some((id) => !tabUrls.has(id))) for (const t of await listTabs()) tabUrls.set(t.tabId, t.url);
    const hosts = mine.map((id) => webHost(tabUrls.get(id) ?? ""));
    return [...new Set(hosts.filter((h): h is string => !!h))];
  };
  // The URL each agent tab was last checked at, so a tab's stream of updates
  // (title, favicon, load state) costs one policy check per landing.
  const checkedLanding = new Map<number, string>();
  /**
   * A main-frame landing off the allowlist (a redirect, a link, a script)
   * sends the tab back to about:blank. The navigate was refused up front
   * when a client asked for it; this catches every way a page moves itself.
   */
  const enforceLanding = (t: BridgeTab): void => {
    if (!t.url || checkedLanding.get(t.tabId) === t.url) return;
    checkedLanding.set(t.tabId, t.url);
    if (isInternalUrl(t.url)) return;
    const why = offPolicy(sessionsOf(t.tabId), t.url);
    if (!why) return;
    console.log(`[bridge] tab ${t.tabId} landed off the site allowlist (${why}); sending it to about:blank`);
    extCall("cdp", { tabId: t.tabId, method: "Page.navigate", params: { url: "about:blank" } }, 10_000)
      .catch((err) => console.log(`[bridge] could not blank tab ${t.tabId}: ${(err as Error).message}`))
      .finally(() => release(t.tabId));
  };
  const remember = (session: string, t: { tabId: number; url: string }): void => {
    const tabs = grantedTo(session);
    if (tabs.get(t.tabId) === t.url) return;
    tabs.set(t.tabId, t.url);
    castTabs.add(t.tabId);
    const profile = tabIds.chrome(t.tabId)?.link;
    if (profile && !sessionProfiles.has(session)) sessionProfiles.set(session, profile);
    persist();
  };
  /**
   * Grants a reconnect's first listing found no tab for, kept for a while:
   * when Chrome restarts, its session restore brings the same pages back
   * under new tab ids, and the extension re-adopts them by their Cast group
   * (background.js adoptCastGroups). Without this each came back an agent
   * tab no session held, left for the 30 minute idle cleanup while its
   * session was told it had no tab (soak ct-87421).
   */
  const vanished: Array<{ session: string; url: string; link: string; at: number }> = [];
  const VANISHED_MS = 5 * 60_000;
  /**
   * Hand `t` back to the session whose grant vanished at its exact URL. Only
   * a tab the extension itself owns and no session holds qualifies, so a tab
   * the human opened is never taken, whatever its URL.
   */
  const readopt = (t: BridgeTab): void => {
    const now = Date.now();
    for (let i = vanished.length - 1; i >= 0; i--) if (now - vanished[i].at > VANISHED_MS) vanished.splice(i, 1);
    if (!vanished.length || !t.url || !(t.owned ?? !!t.group) || sessionsOf(t.tabId).length) return;
    const link = tabIds.chrome(t.tabId)?.link;
    const i = vanished.findIndex((v) => v.url === t.url && v.link === link && !takenBack.get(v.session)?.has(t.tabId));
    if (i < 0) return;
    const [v] = vanished.splice(i, 1);
    remember(v.session, t);
    console.log(`[bridge] tab ${t.tabId} at ${t.url} came back after a Chrome restart; granted to ${v.session} again`);
    announce(t);
  };
  /** A restored partition against the tabs one profile's Chrome actually has: once per connection, on its first tab list. */
  const pruneRestored = (link: ExtLink, tabs: BridgeTab[]): void => {
    if (prunedLinks.has(link.id)) return;
    prunedLinks.add(link.id);
    const byId = new Map(tabs.map((t) => [t.tabId, t]));
    let changed = false;
    for (const [session, granted] of sessionTabs) {
      for (const [tabId, url] of granted) {
        const mine = tabIds.chrome(tabId)?.link === link.id || unclaimed.has(tabId);
        if (!mine) continue;
        unclaimed.delete(tabId);
        const t = byId.get(tabId);
        const keep = t && (t.url === url || (t.owned ?? !!t.group));
        if (keep) castTabs.add(tabId);
        else {
          granted.delete(tabId);
          changed = true;
          if (!t && url) vanished.push({ session, url, link: link.id, at: Date.now() });
        }
      }
    }
    if (changed) persist();
    for (const t of tabs) readopt(t);
  };
  // Target.targetCreated reaches each discovering client that may see the
  // tab, once: the extension's created event, the createTarget reply and a
  // later grant all funnel through here.
  const announce = (t: BridgeTab): void => {
    for (const c of clients) {
      if (!c.discover || !canSee(c, t.tabId) || c.announced.has(t.tabId)) continue;
      c.announced.add(t.tabId);
      sendJson(c.ws, { method: "Target.targetCreated", params: { targetInfo: targetInfo(t) } });
    }
  };
  const grant = async (session: string, tabId: number): Promise<void> => {
    if (grantedTo(session).has(tabId)) return;
    const t = (await listTabs()).find((x) => x.tabId === tabId);
    remember(session, { tabId, url: t?.url ?? "" });
    if (t) announce(t);
  };
  const forget = (tabId: number): void => {
    castTabs.delete(tabId);
    checkedLanding.delete(tabId);
    humanInput.forget(tabId);
    let changed = false;
    for (const tabs of sessionTabs.values()) if (tabs.delete(tabId)) changed = true;
    for (const c of clients) c.announced.delete(tabId);
    if (changed) persist();
  };
  /** A tab as one profile's extension described it, in the host's ids. */
  const hostTab = (link: ExtLink, t: BridgeTab): BridgeTab => ({
    ...t,
    tabId: tabIds.host(link.id, t.tabId),
    ...(typeof t.opener === "number" ? { opener: tabIds.host(link.id, t.opener) } : {}),
    profile: link.id,
  });
  // Profiles whose last listing failed, so a lookup can tell "no such tab"
  // from "its profile did not answer" (a frozen worker) and never drops a
  // session's tab for the second.
  const unlisted = new Map<string, Error>();
  let pendingTabList: Promise<BridgeTab[]> | null = null;
  const listTabs = (): Promise<BridgeTab[]> => {
    if (pendingTabList) return pendingTabList;
    // The worker's process is frozen for tens of seconds at a time on a
    // loaded Mac (background priority); the listing answers when it wakes.
    pendingTabList = (async () => {
      const all = links.list();
      if (!all.length) throw notConnected();
      const replies = await Promise.allSettled(all.map((link) => extCall("tabs.list", {}, 40_000, false, link)));
      const tabs: BridgeTab[] = [];
      replies.forEach((r, i) => {
        const link = all[i];
        if (r.status === "rejected") {
          unlisted.set(link.id, r.reason as Error);
          return;
        }
        unlisted.delete(link.id);
        const mine = (r.value.tabs as BridgeTab[]).map((t) => hostTab(link, t));
        pruneRestored(link, mine);
        tabs.push(...mine);
      });
      if (!tabs.length && unlisted.size === all.length) throw [...unlisted.values()][0];
      return [...tabs.filter(isCast), ...tabs.filter((t) => !isCast(t))];
    })().finally(() => { pendingTabList = null; });
    return pendingTabList;
  };
  /** A tab missing from the listing because its profile did not answer: that error, not "no such tab". */
  const unlistedError = (tabId: number): Error | undefined => {
    const at = tabIds.chrome(tabId);
    return at ? unlisted.get(at.link) : undefined;
  };
  // What the CDP face discovers: cast tabs only. An engine that connects over
  // CDP attaches to every page it is told about before it does anything else
  // (measured: agent-browser attached to 11 of 53 tabs in list order and died
  // on the twelfth), so telling it about the human's tabs put a debugger on
  // each of them for the length of every command, and one frozen or discarded
  // tab of the human's stalled every client for the whole attach budget. A
  // session acts only on tabs it opened; hiding the rest is that rule enforced
  // at the face where it was being broken. An extension older than the
  // `owned` flag reports a group only for groups it created, the same tabs.
  const discoverableTabs = async (client: Client): Promise<BridgeTab[]> =>
    (await listTabs()).filter((t) => isCast(t) && canSee(client, t.tabId));

  // Ids by which a tab is known to CDP clients. Sessions attach by tabId; a
  // tab is released to the human (debugger detached, banner gone) only when
  // the last session anywhere lets go of it.
  const holders = (tabId: number): number => {
    let n = 0;
    for (const c of clients) for (const t of c.sessions.values()) if (t === tabId) n++;
    return n;
  };
  const release = (tabId: number): void => {
    if (holders(tabId) === 0) extRequest("detach", { tabId }, 10_000).catch(() => {});
  };

  const targetInfo = (t: BridgeTab) => ({
    targetId: targetIdOfTab(t.tabId),
    type: "page",
    title: t.title,
    url: t.url,
    attached: t.attached,
    canAccessOpener: false,
    browserContextId: "cast-real-chrome",
  });

  /**
   * Close the sockets of clients whose sessions the host dropped while their
   * tabs live on. An engine daemon (agent-browser) keeps the session id it
   * attached with for the life of its socket, and a detachedFromTarget does
   * not make it attach again, so a live socket would carry the dead id into
   * every later command ("Session with given id not found") until the daemon
   * died. A closed socket it recovers from: it reconnects and attaches afresh,
   * the same path a host restart takes. The close waits one turn so a call
   * that was in flight still receives its error first.
   */
  const disconnect = (stale: Iterable<Client>, reason: string): void => {
    const sockets = [...stale].map((c) => c.ws);
    setImmediate(() => {
      for (const ws of sockets) ws.close(CLOSE_SESSIONS_DROPPED, reason.slice(0, 120));
    });
  };

  /** Drop every session bound to a tab (it closed, or the user cancelled). Returns the clients that held one. */
  const dropTab = (tabId: number, reason: string): Client[] => {
    sendFrames(frames.dropTab(tabId));
    const held: Client[] = [];
    for (const c of clients) {
      for (const [sessionId, t] of [...c.sessions]) {
        if (t !== tabId) continue;
        c.sessions.delete(sessionId);
        if (!held.includes(c)) held.push(c);
        sendJson(c.ws, { method: "Target.detachedFromTarget", params: { sessionId, targetId: targetIdOfTab(tabId), reason } });
      }
    }
    return held;
  };

  const onExtMessage = (link: ExtLink, raw: Buffer): void => {
    link.heardAt = Date.now();
    link.framesHeard++;
    // The two messages that carry nearly every byte go through as bytes (frames.ts).
    const event = readEventFrame(raw);
    if (event) {
      // From here on every tab id is the host's (links.ts).
      event.tabId = tabIds.host(link.id, event.tabId);
      traffic.note(event.method, raw.length);
      if (UNRELAYED_EVENTS.has(event.method)) return;
      if (FRAME_EVENTS.has(event.method) && (event.session || event.method !== "Page.frameNavigated")) {
        let params: any;
        try {
          params = JSON.parse(event.params.toString("utf-8"));
        } catch {
          return;
        }
        onFrameEvent(event.tabId, event.session, event.method, params);
        // Chrome's ids for children never reach a client; frames.ts announced its own.
        if (event.method !== "Page.frameNavigated") return;
      }
      const targets: Array<[Client, string]> = event.session
        ? frames.eventTargets(event.tabId, event.session)
        : [...clients].flatMap((c) => [...c.sessions].filter(([, t]) => t === event.tabId).map(([sid]): [Client, string] => [c, sid]));
      for (const [c, sessionId] of targets) {
        if (c.ws.readyState !== WebSocket.OPEN) continue;
        const out = eventMessage(event.method, event.params, sessionId);
        traffic.sent(c.session, out.length);
        c.ws.send(out, { binary: false });
      }
      return;
    }
    const pendingId = replyId(raw);
    const pending = pendingId === null ? undefined : extPending.get(pendingId);
    if (pending) traffic.note(`${pending.label} reply`, raw.length);
    const reply = pending?.raw ? readReplyFrame(raw) : null;
    if (reply) {
      extPending.delete(reply.id);
      pending!.resolve({ id: reply.id, ok: true, raw: new RawJson(reply.result) });
      return;
    }
    let msg: any;
    try {
      msg = JSON.parse(String(raw));
    } catch {
      return;
    }
    if (typeof msg.id === "number" && extPending.has(msg.id)) {
      const p = extPending.get(msg.id)!;
      extPending.delete(msg.id);
      p.resolve(msg as BridgeReply);
      return;
    }
    if (typeof msg.tabId === "number") msg.tabId = tabIds.host(link.id, msg.tabId);
    if (msg.op === "tab" && msg.tab && typeof msg.tab.tabId === "number") msg.tab = hostTab(link, msg.tab as BridgeTab);
    switch (msg.op) {
      case "pong":
        return;
      case "ping":
        // The worker's own keepalive (background.js startKeepalive): traffic
        // it originates is what Chrome counts, and the answer is traffic too.
        sendJson(link.ws, { op: "pong" });
        return;
      case "event": {
        // An event in a shape frames.ts does not read. Fan out to every
        // session bound to that tab, stamped with ITS id.
        const session = typeof msg.session === "string" ? msg.session : undefined;
        if (FRAME_EVENTS.has(msg.method)) {
          onFrameEvent(msg.tabId, session, msg.method, msg.params);
          if (msg.method !== "Page.frameNavigated") return;
        }
        if (session) {
          for (const [c, sessionId] of frames.eventTargets(msg.tabId, session)) sendJson(c.ws, { method: msg.method, params: msg.params ?? {}, sessionId });
          return;
        }
        for (const c of clients) {
          for (const [sessionId, tabId] of c.sessions) {
            if (tabId === msg.tabId) sendJson(c.ws, { method: msg.method, params: msg.params ?? {}, sessionId });
          }
        }
        return;
      }
      case "tab": {
        const t = msg.tab as BridgeTab;
        if (msg.kind === "removed") {
          tabUrls.delete(t.tabId);
          dropTab(t.tabId, "target closed");
          forget(t.tabId);
          tabIds.drop(t.tabId);
          // Destroyed goes out unconditionally: a target a client never heard of is ignored.
          for (const c of clients) if (c.discover) sendJson(c.ws, { method: "Target.targetDestroyed", params: { targetId: targetIdOfTab(t.tabId) } });
          return;
        }
        tabUrls.set(t.tabId, t.url);
        if (!isCast(t)) return; // the human's tabs are not on the CDP face
        readopt(t);
        enforceLanding(t);
        // A tab an agent's page opened (popup, target=_blank) goes to every
        // session that holds its opener (background.js adoptOpened).
        if (typeof t.opener === "number") for (const session of sessionsOf(t.opener)) if (!grantedTo(session).has(t.tabId)) remember(session, t);
        if (msg.kind === "created") announce(t);
        else {
          for (const session of sessionsOf(t.tabId)) remember(session, t);
          for (const c of clients) if (c.discover && canSee(c, t.tabId)) sendJson(c.ws, { method: "Target.targetInfoChanged", params: { targetInfo: targetInfo(t) } });
        }
        return;
      }
      case "detached": {
        // Chrome took the debugger off a tab that is still open (the banner's
        // Cancel, DevTools, a crash). Its clients reconnect and attach again
        // on their next command; the tab itself is gone only on "removed".
        // A tab the human took back from the toolbar leaves every grant too.
        const reason = msg.reason === "reclaimed" ? "the human took this tab back from agents" : "Chrome detached the debugger from this tab";
        disconnect(dropTab(msg.tabId, reason), reason);
        if (msg.reason === "reclaimed") {
          for (const session of sessionsOf(msg.tabId)) {
            if (!takenBack.has(session)) takenBack.set(session, new Set());
            takenBack.get(session)!.add(msg.tabId);
          }
          forget(msg.tabId);
          persist();
        }
        return;
      }
    }
  };

  // --------------------------------------------------------------- clients

  const grantedTarget = async (client: Client, targetId: unknown): Promise<BridgeTab> => {
    const tabId = tabIdOfTarget(String(targetId ?? ""));
    const tab = (await listTabs()).find(t => t.tabId === tabId);
    if (!tab) throw (tabId !== null && unlistedError(tabId)) || new Error("No target with given id found");
    if (!canSee(client, tab.tabId) || (client.host && !isCast(tab))) throw new Error(`tab ${targetIdOfTab(tab.tabId)} is not granted to this session`);
    return tab;
  };

  /** Whether this socket may raise a tab or Chrome's window. An agent's
   *  engine sends `Page.bringToFront` and `Target.activateTarget` as part of
   *  ordinary work (a tab switch, a keypress), and so does an agent's own raw
   *  CDP script; in the human's Chrome each one pulls their window forward.
   *  Only a socket that asked with `?raise=1` raises: the focus route behind
   *  the web's "open tab" link and `cast browser show`, and `tab --show`. */
  const mayRaise = (client: Client): boolean => client.raise;

  /** Does this session hold a tab in that profile? Then it stays there. */
  const holdsTabsIn = (session: string, profile: string): boolean =>
    [...grantedTo(session).keys()].some((tabId) => tabIds.chrome(tabId)?.link === profile);
  const bindSession = (session: string | null, profile: string): void => {
    if (!session || sessionProfiles.get(session) === profile) return;
    sessionProfiles.set(session, profile);
    persist();
  };
  const connectedIds = (): string => links.list().map((l) => l.id).join(", ") || "none";
  /** The profile this client's session works in, if it is connected. */
  const clientLink = (client: Client): ExtLink | undefined => {
    const id = client.profile ?? (client.session ? sessionProfiles.get(client.session) : undefined);
    return id ? links.get(id) : undefined;
  };
  /**
   * Where a new tab opens: the profile the client asked for (`?profile=`),
   * else the one its session already works in, else the default. Asking for
   * another profile while the session holds tabs in its own is refused: a
   * session's tabs never span two profiles.
   */
  const linkForCreate = (client: Client): ExtLink => {
    const bound = client.session ? sessionProfiles.get(client.session) : undefined;
    if (client.profile) {
      const link = links.get(client.profile);
      if (!link) throw new Error(`no connected Chrome profile "${client.profile}" (connected: ${connectedIds()}; \`cast browser extension status\` lists them)`);
      if (client.session && bound && bound !== link.id && holdsTabsIn(client.session, bound)) {
        throw new Error(`this session works in Chrome profile "${bound}" and stays there; start a new session to use "${link.id}"`);
      }
      bindSession(client.session, link.id);
      return link;
    }
    if (bound) {
      const link = links.get(bound);
      if (link) return link;
      if (client.session && holdsTabsIn(client.session, bound)) throw new Error(`this session works in Chrome profile "${bound}", which is not connected right now`);
    }
    const link = defaultLink();
    if (!link) throw notConnected();
    bindSession(client.session, link.id);
    return link;
  };

  /** Browser-scope CDP, emulated. Returns the `result` or throws. */
  const browserMethod = async (client: Client, method: string, params: any): Promise<unknown> => {
    switch (method) {
      case "Browser.getVersion":
        return {
          protocolVersion: "1.3",
          product: `Chrome (cast bridge, extension ${defaultLink()?.meta.version ?? "?"})`,
          revision: "",
          userAgent: (clientLink(client) ?? defaultLink())?.meta.userAgent ?? "",
          jsVersion: "",
        };
      case "Target.getTargets":
        return { targetInfos: (await discoverableTabs(client)).map(targetInfo) };
      case "Target.setDiscoverTargets": {
        const on = !!params?.discover;
        if (on && !client.discover) {
          // Chrome replays the existing targets on enable; clients rely on it.
          for (const t of await discoverableTabs(client)) {
            client.announced.add(t.tabId);
            sendJson(client.ws, { method: "Target.targetCreated", params: { targetInfo: targetInfo(t) } });
          }
        }
        client.discover = on;
        return {};
      }
      case "Target.getTargetInfo": {
        const t = await grantedTarget(client, params?.targetId);
        return { targetInfo: targetInfo(t) };
      }
      case "Target.attachToTarget": {
        const t = await grantedTarget(client, params?.targetId);
        const tabId = t.tabId;
        await extCall("attach", { tabId, owned: isCast(t) }, 40_000);
        const sessionId = crypto.randomBytes(16).toString("hex").toUpperCase();
        client.sessions.set(sessionId, tabId);
        tabUrls.set(tabId, t.url);
        // Attaching to a grouped tab adopts its group. The extension reports
        // a group only for groups it created itself (background.js
        // ownedGroups), so a human's tab, grouped by the human or not, never
        // hands the session a group of the human's.
        if (t.group) client.group = t.group;
        sendJson(client.ws, {
          method: "Target.attachedToTarget",
          params: {
            sessionId,
            targetInfo: targetInfo(t),
            waitingForDebugger: false,
          },
        });
        return { sessionId };
      }
      case "Target.detachFromTarget": {
        const sessionId = String(params?.sessionId ?? "");
        const frame = frames.route(client, sessionId);
        if (frame) {
          // The client lets go of a child; Chrome's own session stays for other clients.
          frames.dropSession(client, sessionId);
          sendJson(client.ws, { method: "Target.detachedFromTarget", params: { sessionId }, sessionId: frame.parent });
          return {};
        }
        const tabId = client.sessions.get(sessionId);
        if (tabId === undefined) throw new Error("No session with given id");
        frames.dropSession(client, sessionId);
        client.sessions.delete(sessionId);
        sendJson(client.ws, { method: "Target.detachedFromTarget", params: { sessionId, targetId: targetIdOfTab(tabId) } });
        release(tabId);
        return {};
      }
      case "Target.createTarget": {
        // A cloud host's tab belongs to one of its sessions; one made on a
        // session-less socket would belong to nobody it could see.
        if (client.host && !client.session) throw new Error("a cloud host opens tabs only for a session: connect with ?session=");
        const off = params?.url ? offPolicy(client.session ? [client.session] : [], String(params.url)) : null;
        if (off) throw new Error(`the cast bridge refuses to open ${params.url}: ${off}`);
        const group = parseGroup(params?.castGroup) ?? client.group;
        const link = linkForCreate(client);
        // A tab is created in the background unless the client says
        // otherwise: an engine that omits the flag (stock agent-browser does)
        // would otherwise raise the human's Chrome on every fresh session.
        const r = await extCall(
          "tabs.create",
          { url: params?.url || "about:blank", background: !mayRaise(client) || params?.background !== false, ...(group ? { group } : {}) },
          40_000, // the worker's process may be frozen for a while; it answers when it wakes
          false,
          link,
        );
        if (group) client.group = group;
        const tabId = tabIds.host(link.id, r.tabId as number);
        castTabs.add(tabId);
        if (client.session) remember(client.session, { tabId, url: String(params?.url ?? "about:blank") });
        const created = (await listTabs()).find((t) => t.tabId === tabId);
        if (created) announce(created);
        return { targetId: targetIdOfTab(tabId) };
      }
      case "Target.closeTarget": {
        const { tabId } = await grantedTarget(client, params?.targetId);
        dropTab(tabId, "target closed");
        await extCall("tabs.close", { tabId }, 10_000);
        return { success: true };
      }
      case "Target.activateTarget": {
        const { tabId } = await grantedTarget(client, params?.targetId);
        if (mayRaise(client)) await extCall("tabs.activate", { tabId }, 10_000);
        return {};
      }
      case "Target.getBrowserContexts":
        return { browserContextIds: [] };
      // Harmless to accept: clients call these during setup and only need a yes.
      case "Target.setAutoAttach":
      case "Browser.setDownloadBehavior":
      case "Security.setIgnoreCertificateErrors":
        return {};
      default:
        throw Object.assign(new Error(`'${method}' wasn't found`), { code: -32601 });
    }
  };

  /**
   * Session-scope CDP: a couple of local answers, everything else to the tab,
   * or with `frame` to that cross-origin iframe's child session. Auto-attach is
   * the host's to answer: the extension keeps it on for every driven tab
   * (children never wait for a debugger), and each client sees the children
   * under the sessions it asked on (frameSessions.ts).
   */
  const sessionMethod = async (client: Client, sessionId: string, tabId: number, method: string, params: any, frame?: FrameRoute): Promise<unknown> => {
    if (method === "Page.bringToFront" && !mayRaise(client)) return {};
    switch (method) {
      case "Target.setAutoAttach":
        sendFrames(frames.setAutoAttach(client, sessionId, tabId, frame?.chrome ?? null, !!params?.autoAttach));
        return {};
      case "Runtime.runIfWaitingForDebugger":
        return {};
      // chrome.debugger refuses both Browser. and Page.setDownloadBehavior on a tab, so a download
      // saves wherever the human's Chrome saves it and no client can name the file. Say that plainly,
      // before any click, rather than pass on Chrome's "wasn't found".
      case "Browser.setDownloadBehavior":
      case "Page.setDownloadBehavior":
        throw Object.assign(new Error(`the cast bridge cannot set ${method}: downloads in the human's Chrome go to their own Downloads folder, where cast cannot choose or find the file`), { code: -32000 });
      default: {
        if (frame) {
          // A frame answers to the site policy for its own URL, like a tab.
          const url = frames.url(frame);
          const off = webHost(url) ? offPolicy(sessionsOf(tabId), url) : null;
          if (off) throw new Error(`the cast bridge refuses ${method} in a frame at ${url}: ${off}`);
        }
        if (method === "Page.navigate") {
          const off = offPolicy(sessionsOf(tabId), String(params?.url ?? ""));
          if (off) throw new Error(`the cast bridge refuses to navigate to ${params?.url}: ${off}`);
        }
        let hosts: string[] | undefined;
        const scope = async () => (hosts ??= await clientHosts(client));
        if (needsScope(method, params)) {
          const refused = scopeRefusal(method, params, await scope());
          if (refused) throw new Error(refused);
        }
        // Mouse and key input reaches the human's Chrome with a human's path
        // and timing (humanInput.ts); it adjusts params.x/y in place, so it
        // runs before params are forwarded. Its own calls decode the reply.
        // A frame's coordinates are its own, not the tab's: its input goes as sent.
        if (!frame) await humanInput.beforeInput(tabId, method, params, (m, p) => extCall("cdp", { tabId, method: m, params: p }).then((x) => x.result));
        const r = await extCall("cdp", { tabId, ...(frame ? { sessionId: frame.chrome } : {}), method, params: params ?? {} }, undefined, true);
        if (COOKIE_READS.has(method)) {
          const result = r.raw instanceof RawJson ? JSON.parse(r.raw.bytes.toString("utf-8")) : (r.result ?? {});
          return filterCookieReply(result, await scope());
        }
        return r.raw instanceof RawJson ? r.raw : (r.result ?? {});
      }
    }
  };

  const onClientMessage = async (client: Client, raw: string): Promise<void> => {
    let msg: any;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    if (typeof msg.id !== "number" || typeof msg.method !== "string") return;
    try {
      if (isWebAuthnMethod(msg.method)) throw new Error(WEBAUTHN_REFUSAL);
      const refused = methodRefusal(msg.method, msg.params);
      if (refused) throw new Error(refused);
      let result: unknown;
      if (msg.sessionId) {
        const frame = frames.route(client, msg.sessionId);
        const tabId = frame?.tabId ?? client.sessions.get(msg.sessionId);
        if (tabId === undefined) {
          sendJson(client.ws, cdpError(msg.id, "Session with given id not found."));
          return;
        }
        result = await sessionMethod(client, msg.sessionId, tabId, msg.method, msg.params, frame);
        if (result instanceof RawJson) {
          const out = replyMessage(msg.id, result.bytes, msg.sessionId);
          traffic.sent(client.session, out.length);
          if (client.ws.readyState === WebSocket.OPEN) client.ws.send(out, { binary: false });
        } else sendJson(client.ws, { id: msg.id, sessionId: msg.sessionId, result });
      } else {
        result = await browserMethod(client, msg.method, msg.params);
        sendJson(client.ws, { id: msg.id, result });
      }
    } catch (err) {
      const e = err as Error & { code?: number };
      sendJson(client.ws, { ...cdpError(msg.id, e.message, e.code ?? -32000), ...(msg.sessionId ? { sessionId: msg.sessionId } : {}) });
    }
  };

  // ------------------------------------------------------------------ HTTP

  const isLoopbackHost = (hostHeader: string | undefined): boolean => {
    if (!hostHeader) return false;
    const m = /^(\[[^\]]+\]|[^:]+)(?::(\d+))?$/.exec(hostHeader);
    if (!m) return false;
    return LOOPBACK_HOSTS.has(m[1]) && (!m[2] || parseInt(m[2], 10) === port);
  };

  /** Set once a retire is granted: the host is about to exit, so new work is turned away with a retry. */
  let retiring = false;
  const UNCOUNTED_ROUTES = new Set(["/healthz", "/status", "/retire"]);
  const handleHttp = (req: Request): Promise<Response> => {
    const route = new URL(req.url).pathname;
    if (UNCOUNTED_ROUTES.has(route)) return serveHttp(req);
    if (retiring) return Promise.resolve(Response.json({ error: "the bridge host is restarting for a newer cast; retry in a moment" }, { status: 503, headers: { [RETIRING_HEADER]: "1" } }));
    return busy(serveHttp(req));
  };
  const serveHttp = async (req: Request): Promise<Response> => {
    const url = new URL(req.url);
    // /healthz is the only unauthenticated route. It says our name, and to a
    // caller that sends a nonce it proves we hold the token (probeHost); the
    // proof grants nothing, it only lets the CLI tell us from a squatter.
    if (url.pathname === "/healthz") {
      const nonce = url.searchParams.get("nonce");
      // A cloud host proves us with its own token's hash as the key (hostClients.ts).
      const client = url.searchParams.get("client");
      const key = client ? opts.hostClients?.()?.[client]?.hash : token;
      return new Response(`cast-bridge protocol=${BRIDGE_PROTOCOL}${opts.build ? ` build=${opts.build}` : ""}${isNonce(nonce) && key ? ` proof=${bridgeProof(key, "healthz", nonce)}` : ""}`);
    }
    // Reject DNS rebinding: a page at evil.example resolving to 127.0.0.1
    // arrives with Host: evil.example and would otherwise read these bodies.
    const caller = clientOf(url.searchParams.get("token"));
    if (!isLoopbackHost(req.headers.get("host") ?? undefined) || !caller) {
      return new Response("forbidden\n", { status: 403 });
    }
    // A cloud host's token reaches what a CDP client needs and nothing that
    // manages the extension.
    if (caller.host && !HOST_CLIENT_ROUTES.has(url.pathname)) return new Response("forbidden\n", { status: 403 });
    const callerToken = url.searchParams.get("token")!;
    const json = (status: number, body: unknown) => Response.json(body, { status });
    try {
      switch (url.pathname) {
        case "/json/version":
        case "/json/version/":
          return json(200, {
            Browser: `Chrome (cast bridge, extension ${defaultLink()?.meta.version ?? "?"})`,
            "Protocol-Version": "1.3",
            "User-Agent": defaultLink()?.meta.userAgent ?? "",
            webSocketDebuggerUrl: withSession(`ws://127.0.0.1:${port}/devtools/browser/${callerToken}`, {
              port, session: url.searchParams.get("session") || undefined, profile: url.searchParams.get("profile") || undefined,
            }),
          });
        case "/json":
        case "/json/list":
        case "/json/list/": {
          // A cloud host sees only agent tabs granted to its own sessions: the
          // one it names, or with none named, any of its namespace's.
          const session = scopedSession(caller, url.searchParams.get("session"));
          return json(
            200,
            (await listTabs()).filter((t) => (!caller.host || isCast(t)) && canSee({ session, host: caller.host }, t.tabId)).map((t) => ({
              id: targetIdOfTab(t.tabId),
              type: "page",
              title: t.title,
              url: t.url,
              // cast's own fields: an agent's tab, and the sessions it is
              // granted to. `cast browser tabs --all` reads them.
              cast: isCast(t),
              sessions: visibleSessions(caller, sessionsOf(t.tabId)),
              ...(t.profile ? { profile: t.profile } : {}),
              description: "",
              attached: t.attached,
              // The extension's word on the tab: lent by the human, a handoff
              // and where it stands, why no reaper may close it.
              ...(t.lent ? { lent: true } : {}),
              ...(t.handoff ? { handoff: t.handoff } : {}),
              ...(t.keep ? { keep: t.keep } : {}),
            })),
          );
        }
        case "/status": {
          const all = links.list().filter((l) => l.ws.readyState === WebSocket.OPEN);
          const dflt = defaultLink();
          return json(200, {
            extensionConnected: all.length > 0,
            extensionVersion: dflt?.meta.version,
            extensionProtocol: dflt?.meta.protocol,
            profiles: all.map((l) => ({
              id: l.id, name: l.name, ...(l.dir ? { dir: l.dir } : {}), default: l === dflt, legacy: l.key === LEGACY_LINK_KEY,
              version: l.meta.version, protocol: l.meta.protocol, connectedAt: l.connectedAt,
              sessions: visibleSessions(caller, [...sessionProfiles].filter(([, p]) => p === l.id).map(([s]) => s)).length,
            })),
            protocol: BRIDGE_PROTOCOL,
            build: opts.build,
            // How this machine's host is doing is the laptop's business.
            ...(caller.host ? {} : { transport: server.stats(), memory: process.memoryUsage() }),
          });
        }
        case "/retire": {
          // A newer CLI asks this host to make way (ensureBridgeHost). Only
          // when idle, answered at once either way, so no command ever waits
          // on a swap: the caller uses a busy host as it is.
          if (req.method !== "POST" || caller.host) return new Response("forbidden\n", { status: 403 });
          // A connected CDP client counts even when idle between commands: an
          // engine socket, a watch stream or a cloud host loses its tabs'
          // attachments when the host goes.
          const idle = inFlight === 0 && extPending.size === 0 && clients.size === 0 && Date.now() - lastActivityAt >= (opts.idleQuietMs ?? 1_500);
          if (!idle) return json(409, { error: `busy: ${clients.size} CDP client(s) connected, ${inFlight} request(s) in flight, ${extPending.size} extension call(s) pending`, busy: true });
          retiring = true;
          setImmediate(() => opts.onRetire?.());
          return json(200, { ok: true, build: opts.build });
        }
        case "/grant": {
          if (req.method !== "POST") {
            return new Response("POST\n", { status: 405 });
          }
          const session = scopedSession(caller, url.searchParams.get("session")) ?? "";
          const tabId = tabIdOfTarget(url.searchParams.get("target") ?? "");
          if (!session || tabId === null) {
            return json(400, { error: "grant needs session and target" });
          }
          const own = url.searchParams.get("own") === "1";
          if (own && takenBack.get(session)?.has(tabId)) {
            return json(409, { error: `the human took tab ${targetIdOfTab(tabId)} back from agents; do not touch it again unless they lend it to you`, takenBack: true });
          }
          const t = (await listTabs()).find((x) => x.tabId === tabId);
          if (!t) {
            // Its profile did not answer the listing: unknown, not gone, so the session keeps its binding.
            const unanswered = unlistedError(tabId);
            if (unanswered) return json(503, { error: unanswered.message });
            return json(404, { error: `no tab ${targetIdOfTab(tabId)} in the real Chrome` });
          }
          const bound = sessionProfiles.get(session);
          if (!own && t.profile && bound && bound !== t.profile && holdsTabsIn(session, bound)) {
            return json(409, { error: `tab ${targetIdOfTab(tabId)} is in Chrome profile "${t.profile}"; this session works in "${bound}" and stays there` });
          }
          // `--browser <id>` from a session that already works in another profile.
          const asked = caller.host ? null : url.searchParams.get("profile");
          if (own && asked && bound && asked !== bound && holdsTabsIn(session, bound)) {
            return json(409, { error: `this session works in Chrome profile "${bound}" and stays there; start a new session to use "${asked}"`, profileConflict: true });
          }
          if (own && !grantedTo(session).has(tabId)) {
            return json(403, { error: `saved tab ${targetIdOfTab(tabId)} ownership could not be verified for this session; no tab was adopted` });
          }
          if (!isCast(t)) {
            return json(403, { error: `tab ${targetIdOfTab(tabId)} is the human's, not an agent's — only agent tabs can be shared` });
          }
          // A cloud host shares a tab only between its own sessions.
          if (caller.host && !own && !visibleSessions(caller, sessionsOf(tabId)).length) {
            return json(403, { error: `tab ${targetIdOfTab(tabId)} belongs to none of this host's sessions` });
          }
          await grant(session, tabId);
          if (takenBack.get(session)?.delete(tabId)) persist();
          // A cloud host's cwd names a directory on that host, not here: its
          // sessions answer to this machine's own list.
          const cwd = caller.host ? null : url.searchParams.get("cwd");
          if (cwd && path.isAbsolute(cwd)) sessionPolicies.set(session, loadSitePolicy(cwd));
          return json(200, { ok: true, sessions: visibleSessions(caller, sessionsOf(tabId)) });
        }
        case "/reload":
          if (req.method !== "POST") {
            return new Response("POST\n", { status: 405 });
          }
          // Every connected profile: an unpacked load is the same files in each.
          await Promise.all(links.list().map((l) => extCall("reload", {}, 5_000, false, l)));
          return json(200, { ok: true });
        default:
          return new Response("not found\n", { status: 404 });
      }
    } catch (err) {
      return json(503, { error: (err as Error).message });
    }
  };

  // Unproven /ext sockets currently mid-handshake (see holdExtHandshake).
  let pendingExtHandshakes = 0;

  /** One unproven /ext socket, counted against the concurrent-handshake cap
   *  until its hello is accepted or the socket goes away. */
  const holdExtHandshake = (ws: BridgeSocket): { release(): void } => {
    pendingExtHandshakes++;
    let released = false;
    const release = (): void => {
      if (released) return;
      released = true;
      pendingExtHandshakes--;
    };
    ws.once("close", release);
    return { release };
  };

  /** Refused hellos by log line, so a profile retrying forever is one line, not one every 30 s. */
  const refusals = new Map<string, number>();
  /** Each profile's last worker boot, so a reconnect from the same worker is told apart from a new one. */
  const lastBoot = new Map<string, string>();

  /** Does this link say anything (a pong, or any traffic) within the probe window? */
  const incumbentAnswers = async (incumbent: ExtLink): Promise<boolean> => {
    const heard = incumbent.framesHeard;
    sendJson(incumbent.ws, { op: "ping" });
    const deadline = Date.now() + (opts.incumbentProbeMs ?? 2_000);
    while (Date.now() < deadline) {
      if (incumbent.framesHeard !== heard) return true;
      if (links.get(incumbent.id) !== incumbent || incumbent.ws.readyState !== WebSocket.OPEN) return false;
      await sleep(50);
    }
    return incumbent.framesHeard !== heard;
  };

  /** Fail every client session on one profile's tabs: its extension is gone. */
  const failClientsOf = (link: ExtLink, reason: string): void => {
    const held = new Set<Client>();
    for (const c of clients) {
      for (const tabId of new Set(c.sessions.values())) {
        const at = tabIds.chrome(tabId);
        if (at ? at.link === link.id : links.list().length === 0) for (const h of dropTab(tabId, reason)) held.add(h);
      }
    }
    disconnect(held, reason);
  };

  /** The next message on an unproven socket, bounded in size and time; null when it does not come. */
  const nextPreAuthMessage = (ws: BridgeSocket): Promise<any> =>
    new Promise((resolve) => {
      const timer = setTimeout(() => {
        ws.close(CLOSE_HANDSHAKE_TIMEOUT, "no answer");
        resolve(null);
      }, HELLO_TIMEOUT_MS);
      ws.once("message", (raw) => {
        clearTimeout(timer);
        if ((raw as Buffer).length > PRE_AUTH_MAX_BYTES) {
          ws.close(CLOSE_BAD_TOKEN, "message too large");
          return resolve(null);
        }
        try {
          resolve(JSON.parse(String(raw)));
        } catch {
          resolve(null);
        }
      });
    });

  /** Who a proven hello is, and what the welcome carries. */
  interface Admitted {
    key: string;
    id: string;
    name: string;
    dir?: string;
    hash?: string;
    welcome: Record<string, unknown>;
    paired?: string;
  }

  /** The id an unmigrated store build's link goes by: the pinned profile's, as setup paired it. */
  const legacyIdentity = (): { id: string; name: string; dir?: string } => {
    const dir = opts.pinnedProfile?.();
    const name = (dir && opts.profileName?.(dir)) || "Chrome";
    const taken = new Set(Object.values(opts.profiles?.() ?? {}).map((r) => r.id));
    let id = profileSlug(name === "Chrome" ? undefined : name, dir);
    if (taken.has(id)) id = `${id}-legacy`;
    return { id, name, ...(dir ? { dir } : {}) };
  };

  /**
   * Prove a hello. Four ways in (pairing.ts has the scheme): a profile's own
   * key; the shared token from a build that knows profiles, which is issued a
   * key on the spot (the migration); the shared token from a store build
   * that predates profiles; or a one-time code, exchanged here for a key.
   * Returns null when the socket was refused and closed.
   */
  const admit = async (ws: BridgeSocket, msg: any): Promise<Admitted | null> => {
    const refuse = (why: string): null => {
      ws.close(CLOSE_BAD_TOKEN, why.slice(0, 120));
      // A revoked profile asks again every 30 s; the log says so once, with a count when it changes.
      const line = `extension refused: ${why}${isProfileKey(msg?.key) ? ` (profile key ${String(msg.key).slice(0, 6)}…)` : ""}`;
      const seen = refusals.get(line) ?? 0;
      refusals.set(line, seen + 1);
      if (seen === 0 || (seen + 1) % 100 === 0) opts.onProfile?.(seen ? `${line} x${seen + 1}` : line);
      return null;
    };
    if (msg?.op !== "hello" || !isNonce(msg.nonce)) return refuse("bad hello");
    const nonce: string = msg.nonce;
    const mode = msg.mode;
    if (mode === "key") {
      const rec = isProfileKey(msg.key) ? opts.profiles?.()?.[msg.key] : undefined;
      if (!rec || !secretMatches(bridgeProof(rec.hash, "ext", nonce), msg.auth)) return refuse("bad token");
      return { key: msg.key, id: rec.id, name: rec.name, dir: rec.dir, hash: rec.hash, welcome: { proof: bridgeProof(rec.hash, "host", nonce), profile: rec.id } };
    }
    if (mode === "code") {
      if (!isProfileKey(msg.key)) return refuse("bad hello");
      if (!hasPendingCodes()) return refuse("no pairing code is pending; run `cast browser extension setup`");
      const hostNonce = randomNonce();
      const answer = nextPreAuthMessage(ws);
      sendJson(ws, { op: "challenge", nonce: hostNonce });
      const pair = await answer;
      if (!pair) return null;
      const match = pair.op === "pair" ? matchPendingCode(pair.proof, port, nonce, hostNonce) : null;
      if (!match) {
        const exhausted = recordPairingFailure();
        return refuse(exhausted ? "too many wrong pairing codes; run setup for a new one" : "pairing code wrong, used or expired");
      }
      consumePairingCode(match.code.key);
      const { secret, record } = issueProfileKey(msg.key, { name: match.code.name, dir: match.code.dir, via: "code" });
      return {
        key: msg.key, id: record.id, name: record.name, dir: record.dir, hash: record.hash,
        welcome: { proof: hmacHex(match.session, "host"), issue: xorHex(secret, hmacHex(match.session, "wrap")), profile: record.id },
        paired: `paired Chrome profile ${record.id} with a one-time code`,
      };
    }
    // The shared token: an extension paired before profiles existed.
    if (!secretMatches(bridgeProof(token, "ext", nonce), msg.auth)) return refuse("bad token");
    const welcome = { proof: bridgeProof(token, "host", nonce) };
    if (mode === "legacy" && isProfileKey(msg.key)) {
      // A revoked profile is out until the human pairs it again with a code,
      // whatever token its extension still holds.
      if (opts.revokedProfiles?.()?.[msg.key]) return refuse("this Chrome profile was revoked; run `cast browser extension setup` to pair it again");
      // A build that knows profiles: its own key from now on, handed over
      // masked, and it forgets the shared token. The pinned profile goes to
      // the first profile to migrate; another one is named without it.
      const known = opts.profiles?.() ?? {};
      const pinned = opts.pinnedProfile?.();
      const dirTaken = Object.entries(known).some(([k, r]) => k !== msg.key && r.dir === pinned);
      const dir = known[msg.key]?.dir ?? (pinned && !dirTaken ? pinned : undefined);
      const { secret, record } = issueProfileKey(msg.key, { name: dir ? opts.profileName?.(dir) : undefined, dir, via: "migrated" });
      return {
        key: msg.key, id: record.id, name: record.name, dir: record.dir, hash: record.hash,
        welcome: { ...welcome, issue: xorHex(secret, hmacHex(token, `issue:${nonce}`)), profile: record.id },
        paired: `migrated Chrome profile ${record.id} off the shared token`,
      };
    }
    return { key: LEGACY_LINK_KEY, ...legacyIdentity(), welcome };
  };

  /**
   * The extension face. The socket carries no secret: the first message is a
   * hello that proves one (admit), answered with a proof of our own so the
   * extension can tell us from a squatter too. Only a proven socket becomes a
   * profile's link; until then it can neither replace one nor drive anything.
   */
  const adoptExtension = (ws: BridgeSocket, preAuth: { release(): void }): void => {
    // A silent socket is a slow worker, not a wrong token: the code says
    // "try again", never "re-pair".
    const hello = setTimeout(() => {
      preAuth.release();
      ws.close(CLOSE_HANDSHAKE_TIMEOUT, "no hello");
    }, HELLO_TIMEOUT_MS);
    ws.on("error", () => {});
    ws.once("message", async (raw) => {
      clearTimeout(hello);
      // An unproven socket does not get the screenshot-sized budget.
      if ((raw as Buffer).length > PRE_AUTH_MAX_BYTES) {
        preAuth.release();
        ws.close(CLOSE_BAD_TOKEN, "hello too large");
        return;
      }
      let msg: any;
      try {
        msg = JSON.parse(String(raw));
      } catch {
        msg = null;
      }
      const who = await admit(ws, msg);
      // Proven (or refused): the handshake slot is free either way.
      preAuth.release();
      if (!who || ws.readyState !== WebSocket.OPEN) return;
      const boot = typeof msg.boot === "string" ? msg.boot : undefined;
      const prev = links.get(who.id) ?? links.ofKey(who.key);
      // A store build from before profiles carries no identity, so two of
      // them (the extension in two profiles) would hand the one legacy link
      // back and forth every few seconds. The current worker keeps it while
      // it answers a ping; the newcomer stands by. A profile with its own key
      // reconnecting is the same profile, and the newer socket wins.
      if (who.key === LEGACY_LINK_KEY && prev && prev.ws !== ws && prev.ws.readyState === WebSocket.OPEN && (boot === undefined || boot !== prev.meta.boot)) {
        if (await incumbentAnswers(prev)) {
          const detail = `worker ${boot ?? "?"} (${typeof msg.userAgent === "string" ? msg.userAgent : "?"}) stands by: worker ${prev.meta.boot ?? "?"} holds the bridge and answers`;
          ws.close(CLOSE_EXTENSION_STANDBY, "another Chrome profile's extension holds the bridge");
          opts.onStandby?.(detail);
          return;
        }
        if (ws.readyState !== WebSocket.OPEN) return;
      }
      const bootAt = typeof msg.bootAt === "number" ? msg.bootAt : undefined;
      const sameWorker = boot !== undefined && boot === lastBoot.get(who.id);
      if (boot) lastBoot.set(who.id, boot);
      const link: ExtLink = {
        id: who.id, key: who.key, name: who.name, ...(who.dir ? { dir: who.dir } : {}), ...(who.hash ? { hash: who.hash } : {}),
        ws, meta: { version: msg.version, protocol: msg.protocol, userAgent: msg.userAgent, boot, bootAt },
        heardAt: Date.now(), framesHeard: 0, connectedAt: prev?.connectedAt ?? Date.now(),
      };
      const replaced = links.set(link);
      if (replaced) replaced.ws.close(1000, "replaced by a newer extension connection");
      if (who.paired) opts.onProfile?.(who.paired);
      // Which worker, how old, and why it connected: a new boot id means
      // Chrome ended the previous worker; the same one means only the
      // socket dropped.
      const age = bootAt ? `${Math.round((Date.now() - bootAt) / 1000)}s old` : "age unknown";
      const recent = Array.isArray(msg.recent) ? msg.recent.filter((r: unknown) => typeof r === "string").slice(-12) : [];
      onExtension?.(
        true,
        `worker ${boot ?? "?"} (${sameWorker ? "same worker, " : ""}${age}) via ${typeof msg.trigger === "string" ? msg.trigger : "?"}, v${msg.version ?? "?"}` +
          `; profile ${link.id}${link.key === LEGACY_LINK_KEY ? " (shared token)" : ""}` +
          (recent.length ? `; worker notes: ${recent.join(" | ")}` : ""),
      );
      ws.on("message", (raw) => onExtMessage(link, raw as Buffer));
      ws.on("close", (code, reason) => {
        // The code is what carries meaning here: 1006 is a socket that died
        // without a close frame (Chrome ended the worker), 1001 a worker
        // going away, 1000 our own replacement, 4408 the worker's connect
        // deadline. The reason text is best effort (bun drops it).
        for (const [id, p] of extPending) {
          if (p.link !== link) continue;
          extPending.delete(id);
          p.reject(new Error("the extension disconnected mid-command — check the cast bridge extension in Chrome"));
        }
        if (links.remove(ws) !== link) return;
        const why = String(reason ?? "");
        onExtension?.(links.list().length > 0, `close ${code}${why ? ` ${why}` : ""}; profile ${link.id}`);
        failClientsOf(link, "the extension disconnected");
      });
      sendJson(ws, { op: "welcome", protocol: BRIDGE_PROTOCOL, ...who.welcome });
      prunedLinks.delete(link.id);
    });
  };

  const upgrade = (req: Request): Response | ((ws: BridgeSocket) => void) => {
    const url = new URL(req.url);
    const origin = req.headers.get("origin") ?? undefined;
    const pathToken = /^\/devtools\/browser\/([^/?]+)$/.exec(url.pathname)?.[1];
    const role: "ext" | "cdp" | null =
      url.pathname === "/ext" ? "ext" : pathToken || url.pathname === "/devtools/browser" ? "cdp" : null;
    const presented = url.searchParams.get("token") ?? pathToken;

    // CDP clients present the token in the URL (they are our own processes,
    // which verified the host first); the extension proves it in its hello.
    const caller = role === "cdp" ? clientOf(presented) : null;
    const authed = role === "ext" || !!caller;

    // Refused before the handshake completes, so the socket never reaches the
    // WebSocket parser at all. An unknown path, a document's Origin and a
    // non-loopback Host are all "you are not a bridge client"; there is no
    // close code worth spending on them, and completing the upgrade would put
    // a stranger in front of the frame reader.
    if (!role || !bridgeUpgradeOriginAllowed(origin) || !isLoopbackHost(req.headers.get("host") ?? undefined)) {
      return new Response("forbidden\n", { status: 403 });
    }

    // Too many unproven sockets at once is either a bug or a squatter; either
    // way the real extension opens one.
    if (role === "ext" && pendingExtHandshakes >= MAX_PENDING_EXT_HANDSHAKES) {
      return new Response("too many handshakes\n", { status: 503 });
    }

    // A wrong token on an otherwise well-formed client DOES get a close code:
    // that is our own tooling, and "bad token" is what tells it to re-pair.
    if (!authed) {
      return (ws) => ws.close(CLOSE_BAD_TOKEN, "bad token");
    }

    return (ws) => {
      if (role === "ext") {
        // /ext is the one face that authenticates AFTER the upgrade, so it is
        // the one that needs a budget for what it may say before it has.
        adoptExtension(ws, holdExtHandshake(ws));
        return;
      }

      const host = caller?.host ?? null;
      const session = scopedSession({ host }, url.searchParams.get("session"));
      const client: Client = {
        ws, sessions: new Map(), discover: false, group: null,
        session, announced: new Set(), host,
        // A cloud host's tabs open in the profile its session is bound to, or the default; it cannot pick one.
        profile: host ? null : url.searchParams.get("profile") || null,
        // A cloud host's session never pulls a tab over the human's work.
        raise: !caller?.host && url.searchParams.get("raise") === "1",
      };
      clients.add(client);
      if (client.host) {
        hostClientTokens.set(client, hashHostToken(presented!));
        opts.onHostClient?.(`cloud host ${client.host} connected a CDP client${client.session ? ` for session ${visibleSessions(client, [client.session])[0]}` : ""}`);
        ws.on("close", () => {
          hostClientTokens.delete(client);
          opts.onHostClient?.(`cloud host ${client.host} CDP client${client.session ? ` for session ${visibleSessions(client, [client.session])[0]}` : ""} left`);
        });
      }
      ws.on("message", (raw) => {
        void busy(onClientMessage(client, String(raw)));
      });
      ws.on("close", () => {
        clients.delete(client);
        frames.dropClient(client);
        // Whatever this client held is released — after it is gone from the
        // set, so its own sessions do not count as holders.
        for (const tabId of new Set(client.sessions.values())) release(tabId);
        client.sessions.clear();
      });
      ws.on("error", () => {});
    };
  };

  const server = await serveBridge({ port, maxPayload: MAX_MESSAGE_BYTES, fetch: handleHttp, upgrade, onOverflow: opts.onTraffic });

  // Application-level keepalive: protocol pings are invisible to the
  // extension's JavaScript, and it is JS-visible traffic that keeps an MV3
  // service worker alive. 20s sits well inside Chrome's 30s idle teardown.
  const silenceMs = opts.extensionSilenceMs ?? EXTENSION_SILENCE_MS;
  // A revoked or re-minted host token cuts that host's live sockets off,
  // not just its next connection.
  const revokeSweep = setInterval(() => {
    // The same for a Chrome profile: `extension revoke --profile` or a fresh
    // pairing of that profile replaces its record, and the socket it proved
    // with is closed as a bad token.
    const paired = opts.profiles?.();
    for (const link of links.list()) {
      if (!link.hash || paired?.[link.key]?.hash === link.hash) continue;
      opts.onProfile?.(`profile ${link.id} revoked; closing its extension link`);
      link.ws.close(CLOSE_BAD_TOKEN, "this profile's pairing was revoked");
    }
    if (!hostClientTokens.size) return;
    const current = opts.hostClients?.();
    for (const [client, hash] of hostClientTokens) {
      if (current?.[client.host!]?.hash === hash) continue;
      hostClientTokens.delete(client);
      opts.onHostClient?.(`cloud host ${client.host} token revoked; closing its CDP client`);
      client.ws.close(CLOSE_BAD_TOKEN, "bad token");
    }
  }, HOST_CLIENT_SWEEP_MS);

  const pinger = setInterval(() => {
    for (const link of links.list()) {
      if (link.ws.readyState !== WebSocket.OPEN) continue;
      if (Date.now() - link.heardAt > silenceMs) {
        // terminate, not close: a peer that is not reading will not answer a
        // close frame either, and the close event is what frees the link.
        link.ws.terminate();
        continue;
      }
      sendJson(link.ws, { op: "ping" });
    }
  }, opts.pingIntervalMs ?? 20_000);

  return {
    port,
    extensionConnected: () => links.list().some((l) => l.ws.readyState === WebSocket.OPEN),
    profiles: () => links.list().map((l) => l.id),
    async close() {
      clearInterval(pinger);
      clearInterval(revokeSweep);
      await server.close();
    },
  };
}

/** A value read from a file, re-read only when the file changed (mtime or size). A missing file reads as undefined. */
function fileReader<T>(file: string, read: () => T): () => T | undefined {
  let seen = "";
  let value: T | undefined;
  return () => {
    let stamp = "";
    try {
      const st = fs.statSync(file);
      stamp = `${st.mtimeMs}:${st.size}`;
    } catch { /* gone */ }
    if (stamp !== seen) { seen = stamp; value = stamp ? read() : undefined; }
    return value;
  };
}

/** bridge.json's host token records, re-read only when the file changed: `extension revoke --host` writes there. */
function hostClientsReader(): () => HostClients | undefined {
  return fileReader(bridgeStatePath(), () => readBridgeState()?.hostClients);
}

/** The `cast browser bridge-host` entry: run until told to stop. */
export async function runBridgeHost(): Promise<void> {
  const state = ensureBridgeConfig();
  const standing = await probeHostPatiently(state);
  if (standing === "alive" || standing === "busy") {
    console.error(`a bridge host is already ${standing === "alive" ? "answering" : "listening but not answering"} on 127.0.0.1:${state.port}`);
    process.exit(0);
  }
  // Detached, this process's stderr is bridgeHostLogPath(): the only trace
  // a host leaves of why it is no longer running.
  const log = (line: string): void => console.error(`${new Date().toISOString()} [host ${process.pid} port ${state.port}] ${line}`);
  // The state file is how every short-lived CLI process learns, without a
  // round trip, whether the extension is here: the host is the only writer
  // of these two fields, and it clears the flag on the way out.
  const owner = { port: state.port, token: state.token, hostPid: process.pid };
  // `connected` is whether ANY profile is on the socket; each profile's
  // arrival and departure is logged with its id.
  const record = (connected: boolean, detail = ""): void => {
    if (detail) log(`extension ${detail.startsWith("close ") ? "disconnected" : "connected"}: ${detail}`);
    updateBridgeHostState(owner, { extensionConnected: connected, ...(connected ? { extensionSeenAt: Date.now() } : {}) });
  };
  const build = formatBuild(currentBuild());
  const pinned = fileReader(bridgeStatePath(), () => readBridgeState()?.profile);
  let host: RunningHost;
  try {
    host = await startBridgeHost({
      port: state.port,
      token: state.token,
      build,
      onExtension: record,
      onStandby: (detail) => log(`second extension turned away: ${detail}`),
      sessionTabs: state.sessionTabs,
      takenBack: state.takenBack,
      sessionProfiles: state.sessionProfiles,
      onTabState: (tabState) => { updateBridgeHostState(owner, tabState); },
      onTraffic: log,
      hostClients: hostClientsReader(),
      onHostClient: log,
      profiles: fileReader(pairingPath(), () => readPairing().profiles),
      revokedProfiles: fileReader(pairingPath(), () => readPairing().revoked),
      pinnedProfile: pinned,
      profileName: (dir) => extensionProfiles().all.find((p) => p.dir === dir)?.name,
      onProfile: log,
      onRetire: () => { void shutdown(`retired for a newer cast (this host is build ${build})`); },
    });
  } catch (err) {
    // Lost the port to a host that bound between the probe and the listen:
    // that host is the bridge, and this one has nothing to add but noise.
    if ((err as { code?: string })?.code === "EADDRINUSE") {
      console.error(`another bridge host bound 127.0.0.1:${state.port} first; leaving it to it`);
      process.exit(0);
    }
    throw err;
  }
  const current = readBridgeState();
  if (!current || current.port !== state.port || current.token !== state.token) {
    await host.close();
    throw new Error("bridge configuration changed during startup; the stale host stopped");
  }
  writeBridgeState({ ...current, hostPid: process.pid, startedAt: Date.now(), extensionConnected: false });
  log(`bridge host pid ${process.pid} (build ${build}) listening on 127.0.0.1:${state.port}`);
  const shutdown = async (why: string, code = 0) => {
    log(`stopping: ${why}`);
    await host.close();
    record(false);
    process.exit(code);
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
  // A crash leaves a line and a clean state file behind: with stdio ignored
  // and the flag left set, a host that died took the reason with it.
  process.on("uncaughtException", (err: Error) => shutdown(`uncaught exception: ${err?.stack ?? err}`, 1));
  process.on("unhandledRejection", (err) => shutdown(`unhandled rejection: ${(err as Error)?.stack ?? err}`, 1));
  // Keep the event loop alive forever; the sockets do the actual work.
  await new Promise(() => {});
}
