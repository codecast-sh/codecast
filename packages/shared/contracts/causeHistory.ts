// A cause's life over time (line-workspace.md LW1 Timeline, LW5): how often
// its problem happened, every attempt to fix it, what shipped and merged, the
// deploys that carried each merge, the watch after it, and the occurrences
// that came back after a fix went out (a regression). One derivation for every
// reader: the web's line model calls it per cause, and the server assembles
// the same history for a run that starts on the cause (lineWorkspace
// causeHistoryForTask), so the timeline a person reads and the brief a
// station is handed never disagree. Pure.
//
// What codecast cannot know, it says. A deploy is known only when someone
// records it (`cast ship mark`, which packages/convex/deploy.sh runs, or a
// source that reports deploys); a merge with no recorded deploy after it is
// "merged, deploy not recorded", never assumed live. A regression is measured
// from the deploy that carried the fix when one is known, else from the merge,
// else from the ship step, and says which.
import { CARD_GATE_NODE_ID, LINE_END_NODES, isLineRun, passedUnansweredCard, type LineRunEnd } from "./changeCard";
import { parsePrRef } from "./prRefs";

const DAY = 24 * 60 * 60 * 1000;

// ── small run words every reader shares ──────────────────────────────────────

export const isLiveRun = (r: { status: string }) => r.status === "running" || r.status === "paused" || r.status === "pending";

/** "[S] Ship :: Land the change" → "Ship". */
export const choiceWords = (label: string) => label.replace(/^\[[^\]]*\]\s*/, "").split("::")[0].trim() || label;

export const shortDay = (at: number) => new Date(at).toLocaleDateString("en-US", { month: "short", day: "numeric" });

/** "Oct 8", "Oct 8 and Oct 9", "Oct 7, Oct 8 and Oct 9". */
export const andList = (xs: ReadonlyArray<string>) => (xs.length < 2 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`);

/** Markdown in plain words: bold, code and links unwrapped, a leading quote or bullet mark dropped. */
export const plainWords = (s: string) => s.replace(/(\*\*|__)(.+?)\1/g, "$2").replace(/`([^`]+)`/g, "$1").replace(/\[([^\]]+)\]\([^)]+\)/g, "$1").replace(/^[>*-]\s+/, "").trim();

/** The evidence a signal quotes: its detail's quoted lines, in plain words. */
export function signalQuotes(detailMd: string | null | undefined): string[] {
  const out: string[] = [];
  for (const line of (detailMd ?? "").split("\n")) {
    if (!/^\s*>/.test(line)) continue;
    const text = plainWords(line.replace(/^\s*>\s?/, "")).replace(/^["“]|["”]$/g, "").trim();
    if (text.length >= 8) out.push(text);
  }
  return out;
}

/** The fields a station's JSON report puts its finding, proposal or build in, in the order a reader wants them. */
export const REPORT_FIELDS = ["statement", "strategy", "summary", "evidence", "why"] as const;

/** A station's report in its own words: the first of REPORT_FIELDS it filled. */
export function reportFieldWords(result: unknown): string | null {
  const r = result && typeof result === "object" ? (result as Record<string, unknown>) : null;
  const v = REPORT_FIELDS.map((k) => r?.[k]).find((x): x is string => typeof x === "string" && !!x.trim());
  return v?.trim() ?? null;
}

/** The ends every graph shares: a completed watch shipped, a completed drop dropped. */
const SHARED_ENDS: Readonly<Record<string, LineRunEnd>> = { watch: "shipped", drop: "dropped" };

/** Another graph's own close stations, by name: AgentWatch closes a cause at
 *  `dissolved_at_investigate` (no fix needed, found at Investigate) and parks
 *  it at `park_built`. The step it closed at is the name's tail. */
function foreignEnd(id: string): LineRunEnd | null {
  if (/^(?:dissolved|released)_at_\w+$/.test(id)) return "dissolved";
  if (/^park(?:_|$)/.test(id)) return "parked";
  return null;
}

/** The step a run closed at, from its end station: "dissolved_at_investigate" is Investigate; the line's own end stations name themselves. */
export const closedAtStep = (endNode: string): string => /^(?:dissolved|released|failed|escalated)_at_(\w+)$/.exec(endNode)?.[1] ?? endNode;

/** How a run ended, in any graph: the line's own end stations, else the
 *  ends every graph shares and another graph's close stations, so a run of
 *  another graph (AgentWatch) that merged and started its watch reads as
 *  shipped, and one that dissolved the cause reads as dissolved, never by a
 *  gate it passed on the way. `node` is the end station it reached. */
export function runEnd(run: { node_statuses?: ReadonlyArray<{ node_id: string; status: string; outcome?: string | null; started_at?: number; completed_at?: number }> }): { kind: LineRunEnd; at: number; node: string } | null {
  if (passedUnansweredCard(run.node_statuses)) return null;
  const line = isLineRun(run.node_statuses);
  let best: { kind: LineRunEnd; at: number; node: string } | null = null;
  for (const n of run.node_statuses ?? []) {
    const kind = line ? LINE_END_NODES[n.node_id] : SHARED_ENDS[n.node_id] ?? foreignEnd(n.node_id);
    if (!kind || n.status !== "completed") continue;
    const at = n.completed_at ?? n.started_at ?? 0;
    if (!best || at >= best.at) best = { kind, at, node: n.node_id };
  }
  return best;
}

