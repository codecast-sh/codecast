// The line workspace's actions, as the panels read them (line-workspace.md
// LW4): a try's cases grouped into the try they belong to, a save's state
// from its sessionCommands row, and the request an agent is handed when a
// person asks it to change a step. Pure, so the panels and the tests read the
// same words.
import type { LineModel, LineStep, StepDecision } from "./lineModel";
import { lineCauseFields, lineSubject, type LineCauseFields } from "./lineCause";

// ── tries ───────────────────────────────────────────────────────────────────

export type TryStatus = "queued" | "running" | "done" | "not_tryable" | "failed";
export type TryDecisionRow = { outcome?: string; status?: string | null; words?: string; result?: Record<string, unknown> | null };

/** One case of a try, as the lineTries feed (convex lineActions.tries) carries it. */
export type LineTryRow = {
  _id: string;
  key: string;
  try_id: string;
  project_id?: string;
  workflow_id: string;
  node_id: string;
  run_id: string;
  case_id?: string;
  by: string;
  at: number;
  updated_at: number;
  status: TryStatus;
  reason?: string;
  older_text?: boolean;
  model?: string;
  base_hash?: string;
  text_hash?: string;
  via?: "patch" | "checkpoint";
  old: TryDecisionRow;
  new?: TryDecisionRow;
  reply?: string;
  cost_usd?: number;
  turns?: number;
  refused?: string[];
  took_ms?: number;
  pickup?: { error?: string; at?: number; waiting?: boolean };
};

/** A try: its cases, newest try first, with what they add up to. */
export type LineTry = {
  id: string;
  node: string;
  at: number;
  cases: LineTryRow[];
  settled: number;
  changed: number;
  same: number;
  cost: number;
  /** Every case is settled. */
  done: boolean;
  /** Why the machine never took it, when it did not. */
  stalled: string | null;
};

const SETTLED: ReadonlySet<TryStatus> = new Set(["done", "not_tryable", "failed"]);
/** A machine that has not picked a try up after this long is likely off. */
export const TRY_PICKUP_MS = 2 * 60_000;

/** What a decision comes to, for comparing old with new: the json when there is one, else the outcome or the words. */
export function decisionKey(d: TryDecisionRow | undefined | null): string {
  if (!d) return "";
  if (d.result && typeof d.result === "object") return JSON.stringify(sortKeys(d.result));
  return (d.outcome ?? d.words ?? "").trim().toLowerCase();
}
const sortKeys = (v: unknown): unknown =>
  Array.isArray(v) ? v.map(sortKeys) : v && typeof v === "object" ? Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([k, x]) => [k, sortKeys(x)])) : v;

/** Whether a settled case decided differently with the edit: its deciding field moved. Null while it has no answer to compare. */
export function caseChanged(row: LineTryRow): boolean | null {
  if (row.status !== "done" || !row.new) return null;
  // What it decided (the json's deciding field), not how it worded it: the prose differs on every run.
  const before = decisionAnswer(row.old).outcome;
  const after = decisionAnswer(row.new).outcome;
  if (before && after) return before !== after;
  const was = decisionKey(row.old);
  return !was ? null : was !== decisionKey(row.new);
}

/** A step's tries, newest first: a project's rows grouped by try. */
export function triesOf(rows: ReadonlyArray<LineTryRow>, nodeId: string, now = Date.now()): LineTry[] {
  const by = new Map<string, LineTryRow[]>();
  for (const r of rows) {
    if (r.node_id !== nodeId) continue;
    const list = by.get(r.try_id) ?? [];
    list.push(r);
    by.set(r.try_id, list);
  }
  return [...by].map(([id, cases]) => {
    const at = Math.min(...cases.map((c) => c.at));
    const settled = cases.filter((c) => SETTLED.has(c.status)).length;
    const changes = cases.map(caseChanged);
    const err = cases.find((c) => c.pickup?.error)?.pickup?.error;
    const waiting = cases.every((c) => c.status === "queued") && now - at > TRY_PICKUP_MS;
    return {
      id, node: nodeId, at, cases: [...cases].sort((a, b) => a.run_id.localeCompare(b.run_id)), settled,
      changed: changes.filter((c) => c === true).length,
      same: changes.filter((c) => c === false).length,
      cost: cases.reduce((s, c) => s + (c.cost_usd ?? 0), 0),
      done: settled === cases.length,
      stalled: err ? pickupWords(err) : waiting ? "The machine that pushed this graph has not picked the try up yet. It runs when that machine is on and codecast is running there." : null,
    };
  }).sort((a, b) => b.at - a.at);
}

