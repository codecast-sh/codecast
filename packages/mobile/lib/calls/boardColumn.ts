// A call board read as a column on the phone (pl-1145): each top-level frame
// is a card titled by its object's chip, its notes and filed cards below, and
// a folded frame inside it a "Working notes (n)" row the reader opens on tap.
// Whatever sits outside every frame goes in a last "Loose" card.
//
// Containment is the board's own rule (shared/artifacts/boardFrames): an
// element belongs to the smallest unfolded frame whose box holds it, and a
// folded frame's holds belong to it, keeping their coordinates. No React
// Native here, so the builder is tested directly.
import type { ArtifactElement } from "@codecast/shared/artifacts";
import { contains, elementBounds, foldedCount, frameCollapsed, frameRef, hiddenKeys, type Box } from "@codecast/shared/artifacts/board";

/** What the column draws as a row: words and filed cards. Arrows, ink and the like stay on the canvas. */
const ROW_KINDS = new Set(["sticky", "text", "shape", "card"]);

export type ColumnNote = { kind: "note"; key: string; el: ArtifactElement };
export type ColumnGroup = {
  kind: "group";
  key: string;
  ref: string | null;
  title: string;
  /** Folded on the board: drawn as a "title (n)" row that opens on tap. */
  folded: boolean;
  /** The board's "(n)" for a folded frame (foldedCount). */
  count: number;
  items: ColumnItem[];
};
export type ColumnItem = ColumnNote | ColumnGroup;
export type ColumnCard = ColumnGroup | { kind: "loose"; key: "loose"; items: ColumnNote[] };

type Node = { el: ArtifactElement; box: Box; children: Node[] };

const titleOf = (el: ArtifactElement) => (typeof el.title === "string" ? el.title.trim() : "");
const area = (b: Box) => b.w * b.h;
const reading = (a: Node, b: Node) => a.box.y - b.box.y || a.box.x - b.box.x;

export function buildBoardColumn(elements: readonly ArtifactElement[]): ColumnCard[] {
  const view = { elements: elements as ArtifactElement[] };
  const hidden = hiddenKeys(view);
  const byKey = new Map(elements.map((e) => [e.key, e]));
  const nodes = new Map<string, Node>();
  for (const el of elements) {
    if (el.kind !== "frame" && !ROW_KINDS.has(el.kind)) continue;
    nodes.set(el.key, { el, box: elementBounds(el), children: [] });
  }

  // The folded frames holding each key; the innermost holder is the one the
  // others hold too.
  const holdersOf = new Map<string, string[]>();
  for (const el of elements) {
    const c = frameCollapsed(el);
    if (!c) continue;
    for (const k of c.holds) if (k !== el.key) holdersOf.set(k, [...(holdersOf.get(k) ?? []), el.key]);
  }
  const innermostHolder = (key: string): string | null => {
    const hs = holdersOf.get(key) ?? [];
    let best: string | null = null;
    let depth = -1;
    for (const h of hs) {
      const d = (holdersOf.get(h) ?? []).filter((x) => hs.includes(x)).length;
      if (d > depth) [best, depth] = [h, d];
    }
    return best;
  };

  const parentOf = (n: Node): string | null => {
    const holder = innermostHolder(n.el.key);
    // Held keys look among the frames the same fold holds; the rest among the visible frames.
    const pool = holder ? (frameCollapsed(byKey.get(holder))?.holds ?? []) : [...nodes.keys()].filter((k) => !hidden.has(k));
    let best: Node | null = null;
    for (const k of pool) {
      const f = nodes.get(k);
      if (!f || f.el.kind !== "frame" || f.el.key === n.el.key || frameCollapsed(f.el)) continue;
      if (holder && innermostHolder(k) !== holder) continue;
      if (!contains(f.box, n.box) || (best && area(f.box) >= area(best.box))) continue;
      best = f;
    }
    return best ? best.el.key : holder;
  };

  const roots: Node[] = [];
  for (const n of nodes.values()) {
    const p = parentOf(n);
    const parent = p ? nodes.get(p) : undefined;
    if (parent) parent.children.push(n);
    else roots.push(n);
  }

  const toItem = (n: Node): ColumnItem => {
    if (n.el.kind !== "frame") return { kind: "note", key: n.el.key, el: n.el };
    return {
      kind: "group",
      key: n.el.key,
      ref: frameRef(n.el),
      title: titleOf(n.el),
      folded: !!frameCollapsed(n.el),
      count: frameCollapsed(n.el) ? foldedCount(n.el, (k) => byKey.get(k)) : 0,
      items: [...n.children].sort(reading).map(toItem),
    };
  };

  roots.sort(reading);
  const cards: ColumnCard[] = roots.filter((n) => n.el.kind === "frame").map((n) => toItem(n) as ColumnGroup);
  const loose = roots.filter((n) => n.el.kind !== "frame").map((n) => ({ kind: "note" as const, key: n.el.key, el: n.el }));
  if (loose.length) cards.push({ kind: "loose", key: "loose", items: loose });
  return cards;
}

/** A folded frame's row label: its own title, else the name Scribe gives a theme's notes. */
export function foldLabel(g: Pick<ColumnGroup, "title" | "ref" | "count">, topLevel: boolean): string {
  const name = !topLevel && g.title ? g.title : "Working notes";
  return `${name} (${g.count})`;
}
