// The Sources view's rows (line-workspace.md LW1): every source the line
// hears from, declared or not, as one row of numbers. A product's judges
// (AgentWatch's comms, match, ...) sit under their source as rows of their
// own. Each row counts what it filed, the problems it opened and joined, and
// the process those problems ran. Pure: the view and its tests read this.
import type { LineFinderDecl } from "@codecast/shared/contracts/lineProfile";
import { DAY, WEEK, ageShort, isUndeclaredSource, type LineSignal } from "../lineFlow";
import { CODECAST_LINE, graphTitle, newestGraphByTask, processKeyOf, type GraphRun } from "./lineGraphs";
import { judgeName, knownName, sourceName } from "./sourceNames";

/** The bars a source's sparkline draws: one a day. */
export const SPARK_DAYS = 14;

export type SourceKind = "judge" | "person" | "lesson" | "errors" | "eval" | "check" | "agent" | "ci" | "app" | "other";

/** One word for each kind, for a tooltip and the detail's header. */
export const KIND_WORDS: Record<SourceKind, string> = {
  judge: "Judge", person: "Person", lesson: "Lessons", errors: "Errors", eval: "Evals",
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

export { humanize, sourceName } from "./sourceNames";

export type SourceFinder = LineFinderDecl & { projectId: string; projectTitle: string };
export type SourceSignal = Pick<LineSignal, "_id" | "source" | "kind" | "title" | "created_at" | "task_id"> & Partial<Pick<LineSignal, "short_id" | "detail_md" | "evidence_url" | "observed_at" | "project_id" | "attach" | "judge" | "severity" | "reopened">>;
export type SourceTask = { _id: string; short_id?: string; title: string; status: string };

/**
 * When a finding happened: the time of the conversation it is about, else when it was filed. Every count, bar and
 * row time in Sources reads this, the same clock a problem's timeline uses, so a sync that loads a week of
 * conversations at once never reads as a week's findings in one day.
 */
export const findingAt = (s: Pick<SourceSignal, "created_at" | "observed_at">): number => s.observed_at || s.created_at;

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
  /** When it last filed anything (a finding's load time): shown once, as the source's last sync. */
  synced: number | null;
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
  const times = list.map(findingAt);
  const filed = list.map((s) => s.created_at);
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
  const synced = filed.length ? Math.max(...filed) : null;
  const declared = finders.length > 0;
  // Live is about the source itself: it filed in the last day, whatever day those findings are about.
  const state: SourceState = (synced ?? 0) >= now - DAY ? "live" : !declared ? "idle" : newest == null ? "never" : "quiet";
  return {
    key, source, judge,
    name: judge ? judgeName(sourceName(source), judge) : sourceName(source),
    kind: sourceKind(source, judge),
    day,
    week: times.filter((t) => t >= now - WEEK).length,
    total: list.length,
    spark: sparkDays(times, now),
    newest,
    synced,
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

/** The source key of the row codecast's own judges gather under: each files as `judge:<name>`, one source apiece. */
export const JUDGES_GROUP = "judge:*";
const isGroup = (source: string) => source.endsWith(":*");
/** Whether a finding's (or a problem's) source is one a row holds: its own, or for a group row any source it gathers. */
export const sourceIn = (row: Pick<SourceRow, "source">, source: string): boolean => {
  const want = row.source.toLowerCase();
  const got = source.toLowerCase();
  return isGroup(want) ? got.startsWith(want.slice(0, -1)) : got === want;
};

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
    // A source's judges, once its findings name two or more; findings naming none stay on the source's own row, never a stand-in judge.
    const named = [...judges].filter(([j]) => j);
    if (named.length > 1 || (named.length === 1 && judges.size > 1)) {
      row.children = named.map(([j, l]) => {
        const child = rowOf(`${source}/${j}`, source, j, l, [], input, graphOfTask);
        if (child.state === "idle" && row.finders.length) child.state = "quiet";
        return child;
      }).sort(byBusy);
    }
    rows.push(row);
  }
  // Codecast's own judges file one source apiece ("judge:call", "judge:comms"): two or more read as one "Judges" row
  // with a judge under it each, the way a product's judges sit under their source, never as look-alike sources.
  const judges = rows.filter((r) => r.source.toLowerCase().startsWith("judge:"));
  if (judges.length > 1) {
    const list = judges.flatMap((r) => bySource.get(r.source.toLowerCase())?.list ?? []);
    const group = rowOf(JUDGES_GROUP, JUDGES_GROUP, null, list, judges.flatMap((r) => r.finders), input, graphOfTask);
    group.name = "Codecast judges";
    group.undeclared = judges.every((r) => r.undeclared);
    group.children = judges.map((r) => ({ ...r, children: [] })).sort(byBusy);
    return [...rows.filter((r) => !judges.includes(r)), group].sort(byBusy);
  }
  return rows.sort(byBusy);
}