/** Where a run's fix went, for the history: its end (runEnd), or, for a run
 *  that went on past a card nobody answered and still merged and started its
 *  watch, a ship all the same. Nobody approved it (the run report says so),
 *  but the code is live, so what happens after it is measured from it. */
function historyEnd(run: Parameters<typeof runEnd>[0]): { kind: LineRunEnd; at: number; node: string; unapproved: boolean } | null {
  const end = runEnd(run);
  if (end) return { ...end, unapproved: false };
  if (!passedUnansweredCard(run.node_statuses)) return null;
  const watch = run.node_statuses?.find((n) => n.node_id === "watch" && n.status === "completed");
  return watch ? { kind: "shipped", at: watch.completed_at ?? watch.started_at ?? 0, node: "watch", unapproved: true } : null;
}

/** A run that went live past a card nobody answered: the same test the history's `unapproved` reads, for counts made without building a history (the line's rollup). */
export const shippedUnanswered = (run: Parameters<typeof runEnd>[0]): boolean => !!historyEnd(run)?.unapproved;

/** A close's own argument, from its station's JSON report: the dissolution's
 *  `kind` ("in_flight", "already_fixed", "known_cause") and what it was folded
 *  `into` ("xp-12 (card sd-421)", a commit). */
export type CloseArgument = { kind: string; into: string | null; /** The change its own words say owns the fix ("the Oct 6 fee policy"). */ named?: string | null };

/** A close's argument from its report, and the owner its prose names ("already fixed by the Oct 6 fee policy"). */
export function reportArgument(result: unknown, prose?: string | null): CloseArgument | null {
  const r = result && typeof result === "object" ? (result as Record<string, unknown>) : null;
  const kind = typeof r?.kind === "string" ? r.kind.trim() : "";
  if (!kind) return null;
  const into = typeof r?.into === "string" && r.into.trim() ? r.into.trim() : null;
  const named = /\b(?:fixed|covered|owned|handled) by (?:the )?([^;,.()]{3,40})/i.exec(prose ?? "")?.[1]?.trim();
  return { kind, into, named: named ? `the ${named}` : null };
}

/** The words of a close without a change that name a guard (an eval, a test, a check): nothing shipped it, so every surface that shows them says so. */
export const namesGuard = (text: string | null | undefined) => !!text && /\b(evals?|guard|tests?|checks?)\b/i.test(text);

/** A close without a change (a dissolve, a drop) whose words name a guard: that guard was never shipped. */
export const unshippedGuard = (closeKind: string | null | undefined, text: string | null | undefined) => (closeKind === "dissolved" || closeKind === "dropped") && namesGuard(text);

/** Which of found, proposed or built a station's words fill: a plan or
 *  proposal step proposes, a build step builds, a diagnosing step finds. The
 *  caller says whether the step diagnoses or builds; null when it does neither. */
export function saidSlot(nodeId: string, part: "diagnose" | "build" | null): "found" | "proposed" | "built" | null {
  if (/propos|plan/.test(nodeId)) return "proposed";
  if (part === "diagnose") return "found";
  if (part === "build") return "built";
  return null;
}

// ── what it reads ────────────────────────────────────────────────────────────

/** A cause's occurrences over the history window (lineWorkspace.occurrences): observed times, oldest first. */
export type OccurrenceRow = {
  _id: string;
  task_id: string;
  project_id: string;
  observed: number[];
  reopened: number[];
  sources: string[];
  /** The window's start. */
  since: number;
  /** The read stopped at its cap: older occurrences exist. */
  capped: boolean;
};

/** A deploy codecast knows of for the project (lineWorkspace.deploys). */
export type DeployRow = {
  _id: string;
  project_id: string;
  at: number;
  sha: string | null;
  repository: string | null;
  /** A `cast ship mark` surface ("backend"). */
  surface: string | null;
  /** A source's environment ("prod"). */
  environment: string | null;
  version: string | null;
  source: string;
  /** "repository": a marker on the project's repository; "source": a deploy the workspace's source reported. */
  via: "repository" | "source";
  title: string;
  url: string | null;
};

/** The merge the line's merge step recorded on a run (workflow_runs.merge). */
export type RunMergeRow = { sha: string; branch: string; into: string; at: number; pr_url?: string };

/** What a run's stations said: found, proposed, built, and a close's argument. */
export type RunSaid = { found: string | null; proposed: string | null; built: string | null; argued?: CloseArgument | null };

/** The run fields the history reads. */
export type HistoryRunRow = {
  _id: string;
  created_at: number;
  updated_at: number;
  status: string;
  node_statuses?: ReadonlyArray<{ node_id: string; status: string; outcome?: string | null; started_at?: number; completed_at?: number }>;
  merge?: RunMergeRow | null;
};

/** The decision fields the history reads (session_decisions, or lineWorkspace.cards). */
export type HistoryDecisionRow = {
  _id: string;
  workflow_run_id?: string | null;
  gate_node_id?: string | null;
  short_id?: string | null;
  status: string;
  options?: ReadonlyArray<{ label: string }>;
  answer_index?: number | null;
  answer_text?: string | null;
  resolved_at?: number | null;
  created_at?: number;
  card?: unknown;
};

