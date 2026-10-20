// The Problems page's table (line-journeys.md LJ8.2): one row per problem with
// how often it happens in the window, whether that is more or fewer than the
// window before, where it stands (problemStatus, a nine-way partition) and
// when it was last seen; the chips' counts, the search, the two sorts and the
// groups the table draws. Pure. The five-way status at the top is the problem
// page's older reading, kept until that page moves to the partition.
import { causeHeading } from "./causeHeading";
import type { LineIssue } from "./lineModel";
import { attemptEndWords, problemState, type ProblemState } from "./timeline";
import { sourceLabel } from "./loopSteps";
import { clauseHeading } from "../lineFlow";
import { errorTitle } from "@codecast/shared/contracts/ingest";
import type { ProblemSource } from "./stepRuns";
import type { Overlap } from "./overlap";
import { countIn, stripSig, type OverviewWindow } from "./problemsOverview";
import { problemStand, STATUS_LABELS, STATUS_ORDER, type ProblemFacts, type ProblemStand, type StatusKey } from "./problemStatus";

/** Where a problem stands, as a person acts on it. */
export type ProblemStatus = "waiting" | "running" | "open" | "watching" | "closed";

export const PROBLEM_STATUSES: ReadonlyArray<ProblemStatus> = ["waiting", "running", "open", "watching", "closed"];

export const PROBLEM_STATUS_WORDS: Record<ProblemStatus, string> = {
  waiting: "To decide",
  running: "Running",
  open: "Open",
  watching: "Watching",
  closed: "Closed",
};

/**
 * The five-way status from the finer state: running while an attempt is live;
 * waiting on you when its last run stopped for a person (a card, a question) or
 * it shipped past a card nobody answered, or it is in review; watching while a shipped fix is under
 * watch; closed once a close held (or it folded into another cause); open
 * otherwise, which includes a problem that came back (the row flags that apart).
 */
export function problemStatus(issue: Pick<LineIssue, "history" | "status"> & { ask?: string | null; forYou?: string | null }, state: ProblemState): ProblemStatus {
  const h = issue.history;
  // Fed the Inbox, waiting on you means in the Inbox: one definition for the header, the nav, the Inbox and this filter.
  if (issue.forYou !== undefined) {
    if (issue.forYou) return "waiting";
    if (h.attempts.some((a) => a.live)) return "running";
    if (state === "watching" || state === "unapproved") return "watching";
    if (state === "held" || state === "closed" || state === "folded") return "closed";
    return "open";
  }
  if (h.attempts.some((a) => a.live)) return "running";
  if (issue.ask) return "waiting";
  if (state === "unapproved") return "waiting";
  if (state === "watching") return "watching";
  if (state === "held" || state === "closed" || state === "folded") return "closed";
  const last = h.attempts[h.attempts.length - 1];
  if (last && !last.ended && last.outcome.tone === "waiting") return "waiting";
  // In review is the person's (the inbox lists it); a problem the line has not started is open, whatever held it.
  if (issue.status === "in_review") return "waiting";
  return "open";
}

/** Why a problem waits on you, in a word or two: what the person opens to act on it. Null when it does not wait on you. */
const INBOX_WHY: Record<string, string> = { decide: "card", unapproved: "not shipped", confirm: "confirm", question: "question", review: "in review", failed: "failed run", stalled: "silent run", stopped: "go on" };

export function waitingWhy(issue: Pick<LineIssue, "history" | "status"> & { ask?: string | null; forYou?: string | null }, status: ProblemStatus): string | null {
  if (status !== "waiting") return null;
  if (issue.forYou) return INBOX_WHY[issue.forYou] ?? issue.forYou;
  if (issue.ask) return "question";
  const last = issue.history.attempts[issue.history.attempts.length - 1];
  if (last?.unapproved && last.ended === "shipped") return "not shipped";
  if (last && !last.ended && last.outcome.tone === "waiting") return last.card && !last.card.answer ? "card" : "question";
  return issue.status === "in_review" ? "in review" : null;
}

const WAIT_VERB: Record<string, string> = {
  card: "Decide", decide: "Decide", trial: "Decide", "not shipped": "Ask again", unapproved: "Ask again", confirm: "Confirm", question: "Answer",
  "in review": "In review", review: "In review", "failed run": "Failed run", failed: "Failed run", "silent run": "Silent run", stalled: "Silent run", "go on": "Go on?",
};

