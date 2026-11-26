// The hunk under the pointer, handed from the gutter (CodeMirror, no React) to
// the card (components/code/blame, React inside the app tree, so a session
// reference there has the router and store it needs). A plain subscription,
// never a store: hovering is the only thing that writes it.

import type { EditorView } from "@codemirror/view";
import type { BlameRun } from "./model";

export interface BlameHover {
  view: EditorView;
  run: BlameRun;
  hue: string;
  /** Where the card points: the hovered gutter cell, in viewport pixels. */
  rect: { left: number; top: number; width: number; height: number };
  /** Opened by a click: stays until dismissed, not until the pointer leaves. */
  pinned?: boolean;
}

const OPEN_MS = 300;
const CLOSE_MS = 200;

let current: BlameHover | null = null;
let timer: ReturnType<typeof setTimeout> | null = null;
/** The target an open timer will show. */
let pending: BlameHover | null = null;
const listeners = new Set<() => void>();

function set(next: BlameHover | null): void {
  if (next === current) return;
  current = next;
  listeners.forEach((fn) => fn());
}

function cancel(): void {
  if (timer) clearTimeout(timer);
  timer = null;
  pending = null;
}

export function getBlameHover(): BlameHover | null {
  return current;
}

export function subscribeBlameHover(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

const sameRun = (a: BlameHover | null, b: Pick<BlameHover, "view" | "run">) => !!a && a.view === b.view && a.run.fromLine === b.run.fromLine && a.run.hunk === b.run.hunk;

/** The pointer moved within `run`. True when the card needs nothing new (it
 *  is this run's, on its way, or pinned), so the gutter measures nothing. */
export function hoverStays(view: EditorView, run: BlameRun): boolean {
  if (sameRun(current, { view, run })) {
    cancel();
    return true;
  }
  return sameRun(pending, { view, run }) || !!current?.pinned;
}

/** The pointer is over a run: show its card after a moment (at once when a
 *  card is already up, so moving down the gutter reads hunk after hunk). */
export function hoverBlameRun(target: BlameHover): void {
  if (sameRun(current, target)) {
    cancel();
    return;
  }
  if (current?.pinned) return;
  cancel();
  if (current) set(target);
  else {
    pending = target;
    timer = setTimeout(() => {
      pending = null;
      set(target);
    }, OPEN_MS);
  }
}

/** Open a run's card now and keep it until dismissed (a click on the bar). */
export function pinBlameRun(target: BlameHover): void {
  cancel();
  set({ ...target, pinned: true });
}

/** The pointer left the gutter or the card. */
export function leaveBlameHover(): void {
  cancel();
  if (!current || current.pinned) return;
  timer = setTimeout(() => set(null), CLOSE_MS);
}

/** The pointer is on the card: keep it. */
export function keepBlameHover(): void {
  cancel();
}

export function closeBlameHover(view?: EditorView): void {
  if (view && current?.view !== view) return;
  cancel();
  set(null);
}