/** The cause task's fields the history reads. */
export type HistoryTaskRow = {
  watch_until?: number | null;
  resolved_at?: number | null;
  cause?: { first_seen?: number | null; last_seen?: number | null } | null;
};

/** A line card's fields the history reads (session_decisions.card). */
type CardRow = { headline?: string | null; change?: string | null; wrong?: string | null; recommend?: { verdict: string; why?: string } | null; diff?: { files?: number; added?: number; removed?: number; pr?: string } | null };

// ── what it is ───────────────────────────────────────────────────────────────

export type Occurrence = { at: number; reopened: boolean };

export type AttemptCard = {
  decisionId: string;
  ref: string | null;
  headline: string | null;
  /** What the attempt proposed to change. */
  change: string | null;
  /** What it said was wrong. */
  wrong: string | null;
  recommend: { verdict: string; why: string | null } | null;
  status: string;
  /** The answer in the option's own words ("Ship", "Revise"), and a person's note with it. */
  answer: string | null;
  note: string | null;
  answeredAt: number | null;
};

export type AttemptMerge = { sha: string; branch: string; into: string; at: number; prUrl: string | null; repository: string | null };

/** A run's outcome in words; a reader may carry more (the web's tone). */
export type AttemptOutcome = { end: LineRunEnd | null; text: string };

export type HistoryAttempt<O extends AttemptOutcome = AttemptOutcome> = {
  runId: string;
  /** 1 for the cause's first attempt. */
  n: number;
  start: number;
  /** Null while the run is live. */
  end: number | null;
  live: boolean;
  outcome: O;
  /** How the run ended: shipped, dropped, dissolved, parked; null when it stopped short of an end or is live. */
  ended: LineRunEnd | null;
  /** The step it ended at ("investigate" for AgentWatch's dissolved_at_investigate, "dissolve" on the line); null without an end. */
  endStep: string | null;
  /** It shipped past a card nobody answered: live, never approved. */
  unapproved: boolean;
  /** A later attempt replaced this one after it failed. */
  superseded: boolean;
  /** What the attempt found, proposed and built, in its stations' own words. */
  found: string | null;
  /** The argument its close made, from the closing station's report; null when it did not close or said none. */
  argued: CloseArgument | null;
  proposed: string | null;
  built: string | null;
  card: AttemptCard | null;
  diff: { files: number; added: number; removed: number; pr: string | null } | null;
  merge: AttemptMerge | null;
};

/** How a deploy is known to carry a merge: the same commit, or recorded after the merge on the same code (main's history is flat). */
export type CarriedHow = "same commit" | "deployed after the merge";

export type HistoryDeploy = {
  id: string;
  at: number;
  sha: string | null;
  /** The surface or environment it went to ("backend", "prod"); null when the record names neither. */
  target: string | null;
  version: string | null;
  source: string;
  title: string;
  url: string | null;
  /** The attempt whose merge it carried. */
  runId: string;
  how: CarriedHow;
};

/** Where a fix went live, as best the record says. */
export type FixBasis = "deploy" | "merge" | "ship";

export type HistoryShip = {
  runId: string;
  /** When the run's ship step finished. */
  at: number;
  merge: AttemptMerge | null;
  /** The deploys that carried it, first per target. */
  deploys: HistoryDeploy[];
  /** When the fix is taken to be live, and on what record. */
  liveAt: number;
  basis: FixBasis;
  /** The record in words: "deployed to backend Oct 9", "merged Oct 8, no deploy recorded since". */
  words: string;
};

export type WatchState = "watching" | "quiet" | "reopened" | "unknown";
export type HistoryWatch = { runId: string; start: number; end: number | null; state: WatchState; reopenedAt: number | null };

/** How an attempt closed the problem: a fix that shipped, or a close without a change. */
export type CloseKind = "shipped" | "dissolved" | "dropped";

/** Every time an attempt closed the problem, oldest first: a ship at the time
 *  its fix went live, a dissolve or drop at the time the run ended. What comes
 *  after a close and before the next one came back after it (recurrences,
 *  regressions); `back` is what came after it at all until a later fix went
 *  live, since a second dissolve does not make the first one hold. */
export type HistoryClose = { runId: string; n: number; kind: CloseKind; at: number; step: string | null; back: CloseBack | null };
/** What came back after one close until a later fix went live: "Came back 3 times after attempt 1 dissolved it". */
export type CloseBack = { at: number; count: number; words: string };

/** What came back after an attempt closed the problem without a change (a
 *  dissolve or a drop): the cause was called done and kept happening. */
export type HistoryRecurrence = {
  afterRunId: string;
  /** The attempt's number, and how it closed. */
  n: number;
  kind: "dissolved" | "dropped";
  closedAt: number;
  /** The first occurrence after the close, and how many came before the next close. */
  at: number;
  count: number;
  until: number | null;
  /** "Came back 5 times after attempt 2 dissolved it". */
  words: string;
  /** What one of the occurrences after the close said, when its signal quoted evidence. */
  quote: string | null;
};

export type HistoryRegression = {
  /** The shipped attempt whose fix the problem came back after. */
  afterRunId: string;
  /** The first occurrence after the fix went live, and how many came after it before the next fix. */
  at: number;
  count: number;
  basis: FixBasis;
  liveAt: number;
  /** When the next fix went live, which ends this regression's span; null for the newest fix. */
  until: number | null;
  /** "Came back 3 times after the deploy of Oct 9". */
  words: string;
  /** What one of the occurrences after the fix said, when its signal quoted evidence. */
  quote: string | null;
};

