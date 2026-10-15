// Live frames of published pages, kept across unmounts.
//
// A page embed unmounts whenever its surface does: switching decisions,
// leaving a conversation, a virtualized list scrolling it away. Rebuilding the
// iframe reloads the page, so every return to a page cost its whole load
// again and lost its scroll. Here a frame outlives its embed: on unmount it
// moves into a parked container still in the document, and the next embed of
// the same address moves it back. Element.moveBefore keeps an iframe's
// document alive across the move (an ordinary remove-and-insert reloads it);
// where the browser lacks it, nothing is pooled and embeds behave as before.
//
// A parked frame keeps running, so the pool is small and short-lived, and a
// parked page is offscreen, where the browser throttles a cross-origin
// frame's rendering and timers.

import { PAGE_HEIGHT_MESSAGE, PAGE_PARK_MESSAGE } from "../../shared/render/pageTheme";

export type PageHeight = { height: number; preferred: number | null };

type Entry = {
  frame: HTMLIFrameElement;
  /** What the frame shows: its address and the page version it loaded (an address alone outlives a republish). Null
   *  until the embed knew which version it was. */
  key: string | null;
  /** The frame finished loading its document at least once. */
  loaded: boolean;
  /** The page's last height report: it reports only on change, so a frame moved back would never say it again. */
  height: PageHeight | null;
  parkedAt: number;
  /** Rendered by React: dropping it leaves its removal to React, which still holds it. */
  owned?: boolean;
};

const MAX_PARKED = 8;
const PARK_TTL_MS = 10 * 60_000;

// Oldest first. A page can be parked more than once: one shown twice in a view comes back twice.
const parked: Entry[] = [];
const live = new Map<HTMLIFrameElement, Entry>();
let lot: HTMLElement | null = null;
let listening = false;

export function framePoolSupported(): boolean {
  return typeof Element !== "undefined" && "moveBefore" in Element.prototype;
}

function parkingLot(): HTMLElement {
  if (lot?.isConnected) return lot;
  // A lot an earlier copy of this module made (a hot reload in development) holds frames nothing tracks any more.
  for (const stale of document.querySelectorAll("[data-page-frame-lot]")) stale.remove();
  lot = document.createElement("div");
  lot.setAttribute("aria-hidden", "true");
  lot.setAttribute("data-page-frame-lot", "");
  lot.inert = true;
  // Offscreen, not display:none: a hidden frame is laid out at zero size, and a page re-laid out to nothing and back
  // loses its scroll and redraws on return.
  lot.style.cssText = "position:fixed;left:-20000px;top:0;width:0;height:0;overflow:hidden;pointer-events:none;contain:strict;";
  document.body.appendChild(lot);
  return lot;
}

function listen() {
  if (listening) return;
  listening = true;
  window.addEventListener("message", (e) => {
    const m = e.data as { type?: unknown; height?: unknown; preferred?: unknown } | null;
    if (m?.type !== PAGE_HEIGHT_MESSAGE || typeof m.height !== "number") return;
    for (const entry of live.values()) {
      if (entry.frame.contentWindow === e.source) {
        entry.height = { height: m.height, preferred: typeof m.preferred === "number" ? m.preferred : null };
        return;
      }
    }
  });
}

function unpark(entry: Entry) {
  const at = parked.indexOf(entry);
  if (at >= 0) parked.splice(at, 1);
}

function evict(entry: Entry) {
  unpark(entry);
  live.delete(entry.frame);
  entry.frame.remove();
}

function sweep(now = Date.now()) {
  for (const entry of [...parked]) if (now - entry.parkedAt > PARK_TTL_MS) evict(entry);
  while (parked.length > MAX_PARKED) evict(parked[0]!);
}

function parkedFor(key: string | null): Entry | undefined {
  return key ? parked.find((e) => e.key === key) : undefined;
}

/** The pool's key for a page frame: what it shows (the page, theme and gate tokens its address names, and the version
 *  it loaded), not the literal address. A page first framed at its bare address before its version was known and
 *  later asked for pinned (r=vN) is the same page. */
export function frameKey(src: string, version: number | undefined): string | null {
  return version ? `${src.replace(/&r=v\d+/, "")}#v${version}` : null;
}

