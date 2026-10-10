// The learning loop's front half as steps of the line (docs/architecture/
// learning-loop.md LL1): expectations, observe, judge, problems, then the
// project's line. Each step is one node the workspace draws next to the
// line's own stations (line-workspace.md LW2), with its kind, where it runs,
// its version, its health, and its decisions: the findings it produced, which
// a person labels right or wrong like any other step's decisions (LW4).
// Pure: no store, no React. lineModel imports it; it imports nothing of
// lineModel's, so the two never cycle.
//
// ── The stable API ──────────────────────────────────────────────────────────
//
//   buildLoopSteps(rows: LoopRows): LoopSteps
//
//   LoopSteps
//     mode         findings | moments | both | none (LL3: how the product plugs in)
//     steps        Record<id, LoopStep>; order: ids left to right, then top to bottom
//     edges        LoopEdge[]: from, to, words, count (findings that went that way)
//     stages       LOOP_STAGES that hold a step, each with its step ids
//     entry        "line": the step whose outgoing edge reaches the line's first station
//
//   LoopStep
//     id           "expectations" | "observe:<kind>" | "judge:<name>" (codecast's)
//                  | "product:<source>[/<judge>]" (the product's own) | "group" | "line"
//     stage        the column it sits in; stages: every column it covers (a
//                  product's own judge observes and judges, so it covers both)
//     kind         session | call | script | person | product (supplied by the product)
//     where        product | codecast
//     version      the newest version its results name ("v7", a blob sha, "12")
//     mode         shadow | live for a codecast judge, else null
//     health       { tone, words, day, week, spark, failed, right, wrong, costUsd }
//     decisions    LoopDecision[], newest first
//
//   LoopDecision   one result of a step, labelable: id is `${subject.id}:${stepId}`,
//                  so a label row { run_id: subject.id, node_id: stepId } lands on it.
//     subject      { kind: signal | judge_run | moment, id, ref }
//     decided      in words; findings: what broke which expectation, how bad, the
//                  quote, and the problem it reached
//
// Labels: a codecast judge's decision is a judge_runs row; a product judge's is
// the finding (a signals row); a grouping decision is the same finding at the
// "group" step. The label store keys them by (subject id, step id).
import type { Expectation } from "@codecast/shared/contracts/expectations";
import type { JudgeFinding } from "@codecast/shared/contracts/judges";
import type { LineFinderDecl } from "@codecast/shared/contracts/lineProfile";
import { DAY, WEEK, perDay, type LineSignal } from "../lineFlow";
import type { LabelVerdict } from "./lineLabels";

// ── what it reads ────────────────────────────────────────────────────────────

/** A finding as codecast holds it (signals): a product's, or a live codecast judge's (which carries `moment`). */
export type LoopSignal = LineSignal & { moment?: string };
/** The project's current expectations document (project_expectations, highest version). */
export type LoopExpectations = { version: number; items: ReadonlyArray<Pick<Expectation, "id" | "text" | "status">>; applied_at?: number };
/** An extractor as the product's repo published it (moment_extractors). */
export type LoopExtractorRow = { kind: string; path: string; version: string; published_at: number; source?: string };
/** A codecast judge as the product's repo published it (judges). */
export type LoopJudgeRow = {
  _id: string;
  name: string;
  version: string;
  path: string;
  moment_kind: string;
  model: string;
  mode: "shadow" | "live";
  published_at: number;
  removed_at?: number;
};
/** One codecast judge's run on one moment (judge_runs): that judge's decision. */
export type LoopJudgeRunRow = {
  _id: string;
  judge: string;
  judge_version: string;
  moment_short_id: string;
  mode: "shadow" | "live";
  status: "ok" | "failed" | "skipped";
  reason?: string;
  findings: number;
  findings_json?: string;
  signal_ids?: ReadonlyArray<string>;
  cost_usd: number;
  at: number;
};
/** A moment's index fields (moments): the extractor's decision. */
export type LoopMomentRow = {
  _id: string;
  short_id: string;
  kind: string;
  status: "waiting" | "extracting" | "ready" | "failed";
  extractor_version?: string;
  extracted_at?: number;
  blocks?: number;
  error?: string;
  created_at: number;
};
/** A problem (a cause task), for the refs and words a grouping decision names. */
export type LoopProblem = { _id: string; short_id?: string; title: string; status: string; created_at: number; cause?: unknown };
/** A person's verdict on a decision (line_labels): run_id is the decision's subject id, node_id its step id. */
export type LoopLabelRow = { run_id: string; node_id: string; verdict: LabelVerdict; note?: string; by: string; at: number };

