import * as fs from "node:fs";
import * as path from "node:path";
import { CdpConnection, cdpHttpTimeout, listTargets, readCdpJson, type CdpEndpoint } from "./cdp.js";
import {
  baseSessionKey, engineSession, engineSessionKey, engineStateDir, isPaneSession, isRealSession,
  paneSessionKey, realSessionKey,
} from "./engine.js";
import { liveDesktopPaneRegistry } from "./desktopPaneRegistry.js";
import { readState } from "./instance.js";
import { bridgeEndpointIfConfigured } from "./bridge/real.js";
import { grantTab } from "./bridge/host.js";
import { retryOnStall } from "./stall.js";
import { CAST_TAB_GROUP } from "./bridge/protocol.js";
import { isPidAlive } from "../workspace/chrome.js";
import { OWNER_HARNESS_ENV } from "./owner.js";
import { sameDocument } from "./url.js";
import { ownerState, scanLiveOwners, type LiveOwners } from "./engineReap.js";
import { authorizesTeardown } from "@codecast/shared/contracts";

/** The engine daemon for this session, if one is alive. */
export function sessionDaemonPid(session: string, stateDir = engineStateDir()): number | null {
  try {
    const pid = parseInt(fs.readFileSync(path.join(stateDir, `${session}.pid`), "utf-8").trim(), 10);
    return pid > 0 && isPidAlive(pid) ? pid : null;
  } catch {
    return null;
  }
}

/** The session's persisted tab binding, as the engine reads it at attach. */
export function readBoundTarget(session: string, stateDir = engineStateDir()): string | null {
  try {
    const t = JSON.parse(fs.readFileSync(path.join(stateDir, `${session}.target`), "utf-8"));
    return typeof t?.targetId === "string" && t.targetId ? t.targetId : null;
  } catch {
    return null;
  }
}

/**
 * Mark the binding as the one being driven now. The watch server follows the
 * most recently pinned binding across a session's browsers (watchSource.ts
 * resolveEngineTab); the engine writes a binding once, so without this a
 * session that moved back from its desktop pane to its Chrome tab would keep
 * streaming the pane.
 */
export function touchBoundTarget(session: string, stateDir = engineStateDir(), now = new Date()): void {
  try {
    fs.utimesSync(path.join(stateDir, `${session}.target`), now, now);
  } catch {
    /* no binding yet: the engine writes one at attach */
  }
}

