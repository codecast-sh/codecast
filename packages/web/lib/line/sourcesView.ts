// The Sources view's rows (line-workspace.md LW1): every source the line
// hears from, declared or not, as one row of numbers. A product's judges
// (AgentWatch's comms, match, ...) sit under their source as rows of their
// own. Each row counts what it filed, the problems it opened and joined, and
// the process those problems ran. Pure: the view and its tests read this.
import type { LineFinderDecl } from "@codecast/shared/contracts/lineProfile";
import { DAY, WEEK, isUndeclaredSource, type LineSignal } from "../lineFlow";
import { graphTitle, newestGraphByTask, type GraphRun } from "./lineGraphs";
import { knownName } from "./sourceNames";

/** The bars a source's sparkline draws: one a day. */
export const SPARK_DAYS = 14;

export type SourceKind = "judge" | "person" | "lesson" | "errors" | "eval" | "check" | "agent" | "ci" | "app" | "other";

/** One word for each kind, for a tooltip and the detail's header. */
export const KIND_WORDS: Record<SourceKind, string> = {
  judge: "Judge", person: "People", lesson: "Lessons", errors: "Errors", eval: "Evals",
  check: "Checks", agent: "Agents asking", ci: "Code", app: "App", other: "Source",
};

/** What kind of thing a source is, from its name (a judge when it names one). */
export function sourceKind(source: string, judge?: string | null): SourceKind {
  const s = source.toLowerCase();
  if (judge || s === "agentwatch" || s.startsWith("judge")) return "judge";
  if (s === "person") return "person";
  if (s === "lesson") return "lesson";
  if (/error|sentry|crash/.test(s)) return "errors";
  if (/eval/.test(s)) return "eval";
  if (/metric|invariant|guard|posthog|drift/.test(s)) return "check";
  if (/escalat|reply|desk|insight/.test(s)) return "agent";
  if (/github|ci\b|fixloop|promise|deploy/.test(s)) return "ci";
  if (/^app:/.test(s)) return "app";
  return "other";
}

const cap = (w: string) => (w ? w[0].toUpperCase() + w.slice(1) : w);
/** "evalReds" → "Eval reds", "call_eval" → "Call eval". */
export const humanize = (id: string) => cap(id.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/[-_.]+/g, " ").trim().toLowerCase());

/** A source's name as a reader says it: the product's spelling, the finder's own id, else its last part. */
export function sourceName(source: string, finders: ReadonlyArray<Pick<LineFinderDecl, "id">> = []): string {
  const known = knownName(source);
  if (known) return known;
  const s = source.toLowerCase();
  if (s === "person") return "People";
  if (s === "lesson") return "Lessons";
  if (finders.length) return humanize(finders[0].id);
  const prefixed = source.match(/^([\w-]+):(.+)$/);
  if (prefixed) return `${humanize(prefixed[2])} ${prefixed[1].toLowerCase()}`;
  return humanize(source.split(".").pop() || source);
}

export type SourceFinder = LineFinderDecl & { projectId: string; projectTitle: string };
export type SourceSignal = Pick<LineSignal, "_id" | "source" | "kind" | "title" | "created_at" | "task_id"> & Partial<Pick<LineSignal, "short_id" | "detail_md" | "evidence_url" | "observed_at" | "project_id" | "attach" | "judge" | "severity" | "reopened">>;
export type SourceTask = { _id: string; short_id?: string; title: string; status: string };

/** live: filed in the last day. quiet: declared, and nothing in the last day. never: declared, nothing in the window. idle: not declared, nothing in the last day. */
export type SourceState = "live" | "quiet" | "never" | "idle";

export type SourceProcess = { key: string; title: string; problems: number };

export type SourceRow = {
  /** `source`, or `source/judge` for a judge's row ("agentwatch/comms"; "agentwatch/" for findings naming no judge). */
  key: string;
  source: string;
  judge: string | null;
  name: string;
  kind: SourceKind;
  day: number;
  week: number;
  /** Findings in the window the line holds. */
  total: number;
  /** Findings a day over SPARK_DAYS, oldest first. */
  spark: number[];
  newest: number | null;
  /** Problems it opened (its finding started them) and problems it added to. */
  opened: number;
  joined: number;
  /** The process each of its problems' newest run went through, busiest first. */
  processes: SourceProcess[];
  /** Its problems no run has taken yet. */
  notRun: number;
  state: SourceState;
  /** Filed while the project declaring finders does not name it. */
  undeclared: boolean;
  finders: SourceFinder[];
  /** The projects it filed in. */
  projects: string[];
  children: SourceRow[];
};