/** What a problem waiting on you asks for, as its status says it: "Answer", "Confirm", "Decide sd-512", "Failed run". Null when it waits on nobody.
 *  `withRef` false leaves the decision's id out: a list row whose Fix column already opens it. */
export function waitingAction(issue: Pick<LineIssue, "history" | "status"> & { ask?: string | null; forYou?: string | null }, status: ProblemStatus, withRef = true): string | null {
  const why = waitingWhy(issue, status);
  if (!why) return null;
  const verb = WAIT_VERB[why] ?? why;
  const card = issue.history.attempts[issue.history.attempts.length - 1]?.card?.ref;
  return withRef && (verb === "Decide" || verb === "Card") && card ? `${verb} ${card}` : verb;
}

/** A status as a row or a page header says it: what a problem waiting on you asks for, else its status word. */
export const statusWords = (issue: Parameters<typeof waitingAction>[0], status: ProblemStatus, withRef = true): string => waitingAction(issue, status, withRef) ?? PROBLEM_STATUS_WORDS[status];

/**
 * Where the problem stands now, as a few facts read off its newest attempt, always in one order (the run, what became
 * of the fix, its card): "#3", "merged", "not deployed", "card unanswered". One reading every surface of the problem's header shows,
 * so the pill, the chart and the run card never say three different things.
 */
export function problemNow(issue: Pick<LineIssue, "history">): string[] {
  const h = issue.history;
  const last = h.attempts[h.attempts.length - 1];
  if (!last) return [];
  const out = [`#${last.n}`];
  if (last.live) return [...out, "running"];
  const shipped = last.ended === "shipped" || !!last.merge || h.ships.some((s) => s.runId === last.runId);
  // The run's one outcome (attemptVerdict): the same words its chip, its Runs row and its chart mark say.
  out.push(...attemptEndWords(last, h).split(", "));
  const card = last.card;
  // A fix past a card nobody answered is unapproved, whatever became of the card; any other card says its state.
  if (shipped && last.unapproved) out.push("card unanswered");
  else if (card) {
    const st = card.status.toLowerCase();
    out.push(card.answer ? `card: ${card.answer.toLowerCase()}` : st === "pending" ? "card waiting" : `card ${st}`);
  }
  if (h.regressed) out.push("came back");
  return out;
}

/** A problem's title as a list says it. A judge's "Not met:" stays: without it the expectation's words read as a goal
 *  or as a non-problem ("…is the designed pipeline, not a defect", ct-59756). */
export const problemTitle = (title: string): string => title.replace(/^not met:\s*/i, "Not met: ");

/** An error a logger titled twice ("<what failed>: <msg>: <msg>", ct-58610) names its problem by what failed, in the
 *  product's own words; the error itself is detail its page shows. `fromErrors`: the problem is known to come from an
 *  error group, so its words lead even when the error was said once. Null when the title is not that shape. */
export function errorWords(title: string, fromErrors = false): string | null {
  const e = errorTitle(title);
  return e.words && (fromErrors || e.title !== title.trim()) ? e.words : null;
}

/** A problem as a head names it, where a full column has room: its written name, else for an error what failed in the
 *  product's words, else for a title stored cut its first whole clause, else `whole` (the page's expectation-restored
 *  heading) or the title whole. Never problemListName's cut: that is for narrow lists only. */
export function problemHeadName(issue: { title: string; name?: string | null }, o: { fromErrors?: boolean; whole?: string } = {}): string {
  return issue.name?.trim() || errorWords(issue.title, o.fromErrors) || clauseHeading(issue.title) || o.whole || problemTitle(issue.title.trim());
}

/** Longest name a problem list shows; lineRetitle's LIST_NAME_MAX names anything longer. */
const LIST_MAX = 90;
/** How far past LIST_MAX a list name may run to end its clause whole. */
const REACH = 40;

/**
 * A problem as a list names it: its written name (cause.named, which lineRetitle writes for every title), else its
 * title cut to one scannable clause, never mid-word. The page keeps the title whole.
 */