function pickupWords(error: string): string {
  if (/expired/i.test(error)) return "The machine that pushed this graph was not on to pick the try up, so it never ran. Try again when it is.";
  return error;
}

/** A case's state in words. */
export function tryCaseWords(row: LineTryRow): string {
  switch (row.status) {
    case "queued": return "Waiting for the machine";
    case "running": return row.via === "checkpoint" ? "Running, from the run's checkpoint" : "Running";
    case "not_tryable": return row.reason ? `Not tryable: ${row.reason}` : "Not tryable";
    case "failed": return row.reason ? `Failed: ${row.reason}` : "Failed";
    default: {
      const c = caseChanged(row);
      return c === null ? "Ran" : c ? "Decided differently" : "Decided the same";
    }
  }
}

/** The cases a step can try an edit on, labeled wrong first, then right, then the newest. */
export function tryCandidates(step: LineStep, cap = 8): StepDecision[] {
  const rank = (d: StepDecision) => (d.label?.verdict === "wrong" ? 0 : d.label?.verdict === "right" ? 1 : 2);
  return oncePerCase(step.decisions
    .filter((d) => d.status !== "live" && d.status !== "waiting")
    .map((d, i) => ({ d, i }))
    .sort((a, b) => rank(a.d) - rank(b.d) || a.i - b.i)
    .map((x) => x.d))
    .slice(0, cap);
}