export type SourcesInput = {
  signals: ReadonlyArray<SourceSignal>;
  /** Every declared finder in view, with the project declaring it. */
  finders: ReadonlyArray<SourceFinder>;
  runs: ReadonlyArray<GraphRun>;
  now: number;
  /** Graph names by key, for a process's title. */
  graphNames?: ReadonlyMap<string, string>;
};

/** Findings a day over the SPARK_DAYS ending now, oldest first. */
export function sparkDays(times: ReadonlyArray<number>, now: number, days = SPARK_DAYS): number[] {
  const out = new Array(days).fill(0);
  const t0 = now - days * DAY;
  for (const t of times) {
    if (t > now || t < t0) continue;
    out[Math.min(days - 1, Math.floor((t - t0) / DAY))]++;
  }
  return out;
}

function rowOf(key: string, source: string, judge: string | null, list: ReadonlyArray<SourceSignal>, finders: SourceFinder[], input: SourcesInput, graphOfTask: Map<string, string>): SourceRow {
  const { now } = input;
  const times = list.map((s) => s.created_at);
  const tasks = new Set<string>();
  const opened = new Set<string>();
  for (const s of list) {
    if (!s.task_id) continue;
    tasks.add(s.task_id);
    if (s.attach === "new") opened.add(s.task_id);
  }
  const byGraph = new Map<string, number>();
  let notRun = 0;
  for (const t of tasks) {
    const g = graphOfTask.get(t);
    if (g) byGraph.set(g, (byGraph.get(g) ?? 0) + 1);
    else notRun++;
  }
  const day = times.filter((t) => t >= now - DAY).length;
  const newest = times.length ? Math.max(...times) : null;
  const declared = finders.length > 0;
  const state: SourceState = day > 0 ? "live" : !declared ? "idle" : newest == null ? "never" : "quiet";
  return {
    key, source, judge,
    name: judge != null ? (judge ? humanize(judge) : "No judge named") : sourceName(source, finders),
    kind: sourceKind(source, judge),
    day,
    week: times.filter((t) => t >= now - WEEK).length,
    total: list.length,
    spark: sparkDays(times, now),
    newest,
    opened: opened.size,
    joined: tasks.size - opened.size,
    processes: [...byGraph].map(([k, problems]) => ({ key: k, title: graphTitle(k, input.graphNames?.get(k)), problems })).sort((a, b) => b.problems - a.problems || a.title.localeCompare(b.title)),
    notRun,
    state,
    undeclared: false,
    finders,
    projects: [...new Set(list.map((s) => s.project_id).filter((p): p is string => !!p))],
    children: [],
  };
}

const STATE_RANK: Record<SourceState, number> = { live: 0, quiet: 1, idle: 2, never: 3 };
const byBusy = (a: SourceRow, b: SourceRow) =>
  STATE_RANK[a.state] - STATE_RANK[b.state] || b.day - a.day || b.week - a.week || (b.newest ?? 0) - (a.newest ?? 0) || a.name.localeCompare(b.name);

