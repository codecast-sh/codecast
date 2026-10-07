// One thing followed through the line (docs/architecture/line-map.md LX4): any
// ref the line knows (a signal, a fingerprint, a cause task, a run, a card
// decision) resolves to its cause, and the cause's story reads as one step per
// stage: finding, group, cause, ground, each run station by station (loops
// drawn as rounds), card, ship, watch, outcome. A step with nothing yet says
// what it waits on. `pathNodeIds` is the same story as map node ids (lineMap),
// repeated where the cause looped, so the map can draw the path. Pure: no
// store, no React. Station words come from runReport, so a run reads the same
// here as on its own page.
import { CARD_GATE_NODE_ID, lineRunOutcome, type LineRunEnd } from "@codecast/shared/contracts/changeCard";
import { isExpectationId } from "@codecast/shared/contracts/expectations";
import { quietWatchEnd, type LineCauseTask } from "../lineFlow";
import {
  CAUSES_NODE, EXPECTATIONS_NODE, SIGNALS_NODE, endNodeId, rawAnswer, runVisits, sourceNodeId,
  type LineGraph, type MapDecision, type MapEnd, type MapRun, type MapSignal,
} from "./lineMap";
import { cardName, causeWhere, choiceWords, isRoutineStation, runOutcome, runPath, shortDay, type ReportRun, type ReportStep, type ReportTask, type RunOutcome, type StepState } from "./runReport";
import { SHIPPED_LINE } from "./shippedLine.generated";

export type TraceTask = LineCauseTask & { review_verdict?: { verdict: string } | null };
export type TraceRows = { signals: MapSignal[]; tasks: TraceTask[]; runs: MapRun[]; decisions: MapDecision[] };

// ── resolving a ref ──────────────────────────────────────────────────────────

export type TraceRefKind = "cause" | "signal" | "fingerprint" | "run" | "decision";
export type ResolvedTrace = { cause: TraceTask; via: TraceRefKind; focusId: string };

/**
 * The cause any ref names (LX4): a task's id or short id, a signal's id or
 * short id, a fingerprint (a signal's, or one the cause row keeps), a run id,
 * a decision's id or short id. Null when the rows hold no cause for it.
 */
export function resolveTraceRef(ref: string, rows: TraceRows): ResolvedTrace | null {
  const key = ref.trim();
  if (!key) return null;
  const taskById = new Map(rows.tasks.map((t) => [t._id, t]));
  const hit = (taskId: string | null | undefined, via: TraceRefKind, focusId: string): ResolvedTrace | null => {
    const cause = taskId ? taskById.get(taskId) : undefined;
    return cause ? { cause, via, focusId } : null;
  };
  const task = rows.tasks.find((t) => t._id === key || t.short_id === key);
  if (task) return { cause: task, via: "cause", focusId: task._id };
  const signal = rows.signals.find((s) => s._id === key || s.short_id === key);
  if (signal) return hit(signal.task_id, "signal", signal._id);
  const run = rows.runs.find((r) => r._id === key);
  if (run) return hit(run.task_id, "run", run._id);
  const decision = rows.decisions.find((d) => d._id === key || d.short_id === key);
  if (decision) return hit(decision.task_id ?? rows.runs.find((r) => r._id === decision.workflow_run_id)?.task_id, "decision", decision._id);
  // A fingerprint: the newest signal carrying it, else the cause that keeps it.
  const fp = rows.signals.filter((s) => s.fingerprint === key).sort((a, b) => b.created_at - a.created_at)[0];
  if (fp) return hit(fp.task_id, "fingerprint", fp._id);
  const holder = rows.tasks.find((t) => t.cause?.fingerprints?.includes(key));
  return holder ? { cause: holder, via: "fingerprint", focusId: holder._id } : null;
}

// ── the story ────────────────────────────────────────────────────────────────

export type TraceStage = "finding" | "group" | "cause" | "ground" | "station" | "card" | "ship" | "watch" | "outcome";
/** current: the cause is at this step now (a run working it, a card waiting
 *  on a person, a watch running). waiting: the step has not happened, and its
 *  detail says what it waits on. */
export type TraceStatus = "done" | "current" | "waiting" | "failed" | "skipped";
export type TraceLink = { label: string; href: string; external?: boolean };
/** What a step produced: the session that did it, a decision, where a finding
 *  was seen, the expectation it breaks, a sibling signal. `ref` is a trace ref. */