/** The process a finding belongs to (lineGraphs processIndex): its problem's, else its project's. */
export const findingProcess = (process: { task: (taskId: string | null | undefined, projectId?: string | null) => string; project: (id: string | null | undefined) => string }, f: { task_id?: string | null; project_id?: string | null }) =>
  f.task_id ? process.task(f.task_id, f.project_id) : process.project(f.project_id);

/** Every row, children after their source: the order the list draws and j/k walks. */
export const flatSources = (rows: ReadonlyArray<SourceRow>): SourceRow[] => rows.flatMap((r) => [r, ...r.children]);

/** The finder an address names: by its key ("union.escalation"), else by the name its page shows ("Escalation") or its
 *  key's last part ("escalation"), so a link typed the way a person reads the finder still opens it. */
export function finderNamed<R extends Pick<SourceRow, "key" | "name">>(rows: ReadonlyArray<R>, asked: string | null | undefined, ok: (r: R) => boolean = () => true): R | null {
  const k = asked?.trim().toLowerCase();
  if (!k) return null;
  const by = (match: (r: R) => boolean) => rows.find((r) => match(r) && ok(r)) ?? null;
  return by((r) => r.key === asked) ?? by((r) => r.key.toLowerCase() === k) ?? by((r) => r.name.toLowerCase() === k) ?? by((r) => r.key.toLowerCase().split(/[.:/]/).pop() === k);
}