/** Every source in view: one row each, a source's judges as its children, the busiest first. */
export function buildSources(input: SourcesInput): SourceRow[] {
  const graphOfTask = newestGraphByTask(input.runs);
  const bySource = new Map<string, { source: string; list: SourceSignal[] }>();
  for (const s of input.signals) {
    const k = s.source.toLowerCase();
    const e = bySource.get(k) ?? { source: s.source, list: [] };
    e.list.push(s);
    bySource.set(k, e);
  }
  const findersBySource = new Map<string, SourceFinder[]>();
  for (const f of input.finders) {
    const k = f.source.toLowerCase();
    findersBySource.set(k, [...(findersBySource.get(k) ?? []), f]);
    if (!bySource.has(k)) bySource.set(k, { source: f.source, list: [] });
  }
  // Undeclared against the projects it filed in: a project that declares finders but not this one.
  const findersByProject = new Map<string, SourceFinder[]>();
  for (const f of input.finders) findersByProject.set(f.projectId, [...(findersByProject.get(f.projectId) ?? []), f]);

  const rows: SourceRow[] = [];
  for (const [k, { source, list }] of bySource) {
    const row = rowOf(source, source, null, list, findersBySource.get(k) ?? [], input, graphOfTask);
    // Declared anywhere in view is declared; otherwise flagged when it filed into a project that declares others.
    row.undeclared = !row.finders.length && row.projects.some((p) => isUndeclaredSource(source, findersByProject.get(p) ?? []));
    const judges = new Map<string, SourceSignal[]>();
    for (const s of list) judges.set(s.judge ?? "", [...(judges.get(s.judge ?? "") ?? []), s]);
    // A source's judges, once its findings split between two or more; findings naming none sit together.
    if (judges.size > 1 && [...judges.keys()].some((j) => j)) {
      row.children = [...judges].map(([j, l]) => {
        const child = rowOf(`${source}/${j}`, source, j, l, [], input, graphOfTask);
        if (child.state === "idle" && row.finders.length) child.state = "quiet";
        return child;
      }).sort((a, b) => (a.judge ? 0 : 1) - (b.judge ? 0 : 1) || byBusy(a, b));
    }
    rows.push(row);
  }
  return rows.sort(byBusy);
}

/** Every row, children after their source: the order the list draws and j/k walks. */
export const flatSources = (rows: ReadonlyArray<SourceRow>): SourceRow[] => rows.flatMap((r) => [r, ...r.children]);

/** The findings a row holds, newest first. */
export function findingsOf<T extends SourceSignal>(signals: ReadonlyArray<T>, row: Pick<SourceRow, "source" | "judge">): T[] {
  const src = row.source.toLowerCase();
  return signals
    .filter((s) => s.source.toLowerCase() === src && (row.judge == null || (s.judge ?? "") === row.judge))
    .sort((a, b) => b.created_at - a.created_at);
}

/** A finding's severity out of 10: its own field, else what its judge wrote ("severity 8/10"). */
export function severityOf(s: Pick<SourceSignal, "severity" | "detail_md">): number | null {
  if (typeof s.severity === "number") return s.severity;
  const m = s.detail_md?.match(/severity\s+(\d+(?:\.\d+)?)\s*\/\s*10/i);
  return m ? Number(m[1]) : null;
}

/** Whether a line says the title again, with or without a lead-in like "Not met:". */
function repeatsTitle(line: string, title: string): boolean {
  const norm = (t: string) => t.toLowerCase().replace(/^[\w ]{1,20}:\s*/, "").slice(0, 40);
  const l = line.toLowerCase();
  return l.startsWith(title.toLowerCase().slice(0, 40)) || norm(l).startsWith(norm(title)) || l.startsWith(norm(title));
}

/** The first lines of a finding's text as plain words, each marked as a quote (the contact's or the agent's own words,
 *  a blockquote in the detail) or the finder's own reading of it: no markdown marks, no fences, no repeat of its title. */
export function detailParts(md: string | undefined, title: string, max = 3): Array<{ text: string; quote: boolean }> {
  if (!md) return [];
  const out: Array<{ text: string; quote: boolean }> = [];
  for (const raw of md.split("\n")) {
    if (/^\s*```/.test(raw)) continue;
    const quote = /^\s*>/.test(raw);
    const line = raw
      .replace(/^\s*(#+|>|[-*]\s)\s*/, "")
      .replace(/\*\*(.+?)\*\*/g, "$1")
      .replace(/`([^`]+)`/g, "$1")
      .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
      .trim();
    if (!line) continue;
    if (!out.length && repeatsTitle(line, title)) continue;
    out.push({ text: quote ? line.replace(/^["“]|["”]$/g, "") : line, quote });
    if (out.length >= max) break;
  }
  return out;
}

/** The first lines of a finding's text as plain words. */
export const detailLines = (md: string | undefined, title: string, max = 3): string[] => detailParts(md, title, max).map((l) => l.text);

/** An evidence link's host, as its link text ("admin.unionmatching.com"). */
export function evidenceHost(url: string | undefined): string | null {
  if (!url) return null;
  try { return new URL(url).host.replace(/^www\./, ""); } catch { return null; }
}

/** The span the line's findings cover: from the oldest held, when the window is cut short by the cap. */
export function heldSince(oldest: number | null, held: number, capCount: number): number | null {
  return held >= capCount && oldest != null ? oldest : null;
}
