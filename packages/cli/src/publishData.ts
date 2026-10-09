// Live data on published pages, CLI half: reading a bundle's cast-data.json
// into the publish payload, and `cast publish data` (the owner's queries,
// their audit text and current rows, so an agent can verify a dashboard).

import * as fs from "node:fs";
import * as path from "node:path";
import { PAGE_DATA_FILE, parsePageDataDeclaration } from "@codecast/shared/contracts/pageData";
import { fmt } from "./colors.js";
import { apiPost, type PublishDeps } from "./castApi.js";

/** The bundle's declaration as sent to the server, or null without one. Throws on a file the publisher must fix. */
export function readPageData(dir: string): unknown | null {
  const file = path.join(dir, PAGE_DATA_FILE);
  if (!fs.existsSync(file)) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(file, "utf-8"));
  } catch (e) {
    throw new Error(`${PAGE_DATA_FILE} is not valid JSON: ${e instanceof Error ? e.message : String(e)}`);
  }
  const parsed = parsePageDataDeclaration(raw);
  if (!parsed.ok) throw new Error(`${PAGE_DATA_FILE}: ${parsed.error}`);
  return raw;
}

function ago(ms: number): string {
  if (!ms) return "never";
  const s = Math.max(0, (Date.now() - ms) / 1000);
  if (s < 60) return `${Math.round(s)}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

const every = (ms: number) => (ms % 86_400_000 === 0 ? `${ms / 86_400_000}d` : ms % 3_600_000 === 0 ? `${ms / 3_600_000}h` : `${Math.round(ms / 60_000)}m`);

/** Rows as aligned text, the first `max` of them. */
export function formatRows(columns: string[], rows: unknown[][], max = 15): string[] {
  const shown = rows.slice(0, max).map((r) => r.map((c) => (c === null || c === undefined ? "" : String(c))));
  const widths = columns.map((c, i) => Math.min(40, Math.max(c.length, ...shown.map((r) => (r[i] ?? "").length))));
  const line = (cells: string[]) => cells.map((c, i) => c.slice(0, 40).padEnd(widths[i])).join("  ").trimEnd();
  const out = [line(columns), ...shown.map(line)];
  if (rows.length > max) out.push(`… ${rows.length - max} more rows (--json for all)`);
  return out;
}

export async function runPublishData(deps: PublishDeps, target: string, queryId: string | undefined, opts: { refresh: boolean; json: boolean }): Promise<void> {
  const abs = fs.existsSync(target) ? path.resolve(target) : target;
  const result = await apiPost(deps, "/cli/artifacts/data", { target: abs, ...(queryId ? { query_id: queryId } : {}), ...(opts.refresh ? { refresh: true } : {}) });
  if (opts.json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  const queries: any[] = result.queries ?? [];
  console.log(`${fmt.highlight(result.title)} ${fmt.muted(`(${result.slug})`)}`);
  if (!queries.length) {
    console.log(fmt.muted(`  No live queries. Add ${PAGE_DATA_FILE} at the bundle root (cast guide publish, Dashboards).`));
    return;
  }
  console.log(fmt.muted(`  workspace ${result.workspace}`));
  for (const q of queries) {
    const state = q.error ? fmt.error(`error: ${q.error}`) : q.refreshing ? "refreshing" : q.stale ? "stale" : "fresh";
    console.log(`\n${fmt.accent(q.id)}  ${q.reader}${q.title ? ` · ${q.title}` : ""}  ${fmt.muted(`refreshed ${ago(q.refreshed_at)} · every ${every(q.refresh_ms)} · ${q.rows.length} rows`)}  ${state}`);
    console.log(fmt.muted(`  ${q.query_text}`));
    if (q.columns.length) for (const l of formatRows(q.columns, q.rows)) console.log(`  ${l}`);
  }
}
