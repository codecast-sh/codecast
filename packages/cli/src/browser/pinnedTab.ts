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
import { baseSessionKey, engineSession, engineStateDir, isRealSession } from "./engine.js";
import { readState } from "./instance.js";
import { bridgeEndpointIfConfigured } from "./bridge/real.js";
import type { BridgeGroup, BridgeGroupColor } from "./bridge/protocol.js";
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
 * can tell whose it is at a glance: `cast ` plus the short id of the session
 * (its first seven characters, the same prefix codecast prints for it), from
 * the codecast session id when the CLI resolved one and from the harness id
 * otherwise (owner.ts ownerKey, flattened by engine.ts engineSessionKey). A
 * tmux pane, the last fallback, is named as a pane: a bare pane number would
 * read as a session id that exists nowhere.
 */
export function sessionTabGroupTitle(session: string): string {
  const key = baseSessionKey(session);
  const m = /^(session|env|pane)-(.+)$/.exec(key);
  if (!m) return `cast ${key}`;
  if (m[1] === "pane") return `cast pane ${m[2].replace(/^-+/, "")}`;
  return `cast ${m[2].slice(0, 7)}`;
}

/** Chrome's group colours minus grey, which reads as "no colour". */
const GROUP_COLORS: BridgeGroupColor[] = ["blue", "red", "yellow", "green", "pink", "purple", "cyan", "orange"];

/**
 * The group's colour, from a stable hash of the session key with no mode on
 * it, so two agents driving the same Chrome are told apart by colour before
 * anyone reads a title, and a session gets the same colour on every run.
 */
export function sessionTabGroupColor(session: string): BridgeGroupColor {
  let h = 0;
  for (const ch of baseSessionKey(session)) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return GROUP_COLORS[h % GROUP_COLORS.length];
}

/** The group a session's real-mode tabs sit in: title and colour, one place. */
export function sessionTabGroup(session: string): BridgeGroup {
  return { title: sessionTabGroupTitle(session), color: sessionTabGroupColor(session) };
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
 * session pins into the managed Chrome. Null when that browser is not up
 * (or, for the bridge, cannot prove it is ours): the pinned tab is a
 * courtesy and never starts one.
 */
export async function pinnedTabBrowser(session: string): Promise<PinnedTabBrowser | null> {
  if (isRealSession(session)) {
    const endpoint = await bridgeEndpointIfConfigured();
    if (!endpoint) return null;
    return {
      endpoint,
      create: { url: "about:blank", background: true, castGroup: sessionTabGroup(session) },
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
    const browser = await pinnedTabBrowser(session);
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