/** A page frame element for `src`. */
export function makePageFrame(src: string): HTMLIFrameElement {
  const f = document.createElement("iframe");
  f.className = "page-embed__frame block h-full w-full";
  f.setAttribute("sandbox", "allow-scripts allow-popups allow-popups-to-escape-sandbox");
  f.src = src;
  return f;
}

function track(frame: HTMLIFrameElement, key: string | null): Entry {
  const entry: Entry = { frame, key, loaded: false, height: null, parkedAt: 0 };
  live.set(frame, entry);
  frame.addEventListener("load", () => { entry.loaded = true; });
  return entry;
}

/** Whether a frame for `key` is parked: an embed renders no frame of its own then, and claims that one. */
export function hasParkedFrame(key: string | null): boolean {
  return !!parkedFor(key);
}

/** The parked frame for `key` (its page still loaded), taken out of the pool; null when there is none. */
export function claimFrame(key: string | null): { frame: HTMLIFrameElement; loaded: boolean; height: PageHeight | null } | null {
  listen();
  const entry = parkedFor(key);
  if (!entry) return null;
  unpark(entry);
  entry.frame.style.width = "";
  entry.frame.style.height = "";
  return { frame: entry.frame, loaded: entry.loaded, height: entry.height };
}

/** Track a frame an embed made itself, so it can be parked when the embed goes. `owned` (the default): React rendered
 *  it and removes it, so dropping it leaves it in place. */
export function adoptFrame(frame: HTMLIFrameElement, owned = true) {
  listen();
  if (!live.has(frame)) track(frame, null).owned = owned;
}

/** Mark an adopted frame loaded (its own load event may have fired before adoptFrame ran). */
export function frameLoaded(frame: HTMLIFrameElement) {
  const entry = live.get(frame);
  if (entry) entry.loaded = true;
}

/** Load a page the reader is likely to open next into a parked frame, so opening it moves a loaded page into place.
 *  Nothing when that page is parked or on screen already, or where frames cannot be moved without reloading. */
export function preloadFrame(src: string, key: string | null, width: number) {
  if (!key || !framePoolSupported() || typeof document === "undefined") return;
  if (parkedFor(key)) return;
  for (const e of live.values()) if (e.key === key) return;
  listen();
  const frame = makePageFrame(src);
  const entry = track(frame, key);
  // The width it will show at, so the page lays out once.
  frame.style.width = `${Math.round(width)}px`;
  frame.style.height = "420px";
  parkingLot().appendChild(frame);
  entry.parkedAt = Date.now();
  parked.push(entry);
  sweep();
}

/** Move a frame into `slot` without reloading it. */
export function placeFrame(frame: HTMLIFrameElement, slot: HTMLElement) {
  if (frame.parentElement === slot) return;
  if (frame.isConnected && framePoolSupported()) (slot as any).moveBefore(frame, null);
  else slot.appendChild(frame);
}

/** The embed is gone: keep its frame under `key` for the next embed of the same page, or drop it (`key` null: the
 *  frame showed an address the embed had not confirmed). */
export function releaseFrame(frame: HTMLIFrameElement, key: string | null) {
  const entry = live.get(frame);
  if (!entry || !key || !framePoolSupported() || !frame.isConnected) {
    if (entry) live.delete(frame);
    if (!entry?.owned) frame.remove();
    return;
  }
  entry.key = key;
  // Parked, it is the pool's: evicting it later removes it.
  entry.owned = false;
  // Hold its size so the page does not re-lay out while parked.
  const rect = frame.getBoundingClientRect();
  frame.style.width = `${Math.round(rect.width)}px`;
  frame.style.height = `${Math.round(rect.height)}px`;
  (parkingLot() as any).moveBefore(frame, null);
  // Out of sight but alive: a page playing video or sound stops.
  try {
    frame.contentWindow?.postMessage({ type: PAGE_PARK_MESSAGE }, "*");
  } catch { /* mid-navigation */ }
  entry.parkedAt = Date.now();
  unpark(entry);
  parked.push(entry);
  sweep();
}

/** For tests: the addresses parked now, oldest first. */
export function parkedFrames(): string[] {
  return parked.map((e) => e.key ?? "");
}
