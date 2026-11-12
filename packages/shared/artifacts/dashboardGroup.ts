// A table grouped by one column: one row per value, every number column
// summed, and how many source rows each group holds. "Sessions by person"
// reads as one row per person, not ninety person-days.
import type { DataResult } from "./dashboardData";

/** The rows (by index) grouped by `by`: a new result whose rows are the groups, largest first by row count. */
export function groupRows(result: DataResult, rows: readonly number[], by: string): { result: DataResult; groups: number[][] } | { problem: string } {
  const gi = result.columns.indexOf(by);
  if (gi < 0) return { problem: `the source has no column "${by}" to group by (it has ${result.columns.join(", ") || "none"})` };
  const numeric = result.columns.map((_, i) => i !== gi && rows.some((r) => typeof result.rows[r][i] === "number"));
  const order: string[] = [];
  const members = new Map<string, number[]>();
  for (const r of rows) {
    const k = String(result.rows[r][gi] ?? "(none)");
    if (!members.has(k)) {
      members.set(k, []);
      order.push(k);
    }
    members.get(k)!.push(r);
  }
  const columns = [by, ...result.columns.filter((_, i) => numeric[i]), "rows"];
  const groups = order.map((k) => members.get(k)!);
  const out = groups.map((g, n) => [
    order[n],
    ...result.columns.flatMap((_, i) => (numeric[i] ? [Math.round(g.reduce((a, r) => a + (typeof result.rows[r][i] === "number" ? (result.rows[r][i] as number) : 0), 0) * 1e6) / 1e6] : [])),
    g.length,
  ]);
  return { result: { ...result, columns, rows: out }, groups };
}

// ── sheets as a source ──

type Cell = number | string | boolean | null;
// A sheet range's evaluated values come from the Sheets engine (readSheetRange in ./sheet).

/** Values as a table: the first row names the columns, or columns are A, B, C. */
export function sheetTable(values: Cell[][], header: boolean, firstCol = 1): { columns: string[]; rows: Cell[][] } {
  const width = Math.max(0, ...values.map((r) => r.length));
  const letters = (i: number) => {
    let s = "";
    for (let n = i; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
    return s;
  };
  if (!header || !values.length) return { columns: Array.from({ length: width }, (_, i) => letters(firstCol + i)), rows: values };
  const taken = new Set<string>();
  const columns = Array.from({ length: width }, (_, i) => {
    const base = String(values[0][i] ?? "").trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "") || letters(firstCol + i).toLowerCase();
    let name = base;
    for (let n = 2; taken.has(name); n++) name = `${base}_${n}`;
    taken.add(name);
    return name;
  });
  return { columns, rows: values.slice(1) };
}