export type LoopRows = {
  /** The project's findings, every source (scope them to the project first). */
  signals: ReadonlyArray<LoopSignal>;
  /** The project's declared finders (projects.line_profile.finders): a product's own judges, silent or not. */
  finders?: ReadonlyArray<LineFinderDecl>;
  expectations?: LoopExpectations | null;
  extractors?: ReadonlyArray<LoopExtractorRow>;
  judges?: ReadonlyArray<LoopJudgeRow>;
  judgeRuns?: ReadonlyArray<LoopJudgeRunRow>;
  moments?: ReadonlyArray<LoopMomentRow>;
  problems?: ReadonlyArray<LoopProblem>;
  labels?: ReadonlyArray<LoopLabelRow>;
  viewerId?: string | null;
  names?: ReadonlyMap<string, string>;
  /** The product's name as a reader says it ("Union"), for the words of its own steps. */
  product?: string | null;
  now: number;
};

// ── what it is ───────────────────────────────────────────────────────────────

export type LoopStage = "expect" | "observe" | "judge" | "group" | "line";
export const LOOP_STAGES: ReadonlyArray<{ key: LoopStage; label: string }> = [
  { key: "expect", label: "Expectations" },
  { key: "observe", label: "Observe" },
  { key: "judge", label: "Judge" },
  { key: "group", label: "Problems" },
  { key: "line", label: "Fix" },
];
/** session: a coding agent; call: one prompt, one answer; script; person; product: the product does it and sends the result. */
export type LoopStepKind = "session" | "call" | "script" | "person" | "product";
export type LoopWhere = "product" | "codecast";
export type LoopMode = "findings" | "moments" | "both" | "none";

export type LoopHealthTone = "ok" | "quiet" | "failing" | "off" | "new";
export type LoopHealth = {
  tone: LoopHealthTone;
  /** "1,240 judged in the last day, 7 marked wrong". */
  words: string;
  /** Results in the last day and the last seven, and per day over the seven, oldest first. */
  day: number;
  week: number;
  spark: number[];
  failed: number;
  right: number;
  wrong: number;
  /** Model spend over the rows read, for steps that call a model. */
  costUsd: number | null;
};

export type LoopLabel = { verdict: LabelVerdict; note: string | null; by: string; byName: string | null; at: number; mine: boolean };
export type LoopFinding = {
  expectation: string | null;
  severity: number | null;
  what: string;
  quote: string | null;
  signalId: string | null;
  problemId: string | null;
};
export type LoopDecision = {
  /** `${subject.id}:${stepId}`: the label key's decision part. */
  id: string;
  stepId: string;
  subject: { kind: "signal" | "judge_run" | "moment"; id: string; ref: string | null };
  at: number;
  version: string | null;
  status: "ok" | "failed" | "skipped";
  decided: string;
  findings: LoopFinding[];
  problemIds: string[];
  evidenceUrl: string | null;
  moment: string | null;
  /** The viewer's label, else the newest. */
  label: LoopLabel | null;
  labels: LoopLabel[];
};

export type LoopStep = {
  id: string;
  stage: LoopStage;
  stages: LoopStage[];
  kind: LoopStepKind;
  where: LoopWhere;
  label: string;
  purpose: string;
  version: string | null;
  mode: "shadow" | "live" | null;
  /** The file it is read from in the product's repo, when codecast knows it. */
  file: string | null;
  /** The signal source its findings carry, for a judge. */
  source: string | null;
  health: LoopHealth;
  decisions: LoopDecision[];
};
export type LoopEdge = { id: string; from: string; to: string; words: string | null; count: number };
export type LoopSteps = {
  mode: LoopMode;
  steps: Record<string, LoopStep>;
  order: string[];
  edges: LoopEdge[];
  stages: Array<{ key: LoopStage; label: string; steps: string[] }>;
  entry: "line";
};