export function problemListName(issue: { title: string; name?: string | null }): string {
  if (issue.name?.trim()) return issue.name.trim();
  const title = errorWords(issue.title) ?? errorTitle(issue.title).title;
  // A title stored cut at its cap: its first whole clause, never the cut.
  const whole = clauseHeading(title);
  if (whole && whole.length <= LIST_MAX) return whole;
  const t = problemTitle(title).replace(/\s+/g, " ").trim();
  if (t.length <= LIST_MAX) return t;
  // A closing "…, not a defect" turns the whole sentence around: cut it off and the name says the opposite.
  if (t.length <= LIST_MAX + 24 && /,\s+not\s[^,]*$/i.test(t)) return t;
  // Too long to list: its asides are detail the page keeps.
  const bare = t.replace(/\s*\([^()]*\)/g, "").replace(/\s+([:,;.])/g, "$1");
  if (bare.length <= LIST_MAX) return bare;
  const head = bare.slice(0, LIST_MAX + 1);
  // The first whole sentence (not an "e.g." inside an aside), then the last clause break, then the last word, whichever fits.
  const sentence = [...head.matchAll(/[.?!](?=\s|$)/g)].map((m) => head.slice(0, m.index + 1)).find((x) => x.length >= 20 && !/\b(?:e\.g|i\.e|etc|vs|approx)\.$/i.test(x) && !openAside(x));
  if (sentence) return sentence.replace(/\.$/, "");
  const clause = Math.max(head.lastIndexOf(", "), head.lastIndexOf("; "), head.lastIndexOf(": "), head.lastIndexOf(" - "), head.lastIndexOf(" — "));
  // No clause ends inside the cap: the clause it is in ends a little past it ("…even when the failures are a provider
  // outage"), rather than a word cut that drops what the problem is ("…even when the…").
  const next = clause >= 40 ? -1 : bare.slice(LIST_MAX, LIST_MAX + REACH).search(/, |; |: | - | — /);
  let cut = clause >= 40 ? head.slice(0, clause) : next >= 0 ? bare.slice(0, LIST_MAX + next) : head.slice(0, head.lastIndexOf(" ", LIST_MAX));
  // A cut inside an aside ends before it: "missing 03:38-09:00 (the live-feed…" reads "missing 03:38-09:00…".
  const open = openAside(cut);
  if (open >= 40) cut = cut.slice(0, open);
  return `${cut.replace(/[\s,;:.(-]+$/, "")}…`;
}

/** Where the last unclosed "(" in `text` opens, else 0. */
function openAside(text: string): number {
  let at = -1;
  for (let i = 0, depth = 0; i < text.length; i++) {
    if (text[i] === "(") { if (depth++ === 0) at = i; } else if (text[i] === ")" && depth > 0) depth--;
    if (i === text.length - 1 && depth === 0) at = -1;
  }
  return Math.max(0, at);
}

// ── the rows ─────────────────────────────────────────────────────────────────

export type ProblemRow = {
  id: string;
  issue: LineIssue;
  stand: ProblemStand;
  projectId: string | null;
  /** Findings in all: what the cause holds, or the occurrences read when more. */
  findings: number;
  /** Findings inside the window, and inside the window before it; `before` is null when the series does not reach that far back. */
  inWindow: number;
  before: number | null;
  /** Its findings count toward the page's figures and chart: its whole series came (lineWorkspace.occurrences), or it is
   *  in a project, whose series is on its way. A problem in no project has no series feed; its recent findings are
   *  whatever the store's capped window holds on this load, so figures that counted them would change between loads. */
  series: boolean;
  /** Its newest finding, the Last column: when the problem was last seen, never when a run last wrote. 0 when none is known. */
  seenAt: number;
  /** The newest thing that happened to it; breaks ties in every sort. */
  lastAt: number;
  /** The older problem it reads the same as (lib/line/overlap), by ref; null when it is its own. */
  dupOf: string | null;
  /** A twin nothing has started, folded under its older problem (foldTwins): drawn under that row, never a row or a
   *  count of its own, never ready to start. The older problem's id. */
  foldedInto?: string | null;
  /** The twins folded under this row. */
  twins?: ProblemRow[];
  /** What the search matches, lowercased: its title, ref, project and where its findings came from. */
  hay: string;
  /** It is a problem with the line itself, about these steps (ProblemFacts aboutSteps). */
  aboutSteps: ReadonlyArray<string>;
};

export type ProblemRowsInput = {
  win: OverviewWindow;
  now: number;
  facts: (id: string) => ProblemFacts;
  projectOf: (id: string) => string | null;
  projectName: (id: string | null) => string;
  sources?: ReadonlyMap<string, Pick<ProblemSource, "all">>;
  overlaps?: ReadonlyMap<string, Overlap>;
};

