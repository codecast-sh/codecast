// A cause's life over time (line-workspace.md LW1 Timeline, LW5): how often
// its problem happened, every attempt to fix it, what shipped and merged,
// the deploys that carried each merge, the watch after it, and the
// occurrences that came back after a fix went out (a regression). Pure: the
// line model (lineModel.ts) calls it once per cause and every view reads the
// answer from there.
//
// What codecast cannot know, it says. A deploy is known only when someone
// records it (`cast ship mark`, which packages/convex/deploy.sh runs, or a
// source that reports deploys); a merge with no recorded deploy after it is
// "merged, deploy not recorded", never assumed live. A regression is measured
// from the deploy that carried the fix when one is known, else from the merge,
// else from the ship step, and says which.
import { CARD_GATE_NODE_ID, type LineRunEnd } from "@codecast/shared/contracts/changeCard";
import { parsePrRef } from "@codecast/shared/contracts";
import type { LineCauseTask } from "../lineFlow";
import type { MapDecision, MapRun, MapSignal } from "./lineMap";
import { decisionAnswer } from "./lineTrace";
import { choiceWords, isLiveRun, runEnd, runOutcome, shortDay, type ReportRun, type ReportTask, type RunOutcome } from "./runReport";

const DAY = 24 * 60 * 60 * 1000;

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