// ── helpers ──────────────────────────────────────────────────────────────────

const num = (n: number) => n.toLocaleString("en-US");
const plural = (n: number, one: string, many = `${one}s`) => `${num(n)} ${n === 1 ? one : many}`;
const shortVersion = (v: string) => (/^[0-9a-f]{12,}$/i.test(v) ? v.slice(0, 7) : v);
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const firstLine = (s: string | undefined) => s?.split("\n").map((l) => l.trim()).find((l) => l && !l.startsWith(">")) ?? "";
const quoteOf = (md: string | undefined) => {
  const q = md?.split("\n").filter((l) => /^\s*>/.test(l)).map((l) => l.replace(/^\s*>\s?/, "")).join(" ").trim();
  return q || null;
};

/** A signal source as a reader says it: "union.invariant" reads "Union invariant", "sdk:union-errors" "Union errors". */
export function sourceLabel(source: string): string {
  if (source === "person") return "People";
  if (source === "lesson") return "Lessons";
  return cap(source.replace(/^sdk:/, "").replace(/[._:-]+/g, " ").trim());
}

/** A codecast judge's findings are filed under source `judge:<name>` (shared/contracts/judges findingSignal). */
export const isCodecastJudgeSource = (source: string) => source.startsWith("judge:");

/** A product step's id: its source, and the judge within it when the findings name one. */
export const productStepId = (source: string, judge?: string | null) => `product:${source}${judge ? `/${judge}` : ""}`;

/** The judge step a finding is a decision of, the step its label names
 *  (line_labels node_id): a product judge's step, or codecast's judge by name. */
export const findingStepId = (s: Pick<LoopSignal, "source" | "judge">) =>
  isCodecastJudgeSource(s.source) ? `judge:${s.judge || s.source.slice("judge:".length)}` : productStepId(s.source, s.judge);

function countsOf(times: number[], now: number) {
  let day = 0;
  let week = 0;
  for (const t of times) {
    if (t > now) continue;
    if (t >= now - WEEK) week++;
    if (t >= now - DAY) day++;
  }
  return { day, week, spark: perDay(times, now) };
}

const WINDOW_WORDS = "in the last day";

// ── the steps ────────────────────────────────────────────────────────────────

