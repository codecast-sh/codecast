// The rules a range carries, as ops: what it accepts (dropdowns, dates),
// its conditional colors, and which of its columns and rows are hidden. The
// CLI verbs and the web view both write through these.
import type { ArtifactOp, Json } from "../core";
import { newElementKey } from "../spec";
import { parseLiteral } from "./values";
import { colKey, parseKey, rectA1, rowKey, type Rect } from "./refs";
import { validationAt, type CondRule, type SheetModel } from "./model";

/** Hide or show columns or rows: `hidden` on their col:/row: element, which keeps any size it had. */
export function hideOps(model: SheetModel, tabId: string, axis: "col" | "row", indices: number[], hide: boolean): ArtifactOp[] {
  const t = model.byId.get(tabId);
  const ops: ArtifactOp[] = [];
  for (const i of indices) {
    const k = axis === "col" ? colKey(tabId, i) : rowKey(tabId, i);
    const sized = axis === "col" ? t?.colWidths.has(i) : t?.rowHeights.has(i);
    const isHidden = !!(axis === "col" ? t?.hiddenCols : t?.hiddenRows)?.has(i);
    if (hide && !isHidden) ops.push(sized ? { k, set: { hidden: true } } : { k, put: { kind: axis, hidden: true } });
    else if (!hide && isHidden) ops.push(sized ? { k, set: { hidden: null } } : { k, del: true });
  }
  return ops;
}

/**
 * Set what a range accepts: a list (with chip colors) or a date, replacing a
 * validation on exactly that range; rule null removes every validation the
 * range covers. The CLI verb and the web editor both write through this.
 */
export function validationOps(model: SheetModel, tabId: string, rect: Rect, rule: "list" | "date" | null, options: Array<{ v: string; color?: string }> = [], strict = false): ArtifactOp[] {
  const range = rectA1(rect);
  const mine = model.validations.filter((v) => v.tab === tabId);
  if (rule === null) {
    const inside = (r: Rect) => r.c0 >= rect.c0 && r.c1 <= rect.c1 && r.r0 >= rect.r0 && r.r1 <= rect.r1;
    return mine.filter((v) => inside(v.rect) || rectA1(v.rect) === range).map((v) => ({ k: v.key, del: true as const }));
  }
  const seen = new Set<string>();
  const opts = options
    .map((o) => ({ v: o.v.trim(), ...(o.color ? { color: o.color } : {}) }))
    .filter((o) => o.v && !seen.has(o.v.toLowerCase()) && seen.add(o.v.toLowerCase()));
  const fields: Record<string, Json> = { kind: "dv", tab: tabId, range, rule };
  if (rule === "list") fields.options = opts as Json;
  if (strict) fields.strict = true;
  const key = mine.find((v) => rectA1(v.rect) === range)?.key ?? newElementKey("dv");
  return [{ k: key, put: fields as { kind: string } & Record<string, Json> }];
}

/** A typed value checked against the cell's validation: the input to write (a list value in its listed case), or why it is refused. */
export function validateInput(v: { rule: "list" | "date"; options: Array<{ v: string }>; strict: boolean } | undefined, input: string): { input: string } | { refuse: string } {
  if (!v || input === "" || input.startsWith("=")) return { input };
  if (v.rule === "list") {
    const hit = v.options.find((o) => o.v.toLowerCase() === input.trim().toLowerCase());
    if (hit) return { input: hit.v };
    return v.strict ? { refuse: `Pick one of: ${v.options.map((o) => o.v).join(", ")}` } : { input };
  }
  const nf = parseLiteral(input).implied?.nf;
  if (nf === "date" || nf === "datetime") return { input };
  return v.strict ? { refuse: "Enter a date, like 2026-11-12" } : { input };
}

/**
 * Hold a batch of writes to what each cell accepts: a value into a strict
 * dropdown or date cell that it refuses is dropped, and a listed value takes
 * its listed case. Paste, fill and typing all pass through this, so no path
 * slips past a strict cell. Returns how many writes were refused.
 */
export function enforceValidation(model: SheetModel, ops: ArtifactOp[]): { ops: ArtifactOp[]; refused: number } {
  if (!model.validations.length) return { ops, refused: 0 };
  let refused = 0;
  const out: ArtifactOp[] = [];
  for (const op of ops) {
    const fields = "put" in op ? op.put : "set" in op ? op.set : null;
    const k = fields && typeof fields.input === "string" ? parseKey(op.k) : null;
    const v = k?.type === "cell" ? validationAt(model, k.tab, k.col, k.row) : undefined;
    if (!v || !fields) {
      out.push(op);
      continue;
    }
    const checked = validateInput(v, fields.input as string);
    if ("refuse" in checked) {
      refused++;
      continue;
    }
    out.push(checked.input === fields.input ? op : "put" in op ? { ...op, put: { ...op.put, input: checked.input } } : { ...op, set: { ...(op as { set: Record<string, Json> }).set, input: checked.input } });
  }
  return { ops: out, refused };
}


