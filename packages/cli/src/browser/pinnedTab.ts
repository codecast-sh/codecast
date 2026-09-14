import * as fs from "node:fs";
import * as path from "node:path";
import { CdpConnection, cdpHttpTimeout, listTargets, type CdpEndpoint } from "./cdp.js";
import { engineSession, engineStateDir, isPaneSession, isRealSession } from "./engine.js";
import { liveDesktopPaneRegistry } from "./desktopPaneRegistry.js";
import { readState } from "./instance.js";
import { bridgeEndpointIfConfigured } from "./bridge/real.js";
import { grantTab } from "./bridge/host.js";
import { CAST_TAB_GROUP } from "./bridge/protocol.js";
import { isPidAlive } from "../workspace/chrome.js";

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

export async function ensurePinnedTab(session = engineSession(), url?: string): Promise<boolean> {
  const browser = await pinnedTabBrowser(session);
  if (!browser) throw new Error("the browser is unavailable; no tab was opened");
  let bound = readBoundTarget(session);
  if (bound && typeof browser.endpoint !== "number" && browser.endpoint.token && browser.endpoint.session) {
    if (!await grantTab({ port: browser.endpoint.port, token: browser.endpoint.token }, session, bound, { own: true })) {
      fs.rmSync(path.join(engineStateDir(), `${session}.target`), { force: true });
      bound = null;
    }
  }
  if (bound && sessionDaemonPid(session)) return false;
  // Only a tab the browser says is gone is replaced; an unanswered check
  // leaves the binding alone.
  if (bound && (await targetLiveness(browser.endpoint, bound)) !== "gone") return false;

  if (isRealSession(session)) {
    const [existing] = await listTargets(browser.endpoint);
    if (existing) {
      writeBoundTarget(session, existing.targetId, engineStateDir(), existing.url);
      return false;
    }
  }
  if (!browser.create) throw new Error("this session's desktop pane is gone — offer one with `cast browser pane <url>` and wait for the human to open it; an agent never opens a pane itself");
  if (!url) throw new Error("this session has no open page; use `cast browser open <url>` first. No blank tab was created.");

  const conn = await CdpConnection.fromPort(browser.endpoint, cdpHttpTimeout(browser.endpoint, 5_000, 20_000));
  try {
    const r = await conn.send<{ targetId: string }>("Target.createTarget", { ...browser.create, url, background: true }, undefined, 20_000);
    if (!r?.targetId) throw new Error("the browser did not return the requested tab");
    writeBoundTarget(session, r.targetId, engineStateDir(), url);
    return true;
  } finally {
    conn.close();
  }
}