/** The loop's front half for one project, from its rows. */
export function buildLoopSteps(rows: LoopRows): LoopSteps {
  const { now } = rows;
  const product = rows.product?.trim() || "The product";
  const problemById = new Map((rows.problems ?? []).map((p) => [p._id, p]));
  const problemRef = (id: string | null | undefined) => (id ? problemById.get(id)?.short_id ?? null : null);
  const signalById = new Map(rows.signals.map((s) => [s._id, s]));

  // Labels by decision id.
  const labelsBy = new Map<string, LoopLabel[]>();
  for (const l of rows.labels ?? []) {
    const id = `${l.run_id}:${l.node_id}`;
    const list = labelsBy.get(id) ?? [];
    list.push({ verdict: l.verdict, note: l.note?.trim() || null, by: l.by, byName: rows.names?.get(l.by) ?? null, at: l.at, mine: !!rows.viewerId && l.by === rows.viewerId });
    labelsBy.set(id, list);
  }
  for (const list of labelsBy.values()) list.sort((a, b) => b.at - a.at);
  const labelled = (subjectId: string, stepId: string) => {
    const labels = labelsBy.get(`${subjectId}:${stepId}`) ?? [];
    return { labels, label: labels.find((l) => l.mine) ?? labels[0] ?? null };
  };

  const steps: LoopStep[] = [];
  const edges: LoopEdge[] = [];
  const addEdge = (from: string, to: string, words: string | null, count: number) => edges.push({ id: `${from}->${to}`, from, to, words, count });

  /** A step's health from its decisions: counts, labels, and the tone a reader needs first. */
  const health = (decisions: LoopDecision[], verb: string, extra: { cost?: number | null; declared?: boolean; off?: string | null } = {}): LoopHealth => {
    const c = countsOf(decisions.filter((d) => d.status !== "skipped").map((d) => d.at), now);
    const dayDecisions = decisions.filter((d) => d.at >= now - DAY && d.at <= now);
    const failed = dayDecisions.filter((d) => d.status === "failed").length;
    let right = 0;
    let wrong = 0;
    for (const d of decisions) for (const l of d.labels) (l.verdict === "right" ? right++ : wrong++);
    const parts = [`${num(c.day)} ${verb} ${WINDOW_WORDS}`];
    if (failed) parts.push(`${num(failed)} failed`);
    if (wrong) parts.push(`${num(wrong)} marked wrong`);
    let tone: LoopHealthTone = "ok";
    let words = parts.join(", ");
    if (extra.off) { tone = "off"; words = extra.off; }
    else if (c.day > 0 && failed * 2 > c.day) tone = "failing";
    else if (!decisions.length) { tone = extra.declared ? "quiet" : "new"; words = extra.declared ? "nothing sent yet" : "nothing yet"; }
    else if (c.day === 0) {
      tone = "quiet";
      const last = Math.max(...decisions.map((d) => d.at));
      words = `quiet for ${Math.max(1, Math.floor((now - last) / DAY))}d`;
    }
    return { tone, words, ...c, failed, right, wrong, costUsd: extra.cost ?? null };
  };

  // ── expectations ──
  const exp = rows.expectations;
  const active = exp?.items.filter((e) => e.status === "active") ?? [];
  const cited = new Set(rows.signals.filter((s) => s.subject?.startsWith("ex-") && s.created_at >= now - WEEK).map((s) => s.subject!));
  steps.push({
    id: "expectations", stage: "expect", stages: ["expect"], kind: "person", where: "codecast", label: "Expectations",
    purpose: "How the product should behave, one sentence each, quoted from where a person said it.",
    version: exp ? String(exp.version) : null, mode: null, file: null, source: null,
    health: {
      tone: active.length ? "ok" : "new",
      words: active.length ? `${plural(active.length, "expectation")}${cited.size ? `, ${num(cited.size)} broken this week` : ""}` : "none written yet",
      day: 0, week: cited.size, spark: new Array(7).fill(0), failed: 0, right: 0, wrong: 0, costUsd: null,
    },
    decisions: [],
  });

  // ── observe: codecast's extractors, run on the machine that published them ──
  const extractorKinds = new Map<string, LoopExtractorRow>();
  for (const e of rows.extractors ?? []) {
    const had = extractorKinds.get(e.kind);
    if (!had || e.published_at > had.published_at) extractorKinds.set(e.kind, e);
  }
  for (const [kind, e] of extractorKinds) {
    const id = `observe:${kind}`;
    const decisions: LoopDecision[] = (rows.moments ?? [])
      .filter((m) => m.kind === kind && (m.status === "ready" || m.status === "failed"))
      .map((m) => ({
        id: `${m._id}:${id}`, stepId: id, subject: { kind: "moment" as const, id: m._id, ref: m.short_id },
        at: m.extracted_at ?? m.created_at, version: m.extractor_version ?? null,
        status: m.status === "failed" ? ("failed" as const) : ("ok" as const),
        decided: m.status === "failed" ? `Could not extract: ${m.error ?? "no reason given"}` : `Extracted ${plural(m.blocks ?? 0, "block")}`,
        findings: [], problemIds: [], evidenceUrl: null, moment: m.short_id, ...labelled(m._id, id),
      }))
      .sort((a, b) => b.at - a.at);
    steps.push({
      id, stage: "observe", stages: ["observe"], kind: "script", where: "product", label: `${cap(kind)} moments`,
      purpose: `Freezes each ${kind} with what a judge needs to read it, from ${product}'s own data.`,
      version: shortVersion(e.version), mode: null, file: e.path, source: e.source ?? null,
      health: health(decisions, "extracted"), decisions,
    });
  }

  // ── judge: codecast's model-call judges ──
  const judgeByName = new Map<string, LoopJudgeRow>();
  for (const j of rows.judges ?? []) {
    const had = judgeByName.get(j.name);
    if (!had || j.published_at > had.published_at) judgeByName.set(j.name, j);
  }
  const runsByJudge = new Map<string, LoopJudgeRunRow[]>();
  for (const r of rows.judgeRuns ?? []) runsByJudge.set(r.judge, [...(runsByJudge.get(r.judge) ?? []), r]);
  for (const name of new Set([...judgeByName.keys(), ...runsByJudge.keys()])) {
    const j = judgeByName.get(name);
    const runs = runsByJudge.get(name) ?? [];
    const id = `judge:${name}`;
    const decisions = runs.map((r) => judgeRunDecision(r, id, signalById, labelled)).sort((a, b) => b.at - a.at);
    const recent = decisions.filter((d) => d.at >= now - DAY);
    const skippedAll = recent.length > 0 && recent.every((d) => d.status === "skipped");
    const off = j?.removed_at ? "removed from the repo" : skippedAll ? "waiting on a model budget" : null;
    const found = recent.reduce((n, d) => n + d.findings.length, 0);
    const h = health(decisions, "judged", { cost: runs.reduce((n, r) => n + r.cost_usd, 0), off });
    if (h.tone !== "off" && h.day > 0) h.words = h.words.replace(WINDOW_WORDS, `${WINDOW_WORDS}, ${plural(found, "finding")}`);
    const mode = j?.mode ?? runs[0]?.mode ?? null;
    steps.push({
      id, stage: "judge", stages: ["judge"], kind: "call", where: "codecast", label: `${cap(name)} judge`,
      purpose: mode === "shadow"
        ? `Reads each ${j?.moment_kind ?? "moment"} against the expectations and keeps what breaks them, filing nothing while in shadow.`
        : `Reads each ${j?.moment_kind ?? "moment"} against the expectations and files what breaks them as findings.`,
      version: j ? shortVersion(j.version) : runs[0] ? shortVersion(runs[0].judge_version) : null, mode, file: j?.path ?? null, source: `judge:${name}`,
      health: h, decisions,
    });
    if (j && extractorKinds.has(j.moment_kind)) addEdge(`observe:${j.moment_kind}`, id, null, decisions.length);
    addEdge("expectations", id, "grades against", decisions.length);
    addEdge(id, "group", mode === "shadow" ? "files nothing in shadow" : null, mode === "shadow" ? 0 : found);
  }

  // ── judge: the product's own judges (bring findings, LL3) ──
  const finders = rows.finders ?? [];
  const productSignals = new Map<string, LoopSignal[]>();
  for (const s of rows.signals) {
    if (isCodecastJudgeSource(s.source)) continue;
    const id = productStepId(s.source, s.judge);
    productSignals.set(id, [...(productSignals.get(id) ?? []), s]);
  }
  // A declared finder with nothing sent is still a step: its silence is the news.
  for (const f of finders) {
    if (![...productSignals.keys()].some((k) => k === productStepId(f.source) || k.startsWith(`${productStepId(f.source)}/`))) productSignals.set(productStepId(f.source), []);
  }
  for (const [id, list] of productSignals) {
    const sorted = [...list].sort((a, b) => b.created_at - a.created_at);
    const source = sorted[0]?.source ?? id.slice("product:".length).split("/")[0];
    const judge = sorted[0]?.judge ?? null;
    const person = source === "person";
    const lesson = source === "lesson";
    const finder = finders.find((f) => f.source.toLowerCase() === source.toLowerCase());
    const decisions = sorted.map((s) => findingDecision(s, id, problemRef, labelled));
    const kind: LoopStepKind = person ? "person" : lesson ? "session" : "product";
    const where: LoopWhere = person || lesson || source.startsWith("sdk:") ? "codecast" : "product";
    steps.push({
      id, stage: "judge", stages: kind === "product" ? ["observe", "judge"] : ["judge"], kind, where,
      label: judge ? `${cap(judge.replace(/[_-]+/g, " "))} judge` : sourceLabel(source),
      purpose: person ? "People on the team report what they see."
        : lesson ? "Past sessions report what they learned."
        : `${product} watches itself${judge ? ` with its ${judge} judge` : ""} and sends each finding.`,
      version: sorted.find((s) => s.judge_version)?.judge_version ?? null, mode: null, file: null, source,
      health: health(decisions, kind === "product" ? "found" : "reported", { declared: !!finder }),
      decisions,
    });
    const citesExpectations = list.some((s) => s.subject?.startsWith("ex-"));
    if (citesExpectations) addEdge("expectations", id, "grades against", list.filter((s) => s.subject?.startsWith("ex-")).length);
    addEdge(id, "group", null, list.length);
  }

  // ── group: findings into problems ──
  const grouped = rows.signals.filter((s) => s.attach).map((s) => groupDecision(s, problemRef, labelled)).sort((a, b) => b.at - a.at);
  const groupHealth = health(grouped, "grouped");
  const opened = grouped.filter((d) => d.at >= now - DAY && d.decided.startsWith("Opened")).length;
  if (groupHealth.day > 0 && opened) groupHealth.words = groupHealth.words.replace(WINDOW_WORDS, `${WINDOW_WORDS}, ${plural(opened, "new problem")}`);
  steps.push({
    id: "group", stage: "group", stages: ["group"], kind: "call", where: "codecast", label: "Problems",
    purpose: "Puts findings about the same thing into one problem: by the product's issue key, by saying the same thing, or by a reviewer's read.",
    version: null, mode: null, file: null, source: null, health: groupHealth, decisions: grouped,
  });

  // ── the line ──
  const open = (rows.problems ?? []).filter((p) => p.cause && p.status !== "done" && p.status !== "dropped").length;
  const newProblems = grouped.filter((d) => d.decided.startsWith("Opened")).length;
  steps.push({
    id: "line", stage: "line", stages: ["line"], kind: "session", where: "codecast", label: "The line",
    purpose: "Fixes each problem: proves it, builds the change, asks you, ships it and watches.",
    version: null, mode: null, file: null, source: null,
    health: { tone: open ? "ok" : "new", words: open ? `${plural(open, "problem")} open` : "no problems open", day: 0, week: 0, spark: new Array(7).fill(0), failed: 0, right: 0, wrong: 0, costUsd: null },
    decisions: [],
  });
  addEdge("group", "line", "new problems", newProblems);

  const byStage = (s: LoopStep) => LOOP_STAGES.findIndex((x) => x.key === s.stage);
  const kindRank: Record<LoopStepKind, number> = { call: 0, product: 1, script: 1, session: 2, person: 3 };
  const ordered = [...steps].sort((a, b) => byStage(a) - byStage(b) || kindRank[a.kind] - kindRank[b.kind] || b.health.week - a.health.week || a.label.localeCompare(b.label));
  const order = ordered.map((s) => s.id);
  const codecastJudges = steps.some((s) => s.kind === "call" && s.stage === "judge");
  const productJudges = steps.some((s) => s.kind === "product");
  return {
    mode: codecastJudges && productJudges ? "both" : codecastJudges ? "moments" : productJudges ? "findings" : "none",
    steps: Object.fromEntries(ordered.map((s) => [s.id, s])),
    order,
    edges,
    stages: LOOP_STAGES.map((st) => ({ ...st, steps: order.filter((id) => steps.find((s) => s.id === id)!.stage === st.key) })).filter((st) => st.steps.length > 0),
    entry: "line",
  };
}

