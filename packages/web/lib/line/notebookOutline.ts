// The Notebook's outline of a line (line-workspace.md LW1): the steps a
// person reads (agents and people) down a spine, the scripts between them
// folded into the step they follow, and where each step sends work once the
// scripts in between are walked through. Pure, over the one model; the
// layout gives every row a fixed place so the outline's loops can be drawn
// without measuring the page.
import type { LineModel, StepKind } from "./lineModel";

export type OutlineFlow = {
  kind: "next" | "loop" | "end";
  to: string;
  toLabel: string;
  /** The branch in words; null for a plain hand-on. */
  words: string | null;
  does: string | null;
  /** Runs that went this way: the fewest that crossed any hop on the way. */
  count: number;
};

export type NotebookOutline = {
  /** The steps a person reads, in reading order. */
  main: string[];
  /** The scripts after each main step ("__in": before the first), in reading order. */
  segs: Record<string, string[]>;
  /** The main step whose segment holds a script. */
  ownerOf: Record<string, string>;
  /** Where each main step sends work, scripts walked through. */
  flows: Record<string, OutlineFlow[]>;
  scripts: number;
};

export const OUTLINE_IN = "__in";
const isMainKind = (k: StepKind) => k === "agent" || k === "person";

export function notebookOutline(model: LineModel): NotebookOutline {
  const kind = (id: string) => model.steps[id]?.kind ?? "end";
  const readable = model.order.filter((id) => kind(id) !== "end");
  let main = readable.filter((id) => isMainKind(kind(id)));
  // A line of scripts only: every step is read.
  if (!main.length) main = readable;
  const mainSet = new Set(main);

  const segs: Record<string, string[]> = { [OUTLINE_IN]: [] };
  const ownerOf: Record<string, string> = {};
  let cur = OUTLINE_IN;
  for (const id of readable) {
    if (mainSet.has(id)) { cur = id; segs[id] = []; continue; }
    segs[cur].push(id);
    ownerOf[id] = cur;
  }

  const out = new Map<string, typeof model.graph.edges>();
  for (const e of model.graph.edges) out.set(e.from, [...(out.get(e.from) ?? []), e]);
  const at = new Map(main.map((id, i) => [id, i]));

  const flows: Record<string, OutlineFlow[]> = {};
  for (const m of main) {
    const found = new Map<string, OutlineFlow>();
    const seen = new Set<string>([m]);
    const walk = (from: string, first: (typeof model.graph.edges)[number] | null, min: number) => {
      for (const e of out.get(from) ?? []) {
        const lead = first ?? e;
        const count = Math.min(min, e.count);
        const words = lead.gate ? lead.words : e.words ?? lead.words;
        const t = e.to;
        let k: OutlineFlow["kind"] | null = null;
        if (kind(t) === "end") k = "end";
        else if (mainSet.has(t)) k = (at.get(t) ?? 0) <= (at.get(m) ?? 0) ? "loop" : "next";
        if (k) {
          const key = `${k}|${t}|${words ?? ""}`;
          const had = found.get(key);
          if (!had || had.count < count) found.set(key, { kind: k, to: t, toLabel: model.steps[t]?.label ?? t, words, does: lead.does, count });
          continue;
        }
        if (seen.has(t)) continue;
        seen.add(t);
        walk(t, lead, count);
      }
    };
    walk(m, null, Number.POSITIVE_INFINITY);
    const order = { next: 0, loop: 1, end: 2 } as const;
    flows[m] = [...found.values()].sort((a, b) => order[a.kind] - order[b.kind] || b.count - a.count);
  }

  return { main, segs, ownerOf, flows, scripts: readable.length - main.length };
}

// ── layout: every row's place down the spine ─────────────────────────────────

export type OutlineRow =
  | { t: "cap"; y: number; label: string; end?: boolean }
  | { t: "half"; y: number; label: string }
  | { t: "node"; y: number; id: string }
  | { t: "seg"; y: number; key: string; ids: string[] }
  | { t: "script"; y: number; id: string; seg: string; first: boolean };

export type OutlineLoop = { from: string; to: string; fromY: number; toY: number; lane: number; words: string[] };

/** Row heights, in px: the outline's CSS sizes rows to match. */
export const OUTLINE_ROW = { cap: 24, half: 30, node: 50, seg: 34, script: 24, gap: 26 } as const;

/**
 * Every row's centre down the spine, the halves (Diagnose, Fix) as headings,
 * a segment of scripts folded to one row unless it is open, and each loop
 * back to an earlier step in its own lane, the shortest nearest the spine.
 */
export function outlineLayout(model: LineModel, o: NotebookOutline, open: ReadonlySet<string>, all: boolean, ends: { start: string; end: string }) {
  const rows: OutlineRow[] = [];
  let y = 0;
  const seg = (key: string) => {
    const list = o.segs[key] ?? [];
    if (!list.length) { if (key !== OUTLINE_IN) y += OUTLINE_ROW.gap; return; }
    if (all || open.has(key)) {
      y += 6;
      list.forEach((id, i) => { rows.push({ t: "script", y: y + OUTLINE_ROW.script / 2, id, seg: key, first: i === 0 }); y += OUTLINE_ROW.script; });
      y += 6;
    } else {
      rows.push({ t: "seg", y: y + OUTLINE_ROW.seg / 2, key, ids: list });
      y += OUTLINE_ROW.seg;
    }
  };
  rows.push({ t: "cap", y: y + 10, label: ends.start });
  y += OUTLINE_ROW.cap;
  seg(OUTLINE_IN);
  let half: string | null = null;
  for (const id of o.main) {
    const h = model.steps[id]?.half ?? null;
    if (h !== half) {
      if (half) y += 8;
      rows.push({ t: "half", y: y + 12, label: model.graph.halves.find((x) => x.key === h)?.label ?? "" });
      y += OUTLINE_ROW.half;
      half = h;
    }
    rows.push({ t: "node", y: y + OUTLINE_ROW.node / 2, id });
    y += OUTLINE_ROW.node;
    seg(id);
  }
  rows.push({ t: "cap", y: y + 10, label: ends.end, end: true });
  y += 30;

  const yOf = new Map<string, number>();
  for (const r of rows) if (r.t === "node" || r.t === "script") yOf.set(r.id, r.y);
  const merged = new Map<string, { from: string; to: string; words: Set<string> }>();
  for (const m of o.main) {
    for (const f of o.flows[m] ?? []) {
      if (f.kind !== "loop") continue;
      const k = `${m}>${f.to}`;
      const had = merged.get(k) ?? { from: m, to: f.to, words: new Set<string>() };
      if (f.words) had.words.add(f.words);
      merged.set(k, had);
    }
  }
  const lanes: Array<Array<[number, number]>> = [];
  const loops: OutlineLoop[] = [...merged.values()]
    .map((l) => ({ ...l, fromY: yOf.get(l.from) ?? 0, toY: yOf.get(l.to) ?? 0 }))
    .sort((a, b) => Math.abs(a.fromY - a.toY) - Math.abs(b.fromY - b.toY))
    .map((l) => {
      const lo = Math.min(l.fromY, l.toY);
      const hi = Math.max(l.fromY, l.toY);
      let lane = 0;
      while ((lanes[lane] ?? []).some(([a, b]) => !(hi < a - 4 || lo > b + 4))) lane++;
      (lanes[lane] ??= []).push([lo, hi]);
      return { from: l.from, to: l.to, fromY: l.fromY, toY: l.toY, lane, words: [...l.words] };
    });
  return { rows, loops, height: y + 10 };
}
