// The team's flow library as a tree (docs/architecture/flows.md, the library
// model of Oct 23): the spine on top (the flow the team's live flow runs),
// each variant under the flow it extends with only what it changes, and the
// segments flows are built from as a shelf. A variant names its base with
// `extends="<file>.cast"` in its graph (a file-pushed variant) or the row's
// `variant_of` (a flow saved from a session). Pure: no store, no React.
import { flowGraphAttr, segmentTopOf } from "@codecast/shared/contracts/flowPool";
import { pushedFlow, type AppFlow, type PushedFlowRow } from "./flowPool";

/** A workflows row as the library reads it: the pool's fields, and what a variant's changes are read from. */
export type LibraryRow = PushedFlowRow & {
  label?: string | null;
  variant_of?: string | null;
  serves?: ReadonlyArray<string> | null;
  goal?: string | null;
  updated_at?: number;
  nodes: ReadonlyArray<PushedFlowRow["nodes"][number] & Record<string, unknown>>;
};

/** A station a variant adds, removes or changes, by id and the name people read. */
export type LibraryStep = { id: string; label: string };

/** What a variant changes against its base: stations added, removed and changed (with which of their fields), and the
 *  sources it serves when they differ. Empty lists when it changes nothing of that kind. */
export type VariantChange = {
  added: LibraryStep[];
  removed: LibraryStep[];
  changed: Array<LibraryStep & { what: string[] }>;
  serves: string[] | null;
};

export type LibraryEntry = {
  flow: AppFlow;
  /** The flow it extends, by slug; null for a root. */
  base: string | null;
  /** The flow the team's live flow runs. */
  spine: boolean;
  /** Against its base; null for a root, or when the base's stations are not held. */
  change: VariantChange | null;
  variants: LibraryEntry[];
};

export type FlowLibrary = { lines: LibraryEntry[]; segments: AppFlow[] };

/** The flow a row extends, by slug: its `variant_of`, else its graph's `extends` file without its folder or `.cast`. */
export function flowBaseOf(row: Pick<LibraryRow, "source"> & { variant_of?: string | null }): string | null {
  if (row.variant_of) return row.variant_of;
  const ext = flowGraphAttr(row.source, "extends");
  return ext ? ext.replace(/^.*\//, "").replace(/\.cast$/, "") : null;
}

/** A station's fields that say what it does; its id, name and drawing are not a change. */
const SAME = new Set(["id", "label", "shape", "type"]);
/** The words a changed field reads as. */
const FIELD_WORDS: Record<string, string> = { prompt: "prompt", script: "script", timeout: "time limit", max_visits: "visits", model: "model", backend: "agent" };


/** A station people read as a step: not the graph's start or one of its ends. */
const isStep = (n: Record<string, unknown>) => n.type !== "start" && n.type !== "exit";

/** What `variant` changes against `base`, station by station, and the sources it serves when they differ. */
export function variantChange(base: Pick<LibraryRow, "nodes" | "serves">, variant: Pick<LibraryRow, "nodes" | "serves">): VariantChange {
  const before = new Map(base.nodes.map((n) => [n.id, n as Record<string, unknown> & { id: string; label: string }]));
  const after = new Map(variant.nodes.map((n) => [n.id, n as Record<string, unknown> & { id: string; label: string }]));
  // A name several stations share ("Failed" on every failed_at_*) reads by the station's id instead.
  const shared = new Set<string>();
  const seen = new Set<string>();
  for (const n of [...base.nodes, ...variant.nodes.filter((x) => !before.has(x.id))]) { if (seen.has(n.label)) shared.add(n.label); seen.add(n.label); }
  const step = (n: { id: string; label: string }): LibraryStep => ({ id: n.id, label: n.label && !shared.has(n.label) ? n.label : n.id.replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase()) });
  const changed: VariantChange["changed"] = [];
  // A segment's own stations (check__verify) are the segment's: any of them added, removed or changed reads as the
  // segment's steps changing, under the segment's name.
  const inner = (id: string) => segmentTopOf(id) !== id;
  const segments = new Set<string>();
  for (const id of new Set([...before.keys(), ...after.keys()])) {
    if (!inner(id)) continue;
    const b = before.get(id);
    const n = after.get(id);
    if (!b || !n || JSON.stringify({ ...b, label: 0 }) !== JSON.stringify({ ...n, label: 0 })) segments.add(segmentTopOf(id));
  }
  for (const [id, n] of after) {
    const b = before.get(id);
    if (!b || inner(id)) continue;
    const what = [...new Set([...Object.keys(b), ...Object.keys(n)])]
      .filter((k) => !SAME.has(k) && JSON.stringify(b[k]) !== JSON.stringify(n[k]))
      .map((k) => FIELD_WORDS[k] ?? k.replace(/_/g, " "));
    if (segments.has(id)) what.push("steps");
    if (what.length) changed.push({ ...step(n), what });
  }
  const serves = [...(variant.serves ?? [])];
  const baseServes = [...(base.serves ?? [])];
  return {
    added: [...after.values()].filter((n) => !before.has(n.id) && isStep(n) && !inner(n.id)).map(step),
    removed: [...before.values()].filter((n) => !after.has(n.id) && isStep(n) && !inner(n.id)).map(step),
    changed,
    serves: serves.join(" ") !== baseServes.join(" ") ? serves : null,
  };
}