/** What codecast knows about the project's deploys: "unread" while the deploys have not arrived, "none" when nothing is recorded. */
export type DeployCoverage = { state: "unread" | "none" | "known"; targets: string[]; words: string };

export type CauseHistory<O extends AttemptOutcome = AttemptOutcome> = {
  occurrences: Occurrence[];
  /** "history": the cause's full series (lineWorkspace.occurrences); "recent": the two weeks of signals the store holds. */
  occurrencesFrom: "history" | "recent";
  /** The earliest time the series covers, and whether older occurrences were left out. */
  since: number | null;
  capped: boolean;
  attempts: HistoryAttempt<O>[];
  ships: HistoryShip[];
  deploys: HistoryDeploy[];
  coverage: DeployCoverage;
  watches: HistoryWatch[];
  regressions: HistoryRegression[];
  /** Every close, oldest first, and what came back after a close without a change. */
  closes: HistoryClose[];
  recurrences: HistoryRecurrence[];
  /** The newest close was a fix and the problem came back after it: the cause is regressed now. */
  regressed: boolean;
  /** The newest close was a dissolve or a drop and the problem came back after it. */
  cameBack: boolean;
  firstAt: number | null;
  lastActivity: number;
};

export type HistoryInput<R extends HistoryRunRow, O extends AttemptOutcome> = {
  task: HistoryTaskRow | undefined;
  /** The cause's runs, any graph, any order. */
  runs: ReadonlyArray<R>;
  decisions: ReadonlyArray<HistoryDecisionRow>;
  /** The recent signals, read when the full series has not arrived. */
  signals: ReadonlyArray<{ observed_at?: number | null; created_at: number; reopened?: boolean | null }>;
  occurrences: OccurrenceRow | undefined;
  /** Undefined until read; the project's deploys. */
  deploys: ReadonlyArray<DeployRow> | undefined;
  /** Per run, what its stations found, proposed and built, and the argument a close made. */
  said: (runId: string) => RunSaid;
  /** A run's outcome in the reader's words. */
  outcome: (run: R) => O;
  /** The evidence the occurrence observed at `at` quoted, when the reader holds its text. */
  quoteAt?: (at: number) => string | null;
  /** The line profile's watch days, when known. */
  watchDays: number | null;
  now: number;
};

// ── helpers ──────────────────────────────────────────────────────────────────

const sameSha = (a: string | null | undefined, b: string | null | undefined) =>
  !!a && !!b && a.length >= 7 && b.length >= 7 && (a.startsWith(b) || b.startsWith(a));

const mergeOf = (run: HistoryRunRow): AttemptMerge | null => {
  const m = run.merge;
  if (!m?.sha) return null;
  return { sha: m.sha, branch: m.branch, into: m.into, at: m.at, prUrl: m.pr_url ?? null, repository: parsePrRef(m.pr_url)?.repository ?? null };
};

const deployTarget = (d: DeployRow) => d.surface ?? d.environment ?? null;

/** Environments no user reaches: a source that announces every boot (Union's api) also announces a laptop's. */
const NOT_LIVE_ENVIRONMENT = /^(local|localhost|dev|development|test|testing|ci|preview|staging)$/i;

/** Whether a deploy put code where users meet it, so it can carry a fix live. */
export const deployIsLive = (d: Pick<DeployRow, "environment">) => !d.environment || !NOT_LIVE_ENVIRONMENT.test(d.environment.trim());

/** The deploys that carried a merge: the first per live target at or after the merge, on the same code. */
export function carryingDeploys(merge: AttemptMerge, deploys: ReadonlyArray<DeployRow>, runId: string): HistoryDeploy[] {
  const byTarget = new Map<string, HistoryDeploy>();
  for (const d of [...deploys].sort((a, b) => a.at - b.at)) {
    if (!deployIsLive(d)) continue;
    const exact = sameSha(d.sha, merge.sha);
    const sameCode = !d.repository || !merge.repository || d.repository === merge.repository;
    if (!exact && !(sameCode && d.at >= merge.at)) continue;
    const key = deployTarget(d) ?? d.source;
    if (byTarget.has(key)) continue;
    byTarget.set(key, {
      id: d._id, at: d.at, sha: d.sha, target: deployTarget(d), version: d.version, source: d.source, title: d.title, url: d.url,
      runId, how: exact ? "same commit" : "deployed after the merge",
    });
  }
  return [...byTarget.values()];
}

function coverageOf(all: ReadonlyArray<DeployRow> | undefined): DeployCoverage {
  if (!all) return { state: "unread", targets: [], words: "Reading the project's deploys." };
  const deploys = all.filter(deployIsLive);
  if (!deploys.length) {
    return {
      state: "none",
      targets: [],
      words: "No deploy of this project is recorded, so when a fix went live is not known. Deploys are recorded by cast ship mark and by a source that reports them.",
    };
  }
  const targets = [...new Set(deploys.map((d) => deployTarget(d) ?? d.source))].sort();
  return { state: "known", targets, words: `Only ${andList(targets)} deploys are recorded.` };
}