/** The findings a row holds, newest first. */
export function findingsOf<T extends SourceSignal>(signals: ReadonlyArray<T>, row: Pick<SourceRow, "source" | "judge">): T[] {
  return signals
    .filter((s) => sourceIn(row, s.source) && (row.judge == null || (s.judge ?? "") === row.judge))
    .sort((a, b) => findingAt(b) - findingAt(a));
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

export type FindingFact = { k: string | null; v: string; title: string };

/**
 * A finding's text as structure: the finder's own lines become short facts (a count over a window, "key: value"
 * lines, "this one: an X from A woken by T") and the reporter's own words, a fenced or quoted block, stay prose,
 * whole. A line that is neither stays a note. Its title is never said again.
 */
export function findingFacts(md: string | undefined, title: string): { facts: FindingFact[]; said: string | null; notes: string[] } {
  const facts: FindingFact[] = [];
  const notes: string[] = [];
  const own: string[] = [];
  if (!md) return { facts, said: null, notes };
  let fenced = false;
  for (const raw of md.split("\n")) {
    if (/^\s*```/.test(raw)) { fenced = !fenced; continue; }
    if (fenced) { own.push(raw); continue; }
    const quote = /^\s*>/.test(raw);
    const line = raw.replace(/^\s*(#+|>|[-*]\s)\s*/, "").replace(/\*\*(.+?)\*\*/g, "$1").replace(/`([^`]+)`/g, "$1").replace(/\[([^\]]+)\]\([^)]+\)/g, "$1").trim();
    if (!line) continue;
    if (quote) { own.push(line); continue; }
    if (!facts.length && !notes.length && repeatsTitle(line, title)) continue;
    // The label a finder puts before the reporter's words ("The agent's reason (data, its own words):") is the prose's own heading.
    if (/:$/.test(line) && /\b(reason|words|said|says|quote)\b/i.test(line)) continue;
    let m: RegExpMatchArray | null;
    if ((m = line.match(/^(\d+)\b.*?\blast (\d+) (day|hour|week)s?\b/i))) facts.push({ k: null, v: `${m[1]} in ${m[2]}${m[3][0].toLowerCase()}`, title: line });
    else if ((m = line.match(/^this one:\s*an? ([\w ]+?) from (\S+?)(?: woken by (\S+?))?,/i))) facts.push({ k: m[1].toLowerCase(), v: [m[2], m[3]].filter(Boolean).join(" · "), title: line });
    else if ((m = line.match(/^([A-Z][\w ]{0,14}):\s+(.+?)\.?$/))) facts.push({ k: m[1].toLowerCase(), v: m[2].replace(/,\s*for the problem\b.*$/i, ""), title: line });
    else notes.push(line);
  }
  const said = own.join("\n").trim() || null;
  return { facts, said, notes };
}

/** What a finding says broke, for its row's lead: the judge's short tag when it closes with one ("no referral ask after
 *  non-fit"), else the first sentence of its note ("Quinn replied … but did not ask who else she would want to meet").
 *  Null when the finding carries only its title. */
export function findingBreak(notes: ReadonlyArray<string>): string | null {
  const tag = notes[notes.length - 1];
  if (tag && tag.length <= 60 && !/[.!?]$/.test(tag)) return tag.replace(/^\w/, (c) => c.toUpperCase());
  const first = notes[0];
  if (!first) return null;
  return first.match(/^.+?[.!?](?=\s|$)/)?.[0] ?? first;
}

/** An evidence link's host, as its link text ("admin.unionmatching.com"). */
export function evidenceHost(url: string | undefined): string | null {
  if (!url) return null;
  try { return new URL(url).host.replace(/^www\./, ""); } catch { return null; }
}

/** The span the line's findings cover: from the oldest held, when the window is cut short by the cap. */
export function heldSince(oldest: number | null, held: number, capCount: number): number | null {
  return held >= capCount && oldest != null ? oldest : null;
}

/** When the line holds every finding from (signals.webList: the newest LINE_SIGNAL_CAP of the window): null when it holds
 *  the whole window, else the oldest of the newest `cap` rows filed in it. Read over the workspace's rows, before any
 *  project or process filter, since the cap is the workspace's. */
export function heldFrom(signals: ReadonlyArray<Pick<SourceSignal, "created_at">>, now: number, window: number, cap: number): number | null {
  const filed = signals.map((s) => s.created_at).filter((t) => t >= now - window).sort((a, b) => b - a);
  return heldSince(filed.length ? filed[Math.min(cap, filed.length) - 1] : null, filed.length, cap);
}

/** The window every finder count reads (the Find table, a finder's page and its groups): the last week, or from when the
 *  line holds every finding when that is later. `cut` says the week is not whole, and the label says from when. */
export type FindWindow = { from: number; cut: boolean };

export function findWindow(now: number, held: number | null): FindWindow {
  const week = now - WEEK;
  return held != null && held > week ? { from: held, cut: true } : { from: week, cut: false };
}

/** The window's name on a count's label: "7d", or the span the line holds ("4d", "31h") when the week is cut. */
export function findWindowWords(w: FindWindow, now: number): string {
  return w.cut ? ageShort(now - w.from) : "7d";
}

/** A finding's detail as a person reads it: a machine timestamp ("2026-10-11T20:06:26.549Z") as its age ("3h ago"),
 *  and a dash used as a clause break as a comma. The finder's own words otherwise stay as they are. */
export function readableDetail(md: string, now: number): string {
  return md
    .replace(/\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})\b/g, (iso) => {
      const at = Date.parse(iso);
      return Number.isFinite(at) ? (at <= now ? `${ageShort(now - at)} ago` : new Date(at).toLocaleString()) : iso;
    })
    .replace(/\s+[—–]\s+/g, ", ")
    // A finder's template that wrote "a escalation": the article a reader expects.
    .replace(/\b([Aa]) (?=[aeio](?!ne\b)[a-z])/g, "$1n ");
}

