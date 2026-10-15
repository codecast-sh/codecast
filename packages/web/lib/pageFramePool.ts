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

import { PAGE_HEIGHT_MESSAGE } from "../../shared/render/pageTheme";

export type PageHeight = { height: number; preferred: number | null };

type Entry = {
  frame: HTMLIFrameElement;
  src: string;
  /** The frame finished loading its document at least once. */
  loaded: boolean;
  /** The page's last height report: it reports only on change, so a frame moved back would never say it again. */
  height: PageHeight | null;
  parkedAt: number;
};

const MAX_PARKED = 8;
const PARK_TTL_MS = 10 * 60_000;

const parked = new Map<string, Entry>();
const live = new Map<HTMLIFrameElement, Entry>();
let lot: HTMLElement | null = null;
let listening = false;

export function framePoolSupported(): boolean {
  return typeof Element !== "undefined" && "moveBefore" in Element.prototype;
}

function parkingLot(): HTMLElement {
  if (lot?.isConnected) return lot;
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

function evict(entry: Entry) {
  parked.delete(entry.src);
  live.delete(entry.frame);
  entry.frame.remove();
}

function sweep(now = Date.now()) {
  for (const entry of parked.values()) if (now - entry.parkedAt > PARK_TTL_MS) evict(entry);
  // Oldest first: a Map iterates in insertion order and park() re-inserts.
  while (parked.size > MAX_PARKED) evict(parked.values().next().value as Entry);
}

/** A frame for `src`: the parked one when there is one (its page still loaded), else a new element. */
export function claimFrame(src: string, make: () => HTMLIFrameElement): { frame: HTMLIFrameElement; loaded: boolean; height: PageHeight | null } {
  listen();
  const entry = parked.get(src);
  if (entry) {
    parked.delete(src);
    entry.frame.style.width = "";
    entry.frame.style.height = "";
    return { frame: entry.frame, loaded: entry.loaded, height: entry.height };
  }
  const frame = make();
  const fresh: Entry = { frame, src, loaded: false, height: null, parkedAt: 0 };
  live.set(frame, fresh);
  frame.addEventListener("load", () => { fresh.loaded = true; });
  return { frame, loaded: false, height: null };
}

/** Move a frame into `slot` without reloading it. */
export function placeFrame(frame: HTMLIFrameElement, slot: HTMLElement) {
  if (frame.parentElement === slot) return;
  if (frame.isConnected && framePoolSupported()) (slot as any).moveBefore(frame, null);
  else slot.appendChild(frame);
}

/** The embed is gone: keep its frame for the next embed of the same address, or drop it. `keep` false drops it (a
 *  frame that showed the wrong address, or one too new to be worth holding). */
export function releaseFrame(frame: HTMLIFrameElement, keep: boolean) {
  const entry = live.get(frame);
  if (!entry || !keep || !framePoolSupported() || !frame.isConnected) {
    if (entry) live.delete(frame);
    frame.remove();
    return;
  }
  const other = parked.get(entry.src);
  if (other && other !== entry) evict(other);
  // Hold its size so the page does not re-lay out while parked.
  const rect = frame.getBoundingClientRect();
  frame.style.width = `${Math.round(rect.width)}px`;
  frame.style.height = `${Math.round(rect.height)}px`;
  (parkingLot() as any).moveBefore(frame, null);
  entry.parkedAt = Date.now();
  parked.set(entry.src, entry);
  sweep();
}

/** For tests: the addresses parked now, oldest first. */
export function parkedFrames(): string[] {
  return [...parked.keys()];
}