/** The answer a decision was given, in the option's own words. */
export function decisionAnswerWords(d: Pick<HistoryDecisionRow, "answer_text" | "answer_index" | "options">): string | null {
  const raw = d.answer_text?.trim() || (d.answer_index != null ? d.options?.[d.answer_index]?.label : undefined) || null;
  return raw ? choiceWords(raw) : null;
}

function cardOf(runId: string, decisions: ReadonlyArray<HistoryDecisionRow>): { card: AttemptCard; diff: HistoryAttempt["diff"] } | null {
  const d = decisions
    .filter((x) => x.workflow_run_id === runId && (x.gate_node_id === CARD_GATE_NODE_ID || !!x.card))
    .sort((a, b) => (b.created_at ?? 0) - (a.created_at ?? 0))[0];
  if (!d) return null;
  const c = (d.card ?? null) as CardRow | null;
  const option = d.answer_index != null ? d.options?.[d.answer_index]?.label : undefined;
  const answer = d.status !== "answered" ? null : option ? choiceWords(option) : decisionAnswerWords(d);
  const text = d.answer_text?.trim() || null;
  const diff = c?.diff && typeof c.diff.files === "number"
    ? { files: c.diff.files, added: c.diff.added ?? 0, removed: c.diff.removed ?? 0, pr: c.diff.pr ?? null }
    : null;
  return {
    card: {
      decisionId: d._id,
      ref: d.short_id ?? null,
      headline: c?.headline?.trim() || null,
      change: c?.change?.trim() || null,
      wrong: c?.wrong?.trim() || null,
      recommend: c?.recommend ? { verdict: c.recommend.verdict, why: c.recommend.why?.trim() || null } : null,
      status: d.status,
      answer,
      note: text && text !== answer ? text : null,
      answeredAt: d.resolved_at ?? null,
    },
    diff,
  };
}

const watchDone = (run: HistoryRunRow): number | null => {
  const w = run.node_statuses?.find((n) => n.node_id === "watch" && n.status === "completed");
  return w ? w.completed_at ?? w.started_at ?? null : null;
};

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

// ── the history ──────────────────────────────────────────────────────────────