// ── the Find table and a finder's page (line-journeys.md LJ8.5, LJ8.6) ─────

/** A person's mark on a finding (line_labels whose run_id is the finding's id). */
export type FindingMark = { run_id: string; verdict: string };

/** One finder as the Find table lists it: findings in the window, how many reached a problem, and for a judge how
 *  often people marked it wrong. `wrong` is null for a finder whose findings cannot be marked (not a judge). */
/** `name`: the finder's one name (`SourceRow.name`): a judge with its product ("AgentWatch comms judge", "Codecast comms judge"). */
/** `filesHere`: a judge of another product's line, listed on this one only because it files problems here. */
export type FinderRow = { row: SourceRow; name: string; week: number; filed: number; unfiled: number; marked: number; wrong: number | null; filesHere: boolean;
  /** The newest of its Not filed findings, the one its page opens on from the table's Not filed cell. */
  firstUnfiled: string | null };

/** The line a judge belongs to: its product's (codecast's own judges are Codecast's line, "agentwatch/comms" is
 *  AgentWatch's), whichever line its findings are filed into. Null for a finder that is no judge, or a judge of no
 *  product with a line of its own. */
export function judgeLine(source: string, judged: boolean): string | null {
  if (/^judge:/.test(source)) return CODECAST_LINE;
  const key = processKeyOf(source);
  return judged && knownName(key) ? key : null;
}

const NONE: ReadonlySet<string> = new Set();

/** A line's own judges (judgeLine) that filed in the window anywhere, added to `sources` where a project filter left
 *  them out: picking a project narrows a judge's counts, never drops the judge from its own line. `every` is the
 *  sources over every project; `keep` the keys added, so finderRows lists them at the picked project's counts (0). */
export function homeJudges(sources: ReadonlyArray<SourceRow>, every: ReadonlyArray<SourceRow>, everySignals: ReadonlyArray<SourceSignal>, from: number, line: string | null): { sources: SourceRow[]; keep: Set<string> } {
  const keep = new Set<string>();
  if (!line) return { sources: [...sources], keep };
  const have = new Set(flatSources(sources).map((r) => r.key));
  const out = sources.map((r) => ({ ...r, children: [...r.children] }));
  for (const parent of every) {
    const leaves = (parent.children.length ? parent.children : [parent]).filter((leaf) => {
      if (have.has(leaf.key)) return false;
      const list = findingsOf(everySignals, leaf).filter((s) => findingAt(s) >= from);
      return list.length > 0 && judgeLine(leaf.source, leaf.judge != null || list.some((s) => !!s.judge)) === line;
    });
    const mine = out.find((r) => r.key === parent.key);
    // A source the project holds as one row (a single judge) is already its line's row there.
    if (!leaves.length || (mine && !mine.children.length)) continue;
    for (const l of leaves) keep.add(l.key);
    if (!parent.children.length) out.push(parent);
    else if (mine) mine.children.push(...leaves);
    else out.push({ ...parent, children: leaves });
  }
  return { sources: out, keep };
}

/** Whether a finding is one a person can mark wrong: a judge's own finding (FindingReader draws "Judge is wrong" on it). */
export const markable = (s: Pick<SourceSignal, "judge"> & { case_of?: unknown; source?: string }): boolean => !!s.judge || /^judge:/.test(s.source ?? "");

/** The Find table's rows: every finder that filed in the window (each judge of a product its own row, a group row
 *  stands in for none), busiest first. The wrong rate is from marks only: a closing run's word never counts.
 *  `listed` picks which finders the table lists (those that filed into the drawn process `line`, and every judge of that
 *  line's product, judgeLine); each row's figures are always
 *  the finder's whole window, so one finder reads one set of numbers on every process's table and on its page. */