/** Every problem's row: its one status (problemStatus) and its findings on the page's window. */
export function buildProblemRows(issues: ReadonlyArray<LineIssue>, input: ProblemRowsInput): ProblemRow[] {
  const { win } = input;
  const span = win.d1 - win.d0;
  return foldTwins(issues.map((issue) => {
    const h = issue.history;
    const projectId = input.projectOf(issue.id);
    const from = [...new Set((input.sources?.get(issue.id)?.all ?? []).map((a) => sourceLabel(a.source.toLowerCase())))];
    const o = input.overlaps?.get(issue.id);
    // The window before is comparable only when the series reaches back over all of it.
    const reaches = !h.capped || (h.since != null && h.since <= win.d0 - span);
    const facts = input.facts(issue.id);
    return {
      id: issue.id,
      issue,
      stand: problemStand(issue, facts, input.now),
      projectId,
      findings: Math.max(issue.findings, h.occurrences.length),
      inWindow: countIn(issue, win.d0, win.d1),
      before: reaches ? countIn(issue, win.d0 - span, win.d0) : null,
      series: h.occurrencesFrom === "history" || !!projectId,
      seenAt: h.occurrences[h.occurrences.length - 1]?.at ?? h.firstAt ?? 0,
      lastAt: Math.max(h.lastActivity || 0, issue.lastRunAt || 0),
      dupOf: o && o.set.length > 1 && o.primary !== issue.id ? o.primaryRef : null,
      hay: [issue.title, issue.ref ?? "", input.projectName(projectId), ...from].join("\n").toLowerCase(),
      aboutSteps: facts.aboutSteps ?? [],
    };
  }), input.overlaps);
}

/** Twins nothing has started yet (Not started, the overlap's younger member) fold under their older problem when it is
 *  listed: the line would spend a run on the same defect twice, so a twin is never ready to start, and its one act is
 *  merging it in. A twin with a run of its own keeps its row: its run is its own work. */
export function foldTwins(rows: ProblemRow[], overlaps?: ReadonlyMap<string, Overlap>): ProblemRow[] {
  const byId = new Map(rows.map((r) => [r.id, r]));
  const twins = new Map<string, ProblemRow[]>();
  const out = rows.map((r) => {
    const o = overlaps?.get(r.id);
    if (!r.dupOf || !o || r.stand.status !== "notstarted" || !byId.has(o.primary)) return r;
    const t: ProblemRow = { ...r, foldedInto: o.primary, stand: { status: "notstarted", phrase: `Same as ${r.dupOf}`, ready: false, act: "mergeinto" } };
    twins.set(o.primary, [...(twins.get(o.primary) ?? []), t]);
    return t;
  });
  return out.map((r) => {
    const mine = twins.get(r.id);
    return mine ? { ...r, twins: mine, hay: [r.hay, ...mine.map((t) => t.hay)].join("\n") } : r;
  });
}

/** Whether a problem happened more or less in the window than in the one before; null when equal or not comparable. */
export const rowTrend = (r: Pick<ProblemRow, "inWindow" | "before">): "up" | "down" | null =>
  r.before == null || r.before === r.inWindow ? null : r.inWindow > r.before ? "up" : "down";

// ── filter ───────────────────────────────────────────────────────────────────

/** What the figures and the chart narrow the table to: the problems found more in the window than the one before
 *  ("158% more"), or the problems with findings in one picked bar. */
export type FoundFilter = "more" | { from: number; to: number } | null;

/** What narrows the table: one status chip (null: All), only the fixes quiet since they reached production, the search,
 *  and a figure's or a bar's narrowing. */
export type ProblemFilter = { status: StatusKey | null; quiet: boolean; q: string; found?: FoundFilter };

/** Findings of one row inside the picked bar. */
const foundIn = (r: ProblemRow, f: Exclude<FoundFilter, "more" | null>) => countIn(r.issue, f.from, f.to);

