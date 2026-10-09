// One thing followed through the line (docs/architecture/line-map.md LX4): any
// ref the line knows (a signal, a fingerprint, a cause task, a run, a card
// decision) resolves to its cause, and the cause's story reads as one step per
// stage: finding, group, cause, ground, each run station by station (loops
// drawn as rounds), card, ship, watch, outcome. A step with nothing yet says
// what it waits on. `pathNodeIds` is the same story as map node ids (lineMap),
// repeated where the cause looped, so the map can draw the path. Pure: no
// store, no React. Station words come from runReport, so a run reads the same
// here as on its own page.
import { CARD_GATE_NODE_ID, type LineRunEnd } from "@codecast/shared/contracts/changeCard";
import { isExpectationId } from "@codecast/shared/contracts/expectations";
import { LINE_PROFILE_DEFAULTS } from "@codecast/shared/contracts/lineProfile";
import { ageShort, quietWatchEnd, type LineCauseTask } from "../lineFlow";
import {
  CAUSES_NODE, END_LABEL, EXPECTATIONS_NODE, SIGNALS_NODE, endNodeId, graphRunEnd, rawAnswer, runVisits, sourceNodeId,
  type LineGraph, type MapDecision, type MapEnd, type MapRun, type MapSignal,
} from "./lineMap";
import { cardName, causeWhere, choiceWords, stepLabel, closedGate, isLiveRun, isRoutineStation, loopedStation, runEnd, runOutcome, runPath, shortDay, type ReportRun, type ReportStep, type ReportTask, type RunOutcome, type StepState } from "./runReport";
import { SHIPPED_LINE } from "./shippedLine.generated";
import { lineTraceHref } from "./lineMapUrl";

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
 *  detail says what it waits on. noted: it happened and ended neither passed
 *  nor failed (a card taken back, a station stopped by hand), drawn neutral. */
export type TraceStatus = "done" | "current" | "waiting" | "failed" | "skipped" | "noted";
/** `ref` is the short id of what the link opens, when it names a task, so a
 *  list can show both; `note` is where it lives and its state ("Agent Quality, open"). */
export type TraceLink = {
  label: string; href: string; external?: boolean; ref?: string; note?: string;
  /** Another cause's project and state apart, and whether it was filed before this one, so a twin title can say "filed earlier in X". */
  project?: string; state?: string; earlier?: boolean;
};
/** What a step produced: the session that did it, a decision, where a finding
 *  was seen, the expectation it breaks, a sibling signal. `ref` is a trace ref. */
export type TraceArtifact = { kind: "session" | "decision" | "evidence" | "expectation" | "signal"; label: string; href?: string; ref?: string; /** Reports this row stands for, when several said the same thing. */ count?: number };

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
  /** A card step's own headline, so the header can name the card it asks you to answer. */
  headline?: string;
  /** How many times the station ran in its run, when the run's stop says
   *  more than its rows show ("Implement looped three times" on one row). */
  visits?: number;
};

export type TraceOutcome = "held" | "reopened" | "dissolved" | "dropped" | "parked" | "stopped" | "open";
/** How one run on the cause ended, and the station it stopped at.
 *  replaced: it reached a card, and the card was withdrawn because a newer
 *  run started before anyone answered (LX4). Its steps passed, so it is not
 *  a stop: the line threw a good change away, and the story says so. */
/** approved: a person answered Ship on its card and the run has not started
 *  its ship step yet; it waits on the line, not on a person, and is not working. */
export type TraceRunEnd = "working" | "approved" | "waiting" | "shipped" | "closed" | "parked" | "stopped" | "replaced";
export type TraceRun = {
  runId: string; round: number; end: TraceRunEnd; at: string | null;
  /** For a replaced run: the run that replaced it, and what started that run when the line knows ("a new AgentWatch signal joined the cause"). */
  by?: number; why?: string | null;
};
export type LineTrace = {
  cause: TraceTask;
  via: TraceRefKind;
  focusId: string;
  /** The signal the finding step tells (the focus, else the cause's first), so the story can show its full words. */
  focusSignalId: string | null;
  steps: TraceStep[];
  /** The path on the map, in order; a loop repeats its stations. */
  pathNodeIds: string[];
  /** Each path node's name as the map labels it, for the trace's path strip. */
  pathLabels: Record<string, string>;
  outcome: TraceOutcome;
  /** Where the cause is now, in one sentence (runReport causeWhere); when a
   *  newer run builds while an older run's card is open, it says both. The
   *  header, the outcome step and the strip's ring all read this one value. */
  where: RunOutcome;
  /** The map node the cause is at now (the newest run's station, else an open card), for the strip to ring. */
  hereNodeId: string | null;
  /** The run `where` speaks about, when it names one, so the header can link it. */
  whereRun: { runId: string; round: number } | null;
  /** The run answered Ship that nothing drives (shipStall), so the header can
   *  offer to resume it where it stands (its answer kept), or, when it cannot
   *  be resumed, to start the line on the cause again. */
  stalledRun: { runId: string; round: number; resumable: boolean } | null;
  /** Every run on the cause, oldest first, by how it ended. */
  runs: TraceRun[];
};

