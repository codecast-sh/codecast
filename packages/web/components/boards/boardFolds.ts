// What folded frames (pl-1145) hide from the canvas. The renderer, the
// marquee, the selection, the minimap, fit and export all draw from `shown`;
// whatever points at a held element (an arrow's end, a comment pin) points at
// the fold's pill instead (`resolved`).
import { foldedCount, frameCollapsed, hiddenKeys } from "@codecast/shared/artifacts/board";
import type { BoardEl } from "./boardTypes";

export type BoardFolds = {
  hidden: Set<string>;
  /** Every element a person can see: not held by a fold. */
  shown: BoardEl[];
  /** The element an arrow end attached to `key` is drawn to: the visible pill that hides it, else itself. */
  endOf(key: string): BoardEl | undefined;
  /** Every key to what stands for it on the canvas: a held key to its pill. Pins and fit read this in place of byKey. */
  resolved: Map<string, BoardEl>;
};

export function boardFolds(elements: readonly BoardEl[], byKey: Map<string, BoardEl>): BoardFolds {
  const hidden = hiddenKeys({ elements: elements as BoardEl[] });
  if (!hidden.size) return { hidden, shown: elements as BoardEl[], endOf: (k) => byKey.get(k), resolved: byKey };
  // Which fold holds each key; a fold held by another fold hands its keys up to the outer, visible one.
  const holder = new Map<string, string>();
  for (const e of elements) {
    const c = frameCollapsed(e);
    if (c) for (const k of c.holds) if (k !== e.key) holder.set(k, e.key);
  }
  const pillOf = (k: string) => {
    let at = holder.get(k);
    for (let guard = 0; at && hidden.has(at) && guard < 64; guard++) at = holder.get(at);
    return at;
  };
  const shown = elements.filter((e) => {
    if (hidden.has(e.key)) return false;
    // An arrow whose two ends fold into the same pill has nowhere to go.
    if (e.kind === "connector" && typeof e.from === "string" && typeof e.to === "string" && hidden.has(e.from) && hidden.has(e.to)) {
      return pillOf(e.from) !== pillOf(e.to);
    }
    return true;
  });
  const resolved = new Map(byKey);
  for (const k of hidden) {
    const pill = pillOf(k);
    const el = pill ? byKey.get(pill) : undefined;
    if (el) resolved.set(k, el);
    else resolved.delete(k);
  }
  return { hidden, shown, endOf: (k) => resolved.get(k), resolved };
}

/** How many things a folded frame holds, as its pill counts them (the shared foldedCount rule). */
export function foldCount(el: BoardEl, byKey: Map<string, BoardEl>): number {
  return foldedCount(el, (k) => byKey.get(k));
}
