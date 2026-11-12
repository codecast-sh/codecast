// Reading a block's fields defensively: anyone can write an element, so the
// evaluators coerce each field to the shape they expect before using it.

const TEXT_FIELDS = ["field", "label", "compare", "good", "x", "y", "series", "columns", "sort", "chart", "agg", "format", "group"] as const;

/**
 * A block as the evaluators read it. Anyone can write an element (an agent's
 * raw `apply`, an older client), so a field of the wrong shape is coerced, never
 * trusted: a list becomes "a,b", a number its text, an object nothing. One
 * badly written block must not take down a page of good ones.
 */
export function shaped<T extends object>(block: T): T {
  const b = block as Record<string, unknown>;
  let out: Record<string, unknown> | null = null;
  for (const f of TEXT_FIELDS) {
    const v = b[f];
    if (v === undefined || v === null || typeof v === "string") continue;
    out ??= { ...b };
    out[f] = Array.isArray(v) ? v.map(String).join(",") : typeof v === "number" || typeof v === "boolean" ? String(v) : undefined;
  }
  if (b.limit !== undefined && typeof b.limit !== "number") {
    out ??= { ...b };
    const n = Number(b.limit);
    out.limit = Number.isFinite(n) && n > 0 ? n : undefined;
  }
  if (b.where !== undefined && (typeof b.where !== "object" || b.where === null || Array.isArray(b.where))) {
    out ??= { ...b };
    out.where = undefined;
  }
  return (out ?? b) as T;
}