type Labelled = (subjectId: string, stepId: string) => { labels: LoopLabel[]; label: LoopLabel | null };

/** A codecast judge's run as its decision: what it found in the moment, and the problems a live judge's findings reached. */
function judgeRunDecision(r: LoopJudgeRunRow, stepId: string, signalById: Map<string, LoopSignal>, labelled: Labelled): LoopDecision {
  let parsed: JudgeFinding[] = [];
  try { parsed = r.findings_json ? JSON.parse(r.findings_json) : []; } catch { parsed = []; }
  const filed = (r.signal_ids ?? []).map((id) => signalById.get(id)).filter((s): s is LoopSignal => !!s);
  const findings: LoopFinding[] = parsed.map((f) => {
    const s = filed.find((x) => x.subject === f.expectation && firstLine(x.detail_md) === firstLine(f.what_happened)) ?? filed.find((x) => x.subject === f.expectation);
    return { expectation: f.expectation, severity: f.severity, what: f.what_happened, quote: f.quote || null, signalId: s?._id ?? null, problemId: s?.task_id ?? null };
  });
  const decided = r.status === "skipped" ? `Skipped: ${r.reason ?? "no budget"}`
    : r.status === "failed" ? `Failed: ${r.reason ?? "no reason given"}`
    : findings.length ? `Found ${findings.length === 1 ? `1 break of ${findings[0].expectation}` : `${num(findings.length)} breaks`}`
    : "Nothing broke an expectation";
  return {
    id: `${r._id}:${stepId}`, stepId, subject: { kind: "judge_run", id: r._id, ref: r.moment_short_id }, at: r.at, version: shortVersion(r.judge_version),
    status: r.status, decided, findings, problemIds: [...new Set(findings.map((f) => f.problemId).filter((x): x is string => !!x))],
    evidenceUrl: filed.find((s) => s.evidence_url)?.evidence_url ?? null, moment: r.moment_short_id, ...labelled(r._id, stepId),
  };
}

