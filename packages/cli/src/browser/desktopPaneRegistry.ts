/**
 * The desktop app's pane registry, as `cast browser` reads it.
 *
 * The codecast desktop app opens a Chrome DevTools Protocol port on loopback
 * (packages/electron/main.js) and puts every browser pane it shows in a
 * WebContentsView, which is a target on that port like any tab. So an agent
 * can drive the very view the human is looking at — no screencast, no second
 * browser. The one thing the port cannot say is which target is which pane,
 * and which session the human opened it for. The app writes that down in a
 * file under this CLI's own browser state (packages/electron/browserPanes.js
 * explains why a file and not an endpoint: the port is the boundary the app
 * already accepted; the file adds a name for what is behind it, not a door).
 *
 * This module is the read side, and it is deliberately network-free except
 * for `liveDesktopPanes`: the watch server resolves tabs on a timer and must
 * not dial the app to do it.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { listTargets, type CdpEndpoint, type CdpTarget } from "./cdp.js";
import { browserHome } from "./profile.js";
import { isPidAlive } from "../workspace/chrome.js";

export const DESKTOP_PANE_REGISTRY_VERSION = 1;
export const DESKTOP_PANE_REGISTRY_FILE = "desktop-panes.json";

export interface DesktopPaneEntry {
  /** The renderer's own id for the pane (React's useId, per mount). */
  paneId: string;
  /** The CDP target id of the view, once the app has asked its debugger. */
  targetId: string | null;
  url: string | null;
  /** The agent session the human opened this pane for, or null when nobody
   *  offered it — a pane the human opened by hand belongs to no agent. */
  session: string | null;
}

export interface DesktopPaneRegistry {
  version: number;
  /** The app's CDP port on 127.0.0.1. */
  port: number;
  /** The app process that wrote the file; null when it did not say. */
  pid: number | null;
  updatedAt: number;
  panes: DesktopPaneEntry[];
}

/** `$CODECAST_DIR/browser/desktop-panes.json` — the app mirrors this path. */
export function desktopPaneRegistryPath(): string {
  return path.join(browserHome(), DESKTOP_PANE_REGISTRY_FILE);
}

/** The document, checked field by field. Null for anything this version of
 *  the CLI cannot vouch for: a newer schema, a port that is not one. */
export function parseDesktopPaneRegistry(raw: string): DesktopPaneRegistry | null {
  let doc: any;
  try {
    doc = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!doc || typeof doc !== "object" || doc.version !== DESKTOP_PANE_REGISTRY_VERSION) return null;
  const port = Number(doc.port);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) return null;
  const panes: DesktopPaneEntry[] = [];
  for (const p of Array.isArray(doc.panes) ? doc.panes : []) {
    if (!p || typeof p !== "object" || typeof p.paneId !== "string" || !p.paneId) continue;
    panes.push({
      paneId: p.paneId,
      targetId: typeof p.targetId === "string" && p.targetId ? p.targetId : null,
      url: typeof p.url === "string" && p.url ? p.url : null,
      session: typeof p.session === "string" && p.session ? p.session : null,
    });
  }
  const pid = Number(doc.pid);
  return {
    version: doc.version,
    port,
    pid: Number.isInteger(pid) && pid > 0 ? pid : null,
    updatedAt: Number(doc.updatedAt) || 0,
    panes,
  };
}

export function readDesktopPaneRegistry(file = desktopPaneRegistryPath()): DesktopPaneRegistry | null {
  try {
    return parseDesktopPaneRegistry(fs.readFileSync(file, "utf-8"));
  } catch {
    return null;
  }
}

/**
 * The registry of an app that is running now, or null. The file names the
 * process that wrote it, and a dead pid is a file the app did not get to
 * remove (a crash, a kill). No pid is trusted as-is — an older writer.
 */
export function liveDesktopPaneRegistry(
  file = desktopPaneRegistryPath(),
  alive: (pid: number) => boolean = isPidAlive,
): DesktopPaneRegistry | null {
  const reg = readDesktopPaneRegistry(file);
  if (!reg) return null;
  if (reg.pid !== null && !alive(reg.pid)) return null;
  return reg;
}

/**
 * The session ids this CLI process may own a pane under. The app records the
 * session uuid the offer named (the same id `detectCurrentSessionId` yields,
 * which owner.ts wraps as `session:<id>`), and a harness exports its own id
 * for the agent's process tree; either may be what the app wrote. The tmux
 * pane key is not an id anything else knows, so it never matches.
 */
export function paneOwnerIds(ownerKey: string | null, env: NodeJS.ProcessEnv = process.env): string[] {
  const ids = new Set<string>();
  const m = ownerKey ? /^(session|env):(.+)$/.exec(ownerKey) : null;
  if (m) ids.add(m[2]);
  for (const name of ["CLAUDE_CODE_SESSION_ID", "CODEX_SESSION_ID", "CLAUDE_CODE_BRIDGE_SESSION_ID", "CAST_SESSION_ID"]) {
    const v = env[name];
    if (v) ids.add(v);
  }
  return [...ids];
}

/**
 * The pane one of these ids owns: the newest when the human opened several
 * for the same session (the file lists them in creation order). `explicit`
 * names a pane id outright, for a human at a bare shell who can see the
 * registry. A pane nobody offered matches no id, ever.
 */
export function findDesktopPane<T extends DesktopPaneEntry>(panes: T[], ownerIds: string[], explicit?: string): T | null {
  if (explicit) return panes.find((p) => p.paneId === explicit) ?? null;
  const owned = panes.filter((p) => p.session && ownerIds.includes(p.session));
  return owned.length ? owned[owned.length - 1] : null;
}

/** A registry entry the app has confirmed is attachable: its target id is on
 *  the port right now. */
export type LiveDesktopPane = DesktopPaneEntry & { targetId: string };

/**
 * The registry's panes as the app's port sees them now. A closed pane leaves
 * the file a moment after it leaves the port, and an entry whose target id the
 * app never learned (its debugger would not attach) is matched by URL, so both
 * are settled here against the one source that cannot be stale.
 */
export async function liveDesktopPanes(
  reg: DesktopPaneRegistry,
  list: (ep: CdpEndpoint) => Promise<CdpTarget[]> = listTargets,
): Promise<LiveDesktopPane[]> {
  const targets = await list(reg.port);
  const byId = new Map(targets.map((t) => [t.targetId, t]));
  const out: LiveDesktopPane[] = [];
  for (const p of reg.panes) {
    if (p.targetId) {
      if (byId.has(p.targetId)) out.push({ ...p, targetId: p.targetId });
      continue;
    }
    const byUrl = p.url ? targets.find((t) => t.url === p.url && !out.some((o) => o.targetId === t.targetId)) : null;
    if (byUrl) out.push({ ...p, targetId: byUrl.targetId });
  }
  return out;
}

/**
 * What the watch engine needs without dialing anything: the app's endpoint
 * and the target ids the registry vouches for, so a pane pin whose view has
 * gone (the registry no longer lists it) does not shadow the session's other
 * tab (watchSource.ts resolveEngineTab).
 */
export function desktopPanePins(file = desktopPaneRegistryPath()): { endpoint: CdpEndpoint; targets: Set<string> } | null {
  const reg = liveDesktopPaneRegistry(file);
  if (!reg) return null;
  return { endpoint: reg.port, targets: new Set(reg.panes.map((p) => p.targetId).filter((t): t is string => !!t)) };
}