export type TraceOpts = {
  now: number;
  graph?: LineGraph | null;
  /** Who answered a decision, by name ("Ashot Petrosian"), when the caller knows. */
  answeredBy?: (d: MapDecision) => string | null | undefined;
  /** A goal by its name ("Matching that lands"), when the caller knows it; else its ref. */
  goalName?: (ref: string) => string | null | undefined;
  /** A project by its name ("Agent Quality"), so another cause reads by where it lives. */
  projectName?: (id: string) => string | null | undefined;
  /** The project's watch days, when the caller knows them; else the profile default. */
  watchDays?: number | null;
};

/** Finders by the names their products use. */
const FINDER_NAMES: Record<string, string> = { agentwatch: "AgentWatch", posthog: "PostHog", sentry: "Sentry", evals: "Evals" };
export const finderName = (source: string | null | undefined) => (source ? FINDER_NAMES[source.toLowerCase()] ?? `${source[0].toUpperCase()}${source.slice(1)}` : "A source");

/** A task's status as a reader says it. */
const TASK_STATE: Record<string, string> = { backlog: "open", open: "open", in_progress: "in progress", in_review: "in review", done: "done", dropped: "dropped" };
/** A cause's readiness (tasks.readiness) in words. */
const READINESS: Record<string, string> = { ready: "ready to start", needs_context: "needs context", not_actionable: "not actionable" };
/** A sentence that ends in a period, once. */
const sentence = (s: string) => (s && !/[.!?:]$/.test(s) ? `${s}.` : s);