/** The first of each case's decisions, in order: a case tried once, whichever of its runs ranks first. */
export function oncePerCase(decisions: ReadonlyArray<StepDecision>): StepDecision[] {
  const seen = new Set<string>();
  return decisions.filter((d) => {
    const key = d.caseId ?? `run:${d.runId}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// ── the drawn graph ─────────────────────────────────────────────────────────

/** The workflow row the model draws: the busiest graph's newest run names it. */
export function drawnWorkflowId(model: LineModel): string | null {
  return model.graphs.find((g) => g.key === model.graphKey)?.workflowId ?? null;
}

// ── save ────────────────────────────────────────────────────────────────────

export type SaveState =
  | { kind: "saving" }
  | { kind: "pushing"; hash: string | null }
  | { kind: "saved"; hash: string | null; at: number | null }
  | { kind: "unchanged" }
  | { kind: "refused"; reason: string };

/** A save's state from its sessionCommands row: the daemon's write, then its push. */
export function saveState(row: { executed_at?: number | null; result?: string | null; error?: string | null } | null | undefined): SaveState | null {
  if (!row) return null;
  if (row.error) return { kind: "refused", reason: row.error };
  if (!row.executed_at || !row.result) return { kind: "saving" };
  let r: any = null;
  try { r = JSON.parse(row.result); } catch { return { kind: "saving" }; }
  if (!r?.changed) return { kind: "unchanged" };
  const pub = r.published;
  if (pub?.ok === "pending") return { kind: "pushing", hash: r.node_hash ?? null };
  if (pub && pub.ok === false) return { kind: "refused", reason: `Saved to the file, but codecast's copy did not update: ${pub.detail ?? "the push failed"}` };
  return { kind: "saved", hash: r.node_hash ?? null, at: row.executed_at ?? null };
}

// ── ask an agent ────────────────────────────────────────────────────────────

/** A labeled case as the agent is handed it. */
export type AskCase = Pick<StepDecision, "runId" | "caseRef" | "caseTitle" | "reasoning"> & {
  verdict: "right" | "wrong";
  note: string | null;
  decided: string;
  result: Record<string, unknown> | null;
};

/** The step's labeled decisions, wrong first: what an ask carries as its examples. */
export function labeledCases(step: LineStep): AskCase[] {
  const out: AskCase[] = [];
  for (const d of step.decisions) {
    if (!d.label) continue;
    out.push({ runId: d.runId, caseRef: d.caseRef, caseTitle: d.caseTitle, reasoning: d.reasoning, verdict: d.label.verdict, note: d.label.note, decided: d.decided.words, result: d.decided.result });
  }
  return out.sort((a, b) => (a.verdict === b.verdict ? 0 : a.verdict === "wrong" ? -1 : 1));
}

const fenceFor = (text: string) => "`".repeat(Math.max(3, ...[...text.matchAll(/`+/g)].map((m) => m[0].length + 1)));

/**
 * What an agent is asked: the person's words and any draft (the line
 * composer's own filing, lineCauseFields), where the step lives, and the
 * labeled cases as examples, each with what the step decided and the
 * person's verdict, so the change is checked against them before it comes back.
 */
export function askAgentFields(opts: { graphTitle: string; step: Pick<LineStep, "id" | "label" | "prompt">; words: string; draft?: string | null; cases: ReadonlyArray<AskCase> }): LineCauseFields | null {
  const draft = opts.draft?.trim() ? { field: (opts.step.prompt?.kind ?? "prompt") as "prompt" | "script", text: opts.draft } : undefined;
  const base = lineCauseFields({
    subject: lineSubject({ id: opts.step.id, kind: "station" }),
    label: opts.step.label,
    words: opts.words,
    draft,
  });
  if (!base) return null;
  const where = [`The step is ${opts.step.label} (\`${opts.step.id}\`) in the ${opts.graphTitle} graph${opts.step.prompt?.file ? `, which reads its ${opts.step.prompt.kind} from \`${opts.step.prompt.file}\`` : ""}.`];
  if (opts.step.prompt?.version) where.push(`Its text now is version ${opts.step.prompt.version.hash.slice(0, 6)}.`);
  const parts = [base.detail_md, `## Where\n\n${where.join(" ")}`];
  if (opts.cases.length) {
    const wrong = opts.cases.filter((c) => c.verdict === "wrong").length;
    const lines = [`## Labeled cases\n\nA person marked ${opts.cases.length === 1 ? "this decision" : `these ${opts.cases.length} decisions`} of the step${wrong ? `, ${wrong} wrong` : ""}. Check a change against every one before it comes back: the wrong ones should decide differently, the right ones the same.`];
    for (const c of opts.cases) {
      const head = `- **${c.verdict === "wrong" ? "Wrong" : "Right"}**: ${c.caseRef ? `${c.caseRef} ` : ""}${c.caseTitle} (run \`${c.runId}\`)`;
      const body = [`  Decided: ${c.decided}`];
      if (c.note) body.push(`  The person's note: ${c.note}`);
      if (c.result) {
        const json = JSON.stringify(c.result, null, 2);
        const f = fenceFor(json);
        body.push(`  ${f}json\n${json.split("\n").map((l) => `  ${l}`).join("\n")}\n  ${f}`);
      }
      lines.push([head, ...body].join("\n"));
    }
    parts.push(lines.join("\n\n"));
  }
  return { ...base, detail_md: parts.join("\n\n") };
}

/** The fields a station's json usually decides with, in the order they say most. */
const DECIDING = ["outcome", "verdict", "decision", "route", "dissolved", "status", "kind", "cause"];

/** A decision as an answer: a short label for what it decided (its json's deciding field, else its outcome) and its words. */
export function decisionAnswer(d: TryDecisionRow | undefined | null): { outcome: string | null; words: string } {
  if (!d) return { outcome: null, words: "" };
  const r = d.result && typeof d.result === "object" ? d.result : null;
  let outcome: string | null = null;
  if (r) {
    const key = DECIDING.find((k) => r[k] !== undefined && r[k] !== null && typeof r[k] !== "object")
      ?? Object.keys(r).find((k) => typeof r[k] === "string" || typeof r[k] === "boolean");
    if (key) outcome = typeof r[key] === "boolean" ? (r[key] ? key : `not ${key}`) : `${key === "outcome" || key === "verdict" || key === "decision" ? "" : `${key}: `}${String(r[key]).slice(0, 48)}`;
  }
  if (!outcome && d.outcome && d.outcome !== "success") outcome = d.outcome;
  return { outcome, words: d.words ?? "" };
}