// ── Conditional colors ──────────────────────────────────────────────────────

export const COND_RULES = ["sign", "scale", "gt", "lt", "eq", "contains", "before", "after"] as const satisfies readonly CondRule[];

/** Rules that compare against a value the person gives. */
export function condTakesValue(rule: CondRule): boolean {
  return rule === "gt" || rule === "lt" || rule === "eq" || rule === "contains" || rule === "before" || rule === "after";
}

/** How a rule reads in a list: "Value > 100", "Text contains Rejected", "Date before today". */
export function condLabel(c: { rule: CondRule; value?: string | number }): string {
  const v = c.value ?? "";
  switch (c.rule) {
    case "sign": return "Gains green, losses red";
    case "scale": return "Color scale";
    case "gt": return `Value > ${v}`;
    case "lt": return `Value < ${v}`;
    case "eq": return `Is ${v}`;
    case "contains": return `Text contains ${v}`;
    case "before": return `Date before ${v}`;
    case "after": return `Date after ${v}`;
  }
}

/**
 * A conditional color on a range. Rules stack on one range (Offer green and
 * Rejected gray on a Stage column); the same rule with the same value restyles
 * in place. `key` edits a given rule. The CLI verb and the web rules panel both
 * write through this.
 */
export function condOps(model: SheetModel, tabId: string, rect: Rect, rule: CondRule, value?: string | number, color?: string, key?: string): ArtifactOp[] {
  const range = rectA1(rect);
  const fields: Record<string, Json> = { kind: "cf", tab: tabId, range, rule };
  if (condTakesValue(rule)) {
    if (value === undefined || value === "") throw new Error(`${rule} needs a value`);
    fields.value = rule === "contains" || rule === "before" || rule === "after" || Number.isNaN(Number(value)) ? String(value) : Number(value);
  }
  if (color) fields.color = color;
  const same = key ?? model.conds.find((c) => c.tab === tabId && rectA1(c.rect) === range && c.rule === rule && String(c.value ?? "") === String(fields.value ?? ""))?.key;
  return [{ k: same ?? newElementKey("cf"), put: fields as { kind: string } & Record<string, Json> }];
}

// ── Merged cells ────────────────────────────────────────────────────────────

/**
 * Merge a range into one cell (replacing merges it overlaps). Like Sheets and
 * Excel, only the top-left value is kept: the others are cleared, so what the
 * sheet shows is what its formulas count. `dropped` says how many went.
 */
export function mergeOps(model: SheetModel, tabId: string, rect: Rect): ArtifactOp[] & { dropped?: number } {
  const overlapping = model.merges.filter((m) => m.tab === tabId && m.rect.c0 <= rect.c1 && m.rect.c1 >= rect.c0 && m.rect.r0 <= rect.r1 && m.rect.r1 >= rect.r0);
  const ops: ArtifactOp[] & { dropped?: number } = overlapping.map((m) => ({ k: m.key, del: true as const }));
  if (rect.c0 === rect.c1 && rect.r0 === rect.r1) return ops;
  let dropped = 0;
  for (const [n, el] of model.byId.get(tabId)?.cells ?? []) {
    const col = n % 32768, row = Math.floor(n / 32768);
    if (col < rect.c0 || col > rect.c1 || row < rect.r0 || row > rect.r1 || (col === rect.c0 && row === rect.r0)) continue;
    if (typeof el.input !== "string" || el.input === "") continue;
    ops.push({ k: el.key, set: { input: null } });
    dropped++;
  }
  ops.push({ k: newElementKey("mg"), put: { kind: "merge", tab: tabId, range: rectA1(rect) } });
  ops.dropped = dropped;
  return ops;
}

/** Undo the merges a range touches. */
export function unmergeOps(model: SheetModel, tabId: string, rect: Rect): ArtifactOp[] {
  return model.merges.filter((m) => m.tab === tabId && m.rect.c0 <= rect.c1 && m.rect.c1 >= rect.c0 && m.rect.r0 <= rect.r1 && m.rect.r1 >= rect.r0).map((m) => ({ k: m.key, del: true as const }));
}

/** A selection grown to whole merges, so it never cuts one in half. */
export function expandToMerges(model: SheetModel, tabId: string, rect: Rect): Rect {
  const r = { ...rect };
  for (let pass = 0; pass < 4; pass++) {
    let grew = false;
    for (const m of model.merges) {
      if (m.tab !== tabId || m.rect.c0 > r.c1 || m.rect.c1 < r.c0 || m.rect.r0 > r.r1 || m.rect.r1 < r.r0) continue;
      if (m.rect.c0 < r.c0 || m.rect.c1 > r.c1 || m.rect.r0 < r.r0 || m.rect.r1 > r.r1) {
        r.c0 = Math.min(r.c0, m.rect.c0); r.c1 = Math.max(r.c1, m.rect.c1); r.r0 = Math.min(r.r0, m.rect.r0); r.r1 = Math.max(r.r1, m.rect.r1);
        grew = true;
      }
    }
    if (!grew) break;
  }
  return r;
}
