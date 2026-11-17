// Live data on published pages, CLI half: reading a bundle's cast-data.json
// into the publish payload, and `cast publish data` (the owner's queries,
// their audit text and current rows, so an agent can verify a dashboard).

import * as fs from "node:fs";
import * as path from "node:path";
import { PAGE_DATA_FILE, parsePageDataDeclaration } from "@codecast/shared/contracts/pageData";
import { fmt } from "./colors.js";
import { callerSession } from "./publishWatch.js";
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

/** A single-file page's declaration: the same JSON as cast-data.json, in a <script type="application/cast-data+json"> the browser never runs. */
export function readInlinePageData(html: string): unknown | null {
  const m = html.match(/<script[^>]*\btype\s*=\s*["']application\/cast-data\+json["'][^>]*>([\s\S]*?)<\/script>/i);
  if (!m) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(m[1]);
  } catch (e) {
    throw new Error(`The page's cast-data script is not valid JSON: ${e instanceof Error ? e.message : String(e)}`);
  }
  const parsed = parsePageDataDeclaration(raw);
  if (!parsed.ok) throw new Error(`The page's cast-data script: ${parsed.error}`);
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
    if (q.call) console.log(fmt.muted(`  call: ${q.call.reader} ${JSON.stringify(q.call.args)} in ${q.call.workspace}`));
    if (q.cost) console.log(fmt.muted(`  read: ${q.cost.pages} page${q.cost.pages === 1 ? "" : "s"}, ${q.cost.scanned} documents, ${q.cost.ms} ms`));
    if (q.columns.length) for (const l of formatRows(q.columns, q.rows)) console.log(`  ${l}`);
  }
}

export type StateWrite = { op: "set" | "insert" | "patch" | "delete" | "clear"; key?: string; value_json?: string };

/** "key=<json>" → key and JSON text, the JSON checked here so a typo fails before the network. */
export function parseKeyValue(arg: string, flag: string): { key: string; value_json: string } {
  const at = arg.indexOf("=");
  if (at <= 0) throw new Error(`${flag} takes key=<json>, e.g. ${flag} total=42`);
  return { key: arg.slice(0, at), value_json: jsonText(arg.slice(at + 1), flag) };
}

export function jsonText(text: string, flag: string): string {
  try {
    JSON.parse(text);
  } catch {
    throw new Error(`${flag}: ${JSON.stringify(text)} is not JSON (quote strings: '"hello"')`);
  }
  return text;
}

/** `cast publish state <target> [collection]`: the page's collections and their rows, after one optional write. */
export async function runPublishState(deps: PublishDeps, target: string, collection: string | undefined, write: StateWrite | null, opts: { json: boolean }): Promise<void> {
  const abs = fs.existsSync(target) ? path.resolve(target) : target;
  const result = await apiPost(deps, "/cli/artifacts/state", {
    target: abs,
    ...(collection ? { collection } : {}),
    ...(write ? { ...write, ...callerSession() } : {}),
  });
  if (opts.json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  const collections: any[] = result.collections ?? [];
  console.log(`${fmt.highlight(result.title)} ${fmt.muted(`(${result.slug})`)}`);
  if (result.wrote) console.log(fmt.muted(`  wrote ${result.wrote.cleared !== undefined ? `${result.wrote.cleared} rows cleared` : result.wrote.key}`));
  if (!collections.length) {
    console.log(fmt.muted(`  No state. Declare collections under "state" in ${PAGE_DATA_FILE} (cast guide publish, Page state).`));
    return;
  }
  for (const c of collections) {
    console.log(`\n${fmt.accent(c.id)}  ${fmt.muted(`read ${c.read} · write ${c.write}${c.own ? " · own rows" : ""} · ${c.rows.length} rows · ${Math.round(c.bytes / 1024)} KB`)}`);
    const shown = c.rows.slice(-15);
    if (c.can_read === false) console.log(fmt.muted(`  not readable by your account`));
    for (const r of shown) {
      const value = r.value_json.length > 100 ? `${r.value_json.slice(0, 100)}…` : r.value_json;
      const who = r.agent ? `session ${r.agent.session}` : r.by ? r.by.name : "anonymous";
      console.log(`  ${r.key}  ${value}  ${fmt.muted(who)}`);
    }
    if (c.rows.length > shown.length) console.log(fmt.muted(`  … ${c.rows.length - shown.length} earlier rows (--json for all)`));
  }
  const watches: any[] = result.watches ?? [];
  const agents = result.agents ?? { watching: 0, working: 0 };
  console.log("");
  if (!agents.watching) console.log(fmt.muted(`  No session watches this page. cast publish watch ${result.slug} wakes this one on each change.`));
  for (const w of watches) console.log(`  ${fmt.accent(w.trigger)} watching${w.collections ? ` ${w.collections.join(", ")}` : ""} ${fmt.muted(`${w.session ? `from session ${w.session}${w.session_title ? ` (${w.session_title})` : ""}` : "in fresh sessions"} · ${w.status}`)}`);
  if (agents.watching > watches.length) console.log(fmt.muted(`  ${agents.watching - watches.length} other watch${agents.watching - watches.length === 1 ? "" : "es"} by teammates`));
}
