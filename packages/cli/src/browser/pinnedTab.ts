/**
 * Pre-create a session's pinned tab in the background.
 *
 * When the engine daemon attaches with no tab bound to the session, it pins a
 * fresh one by sending `Target.createTarget` with no `background` flag — a
 * foreground create, which on macOS raises the whole Chrome app over whatever
 * the human is doing. Chrome honors `background: true` on the same call, so
 * cast creates the tab itself before the daemon's first attach and hands it
 * over through the engine's persisted tab binding file (`{session}.target` in
 * the daemon state dir, the same file engineReap reads). At attach the daemon
 * restores that binding instead of creating anything, and nothing is raised.
 *
 * This also covers a session coming back after a reap: its stale binding
 * points at a closed tab, which without this would put the daemon in the
 * tab_gone state and route the next `open` through a foreground `tab new`.
 * Rewriting the binding to a live background tab first keeps the whole path
 * quiet.
 *
 * Only when the session's daemon is not running: the binding file is read at
 * attach, so writing it under a live daemon changes nothing — and a live
 * daemon already owns a tab. Best effort throughout; without it the engine
 * still works, it just raises the window the way it always did.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { CdpConnection, cdpHttpUrl, type CdpEndpoint } from "./cdp.js";
import { engineSession, engineStateDir, isRealSession, REAL_SESSION_SUFFIX } from "./engine.js";
import { readState } from "./instance.js";
import { bridgeEndpointIfConfigured } from "./bridge/real.js";
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

/** Write the binding the way tab_binding.rs does: atomic, owner-only. */
export function writeBoundTarget(session: string, targetId: string, stateDir = engineStateDir()): void {
  fs.mkdirSync(stateDir, { recursive: true });
  const file = path.join(stateDir, `${session}.target`);
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify({ targetId, url: "about:blank", pinned: true }), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

async function targetAlive(endpoint: CdpEndpoint, targetId: string): Promise<boolean> {
  try {
    const res = await fetch(cdpHttpUrl(endpoint, "/json/list"), { signal: AbortSignal.timeout(2_000) });
    if (!res.ok) return false;
    return ((await res.json()) as Array<{ id: string }>).some((t) => t.id === targetId);
  } catch {
    return false;
  }
}

/**
 * The Chrome tab group a real-mode session's tabs sit in, named so the human
 * can tell whose it is at a glance: `cast ` plus the start of the session id.
 */
export function sessionTabGroupTitle(session: string): string {
  const id = session
    .slice(0, isRealSession(session) ? -REAL_SESSION_SUFFIX.length : undefined)
    .replace(/^(?:env|session)-/, "");
  return `cast ${id.slice(0, 7)}`;
}

/** The browser a session's pinned tab lives in, and how to create it there. */
export interface PinnedTabBrowser {
  endpoint: CdpEndpoint;
  /** `Target.createTarget` params: always a background tab, never a raise. */
  create: Record<string, unknown>;
}

/**
 * A `-real` session (engine.ts) pins into the human's Chrome through the
 * bridge, grouped under the session's name; the extra `castGroup` param is
 * the bridge host's, stripped before the call reaches Chrome. Any other
 * session pins into the managed Chrome. Null when that browser is not up:
 * the pinned tab is a courtesy and never starts one.
 */
export function pinnedTabBrowser(session: string): PinnedTabBrowser | null {
  if (isRealSession(session)) {
    const endpoint = bridgeEndpointIfConfigured();
    if (!endpoint) return null;
    return {
      endpoint,
      create: { url: "about:blank", background: true, castGroup: { title: sessionTabGroupTitle(session), color: "blue" } },
    };
  }
  const state = readState();
  if (!state || state.remote || !isPidAlive(state.pid)) return null;
  return { endpoint: state.port, create: { url: "about:blank", background: true } };
}

/**
 * Make sure the next daemon attach for this session finds a live bound tab,
 * creating one in the background if it must. Cheap when there is nothing to
 * do: one pid check under a live daemon, one HTTP probe under a live binding.
 */
export async function ensurePinnedTab(session = engineSession()): Promise<void> {
  try {
    const browser = pinnedTabBrowser(session);
    if (!browser) return;
    if (sessionDaemonPid(session)) return;
    const bound = readBoundTarget(session);
    if (bound && (await targetAlive(browser.endpoint, bound))) return;

    const conn = await CdpConnection.fromPort(browser.endpoint, 5_000);
    try {
      const r = await conn.send<{ targetId: string }>("Target.createTarget", browser.create, undefined, 5_000);
      if (r?.targetId) writeBoundTarget(session, r.targetId);
    } finally {
      conn.close();
    }
  } catch {
    /* best effort */
  }
}