/** Write the binding the way tab_binding.rs does: atomic, owner-only. */
export function writeBoundTarget(session: string, targetId: string, stateDir = engineStateDir(), url = "about:blank"): void {
  fs.mkdirSync(stateDir, { recursive: true });
  const file = path.join(stateDir, `${session}.target`);
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify({ targetId, url, pinned: true }), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

/**
 * Is the bound tab still open? "unknown" when the browser did not answer in
 * time: over the bridge the list is a round trip through the extension, which
 * a busy Chrome can stretch past the deadline, and reading that as "gone"
 * created a fresh blank tab beside a live one on every slow check, orphaning
 * the old tab for good.
 */
export async function targetLiveness(endpoint: CdpEndpoint, targetId: string, timeoutMs = cdpHttpTimeout(endpoint, 2_000, 10_000)): Promise<"alive" | "gone" | "unknown"> {
  try {
    return (await listTargets(endpoint, timeoutMs)).some(t => t.targetId === targetId) ? "alive" : "gone";
  } catch {
    return "unknown";
  }
}

/** The browser a session's pinned tab lives in, and how to create it there. */
export interface PinnedTabBrowser {
  endpoint: CdpEndpoint;
  /** `Target.createTarget` params: always a background tab, never a raise.
   *  Null for a browser where this CLI may not create anything: the desktop
   *  app, whose panes only the human opens (desktopPane.ts). */
  create: Record<string, unknown> | null;
}

/**
 * A `-real` session (engine.ts) pins into the human's Chrome through the
 * bridge, grouped under the session's name; the extra `castGroup` param is
 * the bridge host's, stripped before the call reaches Chrome. Any other
 * session pins into the managed Chrome. Null when that browser is not up
 * (or, for the bridge, cannot prove it is ours): the pinned tab is a
 * courtesy and never starts one.
 */
export async function pinnedTabBrowser(session: string): Promise<PinnedTabBrowser | null> {
  if (isPaneSession(session)) {
    // The binding itself is written by desktopPaneCtx, to the pane's exact
    // target; this only says where that target lives.
    const reg = liveDesktopPaneRegistry();
    return reg ? { endpoint: reg.port, create: null } : null;
  }
  if (isRealSession(session)) {
    // Named on the socket, so the host files the tab under this session and
    // lets only this session's engine discover it.
    const endpoint = await bridgeEndpointIfConfigured(session);
    if (!endpoint) return null;
    return {
      endpoint,
      create: { url: "about:blank", background: true, castGroup: CAST_TAB_GROUP },
    };
  }
  const state = readState();
  if (!state || state.remote || !isPidAlive(state.pid)) return null;
  return { endpoint: state.port, create: { url: "about:blank", background: true } };
}

export interface CastTab {
  targetId: string;
  url: string;
  sessions: string[];
}

/** Is this engine session key the same agent as `session`, including an older
 *  identity (tmux pane, harness twin) that would otherwise look like a stranger
 *  and mint a second tab. */
export function tabHolderIsSelf(holder: string, session: string, env: NodeJS.ProcessEnv = process.env): boolean {
  if (holder === session) return true;
  if (baseSessionKey(holder) === baseSessionKey(session)) return true;
  const pane = env.TMUX_PANE;
  if (pane) {
    const paneKey = engineSessionKey(`pane:${pane}`);
    if (holder === paneKey || holder === realSessionKey(paneKey) || holder === paneSessionKey(paneKey)) return true;
  }
  for (const name of OWNER_HARNESS_ENV) {
    const v = env[name];
    if (!v) continue;
    const key = engineSessionKey(`env:${v}`);
    if (holder === key || holder === realSessionKey(key) || holder === paneSessionKey(key)) return true;
  }
  return false;
}

/**
 * Pick a Cast tab already on `url` that this session may drive: ours (including
 * an older identity), an unowned leftover, or one whose every holder has
 * exited. A live stranger's tab is never taken — that is the hijack the
 * isolation exists to prevent.
 */
export function pickReclaimableTab(
  tabs: CastTab[],
  url: string,
  session: string,
  holderExited: (holder: string) => boolean,
  env: NodeJS.ProcessEnv = process.env,
): CastTab | null {
  const matches = tabs.filter((t) => sameDocument(t.url, url));
  const mine = matches.find((t) => t.sessions.some((s) => tabHolderIsSelf(s, session, env)));
  if (mine) return mine;
  const free = matches.find((t) => t.sessions.length === 0);
  if (free) return free;
  return matches.find((t) => t.sessions.length > 0 && t.sessions.every((s) => holderExited(s))) ?? null;
}

function unscopedEndpoint(endpoint: CdpEndpoint): CdpEndpoint {
  return typeof endpoint === "number" ? endpoint : { port: endpoint.port, token: endpoint.token };
}

export async function listCastTabs(endpoint: CdpEndpoint): Promise<CastTab[]> {
  const raw = await readCdpJson<Array<{ id?: string; url?: string; type?: string; cast?: boolean; sessions?: string[] }>>(
    unscopedEndpoint(endpoint),
    "/json/list",
  );
  return raw
    .filter((t) => t.cast && t.type === "page" && t.id)
    .map((t) => ({ targetId: t.id!, url: t.url ?? "", sessions: t.sessions ?? [] }));
}

function holderExitedFn(live: LiveOwners): (holder: string) => boolean {
  // Ask the gate, never the word: only `exited` may retire a holder, and a
  // holder we could not verify keeps its claim on the tab (liveness.guard).
  return (holder) => authorizesTeardown(ownerState(holder, live));
}

async function reclaimCastTab(endpoint: CdpEndpoint, session: string, url: string): Promise<CastTab | null> {
  let tabs: CastTab[];
  try {
    tabs = await listCastTabs(endpoint);
  } catch {
    return null;
  }
  // tmux list-panes is not free on a busy machine; only ask when a same-URL
  // tab still has holders that are not us and not already unowned.
  let live: LiveOwners | undefined;
  const pick = pickReclaimableTab(tabs, url, session, (holder) => {
    live ??= scanLiveOwners();
    return holderExitedFn(live)(holder);
  });
  if (!pick) return null;
  if (typeof endpoint === "number" || !endpoint.token) return pick;
  const granted = await grantTab({ port: endpoint.port, token: endpoint.token }, session, pick.targetId).catch(() => false);
  return granted ? pick : null;
}

export async function ensurePinnedTab(session = engineSession(), url?: string): Promise<boolean> {
  const browser = await pinnedTabBrowser(session);
  if (!browser) throw new Error("the browser is unavailable; no tab was opened");
  let bound = readBoundTarget(session);
  if (bound && typeof browser.endpoint !== "number" && browser.endpoint.token && browser.endpoint.session) {
    const bridge = { port: browser.endpoint.port, token: browser.endpoint.token };
    const target = bound;
    // The host verifies the grant with a tab listing from the worker, whose
    // process may be frozen (stall.ts): asked once more before it counts.
    if (!(await retryOnStall(() => grantTab(bridge, session, target, { own: true })))) {
      fs.rmSync(path.join(engineStateDir(), `${session}.target`), { force: true });
      bound = null;
    }
  }
  // Only a tab the browser says is gone is replaced; an unanswered check
  // leaves the binding alone. A live daemon is not proof the tab still
  // exists — treating it as such made every tab_gone retry mint a second tab.
  if (bound && (await targetLiveness(browser.endpoint, bound)) !== "gone") return false;

  if (isRealSession(session)) {
    const existing = await listTargets(browser.endpoint).catch(() => [] as Awaited<ReturnType<typeof listTargets>>);
    const ours = url ? existing.find((t) => sameDocument(t.url, url)) ?? existing[0] : existing[0];
    if (ours) {
      writeBoundTarget(session, ours.targetId, engineStateDir(), ours.url);
      return false;
    }
    if (url) {
      const reclaimed = await reclaimCastTab(browser.endpoint, session, url);
      if (reclaimed) {
        writeBoundTarget(session, reclaimed.targetId, engineStateDir(), reclaimed.url);
        return false;
      }
    }
  }
  if (!browser.create) throw new Error("this session's desktop pane is gone — offer one with `cast browser pane <url>` and wait for the human to open it; an agent never opens a pane itself");
  if (!url) throw new Error("this session has no open page; use `cast browser open <url>` first. No blank tab was created.");

  // Over the bridge the create is answered by the extension's worker, whose
  // process may be frozen for a while (stall.ts): the request outlasts the
  // host's own budget for it, and is asked once more after a stall.
  const create = async () => {
    const conn = await CdpConnection.fromPort(browser.endpoint, cdpHttpTimeout(browser.endpoint, 5_000, 45_000));
    try {
      return await conn.send<{ targetId: string }>("Target.createTarget", { ...browser.create, url, background: true }, undefined, 45_000);
    } finally {
      conn.close();
    }
  };
  const r = await retryOnStall(create);
  if (!r?.targetId) throw new Error("the browser did not return the requested tab");
  writeBoundTarget(session, r.targetId, engineStateDir(), url);
  return true;
}

/**
 * The engine said this session's tab is gone. Drop the pin only when the
 * browser agrees, then bind one tab (reclaim or create) so a retry of `open`
 * does not mint a second one beside a tab that was merely slow to answer.
 */
export async function recoverGoneTab(session: string, url?: string): Promise<void> {
  const bound = readBoundTarget(session);
  if (bound) {
    const browser = await pinnedTabBrowser(session);
    if (!browser) return;
    const life = await targetLiveness(browser.endpoint, bound);
    if (life !== "gone") return;
    fs.rmSync(path.join(engineStateDir(), `${session}.target`), { force: true });
  }
  if (url) await ensurePinnedTab(session, url);
}
