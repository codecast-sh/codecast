/**
 * Cross-origin iframes for the built-in driver.
 *
 * A frame from another site runs in its own renderer, and its document is
 * reachable only through a child session of the tab: Accessibility, DOM and
 * Input sent on the tab's session never see inside it. Auto-attach (flat
 * sessions) lists those children, on the human's Chrome through the bridge
 * (bridge/frameSessions.ts) and on a Chrome cast launched alike.
 *
 * Refs. A snapshot ref is a backendNodeId, and node ids are per renderer, so
 * one inside a frame could collide with one in the page. A ref inside a frame
 * carries the frame: `key * FRAME_REF_BASE + backendNodeId`, where the key is
 * a hash of the frame's target id. Every command is a fresh process with
 * fresh session ids, and the target id is the one name of the frame that
 * survives between them, so `click #e<ref>` finds the same frame again by its
 * key. A ref below FRAME_REF_BASE is the page's own, unchanged.
 *
 * Input goes to the child session in the frame's own coordinates, which is
 * how Chrome routes it to the frame's widget.
 */

import type { CdpClient, CdpEvent } from "./cdp.js";
import type { PageSession } from "./instance.js";

/** Node ids fit in 32 bits; a frame's key sits above them. Keys stay under 2^16, so a ref stays a safe integer. */
export const FRAME_REF_BASE = 2 ** 32;

export interface ChildFrame {
  sessionId: string;
  targetId: string;
  url: string;
  /** frameKey(targetId): what the frame's refs carry. */
  key: number;
}

/** A frame's ref key: FNV-1a of its target id, 1..65535. */
export function frameKey(targetId: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < targetId.length; i++) {
    h ^= targetId.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return (h % 65535) + 1;
}

export function frameRef(key: number, backendNodeId: number): number {
  return key * FRAME_REF_BASE + backendNodeId;
}

/** The frame key and node id inside a ref (key 0: the page's own). */
export function splitRef(ref: number): { key: number; node: number } {
  return { key: Math.floor(ref / FRAME_REF_BASE), node: ref % FRAME_REF_BASE };
}

const AUTO_ATTACH = { autoAttach: true, waitForDebuggerOnStart: false, flatten: true };

/** Per connection and page session: the children seen so far, kept live by the connection's events. */
const live = new WeakMap<CdpClient, Map<string, Promise<Map<string, ChildFrame>>>>();

/**
 * The cross-origin frames of a page, nested ones included, each as its own
 * session. The first call on a connection turns auto-attach on (Chrome, and
 * the bridge, answer it with the children that exist) and keeps listening, so
 * later calls in the same process see frames that came and went.
 */
export function childFrames(page: PageSession): Promise<ChildFrame[]> {
  let byPage = live.get(page.conn);
  if (!byPage) live.set(page.conn, (byPage = new Map()));
  let known = byPage.get(page.sessionId);
  if (!known) {
    known = watch(page);
    byPage.set(page.sessionId, known);
  }
  return known.then((m) => [...m.values()]);
}

async function watch(page: PageSession): Promise<Map<string, ChildFrame>> {
  const { conn } = page;
  const frames = new Map<string, ChildFrame>();
  // Sessions whose children belong to this page: the page and every frame under it.
  const ours = new Set<string>([page.sessionId]);
  const pending: Promise<unknown>[] = [];
  const onEvent = (ev: CdpEvent): void => {
    if (!ev.sessionId || !ours.has(ev.sessionId)) return;
    const p = ev.params as any;
    if (ev.method === "Target.attachedToTarget" && p?.sessionId && p.targetInfo?.type === "iframe") {
      const targetId = String(p.targetInfo.targetId);
      frames.set(p.sessionId, { sessionId: p.sessionId, targetId, url: String(p.targetInfo.url ?? ""), key: frameKey(targetId) });
      ours.add(p.sessionId);
      // Its own cross-origin frames, and the domains a snapshot and a click read.
      pending.push(
        conn.send("Target.setAutoAttach", AUTO_ATTACH, p.sessionId).catch(() => {}),
        conn.send("DOM.enable", {}, p.sessionId).catch(() => {}),
      );
    } else if (ev.method === "Target.detachedFromTarget" && p?.sessionId) {
      frames.delete(p.sessionId);
      ours.delete(p.sessionId);
    } else if (ev.method === "Page.frameNavigated" && p?.frame && !p.frame.parentId) {
      const f = frames.get(ev.sessionId);
      if (f) f.url = String(p.frame.url ?? f.url);
    }
  };
  conn.on(onEvent);
  try {
    await conn.send("Target.setAutoAttach", AUTO_ATTACH, page.sessionId);
  } catch {
    return frames; // a target that cannot auto-attach has no reachable frames
  }
  // Children announce themselves before the reply; their own children before theirs.
  for (let seen = -1; seen !== pending.length; ) {
    seen = pending.length;
    await Promise.all(pending.slice());
  }
  return frames;
}

/**
 * The page session and node id a ref acts on: the page itself, or the
 * cross-origin frame the ref came from. Throws when that frame is gone.
 */
export async function pageForRef(page: PageSession, ref: number): Promise<{ page: PageSession; ref: number; frame?: ChildFrame }> {
  const { key, node } = splitRef(ref);
  if (!key) return { page, ref };
  const frame = (await childFrames(page)).find((f) => f.key === key);
  if (!frame) throw new Error(`the frame holding #e${ref} is gone from the page; take a fresh snapshot`);
  return { page: { conn: page.conn, sessionId: frame.sessionId, targetId: frame.targetId }, ref: node, frame };
}