/** The number in a short id as typed ("ct-58282", "#58282", "58282"); null when the search is not one. */
const refNumber = (q: string): string | null => /^(?:[a-z]+-|#)?(\d+)$/.exec(q)?.[1] ?? null;

/** The rows the search keeps. A search that is a problem's short id or its number opens that problem alone: the
 *  words also sit in other rows (a cause's finder key names the problem it came from), and those are not what was asked. */
export const searchProblems = (rows: ReadonlyArray<ProblemRow>, q: string): ProblemRow[] => {
  const words = q.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return listed(rows);
  const num = words.length === 1 ? refNumber(words[0]) : null;
  const isRef = (r: ProblemRow) => !!r.issue.ref && (r.issue.ref.toLowerCase() === words[0] || refNumber(r.issue.ref.toLowerCase()) === num);
  // A folded twin's ref opens the row it sits under.
  const exact = num ? listed(rows).filter((r) => isRef(r) || !!r.twins?.some(isRef)) : [];
  return exact.length ? exact : listed(rows).filter((r) => words.every((w) => r.hay.includes(w)));
};

/** The rows the table lists and the chips count: every row but the twins folded under another. */
export const listed = (rows: ReadonlyArray<ProblemRow>): ProblemRow[] => rows.filter((r) => !r.foldedInto);

/** The rows the search and a figure's or bar's narrowing keep: what the chips count. */
export const narrowProblems = (rows: ReadonlyArray<ProblemRow>, q: string, found: FoundFilter = null): ProblemRow[] => {
  const kept = searchProblems(rows, q);
  if (!found) return kept;
  return kept.filter((r) => (found === "more" ? rowTrend(r) === "up" : foundIn(r, found) > 0));
};

export const filterProblems = (rows: ReadonlyArray<ProblemRow>, f: ProblemFilter): ProblemRow[] =>
  narrowProblems(rows, f.q, f.found).filter((r) => (!f.status || r.stand.status === f.status) && (!f.quiet || !!r.stand.quiet));

/** Each chip's count over the rows the search and the narrowing keep, so a count is the rows its chip opens; `all` is their sum. */
export function statusCounts(rows: ReadonlyArray<ProblemRow>, q = "", found: FoundFilter = null): { all: number; by: Record<StatusKey, number> } {
  const by = Object.fromEntries(STATUS_ORDER.map((s) => [s, 0])) as Record<StatusKey, number>;
  const kept = narrowProblems(rows, q, found);
  for (const r of kept) by[r.stand.status]++;
  return { all: kept.length, by };
}

/** Where an empty table leads, so a match the search found elsewhere is one press away (never "Show all 896" when the
 *  search keeps 1): the chips that hold what the search and the day keep, else every day's matches, else the search
 *  cleared, else every problem. `searched`: the rows the search alone keeps; `all`: every row. */
export type EmptyWay = { kind: "status"; status: StatusKey; n: number } | { kind: "anyday"; n: number } | { kind: "search" } | { kind: "all"; n: number };
export function emptyWays(counts: { all: number; by: Record<StatusKey, number> }, f: Pick<ProblemFilter, "status" | "q" | "found">, searched: number, all: number): EmptyWay[] {
  if (f.status && counts.all > 0) return STATUS_ORDER.filter((s) => counts.by[s] > 0).map((s) => ({ kind: "status" as const, status: s, n: counts.by[s] }));
  if (f.found && searched > 0) return [{ kind: "anyday", n: searched }];
  if (f.q.trim()) return [{ kind: "search" }];
  return [{ kind: "all", n: all }];
}

// ── order and groups ─────────────────────────────────────────────────────────

/** `null` is the page's own order: grouped by status, busiest first inside a group. A column sorts the whole list flat. */
export type ProblemSort = "findings" | "last" | null;
export const isProblemSort = (v: string | null | undefined): v is Exclude<ProblemSort, null> => v === "findings" || v === "last";

const byRef = (a: ProblemRow, b: ProblemRow) => (a.issue.ref ?? a.id).localeCompare(b.issue.ref ?? b.id);
const byFindings = (a: ProblemRow, b: ProblemRow) => b.inWindow - a.inWindow || b.findings - a.findings || b.lastAt - a.lastAt || byRef(a, b);
const byLast = (a: ProblemRow, b: ProblemRow) => b.seenAt - a.seenAt || b.lastAt - a.lastAt || byRef(a, b);
const sorter = (s: ProblemSort) => (s === "last" ? byLast : byFindings);

/** Rows under one heading inside a group: a failure cause, or a project's problems not started. */
export type ProblemSub = {
  key: string;
  label: string;
  rows: ProblemRow[];
  /** Not started: the project, how many the sweep would start, and how many are blocked. They sum to the rows. */
  projectId?: string | null;
  ready?: number;
  blocked?: number;
  /** Failed: open problems with the line itself, about a step these runs failed at (ct-58282: the Eval gate has no
   *  database, so every Eval fails). Starting the runs again would fail the same way: the act is that fix. */
  heldBy?: ProblemRow[];
};

/** The steps of the line a problem about the line itself names, by id, from its finder's keys: `union:line-eval:...`
 *  names Eval; `union:line:ship-fails-...` leads with Ship. Only ever matched against the steps a run failed at, so a
 *  key's leading word that names no step holds nothing. */
export function lineStepsOf(fingerprints: ReadonlyArray<string> | null | undefined): string[] {
  const out = new Set<string>();
  for (const f of fingerprints ?? []) {
    const m = /(?:^|:)line-([a-z][a-z_]*):/.exec(f) ?? /(?:^|:)line:([a-z][a-z_]*)-/.exec(f);
    if (m) out.add(m[1]);
  }
  return [...out];
}

/** A problem with the line holds the runs that failed at its step until its fix lands (merged, in production, or closed). */
const LANDED: ReadonlySet<StatusKey> = new Set(["merged", "shipped", "trial", "closed"]);

/** The open problems with the line itself about any of these steps, most findings first: a run that failed at one of
 *  them fails the same way until that problem's fix lands, so opening it is the act, never starting the run again or
 *  editing the step. Problems' Failed headings and a step's page both read it. */
export function lineProblemsAt(rows: ReadonlyArray<ProblemRow>, steps: ReadonlySet<string>): ProblemRow[] {
  return rows.filter((r) => r.aboutSteps.some((x) => steps.has(x)) && !LANDED.has(r.stand.status)).sort(byFindings);
}

export type ProblemSection = {
  /** Null for a flat list under a column sort. */
  status: StatusKey | null;
  label: string;
  n: number;
  /** Shown as its heading only (Not started and Closed under All): the heading opens its chip. */
  folded: boolean;
  subs: ProblemSub[] | null;
  rows: ProblemRow[];
};

/** The groups that open as one line under All: long, and nothing in them is the next thing to move. */
const FOLDED_IN_ALL: ReadonlySet<StatusKey> = new Set(["notstarted", "closed"]);

function subsOf(status: StatusKey, rows: ProblemRow[], projectName: (id: string | null) => string, all: ReadonlyArray<ProblemRow> = rows, startOrder?: ReadonlyMap<string, number>): ProblemSub[] | null {
  if (status === "failed") {
    const by = new Map<string, ProblemSub>();
    const steps = new Map<string, Set<string>>();
    // One heading per cause (its key: what happened, at which step, by which check), as a step page groups its runs,
    // so the two count alike. Runs of one cause that differ in a detail say what they share (causeHeading).
    const labels = new Map<string, string[]>();
    for (const r of rows) {
      const c = r.stand.cause ?? { key: "unknown", label: "Failed" };
      const sub = by.get(c.key) ?? by.set(c.key, { key: c.key, label: c.label, rows: [] }).get(c.key)!;
      sub.rows.push(r);
      (labels.get(c.key) ?? labels.set(c.key, []).get(c.key)!).push(c.label);
      const s = steps.get(sub.key) ?? steps.set(sub.key, new Set()).get(sub.key)!;
      for (const x of c.steps ?? []) s.add(x);
    }
    for (const sub of by.values()) sub.label = causeHeading(labels.get(sub.key)!);
    // Whatever the search or a chip keeps, the problem that holds a cause is read from every row.
    for (const sub of by.values()) {
      const held = lineProblemsAt(all, steps.get(sub.key)!).filter((r) => !sub.rows.includes(r));
      if (held.length) sub.heldBy = held;
    }
    return [...by.values()].sort((a, b) => b.rows.length - a.rows.length || a.label.localeCompare(b.label));
  }
  if (status === "notstarted") {
    const by = new Map<string, ProblemSub>();
    for (const r of rows) {
      const key = r.projectId ?? "";
      const sub = by.get(key) ?? by.set(key, { key, label: projectName(r.projectId) || "No project", rows: [], projectId: r.projectId, ready: 0, blocked: 0 }).get(key)!;
      sub.rows.push(r);
      if (r.stand.ready) sub.ready!++; else sub.blocked!++;
    }
    // Ready ones first, in the order the line takes them; the blocked after, in the table's order.
    if (startOrder) {
      const at = (r: ProblemRow) => (r.stand.ready ? startOrder.get(r.id) ?? Infinity : Infinity);
      for (const sub of by.values()) sub.rows = sub.rows.map((r, i) => ({ r, i })).sort((x, y) => Number(!x.r.stand.ready) - Number(!y.r.stand.ready) || at(x.r) - at(y.r) || x.i - y.i).map(({ r }) => r);
    }
    return [...by.values()].sort((a, b) => b.rows.length - a.rows.length || a.label.localeCompare(b.label));
  }
  return null;
}

/**
 * The table as it is drawn. Under All with the page's own order: one group per status in chip order, Failed by
 * cause, Not started and Closed folded to their headings. Under one chip: that group open (Failed by cause, Not
 * started by project, which is that page). Under a column sort with no chip: one flat list.
 */
/** `startOrder`: each problem's place in its line's start order (lineStartOrder): a project's ready problems under Not
 *  started list in it, so the first ones are what Turn on starts. */
export function problemSections(rows: ReadonlyArray<ProblemRow>, f: ProblemFilter, sort: ProblemSort, projectName: (id: string | null) => string, startOrder?: ReadonlyMap<string, number>): ProblemSection[] {
  const kept = filterProblems(rows, f);
  // A picked bar lists its problems busiest that day first, unless a column sorts.
  const day = f.found && f.found !== "more" ? f.found : null;
  const cmp = day && !sort ? (a: ProblemRow, b: ProblemRow) => foundIn(b, day) - foundIn(a, day) || byFindings(a, b) : sorter(sort);
  if (!f.status && sort) return kept.length ? [{ status: null, label: "", n: kept.length, folded: false, subs: null, rows: [...kept].sort(cmp) }] : [];
  const out: ProblemSection[] = [];
  for (const status of STATUS_ORDER) {
    const mine = kept.filter((r) => r.stand.status === status).sort(cmp);
    if (!mine.length) continue;
    const folded = !f.status && !f.q.trim() && !f.found && FOLDED_IN_ALL.has(status);
    // A sub-group is drawn where its heading carries the act: Failed always, Not started when it is the page.
    const subs = status === "failed" || (status === "notstarted" && f.status === "notstarted") ? subsOf(status, mine, projectName, rows, startOrder) : null;
    out.push({ status, label: STATUS_LABELS[status], n: mine.length, folded, subs, rows: subs ? subs.flatMap((s) => s.rows) : mine });
  }
  return out;
}

/** Every problem under the filter in the table's order, folded groups included: what prev and next walk on a problem's page. */
export const problemOrder = (sections: ReadonlyArray<ProblemSection>): string[] => sections.flatMap((s) => s.rows.map((r) => r.id));
/** The rows drawn: what J and K move over. */
export const shownOrder = (sections: ReadonlyArray<ProblemSection>): string[] => sections.flatMap((s) => (s.folded ? [] : s.rows.map((r) => r.id)));

/** Everything a row draws, so a model rebuild keeps the rows that did not move. */
export const problemRowSig = (r: ProblemRow): string =>
  [r.id, r.issue.title, r.issue.ref ?? "", r.stand.status, r.stand.phrase, r.stand.cause?.key ?? "", r.stand.quiet ? 1 : 0, r.stand.ready ? 1 : 0, r.stand.act ?? "", r.stand.gate ?? "", r.series ? 1 : 0, r.projectId ?? "", r.inWindow, r.before ?? "", r.seenAt, r.dupOf ?? "", r.hay.length, r.aboutSteps.join(","), r.foldedInto ?? "", (r.twins ?? []).map((t) => t.id).join(","), stripSig(r.issue.history)].join("|");

// ── what the workspace counts ────────────────────────────────────────────────

/** A problem only a lesson filed: a note to the line, not an occurrence. */
export function lessonOnlyIds(sources: ReadonlyMap<string, Pick<ProblemSource, "all">>): Set<string> {
  const out = new Set<string>();
  for (const [id, s] of sources) if (s.all.length > 0 && s.all.every((a) => a.source.toLowerCase() === "lesson")) out.add(id);
  return out;
}
/** The problems still open in any sense (not closed). */
export const isActiveProblem = (i: LineIssue): boolean => problemStatus(i, problemState(i.history, i.status)) !== "closed";
/** Active as every count of it reads: not closed, and not a lesson-only problem. */
export const isCountedActive = (i: LineIssue, lessons?: ReadonlySet<string>): boolean => isActiveProblem(i) && !lessons?.has(i.id);
export const activeProblemCount = (issues: ReadonlyArray<LineIssue>, lessons?: ReadonlySet<string>): number => issues.filter((i) => isCountedActive(i, lessons)).length;