export type HistoryAttempt = {
  runId: string;
  /** 1 for the cause's first attempt. */
  n: number;
  start: number;
  /** Null while the run is live. */
  end: number | null;
  live: boolean;
  outcome: RunOutcome;
  /** How the run ended: shipped, dropped, dissolved, parked; null when it stopped short of an end or is live. */
  ended: LineRunEnd | null;
  /** A later attempt replaced this one after it failed. */
  superseded: boolean;
  /** What the attempt found, proposed and built, in its stations' own words. */
  found: string | null;
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

export type HistoryRegression = {
  /** The shipped attempt whose fix the problem came back after. */
  afterRunId: string;
  /** The first occurrence after the fix went live, and how many came after it before the next fix. */
  at: number;
  count: number;
  basis: FixBasis;
  liveAt: number;
  /** "Came back 3 times after the deploy of Oct 9". */
  words: string;
};

/** What codecast knows about the project's deploys: "unread" while the deploys have not arrived, "none" when nothing is recorded. */
export type DeployCoverage = { state: "unread" | "none" | "known"; targets: string[]; words: string };

export type CauseHistory = {
  occurrences: Occurrence[];
  /** "history": the cause's full series (lineWorkspace.occurrences); "recent": the two weeks of signals the store holds. */
  occurrencesFrom: "history" | "recent";
  /** The earliest time the series covers, and whether older occurrences were left out. */
  since: number | null;
  capped: boolean;
  attempts: HistoryAttempt[];
  ships: HistoryShip[];
  deploys: HistoryDeploy[];
  coverage: DeployCoverage;
  watches: HistoryWatch[];
  regressions: HistoryRegression[];
  /** The newest fix's problem came back: the cause is regressed now. */
  regressed: boolean;
  firstAt: number | null;
  lastActivity: number;
};

export type HistoryInput = {
  task: LineCauseTask | undefined;
  /** The cause's runs, any graph, newest first. */
  runs: ReadonlyArray<MapRun>;
  decisions: ReadonlyArray<MapDecision>;
  signals: ReadonlyArray<MapSignal>;
  occurrences: OccurrenceRow | undefined;
  /** Undefined until read; the project's deploys newest first. */
  deploys: ReadonlyArray<DeployRow> | undefined;
  /** Per run, what its stations found, proposed and built (the model reads them off the visits). */
  said: (runId: string) => { found: string | null; proposed: string | null; built: string | null };
  /** The line profile's watch days, when known. */
  watchDays: number | null;
  now: number;
};

// ── helpers ──────────────────────────────────────────────────────────────────

const sameSha = (a: string | null | undefined, b: string | null | undefined) =>
  !!a && !!b && a.length >= 7 && b.length >= 7 && (a.startsWith(b) || b.startsWith(a));

const mergeOf = (run: MapRun): AttemptMerge | null => {
  const m = (run as MapRun & { merge?: RunMergeRow | null }).merge;
  if (!m?.sha) return null;
  return { sha: m.sha, branch: m.branch, into: m.into, at: m.at, prUrl: m.pr_url ?? null, repository: parsePrRef(m.pr_url)?.repository ?? null };
};

const deployTarget = (d: DeployRow) => d.surface ?? d.environment ?? null;

/** The deploys that carried a merge: the first per target at or after the merge, on the same code. */
export function carryingDeploys(merge: AttemptMerge, deploys: ReadonlyArray<DeployRow>, runId: string): HistoryDeploy[] {
  const byTarget = new Map<string, HistoryDeploy>();
  for (const d of [...deploys].sort((a, b) => a.at - b.at)) {
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

function coverageOf(deploys: ReadonlyArray<DeployRow> | undefined): DeployCoverage {
  if (!deploys) return { state: "unread", targets: [], words: "Reading the project's deploys." };
  if (!deploys.length) {
    return {
      state: "none",
      targets: [],
      words: "No deploy of this project is recorded, so when a fix went live is not known. Deploys are recorded by cast ship mark and by a source that reports them.",
    };
  }
  const targets = [...new Set(deploys.map((d) => deployTarget(d) ?? d.source))].sort();
  return { state: "known", targets, words: `Deploys recorded for ${targets.join(", ")}; anything else that deploys is not.` };
}

function cardOf(runId: string, decisions: ReadonlyArray<MapDecision>): { card: AttemptCard; diff: HistoryAttempt["diff"] } | null {
  const d = decisions
    .filter((x) => x.workflow_run_id === runId && (x.gate_node_id === CARD_GATE_NODE_ID || !!x.card))
    .sort((a, b) => (b.created_at ?? 0) - (a.created_at ?? 0))[0];
  if (!d) return null;
  const c = (d.card ?? null) as CardRow | null;
  const option = d.answer_index != null ? d.options?.[d.answer_index]?.label : undefined;
  const answer = d.status !== "answered" ? null : option ? choiceWords(option) : decisionAnswer(d);
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

const watchDone = (run: MapRun): number | null => {
  const w = run.node_statuses?.find((n) => n.node_id === "watch" && n.status === "completed");
  return w ? w.completed_at ?? w.started_at ?? null : null;
};

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

// ── the history ──────────────────────────────────────────────────────────────

export function causeHistory(input: HistoryInput): CauseHistory {
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
  const attempts: HistoryAttempt[] = runs.map((run, i) => {
    const live = isLiveRun(run);
    const ended = runEnd(run as ReportRun);
    const card = cardOf(run._id, decisions);
    const said = input.said(run._id);
    return {
      runId: run._id,
      n: i + 1,
      start: run.created_at,
      end: live ? null : ended?.at ?? run.updated_at,
      live,
      outcome: runOutcome(run as ReportRun, task as ReportTask | undefined, now, true),
      ended: ended?.kind ?? null,
      superseded: run.status === "failed" && run.created_at < newestStart,
      found: said.found,
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
    ships.push({ runId: a.runId, at, merge: a.merge, deploys, liveAt, basis, words });
  }
  const deploys = ships.flatMap((s) => s.deploys).sort((a, b) => a.at - b.at);

  // ── regressions: occurrences after a fix went live, until the next fix ──
  const regressions: HistoryRegression[] = [];
  for (const [i, s] of ships.entries()) {
    const until = ships[i + 1]?.liveAt ?? Infinity;
    const back = occurrences.filter((o) => o.at > s.liveAt && o.at < until);
    if (!back.length) continue;
    const after = s.basis === "deploy" ? `the deploy of ${shortDay(s.liveAt)}` : s.basis === "merge" ? `the merge of ${shortDay(s.liveAt)} (no deploy recorded)` : `the ship of ${shortDay(s.liveAt)} (no merge recorded)`;
    regressions.push({ afterRunId: s.runId, at: back[0].at, count: back.length, basis: s.basis, liveAt: s.liveAt, words: `Came back ${back.length === 1 ? "once" : `${back.length} times`} after ${after}` });
  }
  const latestShip = ships[ships.length - 1];
  const regressed = !!latestShip && regressions.some((r) => r.afterRunId === latestShip.runId);

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
    regressed,
    firstAt,
    lastActivity,
  };
}

// ── LW5: the history as the next attempt is handed it ────────────────────────

/**
 * The cause's earlier attempts in words, for a person reading the next card
 * and for the stations that diagnose and propose (LW5): what each attempt
 * found, proposed and built, how its card was answered, what shipped and when
 * it went live, and whether the problem came back. Empty when there is no
 * earlier attempt to remember.
 */
export function historyBrief(h: CauseHistory): string {
  const done = h.attempts.filter((a) => !a.live);
  if (!done.length) return "";
  const lines: string[] = [`This cause has had ${plural(done.length, "earlier attempt")}.`];
  for (const a of done) {
    const ship = h.ships.find((s) => s.runId === a.runId);
    const back = h.regressions.find((r) => r.afterRunId === a.runId);
    const parts = [
      `Attempt ${a.n} (${shortDay(a.start)}): ${a.outcome.text}`,
      a.found && `Found: ${a.found}`,
      a.proposed && `Proposed: ${a.proposed}`,
      a.built && `Built: ${a.built}`,
      a.card?.answer && `Card answered ${a.card.answer}${a.card.note ? `: "${a.card.note}"` : ""}`,
      a.diff && `Diff: ${plural(a.diff.files, "file")}, +${a.diff.added} -${a.diff.removed}${a.diff.pr ? ` (${a.diff.pr})` : ""}`,
      a.merge && `Merged ${a.merge.sha.slice(0, 10)} into ${a.merge.into}`,
      ship && ship.words,
      back ? `${back.words}. That fix did not hold.` : ship && h.watches.find((w) => w.runId === a.runId && w.state === "quiet") ? "The watch after it ended quiet." : null,
    ].filter(Boolean);
    lines.push(`- ${parts.join(". ").replace(/\.\./g, ".")}`);
  }
  if (h.regressed) lines.push("The newest fix did not hold: explain why it failed before proposing anything, and do not propose the same change again.");
  return lines.join("\n");
}