/** Whether a change has anything to show. */
export const changesAnything = (c: VariantChange | null): boolean => !!c && (c.added.length + c.removed.length + c.changed.length > 0 || !!c.serves);

/**
 * The library: every line of the pool, the spine (the live flow's flow, whatever its row says it is) and every row
 * that extends a flow already in it, as a tree; then the pool's segments. The spine leads, then the roots by name;
 * variants by name under their base. `rows` is newest first, so the first row of a slug is the one read.
 */
export function flowLibrary(pool: ReadonlyArray<AppFlow>, rows: ReadonlyArray<LibraryRow>, spine: { slug?: string | null; id?: string | null } | null): FlowLibrary {
  const rowOf = new Map<string, LibraryRow>();
  for (const r of rows) if (!rowOf.has(r.slug)) rowOf.set(r.slug, r);
  const spineRow = spine ? rows.find((r) => r._id === spine.id) ?? (spine.slug ? rowOf.get(spine.slug) : undefined) : undefined;
  const spineSlug = spineRow?.slug ?? spine?.slug ?? null;
  const flows = new Map<string, AppFlow>(pool.filter((f) => f.kind === "line").map((f) => [f.slug, f]));
  const asFlow = (r: LibraryRow): AppFlow => {
    const f = pushedFlow(r);
    return { ...f, kind: "line", label: r.label?.trim() || f.label };
  };
  if (spineRow) flows.set(spineRow.slug, asFlow(spineRow));
  // Rows that extend a flow in the library join it, and their own variants after them.
  for (let grew = true; grew;) {
    grew = false;
    for (const r of rowOf.values()) {
      const base = flowBaseOf(r);
      // A session's draft is not the library's until it is saved (flowPool publishableFlowSource).
      if (base && flows.has(base) && !flows.has(r.slug) && r.slug !== base && !flowGraphAttr(r.source, "draft")) { flows.set(r.slug, asFlow(r)); grew = true; }
    }
  }
  const entries = new Map<string, LibraryEntry>();
  for (const [slug, flow] of flows) {
    const row = rowOf.get(slug);
    const base = row ? flowBaseOf(row) : null;
    const baseRow = base ? rowOf.get(base) : undefined;
    const inTree = !!base && flows.has(base) && base !== slug;
    entries.set(slug, { flow, base: inTree ? base : null, spine: slug === spineSlug, change: inTree && row && baseRow ? variantChange(baseRow, row) : null, variants: [] });
  }
  const byName = (a: LibraryEntry, b: LibraryEntry) => a.flow.label.localeCompare(b.flow.label);
  for (const e of entries.values()) if (e.base) entries.get(e.base)!.variants.push(e);
  for (const e of entries.values()) e.variants.sort(byName);
  const lines = [...entries.values()].filter((e) => !e.base).sort((a, b) => Number(b.spine) - Number(a.spine) || byName(a, b));
  return { lines, segments: pool.filter((f) => f.kind === "segment") };
}

/** Every flow of the library, the tree walked in order: what a flow's page picks among. */
export function libraryFlows(lib: FlowLibrary): AppFlow[] {
  const out: AppFlow[] = [];
  const walk = (e: LibraryEntry) => { out.push(e.flow); e.variants.forEach(walk); };
  lib.lines.forEach(walk);
  return [...out, ...lib.segments];
}

/** One entry of the library by slug, wherever it sits in the tree. */
export function libraryEntry(lib: FlowLibrary, slug: string | null | undefined): LibraryEntry | null {
  if (!slug) return null;
  const find = (list: ReadonlyArray<LibraryEntry>): LibraryEntry | null => {
    for (const e of list) { if (e.flow.slug === slug) return e; const v = find(e.variants); if (v) return v; }
    return null;
  };
  return find(lib.lines);
}