export type TraceArtifact = { kind: "session" | "decision" | "evidence" | "expectation" | "signal"; label: string; href?: string; ref?: string };

export type TraceStep = {
  id: string;
  stage: TraceStage;
  title: string;
  at: number | null;
  durationMs: number | null;
  status: TraceStatus;
  detail: string;
  links: TraceLink[];
  artifacts: TraceArtifact[];
  /** The map node this step happened at (lineMap ids). */
  nodeId: string | null;
  runId?: string;
  /** Which run on the cause, from 1, for a station step. */
  round?: number;
  /** An earlier visit of a loop: the line keeps details for the newest only. */
  inferred?: boolean;
};

export type TraceOutcome = "held" | "reopened" | "dissolved" | "dropped" | "parked" | "stopped" | "open";
export type LineTrace = {
  cause: TraceTask;
  via: TraceRefKind;
  focusId: string;
  /** The signal the finding step tells (the focus, else the cause's first), so the story can show its full words. */
  focusSignalId: string | null;
  steps: TraceStep[];
  /** The path on the map, in order; a loop repeats its stations. */
  pathNodeIds: string[];
  outcome: TraceOutcome;
  /** Where the cause is now, in one sentence (runReport causeWhere). */
  where: RunOutcome;
};

export type TraceOpts = {
  now: number;
  graph?: LineGraph | null;
  /** Who answered a decision, by name ("Ashot Petrosian"), when the caller knows. */
  answeredBy?: (d: MapDecision) => string | null | undefined;
  /** A goal by its name ("Matching that lands"), when the caller knows it; else its ref. */
  goalName?: (ref: string) => string | null | undefined;
};

/** How a signal joined its cause (signals.attach), as a sentence. */
const ATTACH_WORDS: Record<string, string> = {
  fingerprint: "It joined by its fingerprint",
  judge: "The judge read it as the same problem and joined it",
  new: "It opened this cause",
  person: "A person filed it here",
};

/** A signal's kind (shared SIGNAL_KINDS) as words in a sentence. */
const KIND_WORDS: Record<string, string> = { bug: "a bug", regression: "a regression", prompt_miss: "a prompt miss", ux: "a UX problem", cohesion: "a cohesion problem", request: "a request" };
const kindWords = (kind: string) => KIND_WORDS[kind] ?? kind.replace(/_/g, " ");