export function causeHistory<R extends HistoryRunRow, O extends AttemptOutcome>(input: HistoryInput<R, O>): CauseHistory<O> {
  const { task, decisions, now } = input;

  // ── occurrences ──
  const fromHistory = !!input.occurrences;
  const occurrences: Occurrence[] = input.occurrences
    ? (() => {
        const reopened = new Set(input.occurrences.reopened);
        return input.occurrences.observed.map((at) => ({ at, reopened: reopened.has(at) }));
      })()
    : input.signals.map((s) => ({ at: s.observed_at ?? s.created_at, reopened: !!s.reopened })).sort((a, b) => a.at - b.at);

  // ── attempts, oldest first ──
  const runs = [...input.runs].sort((a, b) => a.created_at - b.created_at);
  const newestStart = runs[runs.length - 1]?.created_at ?? 0;
  const attempts: HistoryAttempt<O>[] = runs.map((run, i) => {
    const live = isLiveRun(run);
    const ended = historyEnd(run);
    const card = cardOf(run._id, decisions);
    const said = input.said(run._id);
    return {
      runId: run._id,
      n: i + 1,
      start: run.created_at,
      end: live ? null : ended?.at ?? run.updated_at,
      live,
      outcome: input.outcome(run),
      ended: ended?.kind ?? null,
      endStep: ended ? closedAtStep(ended.node) : null,
      unapproved: !!ended?.unapproved,
      superseded: run.status === "failed" && run.created_at < newestStart,
      found: said.found,
      argued: ended && ended.kind !== "shipped" ? said.argued ?? null : null,
      proposed: card?.card.change ?? said.proposed,
      built: said.built,
      card: card?.card ?? null,
      diff: card?.diff ?? null,
      merge: mergeOf(run),
    };
  });

  // ── ships, merges and the deploys that carried them ──
  const coverage = coverageOf(input.deploys);
  const ships: HistoryShip[] = [];
  for (const a of attempts) {
    if (a.ended !== "shipped" && !a.merge) continue;
    const at = a.ended === "shipped" ? a.end ?? a.start : a.merge!.at;
    const deploys = a.merge && input.deploys ? carryingDeploys(a.merge, input.deploys, a.runId) : [];
    const firstDeploy = deploys.reduce<HistoryDeploy | null>((m, d) => (!m || d.at < m.at ? d : m), null);
    const basis: FixBasis = firstDeploy ? "deploy" : a.merge ? "merge" : "ship";
    const liveAt = firstDeploy?.at ?? a.merge?.at ?? at;
    const words = firstDeploy
      ? `Deployed ${deploys.map((d) => (d.target ? `to ${d.target}` : `by ${d.source}`)).join(" and ")} ${shortDay(firstDeploy.at)}`
      : a.merge
        ? coverage.state === "unread"
          ? `Merged ${shortDay(a.merge.at)}`
          : `Merged ${shortDay(a.merge.at)}; no deploy recorded since`
        : `Shipped ${shortDay(at)}; no merge recorded`;
    ships.push({ runId: a.runId, at, merge: a.merge, deploys, liveAt, basis, words: a.unapproved ? `${words}, past a card nobody answered` : words });
  }
  const deploys = ships.flatMap((s) => s.deploys).sort((a, b) => a.at - b.at);

  // ── closes: each fix going live, each dissolve and drop ──
  const closes: HistoryClose[] = [];
  for (const a of attempts) {
    const ship = ships.find((s) => s.runId === a.runId);
    if (ship) closes.push({ runId: a.runId, n: a.n, kind: "shipped", at: ship.liveAt, step: a.endStep, back: null });
    else if (!a.live && (a.ended === "dissolved" || a.ended === "dropped")) closes.push({ runId: a.runId, n: a.n, kind: a.ended, at: a.end ?? a.start, step: a.endStep, back: null });
  }
  closes.sort((a, b) => a.at - b.at);
  const shipAfter = (s: HistoryShip) => (s.basis === "deploy" ? `the deploy of ${shortDay(s.liveAt)}` : s.basis === "merge" ? `the merge of ${shortDay(s.liveAt)} (no deploy recorded)` : `the ship of ${shortDay(s.liveAt)} (no merge recorded)`);
  for (const c of closes) {
    const nextFix = closes.find((x) => x.kind === "shipped" && x.at > c.at)?.at ?? Infinity;
    const after = occurrences.filter((o) => o.at > c.at && o.at < nextFix);
    if (!after.length) continue;
    const what = c.kind === "shipped" ? shipAfter(ships.find((x) => x.runId === c.runId)!) : `attempt ${c.n} ${c.kind} it`;
    c.back = { at: after[0].at, count: after.length, words: `Came back ${timesWords(after.length)} after ${what}` };
  }

  // ── what came back after each close, until the next close: a regression after a fix, a recurrence after a close without one ──
  const regressions: HistoryRegression[] = [];
  const recurrences: HistoryRecurrence[] = [];
  for (const [i, c] of closes.entries()) {
    const next = closes[i + 1]?.at ?? null;
    const back = occurrences.filter((o) => o.at > c.at && o.at < (next ?? Infinity));
    if (!back.length) continue;
    const times = timesWords(back.length);
    let quote: string | null = null;
    for (const o of input.quoteAt ? back : []) if ((quote = input.quoteAt!(o.at))) break;
    if (c.kind === "shipped") {
      const s = ships.find((x) => x.runId === c.runId)!;
      regressions.push({ afterRunId: s.runId, at: back[0].at, count: back.length, basis: s.basis, liveAt: s.liveAt, until: next, words: `Came back ${times} after ${shipAfter(s)}`, quote });
    } else {
      recurrences.push({ afterRunId: c.runId, n: c.n, kind: c.kind, closedAt: c.at, at: back[0].at, count: back.length, until: next, words: `Came back ${times} after attempt ${c.n} ${c.kind} it`, quote });
    }
  }
  const latestClose = closes[closes.length - 1];
  const regressed = latestClose?.kind === "shipped" && regressions.some((r) => r.afterRunId === latestClose.runId);
  const cameBack = !!latestClose && latestClose.kind !== "shipped" && recurrences.some((r) => r.afterRunId === latestClose.runId);

  // ── watch windows ──
  const watches: HistoryWatch[] = [];
  for (const [i, run] of runs.entries()) {
    const start = watchDone(run);
    if (start == null) continue;
    const isLatest = !runs.slice(i + 1).some((r) => watchDone(r) != null);
    const planned = isLatest && task?.watch_until ? task.watch_until
      : isLatest && task?.resolved_at ? task.resolved_at
      : input.watchDays ? start + input.watchDays * DAY
      : null;
    const nextStart = runs[i + 1]?.created_at ?? null;
    const horizon = planned ?? nextStart ?? Infinity;
    const back = occurrences.find((o) => o.at > start && o.at <= horizon);
    const state: WatchState = back ? "reopened" : planned != null && planned <= now ? "quiet" : planned != null ? "watching" : "unknown";
    watches.push({ runId: run._id, start, end: back?.at ?? planned ?? nextStart, state, reopenedAt: back?.at ?? null });
  }

  const firstAt = occurrences[0]?.at ?? task?.cause?.first_seen ?? runs[0]?.created_at ?? null;
  const lastActivity = Math.max(
    occurrences[occurrences.length - 1]?.at ?? 0,
    ...attempts.map((a) => a.end ?? now),
    ...attempts.map((a) => a.start),
    ...deploys.map((d) => d.at),
    task?.cause?.last_seen ?? 0,
  );

  return {
    occurrences,
    occurrencesFrom: fromHistory ? "history" : "recent",
    since: input.occurrences?.since ?? occurrences[0]?.at ?? null,
    capped: input.occurrences?.capped ?? false,
    attempts,
    ships,
    deploys,
    coverage,
    watches,
    regressions,
    closes,
    recurrences,
    regressed,
    cameBack,
    firstAt,
    lastActivity,
  };
}

// ── LW5: the history as the next attempt is handed it ────────────────────────

/** The earlier shipped fixes a new attempt's card shows beside its own change
 *  (ChangeCard.earlier): what each changed, when it went live, and whether the
 *  problem came back after it. Oldest first; empty when nothing shipped. */
export type EarlierFix = { attempt: number; ref: string | null; change: string; live: string; held: string | null; back: string | null };