/** How a signal joined its cause (signals.attach), as a sentence. */
const ATTACH_WORDS: Record<string, string> = {
  fingerprint: "It matched a cause already open, so it joined it",
  judge: "A reviewer read it as the same problem and joined it",
  new: "It was the first report of this cause",
  person: "It was moved here from another cause",
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
const STATUS_OF: Record<StepState, TraceStatus> = { done: "done", noted: "noted", failed: "failed", live: "current", waiting: "current" };
const taskHref = (t: { _id: string; short_id?: string }) => `/tasks/${t.short_id || t._id}`;

/** The answer a decision was given, in the option's own words. */
export function decisionAnswer(d: MapDecision): string | null {
  const raw = rawAnswer(d);
  return raw ? choiceWords(raw) : null;
}

export function buildLineTrace(resolved: ResolvedTrace | TraceTask, rows: TraceRows, opts: TraceOpts): LineTrace {
  const { cause, via, focusId } = "cause" in resolved && "via" in resolved ? resolved : { cause: resolved, via: "cause" as const, focusId: resolved._id };
  const { now } = opts;
  const graph: LineGraph = opts.graph?.nodes?.length ? opts.graph : SHIPPED_LINE;
  const labelOf = (id: string) => stepLabel({ id, label: graph.nodes.find((n) => n.id === id)?.label ?? SHIPPED_LINE.nodes.find((n) => n.id === id)?.label });
  const steps: TraceStep[] = [];
  const path: string[] = [];
  // How a run ended, one reading for every part of the story (the summary,
  // the header, Ship, Outcome): a foreign graph by its own terminal steps
  // (lineMap graphRunEnd), else the ends every graph shares (runReport runEnd).
  const endOf = (run: MapRun): { kind: LineRunEnd; at: number } | null => {
    const own = graph.ends ? graphRunEnd(run, graph) : null;
    return own && own.kind !== "stopped" ? { kind: own.kind, at: own.at } : runEnd(run as ReportRun);
  };

  const signals = rows.signals.filter((s) => s.task_id === cause._id).sort((a, b) => a.created_at - b.created_at);
  const runs = rows.runs.filter((r) => r.task_id === cause._id).sort((a, b) => a.created_at - b.created_at);
  const runIds = new Set(runs.map((r) => r._id));
  const decisions = rows.decisions
    .filter((d) => d.task_id === cause._id || (!!d.workflow_run_id && runIds.has(d.workflow_run_id)))
    .sort((a, b) => (a.created_at ?? 0) - (b.created_at ?? 0));
  const latest = runs[runs.length - 1] ?? null;
  // The newest run, live at its card with Ship answered and no ship step
  // started: approved, waiting on the line (LX4). Read from the card's
  // decision, else the answer the run row keeps.
  const approved = latest && isLiveRun(latest) ? shipApproval(latest, decisions) : null;

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
    steps.push({ id: "finding:none", stage: "finding", title: "No signal on record", at: null, durationMs: null, status: "skipped", detail: "The problem was filed directly, not reported by a source", links: [], artifacts: [], nodeId: null });
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
    // A finding that also opened other causes says so, and those causes read
    // by where they live, so near-identical titles are told apart (LX4).
    const how = elsewhere.length && focus.attach === "new" ? null : ATTACH_WORDS[focus.attach ?? ""];
    steps.push({
      id: "group", stage: "group",
      // The headline never contradicts the detail: a finding filed to other
      // causes is "seen before", not "only this signal" (LX4).
      title: siblings.length
        ? `${plural(signals.length, "report")} of this cause`
        : elsewhere.length ? `Seen before: also filed to ${plural(elsewhere.length, "other cause")}` : "The only report so far",
      at: siblings.length ? siblings[siblings.length - 1].created_at : focus.created_at, durationMs: null, status: "done",
      detail: [
        how,
        sources.length > 1 ? `From ${sources.slice(0, -1).join(", ")} and ${sources[sources.length - 1]}` : null,
        elsewhere.length ? `The same ${finderName(focus.source)} finding also opened:` : null,
      ].filter(Boolean).join(". "),
      // The other causes by what they are and where they live, each opening its own trace.
      links: elsewhereRefs.map((t) => {
        const project = (t as { project_id?: string | null }).project_id;
        const projectName = project ? opts.projectName?.(project) ?? null : null;
        const taskState = TASK_STATE[t.status] ?? t.status.replace(/_/g, " ");
        const note = [projectName, taskState].filter(Boolean).join(", ");
        return {
          label: t.title || t.short_id || "Another cause", href: t.short_id ? lineTraceHref(t.short_id) : taskHref(t), ...(t.short_id ? { ref: t.short_id } : {}), ...(note ? { note } : {}),
          ...(projectName ? { project: projectName } : {}), state: taskState, earlier: (t.created_at ?? 0) < (cause.created_at ?? 0),
        };
      }),
      // Reports that say the same thing are one row with a count, newest first.
      artifacts: groupReports(siblings),
      nodeId: SIGNALS_NODE,
    });
  }

  // ── cause ──
  path.push(CAUSES_NODE);
  // Once runs have started, the cause's state is its runs, never the stored
  // readiness it was admitted with ("on its 7th run", not "ready to start").
  const state = runs.length
    ? latest && isLiveRun(latest) ? `on its ${ordinal(runs.length)} run` : `${plural(runs.length, "run")} so far`
    : cause.readiness && (READINESS[cause.readiness] ?? cause.readiness.replace(/_/g, " "));
  steps.push({
    id: "cause", stage: "cause", title: cause.title, at: cause.created_at, durationMs: null, status: "done",
    detail: [cause.category, cause.risk && `${cause.risk} risk`, state].filter(Boolean).join(" · ") || "Not rated yet",
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
  const runEnds: TraceRun[] = [];
  runs.forEach((run, i) => {
    const round = i + 1;
    if (i > 0) path.push(CAUSES_NODE);
    const report = new Map(runPath(run as ReportRun, graph, cause).flatMap((p) => [...p.steps, ...p.routine]).map((s) => [s.id, s]));
    const visits = runVisits(run, graph, decisions);
    // A run stopped for looping names how often its station ran; the rows keep fewer.
    const looped = loopedStation(run as ReportRun);
    const loopRows = looped ? visits.filter((v) => v.node === looped.node).length : 0;
    for (const [j, v] of visits.entries()) {
      // The path is drawn on today's map: a station the line has since lost
      // (an old run's merge) keeps its story step but no place on the path.
      // A foreign graph's terminal step is its end on the map, which the run's tail draws.
      const onMap = graph.nodes.some((n) => n.id === v.node) && !graph.ends?.[v.node];
      if (onMap) path.push(v.node);
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
        nodeId: onMap ? v.node : null, runId: run._id, round, ...(v.inferred ? { inferred: true } : {}),
        ...(newest && looped?.node === v.node && looped.times > loopRows ? { visits: looped.times } : {}),
      });
    }
    const end = endOf(run);
    if (end?.kind === "shipped") lastShip = { run, at: end.at };
    const replaced = !isLiveRun(run) && !end ? replacedBy(run, round, runs, decisions, signals) : null;
    const runEnd: TraceRunEnd = isLiveRun(run) ? (run.status === "paused" ? "waiting" : run === latest && approved ? "approved" : "working")
      : end?.kind === "shipped" ? "shipped" : end?.kind === "dissolved" || end?.kind === "dropped" ? "closed" : end?.kind === "parked" ? "parked" : replaced ? "replaced" : "stopped";
    const stopAt = runEnd === "stopped" ? stoppedAt(run) : null;
    runEnds.push({ runId: run._id, round, end: runEnd, at: stopAt ? labelOf(stopAt) : null, ...(replaced ? { by: replaced.by, why: replaced.why } : {}) });
    const reopenedAfter = end?.kind === "shipped" && signals.some((s) => s.reopened && s.created_at > end.at);
    // A replaced run goes back to the queue for the run that replaced it, never to Stopped.
    const tail = replaced ? [] : runTail(end?.kind ?? null, run, reopenedAfter, i === runs.length - 1);
    path.push(...tail);
  });

  // ── card ──
  const cards = decisions.filter((d) => d.gate_node_id === CARD_GATE_NODE_ID);
  const roundOf = (runId: string | null | undefined) => (runId ? runs.findIndex((r) => r._id === runId) + 1 : 0);
  for (const d of cards) {
    const answer = decisionAnswer(d);
    const waiting = d.status === "pending";
    const who = answer ? opts.answeredBy?.(d) : null;
    const why = d.card?.recommend?.why?.trim().replace(/[.\s]+$/, "");
    const recommend = d.card?.recommend ? `Recommends ${d.card.recommend.verdict}${why ? `: ${why}` : ""}` : null;
    steps.push({
      id: `card:${d._id}`, stage: "card", title: cardName(answer, d.card, waiting), at: d.created_at ?? null,
      durationMs: d.resolved_at != null && d.created_at != null ? d.resolved_at - d.created_at : waiting && d.created_at != null ? now - d.created_at : null,
      // A card taken back or dismissed ended without an answer: finished, neutral.
      status: waiting ? "current" : d.status === "answered" ? "done" : "noted",
      detail: [recommend, answer ? `${who ?? "Answered"}${who ? " answered" : ""} ${answer}${d.resolved_at ? ` ${shortDay(d.resolved_at)}` : ""}` : waiting ? "Waiting for an answer" : unansweredWords(d, runs, roundOf(d.workflow_run_id), runEnds)].filter((x): x is string => !!x).map(sentence).join(" "),
      links: d.short_id ? [{ label: "Open the decision", href: `/decisions/${d.short_id}` }] : [],
      artifacts: [], nodeId: CARD_GATE_NODE_ID, ...(d.workflow_run_id ? { runId: d.workflow_run_id } : {}),
      ...(d.card?.headline?.trim() || d.card?.change?.trim() ? { headline: cardName(null, d.card, false) } : {}),
    });
  }
  const finalEnd = latest ? endOf(latest)?.kind ?? null : null;
  if (cards.length === 0) {
    // A run that reached the card while the store holds no decision row still says what was answered.
    const answered = [...runs].reverse().find((r) => r.gate_node_id === CARD_GATE_NODE_ID && (r.gate_answer || r.status === "paused"));
    if (answered) {
      const waiting = answered.status === "paused" && !answered.gate_answer;
      steps.push({
        id: `card:${answered._id}`, stage: "card", title: cardName(answered.gate_answer ? choiceWords(answered.gate_answer) : null, null, waiting), at: null, durationMs: null,
        status: waiting ? "current" : "done", detail: waiting ? "Waiting for an answer." : "",
        links: answered.gate_decision_short_id ? [{ label: "Open the decision", href: `/decisions/${answered.gate_decision_short_id}` }] : [],
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
      links: landed?.href ? [{ label: landed.hrefTitle ?? "Open", href: landed.href }] : [], artifacts: [], nodeId: landed && graph.nodes.some((n) => n.id === landed.id) ? landed.id : "ship",
    });
  } else {
    // Titled by what it waits on: the kicker already says Ship.
    const closed = closedBefore(finalEnd);
    const cardWaits = cards.some((d) => d.status === "pending");
    steps.push(closed ? pending("ship", "Not shipped", "skipped", sentence(`${endWords(finalEnd!)[0].toUpperCase()}${endWords(finalEnd!).slice(1)}`), "ship")
      // A stall is said once, in the header (where); the step keeps a short title.
      : approved ? (shipStall(latest!, approved, now)
        ? pending("ship", "Waiting for a runner since you answered Ship", "waiting", "", "ship")
        : pending("ship", "Waiting for the ship step to start", "waiting", `${approvedWords(approved, now)}; run ${runs.length} has not started the ship step.`, "ship"))
      : cardWaits ? pending("ship", "Waiting for your decision", "waiting", "The change ships when a person decides Ship.", "ship")
      : pending("ship", "Not shipped yet", "waiting", "A change ships once a person decides Ship.", "ship"));
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
    steps.push(closedBefore(finalEnd)
      ? pending("watch", "Nothing shipped to watch", "skipped", "", watchNode)
      : pending("watch", "Waiting for the change to land", "waiting", "Once it ships, the line watches for the problem to come back.", watchNode));
  }

  // ── outcome ──
  const reopened = reopenedBy.length > 0 && (cause.status === "open" || cause.status === "backlog");
  // Where it is now, one value for the header, the outcome step and the strip.
  // A newer run can be building while an older run's card still waits on a
  // person; then both are said outright, since answering ships the older change.
  let where = causeWhere(cause as ReportTask, (latest as ReportRun | null) ?? null, reopened, now);
  const openCard = [...cards].reverse().find((d) => d.status === "pending") ?? null;
  const openRound = roundOf(openCard?.workflow_run_id);
  let hereNodeId: string | null = null;
  let whereRun: LineTrace["whereRun"] = null;
  let stalledRun: LineTrace["stalledRun"] = null;
  if (latest && approved) {
    // The card was answered: the cause waits on the ship step, not on Decide.
    hereNodeId = CARD_GATE_NODE_ID;
    whereRun = { runId: latest._id, round: runs.length };
    // Past the usual pickup the wait is trouble, said in the warning tone with what the run shows (LX4).
    const stall = shipStall(latest, approved, now);
    where = { tone: stall ? "stuck" : "waiting", end: null, text: stall ? `${approvedWords(approved, now)}, but run ${runs.length} ${stall}.` : `${approvedWords(approved, now)}; the ship step has not started.` };
    // A live run standing at a node continues there on its machine (cli
    // runResume.ts); only a run with nowhere to stand is started over.
    if (stall) stalledRun = { ...whereRun, resumable: isLiveRun(latest) && !!latest.current_node_id };
  } else if (latest && isLiveRun(latest)) {
    hereNodeId = (latest.status === "paused" ? latest.gate_node_id : null) ?? latest.current_node_id ?? null;
    if (openCard && openRound && openRound !== runs.length && hereNodeId) {
      const card = openCard.short_id ? `Decision ${openCard.short_id}` : "A decision";
      const at = latest.status === "pending" ? "is queued to start" : `is at ${labelOf(hereNodeId)}`;
      where = { tone: "waiting", end: null, text: `Run ${runs.length} ${at}. ${card} from run ${openRound} is still open; answering Ship ships run ${openRound}'s change.` };
    } else if (latest.status === "running" && runs.length > 1 && hereNodeId) {
      // Several runs: name the one working, as the summary counts them.
      where = { ...where, text: `Run ${runs.length} is at ${labelOf(hereNodeId)}.` };
      whereRun = { runId: latest._id, round: runs.length };
    }
  } else if (openCard) hereNodeId = CARD_GATE_NODE_ID;
  const outcome: TraceOutcome = reopened ? "reopened"
    : finalEnd === "dissolved" ? "dissolved"
    : finalEnd === "dropped" || cause.status === "dropped" ? "dropped"
    : finalEnd === "parked" && !isLiveRun(latest!) ? "parked"
    : held != null ? "held"
    // A run that ended with no end station (failed, cancelled, rejected at
    // review, not shipped, unscored): the map counts it at Stopped.
    : latest && !isLiveRun(latest) && !finalEnd ? "stopped"
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
  // Shipped and still in its watch: the outcome is known when the watch ends.
  const watching = outcome === "open" && !!ship && !reopenedBy.length && (cause.watch_until ?? 0) > now;
  const o = watching ? { ...OUTCOME.open, title: "Shipped, being watched" } : OUTCOME[outcome];
  if (o.end && path[path.length - 1] !== endNodeId(o.end)) path.push(endNodeId(o.end));
  steps.push({
    id: "outcome", stage: "outcome", title: o.title,
    at: outcome === "held" ? held : outcome === "reopened" ? reopenedBy[0].created_at : outcome === "open" || outcome === "parked" ? null : cause.closed_at ?? latest?.updated_at ?? null,
    durationMs: cause.cause?.first_seen && (outcome === "held" || outcome === "dissolved" || outcome === "dropped") ? ((outcome === "held" ? held : null) ?? cause.closed_at ?? now) - cause.cause.first_seen : null,
    // An approved change has not shipped yet: the outcome says when it will be
    // known, not the header's wait again.
    status: o.status, detail: watching ? `Known when the watch ends ${shortDay(cause.watch_until!)}: held if the problem stays away, reopened if it comes back` : outcome === "open" && approved ? `Known about ${plural(opts.watchDays ?? LINE_PROFILE_DEFAULTS.watch_days, "day")} after it ships` : where.text, links: [], artifacts: [], nodeId: o.end ? endNodeId(o.end) : null,
  });

  const pathLabels: Record<string, string> = {};
  for (const id of path) {
    pathLabels[id] = id === EXPECTATIONS_NODE ? "Expectations" : id === SIGNALS_NODE ? "Signals" : id === CAUSES_NODE ? "Causes"
      : id.startsWith("source:") ? (signals.find((s) => sourceNodeId(s.source) === id)?.source ?? id.slice(7))
      : id.startsWith("end:") ? END_LABEL[id.slice(4) as MapEnd] ?? id
      : labelOf(id);
  }
  return { cause, via, focusId, focusSignalId: focus?._id ?? null, steps, pathNodeIds: path, pathLabels, outcome, where, hereNodeId, whereRun, stalledRun, runs: runEnds };
}

/** A live run's Ship answer, when its ship step has not started: when it
 *  was answered (null when the run row keeps the answer without its time). */
type ShipApproval = { at: number | null };
function shipApproval(run: MapRun, decisions: MapDecision[]): ShipApproval | null {
  if (run.status !== "running" || run.current_node_id !== CARD_GATE_NODE_ID) return null;
  if ((run.node_statuses ?? []).some((n) => (n.node_id === "ship" || n.node_id === "merge") && (n.started_at != null || n.status !== "pending"))) return null;
  const card = [...decisions].reverse().find((d) => d.workflow_run_id === run._id && d.gate_node_id === CARD_GATE_NODE_ID && d.status === "answered");
  const raw = card ? rawAnswer(card) : run.gate_answer ?? null;
  if (!raw || !/^ship$/i.test(choiceWords(raw))) return null;
  return { at: card?.resolved_at ?? null };
}

/** A runner picks an answered card up within seconds; this long with nothing is a stall. */
const SHIP_STALL_MS = 15 * 60_000;

/** Why an approved run has not started its ship step, in what the run row
 *  shows: it has reported nothing since the answer, so nothing is driving it
 *  (the runner that asked has stopped). Null while it is still early. */
function shipStall(run: MapRun, a: ShipApproval, now: number): string | null {
  const last = Math.max(run.updated_at ?? 0, a.at ?? 0);
  if (!last || now - last < SHIP_STALL_MS) return null;
  return `has reported nothing in ${ageShort(now - last)}: no runner is driving it`;
}

/** "You answered Ship 5h ago": the approval and the time since it. */
const approvedWords = (a: ShipApproval, now: number) => `You answered Ship${a.at != null ? ` ${ageShort(Math.max(0, now - a.at))} ago` : ""}`;

/** The station a stopped run stopped at: where the runner left it, else the
 *  gate whose question was taken back, else its last failed station. */
function stoppedAt(run: MapRun): string | null {
  const cur = run.current_node_id;
  if (cur && cur !== "exit" && cur !== "start") return cur;
  if (closedGate(run) && run.gate_node_id) return run.gate_node_id;
  const failed = (run.node_statuses ?? []).filter((n) => n.status === "failed").sort((a, b) => (b.completed_at ?? b.started_at ?? 0) - (a.completed_at ?? a.started_at ?? 0))[0];
  return failed?.node_id ?? null;
}

/** Why a card ended without an answer, in the facts the line holds: who
 *  closed it, and the run that replaced it when one did (the run's own end,
 *  so the card and its run say the same thing). */
function unansweredWords(d: MapDecision, runs: MapRun[], round: number, ends: TraceRun[]): string {
  if (d.status === "dismissed") return "A person dismissed the decision without answering";
  if (d.status !== "withdrawn") return `The decision was ${d.status}`;
  const end = ends.find((e) => e.round === round);
  if (end?.end === "shipped") return "This decision was withdrawn without an answer here, and the run went on to ship";
  if (end?.end === "replaced") return `The decision was withdrawn before anyone answered it: run ${end.by} started and replaced it${end.why ? `. ${sentence(end.why)}` : ""}`;
  const next = d.resolved_at != null ? nextRunAfter(runs, round, d.resolved_at) : -1;
  return next >= 0
    ? `The decision was withdrawn before anyone answered it: run ${next + 1} started over right after`
    : "The decision was withdrawn before anyone answered it";
}

/** The index of the run that started within minutes of `at`, after run `round`, else -1. */
const nextRunAfter = (runs: MapRun[], round: number, at: number) =>
  runs.findIndex((r, i) => i + 1 > round && r.created_at >= at - 60_000 && r.created_at - at <= 15 * 60_000);

/** A run whose card was withdrawn because a newer run started (LX4): the
 *  round of that run, and what started it when the line holds the fact. A
 *  run row records no trigger, so the one fact read is a signal that joined
 *  the cause while the card waited. Null when the run was not replaced. */
function replacedBy(run: MapRun, round: number, runs: MapRun[], decisions: MapDecision[], signals: MapSignal[]): { by: number; why: string | null } | null {
  const card = decisions.find((d) => d.workflow_run_id === run._id && d.gate_node_id === CARD_GATE_NODE_ID && d.status === "withdrawn");
  const atCard = run.gate_node_id === CARD_GATE_NODE_ID && closedGate(run) === "withdrawn";
  if (!card && !atCard) return null;
  const at = card?.resolved_at ?? run.updated_at;
  const next = nextRunAfter(runs, round, at);
  if (next < 0) return null;
  const from = card?.created_at ?? run.created_at;
  const joined = signals.find((s) => s.created_at >= from && s.created_at <= runs[next].created_at + 60_000);
  return { by: next + 1, why: joined ? `Run ${next + 1} started when a new ${finderName(joined.source)} signal joined the cause` : null };
}

/** "Reached a card; replaced by run 5 before anyone answered": a replaced run's headline. */
export const replacedWords = (r: Pick<TraceRun, "by">) => `Reached your decision; replaced by run ${r.by} before anyone answered.`;

const ordinal = (n: number) => `${n}${n % 100 >= 11 && n % 100 <= 13 ? "th" : ["th", "st", "nd", "rd"][n % 10] ?? "th"}`;

/** How a step or chip reads, its status unless the run it belongs to was
 *  replaced: that run's steps passed and its change was thrown away, so it
 *  takes its own tone, never a pass's green (LX4). */
export type TraceTone = TraceStatus | "replaced";
export const runEndTone = (end: TraceRunEnd | null | undefined, status: TraceStatus): TraceTone => (end === "replaced" ? "replaced" : status);

/** `runs`: how many runs on the cause reached this station (every run, for
 *  a node no run step names, such as Causes, which each run starts from), so
 *  a chip counts its visits only where they differ (a loop inside one run). `tone`: its
 *  newest step's, through its run's end (runEndTone). */
export type TracePathChip = {
  nodeId: string; label: string; times: number; status: TraceStatus; tone: TraceTone; runs: number;
  /** How many runs on the cause stopped here, so an earlier stop shows even when the last visit passed. */
  stops: number;
};

const ROUTINE_CHIP = "routine:card";

/** How an end reads on the strip: stopped or reopened is the line stopping it. */
const END_STATUS: Record<MapEnd, TraceStatus> = { held: "done", reopened: "failed", stopped: "failed", dissolved: "skipped", dropped: "skipped" };

/** The trace's path as a strip of chips (LX4): each node it went through
 *  once, in the order it first got there, with how many times it went
 *  (Prove x3), and the ends it reached last. Each chip takes the status of
 *  its newest step there, the same status the story's dot for that step
 *  shows, so a chip reads as the outcome of its last visit. */
export function tracePathChips(trace: Pick<LineTrace, "pathNodeIds" | "pathLabels" | "steps"> & Partial<Pick<LineTrace, "runs" | "hereNodeId">>): TracePathChip[] {
  // The steps that only assemble the card read as one chip, Card, as the
  // story folds them into "routine steps assembling the card".
  const key = (id: string) => (isRoutineStation(id) ? ROUTINE_CHIP : id);
  const endOf = new Map((trace.runs ?? []).map((r) => [r.runId, r.end]));
  const status = new Map<string, TraceStatus>();
  const tone = new Map<string, TraceTone>();
  const runsAt = new Map<string, Set<string>>();
  for (const s of trace.steps) {
    if (!s.nodeId) continue;
    const k = key(s.nodeId);
    status.set(k, s.status);
    tone.set(k, runEndTone(s.runId ? endOf.get(s.runId) : null, s.status));
    if (s.runId) runsAt.set(k, (runsAt.get(k) ?? new Set()).add(s.runId));
  }
  const byNode = new Map<string, TracePathChip>();
  const path = trace.pathNodeIds;
  const stopped = endNodeId("stopped");
  path.forEach((id, i) => {
    // A run that stopped along the way is a tally the summary says, never a
    // station on the strip; Stopped shows only as the trace's own end.
    if (id === stopped && i !== path.length - 1) return;
    const k = key(id);
    const chip = byNode.get(k);
    if (chip) { if (k !== ROUTINE_CHIP || !isRoutineStation(path[i - 1] ?? "")) chip.times++; return; }
    const end = id.startsWith("end:") ? END_STATUS[id.slice(4) as MapEnd] : undefined;
    const st = status.get(k) ?? end ?? "done";
    const label = k === ROUTINE_CHIP ? "Preparing your decision" : trace.pathLabels[id] ?? id;
    // The chip the cause is at now reads as under way, whatever its last step said.
    const here = id === trace.hereNodeId;
    const stops = id.startsWith("end:") ? 0 : (trace.runs ?? []).filter((r) => r.end === "stopped" && r.at === label).length;
    byNode.set(k, { nodeId: id, label, times: 1, status: here ? "current" : st, tone: here ? "current" : tone.get(k) ?? st, runs: runsAt.get(k)?.size ?? Math.max(1, trace.runs?.length ?? 0), stops });
  });
  const chips = [...byNode.values()];
  return [...chips.filter((c) => !c.nodeId.startsWith("end:")), ...chips.filter((c) => c.nodeId.startsWith("end:"))];
}

/** How the runs ended, in the order a reader weighs them; a replaced run is
 *  told apart from a stop, since its change passed and was thrown away. */
const RUN_END_WORDS: Array<[TraceRunEnd, string, string]> = [
  ["shipped", "shipped", "shipped"], ["stopped", "stopped", "stopped"],
  ["replaced", "reached your decision and was replaced by a newer run", "reached your decision and were replaced by a newer run"],
  ["closed", "closed without a change", "closed without a change"], ["parked", "parked", "parked"],
  ["waiting", "waiting on you", "waiting on you"], ["approved", "approved, waiting to ship", "approved, waiting to ship"], ["working", "working", "working"],
];

/** The trace in one line, before its timeline: when it was found, every run
 *  by how it ended, and where the stopped ones stopped most ("Found Oct 6,
 *  7 runs: 4 stopped (2 at Prove), 2 reached a card and were replaced by a
 *  newer run, 1 waiting on you"). Where it is now reads on the line after. */
export function tracePathSummary(trace: Pick<LineTrace, "steps" | "runs">): string {
  const found = trace.steps.find((s) => s.stage === "finding")?.at ?? trace.steps.find((s) => s.stage === "cause")?.at ?? null;
  const runs = trace.runs;
  const head = found != null ? `Found ${shortDay(found)}, ` : "";
  if (!runs.length) return `${head}${found != null ? "no run yet" : "No run yet"}`;
  const stops = new Map<string, number>();
  for (const r of runs) if (r.end === "stopped" && r.at) stops.set(r.at, (stops.get(r.at) ?? 0) + 1);
  const ranked = [...stops].sort((a, b) => b[1] - a[1]);
  const top = ranked[0]?.[1] ?? 0;
  const tied = ranked.filter(([, n]) => n === top).map(([at]) => at);
  const stopped = runs.filter((r) => r.end === "stopped").length;
  const where = top < 2 ? "" : top === stopped ? ` (all at ${tied[0]})` : tied.length === 1 ? ` (${top} at ${tied[0]})` : tied.length === 2 ? ` (${top} each at ${tied[0]} and ${tied[1]})` : "";
  if (runs.length === 1) {
    const r = runs[0];
    const words = RUN_END_WORDS.find(([e]) => e === r.end)![1];
    return `${head}1 run, ${words}${r.end === "stopped" && r.at ? ` at ${r.at}` : ""}`;
  }
  const parts = RUN_END_WORDS.flatMap(([end, one, many]) => {
    const n = runs.filter((r) => r.end === end).length;
    return n ? [`${n} ${n === 1 ? one : many}${end === "stopped" ? where : ""}`] : [];
  });
  return `${head}${runs.length} runs: ${parts.join(", ")}`;
}

/** Where the path goes after one run, before the next run or the outcome. */
function runTail(end: LineRunEnd | null, run: MapRun, reopened: boolean, last: boolean): string[] {
  if (end === "dissolved") return [endNodeId("dissolved")];
  if (end === "dropped") return [endNodeId("dropped")];
  // Parked goes back to the queue; the next run, or the outcome, picks it up there.
  if (end === "parked") return [];
  if (end === "shipped") return reopened ? [endNodeId("reopened")] : [];
  if (!isLiveRun(run) && !last) return [endNodeId("stopped")];
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
  | { kind: "run"; runId: string; round: number; rows: TraceRunRow[]; status: TraceStatus; at: number | null; durationMs: number | null; rounds: number;
      /** A replaced run's card, told inside its run (its title and where to open it), never as a step of its own. */
      card?: { title: string; href?: string } };

/**
 * The story as a reader takes it (LX4): the stage steps one by one, and each
 * run as one block of its stations followed by the card it wrote, where an earlier round of a loop folds
 * into one row naming the stations it went through, and a station visited
 * again says which visit it is. A replaced run's card folds into its run
 * block, and the run's rows end at the card gate: the run's headline already
 * says the card was withdrawn, so neither a card step nor a skipped Ship says it again.
 */
export function traceBlocks(trace: Pick<LineTrace, "steps"> & Partial<Pick<LineTrace, "runs">>): TraceBlock[] {
  const out: TraceBlock[] = [];
  const replaced = new Set((trace.runs ?? []).filter((r) => r.end === "replaced").map((r) => r.runId));
  const folded = new Map<string, TraceStep>();
  // A card follows the run that wrote it, so a later run reads after its card.
  const runIds = new Set(trace.steps.flatMap((s) => (s.stage === "station" && s.runId ? [s.runId] : [])));
  const cardsOf = new Map<string, TraceStep[]>();
  for (const s of trace.steps) {
    if (s.stage !== "card" || !s.runId || !runIds.has(s.runId)) continue;
    if (replaced.has(s.runId)) folded.set(s.runId, s);
    else cardsOf.set(s.runId, [...(cardsOf.get(s.runId) ?? []), s]);
  }
  const placed = new Set([...cardsOf.values()].flat().concat([...folded.values()]));
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
    const lastStatus = timed[timed.length - 1]?.status;
    b.status = timed.some((s) => s.status === "current") ? "current" : lastStatus === "failed" || lastStatus === "noted" ? lastStatus : "done";
    if (replaced.has(b.runId)) {
      let gate = -1;
      b.rows.forEach((r, i) => { if (r.kind === "station" && r.step.nodeId === CARD_GATE_NODE_ID) gate = i; });
      if (gate >= 0) b.rows = b.rows.slice(0, gate + 1);
      const card = folded.get(b.runId);
      if (card) b.card = { title: card.headline ?? card.title, ...(card.links[0]?.href ? { href: card.links[0].href } : {}) };
    }
  }
  return out;
}

/** A report's title without the judge's "Not met:" lead and a trailing machine number, for grouping. */
const reportKey = (t: string) => t.replace(/^not met:\s*/i, "").replace(/\s+\d{10,13}\s*$/, "").trim().toLowerCase();

/** Sibling reports as rows: reports that say the same thing fold into one
 *  with a count (the newest's ref), busiest first, then newest. */
export function groupReports(signals: ReadonlyArray<MapSignal>): TraceArtifact[] {
  const groups = new Map<string, MapSignal[]>();
  for (const s of signals) groups.set(reportKey(s.title), [...(groups.get(reportKey(s.title)) ?? []), s]);
  return [...groups.values()]
    .map((g) => [...g].sort((a, b) => b.created_at - a.created_at))
    .sort((a, b) => b.length - a.length || b[0].created_at - a[0].created_at)
    .map((g) => ({ kind: "signal" as const, label: g[0].title.replace(/^not met:\s*/i, ""), ref: g[0].short_id || g[0]._id, ...(g.length > 1 ? { count: g.length } : {}), ...(g[0].evidence_url ? { href: g[0].evidence_url } : {}) }));
}