/** Markdown's inline marks taken off, so a finder's words read as words. */
export const plainWords = (s: string) => s.replace(/(\*\*|__)(.+?)\1/g, "$2").replace(/`([^`]+)`/g, "$1").replace(/\[([^\]]+)\]\([^)]+\)/g, "$1").replace(/^[>*-]\s+/, "").trim();
/** The first line of prose in a finder's markdown: headings are its labels, not its words. */
const firstLine = (s: string | null | undefined): string | null => {
  const line = s?.split("\n").map((l) => l.trim()).find((l) => l && !l.startsWith("#"));
  return line ? plainWords(line) || null : null;
};
/** What the finder saw, in its words: when the finding breaks an expectation,
 *  the finder's markdown opens with that expectation's own sentence
 *  ("**<line>** (severity 7/10, <id>)"), which the title and the Breaks chip
 *  already say, so the words are the first line after it (LX4). */
const finderWords = (md: string | null | undefined, breaks: string | null): string | null => {
  if (!md || !breaks) return firstLine(md);
  const lines = md.split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));
  const own = lines.filter((l) => !(l.startsWith("**") && l.includes(breaks)));
  return firstLine(own.join("\n")) ?? firstLine(md);
};
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const isLive = (r: { status: string }) => r.status === "running" || r.status === "paused" || r.status === "pending";
const STATUS_OF: Record<StepState, TraceStatus> = { done: "done", noted: "done", failed: "failed", live: "current", waiting: "current" };
const taskHref = (t: { _id: string; short_id?: string }) => `/tasks/${t.short_id || t._id}`;

/** The answer a decision was given, in the option's own words. */
export function decisionAnswer(d: MapDecision): string | null {
  const raw = rawAnswer(d);
  return raw ? choiceWords(raw) : null;
}

export function buildLineTrace(resolved: ResolvedTrace | TraceTask, rows: TraceRows, opts: TraceOpts): LineTrace {
  const { cause, via, focusId } = "cause" in resolved && "via" in resolved ? resolved : { cause: resolved, via: "cause" as const, focusId: resolved._id };
  const { now } = opts;
  const graph = opts.graph?.nodes?.length ? opts.graph : SHIPPED_LINE;
  const labelOf = (id: string) => graph.nodes.find((n) => n.id === id)?.label ?? SHIPPED_LINE.nodes.find((n) => n.id === id)?.label ?? id;
  const steps: TraceStep[] = [];
  const path: string[] = [];

  const signals = rows.signals.filter((s) => s.task_id === cause._id).sort((a, b) => a.created_at - b.created_at);
  const runs = rows.runs.filter((r) => r.task_id === cause._id).sort((a, b) => a.created_at - b.created_at);
  const runIds = new Set(runs.map((r) => r._id));
  const decisions = rows.decisions
    .filter((d) => d.task_id === cause._id || (!!d.workflow_run_id && runIds.has(d.workflow_run_id)))
    .sort((a, b) => (a.created_at ?? 0) - (b.created_at ?? 0));
  const latest = runs[runs.length - 1] ?? null;

  // ── finding ──
  const focus = signals.find((s) => s._id === focusId) ?? signals[0] ?? null;
  if (focus) {
    const breaks = isExpectationId(focus.subject) ? focus.subject : null;
    if (breaks) path.push(EXPECTATIONS_NODE);
    path.push(sourceNodeId(focus.source), SIGNALS_NODE);
    steps.push({
      id: `finding:${focus._id}`, stage: "finding", title: focus.title, at: focus.observed_at, durationMs: null, status: "done",
      detail: finderWords(focus.detail_md, breaks) ?? `${focus.source} filed ${kindWords(focus.kind)}`,
      links: focus.evidence_url ? [{ label: "Where it was seen", href: focus.evidence_url, external: /^https?:/.test(focus.evidence_url) }] : [],
      artifacts: [
        { kind: "signal", label: `${focus.source} · ${focus.kind.replace(/_/g, " ")}`, ref: focus.short_id || focus._id },
        ...(breaks ? [{ kind: "expectation" as const, label: `Breaks ${breaks}`, ref: breaks }] : []),
      ],
      nodeId: sourceNodeId(focus.source),
    });
  } else {
    steps.push({ id: "finding:none", stage: "finding", title: "No signal on record", at: null, durationMs: null, status: "skipped", detail: "The cause was filed directly, not from a finder", links: [], artifacts: [], nodeId: null });
  }

  // ── group ──
  const siblings = signals.filter((s) => s !== focus);
  if (focus) {
    // The same finding seen again but filed to another cause (LX4: other
    // signals with the same fingerprint), so a duplicate cause is visible here.
    const elsewhere = focus.fingerprint
      ? [...new Set(rows.signals.filter((s) => s.fingerprint === focus.fingerprint && s.task_id && s.task_id !== cause._id).map((s) => s.task_id!))]
          .map((id) => rows.tasks.find((t) => t._id === id) ?? null)
      : [];
    const elsewhereRefs = elsewhere.filter((t): t is NonNullable<typeof t> => !!t);
    const sources = [...new Set(signals.map((s) => s.source))];
    const fingerprints = cause.cause?.fingerprints ?? [];
    const how = ATTACH_WORDS[focus.attach ?? ""];
    steps.push({
      id: "group", stage: "group",
      // The headline never contradicts the detail: a finding filed to other
      // causes is "seen before", not "only this signal" (LX4).
      title: siblings.length
        ? `${plural(signals.length, "signal")} share this cause`
        : elsewhere.length ? `Seen before: filed to ${plural(elsewhere.length, "other cause")} too` : "Only this signal so far",
      at: siblings.length ? siblings[siblings.length - 1].created_at : focus.created_at, durationMs: null, status: "done",
      detail: [
        how,
        sources.length > 1 ? `From ${sources.slice(0, -1).join(", ")} and ${sources[sources.length - 1]}` : null,
        fingerprints.length > 1 ? `${fingerprints.length} fingerprints point here` : null,
        elsewhere.length && siblings.length ? `The same finding also opened ${plural(elsewhere.length, "other cause")}` : null,
      ].filter(Boolean).join(". "),
      links: elsewhereRefs.map((t) => ({ label: `Open ${t.short_id || "the other cause"}`, href: taskHref(t) })),
      artifacts: siblings.map((s) => ({ kind: "signal" as const, label: s.title, ref: s.short_id || s._id, ...(s.evidence_url ? { href: s.evidence_url } : {}) })),
      nodeId: SIGNALS_NODE,
    });
  }

  // ── cause ──
  path.push(CAUSES_NODE);
  steps.push({
    id: "cause", stage: "cause", title: cause.title, at: cause.created_at, durationMs: null, status: "done",
    detail: [cause.category, cause.risk && `${cause.risk} risk`, cause.readiness && cause.readiness.replace(/_/g, " ")].filter(Boolean).join(" · ") || "Not rated yet",
    links: [{ label: cause.short_id ? `Open ${cause.short_id}` : "Open the task", href: taskHref(cause) }],
    artifacts: [], nodeId: CAUSES_NODE,
  });

  // ── ground ──
  const groundVisit = runs.flatMap((r) => (r.node_statuses ?? []).filter((n) => n.node_id === "ground").map((n) => ({ r, n })))[0];
  const grounded = !!cause.goal_ref || !!cause.readiness;
  const groundStep = groundVisit && runPath(groundVisit.r as ReportRun, graph, cause).flatMap((p) => p.steps).find((s) => s.id === "ground");
  steps.push({
    id: "ground", stage: "ground", title: "Ground",
    at: groundVisit?.n.started_at ?? null,
    durationMs: groundVisit?.n.started_at != null && groundVisit.n.completed_at != null ? groundVisit.n.completed_at - groundVisit.n.started_at : null,
    status: grounded ? "done" : groundStep ? STATUS_OF[groundStep.state] : "waiting",
    detail: grounded
      ? [cause.goal_ref ? (cause.goal_ref === "none" ? "Serves no goal yet" : `Serves ${opts.goalName?.(cause.goal_ref) || cause.goal_ref}`) : null, cause.readiness_note?.trim()].filter(Boolean).join(". ")
      : groundStep ? groundStep.result : "Waiting to be admitted: the line grounds a cause when a run starts on it",
    links: [], artifacts: sessionArtifacts(groundStep), nodeId: graph.nodes.some((n) => n.id === "ground") ? "ground" : null,
  });

  // ── each run, station by station ──
  let lastShip: { run: MapRun; at: number } | null = null;
  runs.forEach((run, i) => {
    const round = i + 1;
    if (i > 0) path.push(CAUSES_NODE);
    const report = new Map(runPath(run as ReportRun, graph, cause).flatMap((p) => [...p.steps, ...p.routine]).map((s) => [s.id, s]));
    for (const [j, v] of runVisits(run, graph, decisions).entries()) {
      path.push(v.node);
      if (v.node === "ground") continue;
      const s = report.get(v.node);
      // The newest visit of a station is the one the run row keeps.
      const newest = !v.inferred && s;
      steps.push({
        id: `${run._id}:${v.node}:${j}`, stage: "station", title: s?.label ?? labelOf(v.node),
        at: v.inferred ? null : v.startedAt ?? v.at,
        durationMs: v.startedAt != null && v.completedAt != null ? v.completedAt - v.startedAt : null,
        status: newest ? STATUS_OF[newest.state] : STATUS_OF[v.state],
        detail: newest ? [newest.result, newest.note].filter(Boolean).join(": ") : "An earlier round: the line keeps the details of a station's newest visit only",
        links: [], artifacts: newest ? sessionArtifacts(s) : [],
        nodeId: v.node, runId: run._id, round, ...(v.inferred ? { inferred: true } : {}),
      });
    }
    const end = lineRunOutcome(run.node_statuses);
    if (end?.kind === "shipped") lastShip = { run, at: end.at };
    const reopenedAfter = end?.kind === "shipped" && signals.some((s) => s.reopened && s.created_at > end.at);
    const tail = runTail(end?.kind ?? null, run, reopenedAfter, i === runs.length - 1);
    path.push(...tail);
  });

  // ── card ──
  const cards = decisions.filter((d) => d.gate_node_id === CARD_GATE_NODE_ID);
  for (const d of cards) {
    const answer = decisionAnswer(d);
    const waiting = d.status === "pending";
    const who = answer ? opts.answeredBy?.(d) : null;
    const why = d.card?.recommend?.why?.trim().replace(/[.\s]+$/, "");
    const recommend = d.card?.recommend ? `Recommends ${d.card.recommend.verdict}${why ? `: ${why}` : ""}` : null;
    steps.push({
      id: `card:${d._id}`, stage: "card", title: cardName(answer, d.card, waiting), at: d.created_at ?? null,
      durationMs: d.resolved_at != null && d.created_at != null ? d.resolved_at - d.created_at : waiting && d.created_at != null ? now - d.created_at : null,
      status: waiting ? "current" : d.status === "answered" ? "done" : "skipped",
      detail: [recommend, answer ? `${who ?? "Answered"}${who ? " answered" : ""} ${answer}${d.resolved_at ? ` ${shortDay(d.resolved_at)}` : ""}` : waiting ? "Waiting for an answer" : `The card was ${d.status}`].filter(Boolean).join(". "),
      links: d.short_id ? [{ label: "Open the card", href: `/decisions/${d.short_id}` }] : [],
      artifacts: [], nodeId: CARD_GATE_NODE_ID, ...(d.workflow_run_id ? { runId: d.workflow_run_id } : {}),
    });
  }
  const finalEnd = latest ? lineRunOutcome(latest.node_statuses)?.kind ?? null : null;
  if (cards.length === 0) {
    // A run that reached the card while the store holds no decision row still says what was answered.
    const answered = [...runs].reverse().find((r) => r.gate_node_id === CARD_GATE_NODE_ID && (r.gate_answer || r.status === "paused"));
    if (answered) {
      const waiting = answered.status === "paused" && !answered.gate_answer;
      steps.push({
        id: `card:${answered._id}`, stage: "card", title: cardName(answered.gate_answer ? choiceWords(answered.gate_answer) : null, null, waiting), at: null, durationMs: null,
        status: waiting ? "current" : "done", detail: waiting ? "Waiting for an answer" : "",
        links: answered.gate_decision_short_id ? [{ label: "Open the card", href: `/decisions/${answered.gate_decision_short_id}` }] : [],
        artifacts: [], nodeId: CARD_GATE_NODE_ID, runId: answered._id,
      });
    } else {
      steps.push(pending("card", "Card", closedBefore(finalEnd) ? "skipped" : "waiting", closedBefore(finalEnd) ? `No card: ${endWords(finalEnd!)}` : "Waiting for a card: it is written once the change passes review", CARD_GATE_NODE_ID));
    }
  }

  // ── ship ──
  const ship = lastShip as { run: MapRun; at: number } | null;
  if (ship) {
    const report = runPath(ship.run as ReportRun, graph, cause).flatMap((p) => p.steps);
    // What landed where: the merge when the line merged (or left it to a
    // person), else the project's own ship command's line.
    const landed = report.find((s) => s.id === "merge") ?? report.find((s) => s.id === "ship");
    const visit = (ship.run.node_statuses ?? []).find((n) => n.node_id === (landed?.id ?? "ship"));
    steps.push({
      id: "ship", stage: "ship", title: runOutcome(ship.run as ReportRun, cause, now, true).text.replace(/\.$/, ""),
      at: visit?.completed_at ?? ship.at, durationMs: visit?.started_at != null && visit.completed_at != null ? visit.completed_at - visit.started_at : null,
      status: "done", detail: landed ? [landed.result, landed.note].filter(Boolean).join(": ") : "",
      links: landed?.href ? [{ label: landed.hrefTitle ?? "Open", href: landed.href }] : [], artifacts: [], nodeId: landed?.id ?? "ship",
    });
  } else {
    const closed = closedBefore(finalEnd);
    const cardWaits = cards.some((d) => d.status === "pending");
    steps.push(pending("ship", "Ship", closed ? "skipped" : "waiting", closed ? `Not shipped: ${endWords(finalEnd!)}` : cardWaits ? "Waiting for the card's answer" : "Not shipped yet", "ship"));
  }

  // ── watch ──
  const watchNode = graph.nodes.find((n) => n.id === "watch") ? "watch" : null;
  const reopenedBy = ship ? signals.filter((s) => s.reopened && s.created_at > ship.at) : [];
  // The watch on the last ship ended quiet (LE12), swept or not yet: the map's held.
  const quiet = quietWatchEnd(cause, now);
  const held = ship && !reopenedBy.length && quiet != null && quiet >= ship.at ? quiet : null;
  if (ship) {
    const after = signals.filter((s) => s.created_at > ship.at);
    const until = cause.watch_until ?? null;
    const status: TraceStatus = reopenedBy.length ? "failed" : until && until > now ? "current" : "done";
    const ended = reopenedBy[0]?.created_at ?? held ?? (until && until <= now ? until : null);
    steps.push({
      id: "watch", stage: "watch",
      title: reopenedBy.length ? `Its signal came back ${shortDay(reopenedBy[0].created_at)}` : status === "current" ? `Watching until ${shortDay(until!)}` : "The watch ended quiet",
      at: ship.at, durationMs: (ended ?? now) - ship.at, status,
      detail: after.length ? `${plural(after.length, "signal")} since the ship` : status === "current" ? "No signal since the ship" : "No signal came back",
      links: [], artifacts: reopenedBy.map((s) => ({ kind: "signal" as const, label: s.title, ref: s.short_id || s._id })), nodeId: watchNode,
    });
  } else {
    steps.push(pending("watch", "Watch", closedBefore(finalEnd) ? "skipped" : "waiting", closedBefore(finalEnd) ? "Nothing shipped to watch" : "Waiting for the ship: the watch starts when the change lands", watchNode));
  }

  // ── outcome ──
  const reopened = reopenedBy.length > 0 && (cause.status === "open" || cause.status === "backlog");
  const where = causeWhere(cause as ReportTask, (latest as ReportRun | null) ?? null, reopened, now);
  const outcome: TraceOutcome = reopened ? "reopened"
    : finalEnd === "dissolved" ? "dissolved"
    : finalEnd === "dropped" || cause.status === "dropped" ? "dropped"
    : finalEnd === "parked" && !isLive(latest!) ? "parked"
    : held != null ? "held"
    // A run that ended with no end station (failed, cancelled, rejected at
    // review, not shipped, unscored): the map counts it at Stopped.
    : latest && !isLive(latest) && !finalEnd ? "stopped"
    : "open";
  const OUTCOME: Record<TraceOutcome, { title: string; status: TraceStatus; end: MapEnd | null }> = {
    held: { title: "Held: the fix stayed fixed through its watch", status: "done", end: "held" },
    reopened: { title: "Reopened: its signal came back during the watch", status: "failed", end: "reopened" },
    dissolved: { title: "Dissolved: the problem did not reproduce", status: "done", end: "dissolved" },
    dropped: { title: "Dropped", status: "done", end: "dropped" },
    parked: { title: "Parked: not ready to build", status: "waiting", end: null },
    stopped: { title: "The last run stopped before a change landed", status: "failed", end: "stopped" },
    open: { title: "No outcome yet", status: "waiting", end: null },
  };
  const o = OUTCOME[outcome];
  if (o.end && path[path.length - 1] !== endNodeId(o.end)) path.push(endNodeId(o.end));
  steps.push({
    id: "outcome", stage: "outcome", title: o.title,
    at: outcome === "held" ? held : outcome === "reopened" ? reopenedBy[0].created_at : outcome === "open" || outcome === "parked" ? null : cause.closed_at ?? latest?.updated_at ?? null,
    durationMs: cause.cause?.first_seen && (outcome === "held" || outcome === "dissolved" || outcome === "dropped") ? ((outcome === "held" ? held : null) ?? cause.closed_at ?? now) - cause.cause.first_seen : null,
    status: o.status, detail: where.text, links: [], artifacts: [], nodeId: o.end ? endNodeId(o.end) : null,
  });

  return { cause, via, focusId, focusSignalId: focus?._id ?? null, steps, pathNodeIds: path, outcome, where };
}

/** Where the path goes after one run, before the next run or the outcome. */
function runTail(end: LineRunEnd | null, run: MapRun, reopened: boolean, last: boolean): string[] {
  if (end === "dissolved") return [endNodeId("dissolved")];
  if (end === "dropped") return [endNodeId("dropped")];
  // Parked goes back to the queue; the next run, or the outcome, picks it up there.
  if (end === "parked") return [];
  if (end === "shipped") return reopened ? [endNodeId("reopened")] : [];
  if (!isLive(run) && !last) return [endNodeId("stopped")];
  return [];
}

const closedBefore = (end: LineRunEnd | null) => end === "dissolved" || end === "dropped" || end === "parked";
const endWords = (end: LineRunEnd) => (end === "dissolved" ? "the problem did not reproduce" : end === "dropped" ? "the cause was dropped" : end === "parked" ? "the cause was parked, not ready to build" : "it shipped");

function pending(stage: TraceStage, title: string, status: TraceStatus, detail: string, nodeId: string | null): TraceStep {
  return { id: stage, stage, title, at: null, durationMs: null, status, detail, links: [], artifacts: [], nodeId };
}

function sessionArtifacts(s: ReportStep | undefined | null | false): TraceArtifact[] {
  if (!s || !s.href) return [];
  if (s.href.startsWith("/conversation/")) return [{ kind: "session", label: s.hrefTitle ?? "Open the session", href: s.href }];
  if (s.href.startsWith("/decisions/")) return [{ kind: "decision", label: s.hrefTitle ?? "Open the decision", href: s.href }];
  return [];
}

// ── the story's blocks, for a reader ─────────────────────────────────────────

/** One row of a run in the story: a station visit, or an earlier round of a
 *  loop the run row kept no details for, folded into one row. `visit` counts
 *  the station's visits in this run, from 1, so a second implement says so.
 *  `routine` marks a step that only assembles the card. */
export type TraceRunRow =
  | { kind: "station"; step: TraceStep; visit: number; routine: boolean }
  | { kind: "loop"; steps: TraceStep[]; stations: string[] };

export type TraceBlock =
  | { kind: "step"; step: TraceStep }
  | { kind: "run"; runId: string; round: number; rows: TraceRunRow[]; status: TraceStatus; at: number | null; durationMs: number | null; rounds: number };

/**
 * The story as a reader takes it (LX4): the stage steps one by one, and each
 * run as one block of its stations followed by the card it wrote, where an earlier round of a loop folds
 * into one row naming the stations it went through, and a station visited
 * again says which visit it is.
 */
export function traceBlocks(trace: Pick<LineTrace, "steps">): TraceBlock[] {
  const out: TraceBlock[] = [];
  // A card follows the run that wrote it, so a later run reads after its card.
  const runIds = new Set(trace.steps.flatMap((s) => (s.stage === "station" && s.runId ? [s.runId] : [])));
  const cardsOf = new Map<string, TraceStep[]>();
  for (const s of trace.steps) if (s.stage === "card" && s.runId && runIds.has(s.runId)) cardsOf.set(s.runId, [...(cardsOf.get(s.runId) ?? []), s]);
  const placed = new Set([...cardsOf.values()].flat());
  const steps: TraceStep[] = [];
  for (const [i, s] of trace.steps.entries()) {
    if (placed.has(s)) continue;
    steps.push(s);
    const next = trace.steps[i + 1];
    if (s.stage === "station" && s.runId && (next?.stage !== "station" || next.runId !== s.runId)) steps.push(...(cardsOf.get(s.runId) ?? []));
  }
  for (const step of steps) {
    if (step.stage !== "station" || !step.runId) { out.push({ kind: "step", step }); continue; }
    let block = out[out.length - 1];
    if (block?.kind !== "run" || block.runId !== step.runId) {
      block = { kind: "run", runId: step.runId, round: step.round ?? 1, rows: [], status: "done", at: null, durationMs: null, rounds: 1 };
      out.push(block);
    }
    const last = block.rows[block.rows.length - 1];
    if (step.inferred) {
      if (last?.kind === "loop") { last.steps.push(step); if (!isRoutineStation(step.nodeId ?? "")) last.stations.push(step.title); }
      else block.rows.push({ kind: "loop", steps: [step], stations: isRoutineStation(step.nodeId ?? "") ? [] : [step.title] });
      continue;
    }
    const visit = block.rows.reduce((n, r) => n + (r.kind === "station" ? (r.step.nodeId === step.nodeId ? 1 : 0) : r.steps.filter((s) => s.nodeId === step.nodeId).length), 1);
    block.rows.push({ kind: "station", step, visit, routine: isRoutineStation(step.nodeId ?? "") });
  }
  for (const b of out) {
    if (b.kind !== "run") continue;
    const timed = b.rows.flatMap((r) => (r.kind === "station" ? [r.step] : []));
    const first = timed.find((s) => s.at != null)?.at ?? null;
    const lastTimed = [...timed].reverse().find((s) => s.at != null);
    b.at = first;
    b.durationMs = first != null && lastTimed?.at != null ? lastTimed.at + (lastTimed.durationMs ?? 0) - first : null;
    b.rounds = 1 + b.rows.filter((r) => r.kind === "loop").length;
    b.status = timed.some((s) => s.status === "current") ? "current" : timed[timed.length - 1]?.status === "failed" ? "failed" : "done";
  }
  return out;
}