export function earlierFixes(h: CauseHistory<AttemptOutcome>, exceptRunId?: string): EarlierFix[] {
  const out: EarlierFix[] = [];
  for (const s of h.ships) {
    if (s.runId === exceptRunId) continue;
    const a = h.attempts.find((x) => x.runId === s.runId);
    const change = a?.card?.change ?? a?.proposed ?? a?.built ?? a?.card?.headline ?? null;
    if (!a || !change) continue;
    const back = h.regressions.find((r) => r.afterRunId === s.runId);
    const quiet = h.watches.some((w) => w.runId === s.runId && w.state === "quiet");
    out.push({
      attempt: a.n,
      ref: a.card?.ref ?? null,
      change: clip(change, 400),
      live: s.words,
      held: back ? null : quiet ? "The watch after it ended quiet." : null,
      back: back ? `${back.words}.` : null,
    });
  }
  return out;
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);

const CLOSE_WORDS: Record<HistoryRecurrence["kind"], { verb: string; how: string }> = {
  dissolved: { verb: "Dissolved", how: "as no fix needed" },
  dropped: { verb: "Dropped", how: "without a fix" },
};

const timesWords = (n: number) => (n === 1 ? "once" : `${n} times`);

/**
 * The closes without a change in one line, and whether each held: "Dissolved
 * 3x as no fix needed, all on Oct 7; it came back 3 times after the latest."
 * A close counts as not holding when the problem came back before the next
 * close, so three dissolves an hour apart are not "came back each time". Null
 * when no attempt closed the problem without a fix. The person's "Already
 * tried" and the next attempt's brief both read it, so a close that did not
 * hold is not repeated.
 */
export function closesSummary(h: Pick<CauseHistory<AttemptOutcome>, "closes" | "recurrences">): string | null {
  const out: string[] = [];
  const lastClose = h.closes[h.closes.length - 1];
  for (const kind of ["dissolved", "dropped"] as const) {
    const mine = h.closes.filter((c) => c.kind === kind);
    if (!mine.length) continue;
    const k = mine.length;
    const backOf = (c: HistoryClose) => h.recurrences.find((r) => r.afterRunId === c.runId && r.count > 0) ?? null;
    const j = mine.filter(backOf).length;
    const afterLast = lastClose?.kind === kind ? backOf(lastClose) : null;
    const days = new Set(mine.map((c) => shortDay(c.at)));
    const when = k > 1 && days.size === 1 ? `, all on ${[...days][0]}` : "";
    const tail = j === 0 ? "it has not come back since"
      : j === k ? (k === 1 ? `it came back ${timesWords(backOf(mine[0])!.count)}` : "it came back after each one")
      : afterLast ? (j === 1 ? `it came back ${timesWords(afterLast.count)} after the latest` : `it came back after ${j} of them, ${timesWords(afterLast.count)} after the latest`)
      : `it came back after ${j} of them`;
    out.push(`${CLOSE_WORDS[kind].verb} ${k === 1 ? "once" : `${k}x`} ${CLOSE_WORDS[kind].how}${when}; ${tail}.`);
  }
  return out.length ? out.join(" ") : null;
}

/** What a close argued, by family: closes that argued the same thing in other words ("in flight", "already fixed") are one argument. */
const ARGUMENTS: Record<string, { family: string; words: string }> = {
  in_flight: { family: "owned", words: "the fix is owned elsewhere" },
  already_fixed: { family: "owned", words: "the fix is owned elsewhere" },
  known_cause: { family: "known", words: "it belongs to another cause" },
};
const argumentOf = (kind: string) => ARGUMENTS[kind] ?? { family: kind, words: `it was ${kind.replace(/_/g, " ")}` };

/** Who a close said owns the fix: what it was folded into, else the change its own words name ("already fixed by the Oct 6 fee policy"), else the commit. */
function ownerOf(a: Pick<HistoryAttempt, "argued">): string | null {
  const into = a.argued?.into?.replace(/\s*\([^)]*\)\s*$/, "").trim() || null;
  if (into && !/^[0-9a-f]{7,40}$/i.test(into)) return into;
  return a.argued?.named ?? (into ? `commit ${into.slice(0, 7)}` : null);
}

/**
 * What every close without a change argued, when they all argued the same
 * thing and the problem came back anyway: "All 3 closes argued the fix is
 * owned elsewhere (xp-12, the Oct 6 fee policy); it kept happening, so that
 * argument is spent." The next attempt reads it so it does not close the
 * problem the same way again. Null when a close said no argument, the closes
 * argued different things, or nothing came back.
 */
export function closesArgument(h: Pick<CauseHistory<AttemptOutcome>, "closes" | "recurrences" | "attempts">): string | null {
  const closes = h.closes.filter((c) => c.kind !== "shipped");
  if (!closes.length || !h.recurrences.some((r) => r.count > 0 && closes.some((c) => c.runId === r.afterRunId))) return null;
  const attempts = closes.map((c) => h.attempts.find((a) => a.runId === c.runId));
  if (attempts.some((a) => !a?.argued)) return null;
  const args = attempts.map((a) => argumentOf(a!.argued!.kind));
  if (new Set(args.map((x) => x.family)).size > 1) return null;
  const owners = [...new Set(attempts.map((a) => ownerOf(a!)).filter((x): x is string => !!x))];
  const n = closes.length;
  const who = n === 1 ? "The close" : n === 2 ? "Both closes" : `All ${n} closes`;
  return `${who} argued ${args[0].words}${owners.length ? ` (${owners.join(", ")})` : ""}; it kept happening, so that argument is spent.`;
}

