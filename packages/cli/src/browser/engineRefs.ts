// The engine's snapshot lines parsed into refs a command can act on, and the
// pure ranking over them. Pure, so testable without a browser.
import { ordinalsFor, refLabel } from "./snapshot.js";

/** One line of the engine's snapshot that carries a ref, parsed for matching.
 *  Flags render as `[expanded=false, ref=e162]` — the ref is not always at the
 *  start of the bracket, so match the pattern, not a "[ref=" prefix (that
 *  prefix filter silently hid every expanded/checked/disabled element). */
const REF_IN_LINE = /[[ ]ref=(e\d+)\]/;

/** One line of an engine snapshot, split into the parts we act on. */
export interface EngineRef {
  line: string;
  ref: string;
  role: string;
  name: string;
  /** Position among same role and name; set only when the name repeats. */
  nth?: number;
}

export function parseEngineRefs(stdout: string): EngineRef[] {
  const items = stdout
    .split("\n")
    .filter((l) => REF_IN_LINE.test(l))
    .map((line) => ({
      line: line.trim(),
      ref: line.match(REF_IN_LINE)?.[1] ?? "",
      role: line.match(/^\s*- (\w+)/)?.[1] ?? "",
      name: line.match(/"([^"]*)"/)?.[1] ?? "",
    }));
  // The engine prints three identical lines for three "Delete" buttons. Their
  // position among the namesakes is the only thing that tells them apart, in
  // the printed snapshot and on a stale-ref recovery (ct-49555).
  const ords = ordinalsFor(items);
  return items.map((it, i) => (ords[i].duplicated ? { ...it, nth: ords[i].nth } : it));
}

/** The engine's snapshot with `(2nd)`, `(3rd)` … on names that repeat. The ref
 *  and the raw name are untouched, so `find "Delete"` still matches all of
 *  them and the suffix is purely what the agent reads. */
export function withOrdinals(stdout: string, items = parseEngineRefs(stdout)): string {
  const labels = new Map<string, string>();
  for (const r of items) {
    const label = refLabel(r);
    if (label !== r.name) labels.set(r.ref, label);
  }
  if (!labels.size) return stdout;
  return stdout
    .split("\n")
    .map((line) => {
      const label = labels.get(line.match(REF_IN_LINE)?.[1] ?? "");
      return label ? line.replace(/"[^"]*"/, JSON.stringify(label)) : line;
    })
    .join("\n");
}

/** Reorder ambiguous matches so on-screen elements come first, given each
 *  ref's box (zero size = hidden: display:none, a kept-alive background tab
 *  pane, a collapsed menu). Pure, so it is testable without a browser. */
export function rankByVisibility<T>(
  hits: T[],
  boxOf: (hit: T) => { width: number; height: number } | null,
): { ordered: T[]; hidden: Set<T> } {
  const hidden = new Set<T>();
  for (const h of hits) {
    const b = boxOf(h);
    if (b && (b.width <= 0 || b.height <= 0)) hidden.add(h);
  }
  return { ordered: [...hits.filter((h) => !hidden.has(h)), ...hits.filter((h) => hidden.has(h))], hidden };
}