/** One finding a product's judge sent, as that judge's decision. */
function findingDecision(s: LoopSignal, stepId: string, problemRef: (id: string) => string | null, labelled: Labelled): LoopDecision {
  const expectation = s.subject?.startsWith("ex-") ? s.subject : null;
  const severity = typeof s.severity === "number" ? s.severity : null;
  return {
    id: `${s._id}:${stepId}`, stepId, subject: { kind: "signal", id: s._id, ref: s.short_id ?? null }, at: s.created_at, version: s.judge_version ?? null,
    status: "ok", decided: `${expectation ? `Broke ${expectation}: ` : ""}${s.title}${severity != null ? ` (severity ${severity})` : ""}`,
    findings: [{ expectation, severity, what: s.title, quote: quoteOf(s.detail_md), signalId: s._id, problemId: s.task_id || null }],
    problemIds: s.task_id ? [s.task_id] : [], evidenceUrl: s.evidence_url ?? null, moment: s.moment ?? null, ...labelled(s._id, stepId),
  };
}

/** How a finding joined its problem (signals.attach), as the grouping step's decision. */
const GROUP_WORDS: Record<string, (ref: string) => string> = {
  fingerprint: (ref) => `Joined ${ref} by its key`,
  similar: (ref) => `Joined ${ref}: it said what that problem's findings said`,
  judge: (ref) => `Joined ${ref}: a reviewer read it as the same problem`,
  person: (ref) => `Moved to ${ref} by a person`,
  new: (ref) => `Opened ${ref}, a new problem`,
};

function groupDecision(s: LoopSignal, problemRef: (id: string) => string | null, labelled: Labelled): LoopDecision {
  const ref = problemRef(s.task_id) ?? "a problem";
  const words = GROUP_WORDS[s.attach ?? ""] ?? ((r: string) => `Joined ${r}`);
  return {
    id: `${s._id}:group`, stepId: "group", subject: { kind: "signal", id: s._id, ref: s.short_id ?? null }, at: s.created_at, version: null,
    status: "ok", decided: words(ref), findings: [], problemIds: s.task_id ? [s.task_id] : [], evidenceUrl: null, moment: s.moment ?? null,
    ...labelled(s._id, "group"),
  };
}