/** How many occurrences after a regression the brief quotes the times of. */
const BRIEF_EXAMPLE_TIMES = 3;

/** Parts as sentences: each ends with one stop, a quote's own stop included. */
const sentences = (parts: ReadonlyArray<string>) => parts.map((p) => (/[.!?]["”]?$/.test(p) ? p : `${p}.`)).join(" ");

/**
 * The cause's earlier attempts in words, for a person reading the next card
 * and for the stations that diagnose and propose (LW5): what each attempt
 * found, proposed and built, how its card was answered, what shipped and when
 * it went live, and whether the problem came back, with when. What came back
 * after the closes without a change is said once, after the list, with what
 * those closes argued. Empty when there is no earlier attempt to remember.
 */
export function historyBrief(h: CauseHistory<AttemptOutcome>, exceptRunId?: string, maxChars = Infinity): string {
  const done = h.attempts.filter((a) => !a.live && a.runId !== exceptRunId);
  if (!done.length) return "";
  // When it came back: every date when there are few, else the first; and one occurrence's own words.
  const cameBack = (r: { at: number; count: number }, quote: string | null) =>
    `${r.count <= BRIEF_EXAMPLE_TIMES ? `on ${andList(h.occurrences.filter((o) => o.at >= r.at).slice(0, r.count).map((o) => shortDay(o.at)))}` : `first on ${shortDay(r.at)}`}${quote ? `; one said: "${clip(quote, 300)}"` : ""}`;
  const lines: string[] = [];
  for (const a of done) {
    const ship = h.ships.find((s) => s.runId === a.runId);
    const close = h.closes.find((c) => c.runId === a.runId);
    const regression = close?.kind === "shipped" && close.back ? close.back : null;
    const quote = h.regressions.find((r) => r.afterRunId === a.runId)?.quote ?? null;
    // A close without a change shipped nothing: a guard its reasoning names (an eval, a test) is not in place.
    const unshipped = unshippedGuard(close?.kind, `${a.found ?? ""} ${a.proposed ?? ""} ${a.built ?? ""}`);
    const parts = [
      `Attempt ${a.n} (${shortDay(a.start)}): ${a.outcome.text}`,
      a.found && `Found: ${clip(a.found, 600)}`,
      a.proposed && `Proposed: ${clip(a.proposed, 600)}`,
      a.built && `Built: ${clip(a.built, 600)}`,
      a.card?.answer && `Card answered ${a.card.answer}${a.card.note ? `: "${clip(a.card.note, 300)}"` : ""}`,
      a.diff && `Diff: ${plural(a.diff.files, "file")}, +${a.diff.added} -${a.diff.removed}${a.diff.pr ? ` (${a.diff.pr})` : ""}`,
      a.merge && `Merged ${a.merge.sha.slice(0, 10)} into ${a.merge.into}`,
      ship && ship.words,
      unshipped && "Nothing shipped with this close: any eval or guard it mentions was never shipped, so nothing guards against it",
      regression ? `${regression.words}, ${cameBack(regression, quote)}` : null,
      regression ? "That fix did not hold"
        : ship && h.watches.find((w) => w.runId === a.runId && w.state === "quiet") ? "The watch after it ended quiet" : null,
    ].filter((x): x is string => !!x);
    lines.push(`- ${sentences(parts)}`);
  }
  // What came back after the closes without a change, once: a run of closes with nothing between them is one span.
  const back: string[] = [];
  for (const r of h.recurrences) {
    if (!r.count || r.afterRunId === exceptRunId) continue;
    const at = h.closes.findIndex((c) => c.runId === r.afterRunId);
    let first = at;
    while (first > 0 && h.closes[first - 1].kind !== "shipped" && !h.recurrences.some((x) => x.afterRunId === h.closes[first - 1].runId && x.count > 0)) first--;
    const span = h.closes.slice(first, at + 1);
    const who = span.length > 1 ? `attempts ${span[0].n} to ${span[span.length - 1].n}` : `attempt ${r.n}`;
    const verb = span.every((c) => c.kind === r.kind) ? r.kind : "closed";
    back.push(`Came back ${timesWords(r.count)} after ${who} ${verb} it, ${cameBack(r, r.quote)}`);
  }
  if (back.length) back.push(back.length > 1 ? "Closing it without a change never held: the reasoning that closed it was wrong" : "Closing it did not hold: the reasoning that closed it was wrong");
  const argued = closesArgument(h);
  const tail = back.length ? [sentences(back), ...(argued ? [argued] : [])] : [];
  const closed = back.length ? null : closesSummary(h);
  // Over the budget, the oldest attempts go first: the newest are what the next one most needs.
  let dropped = 0;
  const head = () => [`This cause has had ${plural(done.length, "earlier attempt")}.${closed ? ` ${closed}` : ""}${dropped ? ` The oldest ${dropped === 1 ? "one is" : `${dropped} are`} left out for length.` : ""}`];
  const text = () => [...head(), ...lines.slice(dropped), ...tail].join("\n");
  while (text().length > maxChars && dropped < lines.length - 1) dropped++;
  return text();
}