export function finderRows(sources: ReadonlyArray<SourceRow>, signals: ReadonlyArray<SourceSignal & { case_of?: unknown }>, marks: ReadonlyArray<FindingMark>, from: number, listed: (s: SourceSignal) => boolean = () => true, line: string | null = null, keep: ReadonlySet<string> = NONE): FinderRow[] {
  const wrongIds = new Set(marks.filter((m) => m.verdict === "wrong").map((m) => m.run_id));
  const markedIds = new Set(marks.map((m) => m.run_id));
  const out: FinderRow[] = [];
  const leaves = sources.flatMap((r) => (r.children.length ? r.children : [r]));
  for (const row of leaves) {
    const list = findingsOf(signals, row).filter((s) => findingAt(s) >= from);
    // A judge is always on its own product's line (`line`), and on another only where it files.
    const home = judgeLine(row.source, row.judge != null || list.some((s) => !!s.judge));
    // `keep`: this line's own judges, listed under a picked project even with none of their findings in it (homeJudges).
    if (!list.some(listed) && !(line && home === line && list.length) && !keep.has(row.key)) continue;
    const judged = list.filter((s) => markable(s) && !s.case_of);
    out.push({
      row,
      name: row.name,
      week: list.length,
      // Filed and not marked wrong: the finder page's "Filed to a problem" group, so the two read one number.
      filed: list.filter((s) => !!s.task_id && !wrongIds.has(s._id)).length,
      // The finder page's "Not filed" group: what reached no problem and nobody marked wrong.
      unfiled: list.filter((s) => !s.task_id && !wrongIds.has(s._id)).length,
      firstUnfiled: (() => { const u = list.filter((s) => !s.task_id && !wrongIds.has(s._id)).sort((a, b) => findingAt(b) - findingAt(a))[0]; return u ? u.short_id ?? u._id : null; })(),
      marked: judged.filter((s) => markedIds.has(s._id)).length,
      wrong: judged.length ? judged.filter((s) => wrongIds.has(s._id)).length : null,
      filesHere: !!line && !!home && home !== line,
    });
  }
  return out.sort((a, b) => b.week - a.week || a.name.localeCompare(b.name));
}

/** A wrong rate as the table says it: "7% (2 of 28)"; "none marked" when nobody marked any. */
export function wrongRateWords(r: Pick<FinderRow, "wrong" | "week">): string | null {
  if (r.wrong == null) return null;
  if (!r.wrong) return "none marked wrong";
  return `${Math.round((r.wrong / r.week) * 100)}% (${r.wrong} of ${r.week})`;
}

export type FinderGroupKey = "filed" | "wrong" | "unfiled" | "older";
export type FinderGroup<T> = { key: FinderGroupKey; label: string; findings: T[] };

/** A finder's findings as its page groups them (LJ8.6): the window's (findWindow) filed to a problem, marked wrong and
 *  not filed, counted as the Find table counts them, then everything older in one group; newest first in each. */
export function finderGroups<T extends SourceSignal>(findings: ReadonlyArray<T>, marks: ReadonlyArray<FindingMark>, { from, cut }: FindWindow): FinderGroup<T>[] {
  const wrongIds = new Set(marks.filter((m) => m.verdict === "wrong").map((m) => m.run_id));
  const sorted = [...findings].sort((a, b) => findingAt(b) - findingAt(a));
  const week = sorted.filter((s) => findingAt(s) >= from);
  const groups: FinderGroup<T>[] = [
    { key: "filed", label: "Filed to a problem", findings: week.filter((s) => !wrongIds.has(s._id) && !!s.task_id) },
    { key: "wrong", label: "Marked wrong", findings: week.filter((s) => wrongIds.has(s._id)) },
    { key: "unfiled", label: "Not filed", findings: week.filter((s) => !wrongIds.has(s._id) && !s.task_id) },
    { key: "older", label: cut ? "Earlier" : "Before this week", findings: sorted.filter((s) => findingAt(s) < from) },
  ];
  return groups.filter((g) => g.findings.length > 0);
}
