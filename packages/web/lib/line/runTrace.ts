// A run's detail read like a debugger trace (line-workspace.md LW1), pure and
// tested: where the problem came from (its findings, their source and judge),
// then every step the run visited in order with what it was given, what it
// did and where it sent the run. The model (lineModel) says what each visit
// decided; the run row's own node record adds the nuts and bolts the model
// leaves out: the session and its size, the script's printed output, tokens,
// cost, how the run failed.
import { toolCallGist } from "../toolCallGist";
import type { LineModel, LineRunModel, LineVisit, StepKind } from "./lineModel";
import { closedGate, LANDING_STATIONS, stationEnd, stepFailWords, type ReportRun, type StepState } from "./runReport";
import { headFields, isAnswerKey, jsonObject, visitOutput, visitOutputWords, type VisitOutput } from "./visitOutput";
import { evalsOwed, isPathValue, reviewWords, scriptChecks, scriptErrors, type ReviewVerdict, type ScriptChecks } from "./scriptReport";

// ── where the problem came from ──────────────────────────────────────────────


// ── the steps ────────────────────────────────────────────────────────────────

/** A run row's node record, the fields the trace reads (workflow_runs.node_statuses, enriched with its session). */
export type TraceNode = {
  node_id: string;
  status: string;
  outcome?: string;
  session_id?: string;
  session?: { _id: string; title?: string; state?: string; state_status?: string; result?: string; message_count?: number; killed?: boolean; is_active?: boolean; updated_at?: number; handoff?: { status: string; note?: string } } | null;
  completed_at?: number;
  result_preview?: string;
  activity?: string;
  tokens?: number;
  cost_usd?: number;
};
export type TraceRun = {
  node_statuses?: ReadonlyArray<TraceNode>;
  fail_reason?: string;
  gate_node_id?: string;
  gate_choices?: ReadonlyArray<{ key: string; label: string }>;
  /** The card's text as the person read it, its template resolved. */
  gate_prompt?: string;
  gate_answer?: string;
  gate_response?: string;
  gate_decision_short_id?: string;
  gate_decision_status?: string;
};

export type TraceStep = {
  i: number;
  /** "01", "02": the visit's number in the run. */
  n: string;
  node: string;
  label: string;
  kind: StepKind;
  status: StepState;
  /** An earlier round of a loop: the run kept nothing of it but that it happened. */
  inferred: boolean;
  tookMs: number | null;
  /** What it decided, as a key ("proved"), null when it only handed on (or a person step nobody answered). */
  outcome: string | null;
  /** A person step that ended with no answer (its card timed out or was taken back): the run's runner went on without a choice. */
  unanswered: boolean;
  /** What it produced (visitOutput): the one reading Decisions, Runs and this trace show. */
  produced: VisitOutput | null;
  /** That output in one line. */
  gist: string | null;
  /** Where it sent the run, and the edge's words for that way. */
  next: { i: number; node: string; label: string; when: string | null } | null;
  /** Its session (an agent step), with how much happened in it. */
  session: { id: string; short: string | null; messages: number | null; killed: boolean } | null;
  /** How its session handed the problem back (blocked, needs_context), with what it wrote: the evidence and its ask, whole. */
  handoff: { status: string; note: string | null } | null;
  /** What an agent pinned as its conclusion when it settled (the session's state), json left out. */
  pinned: string | null;
  /** What the runner recorded as its output: a script's printed head, an agent's conclusion. */
  output: string | null;
  tokens: number | null;
  costUsd: number | null;
  /** A script's command as the graph holds it. */
  command: string | null;
  /** How the run failed here, when it did. */
  failReason: string | null;
  /** The session went quiet without a report and the line took that as its end (runReport stationEnd went_quiet): what
   *  it said last is where it was, never a conclusion. */
  quiet?: boolean;
  /** Why a landing step never ran ("the decision was withdrawn"): the runner marks it failed, but nothing it did failed. */
  notRun: string | null;
  /** How many times the run went through this step, when a loop hit its visit cap ("max_visits=3 exceeded on build"):
   *  the run keeps only the newest visit of each, so the count is all it knows of the earlier rounds. */
  rounds: number | null;
  /** This step is the one whose visit cap stopped the run. */
  capped: boolean;
  /** A person's card at this step: the decision it was asked on, the question as they read it, the choices, the
   *  chosen one's label and their note. */
  gate: { ref: string | null; question: string | null; choices: string[]; answer: string | null; note: string | null } | null;
  /** A check runner's report, as a table (scriptReport). */
  checks: ScriptChecks | null;
  /** Errors a script reported while exiting 0: the step is amber even though it passed. */
  errors: string[];
  /** A reviewer's verdict, read from what it recorded on the task. */
  review: ReviewVerdict | null;
  /** Evals this step selected that no later step ran. */
  owed: { select: string; files: number } | null;
};

/** What the trace reads beside the run row: the reviewers' recorded verdicts, by the session that wrote each. */
export type TraceExtra = { reviews?: ReadonlyMap<string, ReviewVerdict> };

/** The card a person answered, as they read it: the question (the resolved card's first paragraph), the choices by
 *  label ("[A] Approve" reads "Approve"), the one they chose, and their note without its leading key ("A: …"). */
export function gateCard(raw: Pick<TraceRun, "gate_prompt" | "gate_choices" | "gate_answer" | "gate_response"> | null | undefined, outcome?: string | null): { question: string | null; choices: string[]; answer: string | null; note: string | null } {
  const label = (l: string) => l.replace(/^\s*\[[^\]]{1,3}\]\s*/, "").trim();
  const choices = raw?.gate_choices ?? [];
  const response = raw?.gate_response?.trim() ?? "";
  // "A: note", or a bare "A": the key leads, the rest is the note.
  const keyed = /^([A-Za-z])(?:\s*[:.)-]\s*|$)/.exec(response);
  // A gate's generic "failure" or "success" is the runner's, never a choice a person made.
  const said = raw?.gate_answer?.trim() || keyed?.[1] || (outcome && !/^(failure|success)$/i.test(outcome) ? outcome : null) || null;
  const chosen = said ? choices.find((c) => c.key.toLowerCase() === said.toLowerCase() || label(c.label).toLowerCase() === said.toLowerCase()) : undefined;
  const question = raw?.gate_prompt?.trim().split(/\n\s*\n/)[0]?.trim() || null;
  return {
    question,
    choices: choices.map((c) => label(c.label)),
    answer: chosen ? label(chosen.label) : said && !/^[a-z]$/i.test(said) ? said : null,
    note: (keyed ? response.slice(keyed[0].length) : response).trim() || null,
  };
}

const JSON_FENCE = /```json[ \t]*\n[\s\S]*?\n[ \t]*```/g;
const clean = (t: string | null | undefined) => (t ?? "").replace(JSON_FENCE, "").trim() || null;

/** Every visit of a run as a trace, numbered, each with its nuts and bolts from the run row. */
export function runTrace(model: Pick<LineModel, "steps">, run: Pick<LineRunModel, "visits"> & { caseTitle?: string; caseRef?: string | null }, raw: TraceRun | null | undefined, extra: TraceExtra = {}): TraceStep[] {
  const nodes = new Map((raw?.node_statuses ?? []).map((n) => [n.node_id, n]));
  const width = Math.max(2, String(run.visits.length).length);
  const last = run.visits.length - 1;
  // A loop stopped by its visit cap: the capped step and every step after its last visit went round that many times.
  const capM = /^max_visits=(\d+) exceeded on (\S+)/.exec(raw?.fail_reason?.trim() ?? "");
  const capNode = capM?.[2] ?? null;
  const capFrom = capNode ? run.visits.reduce((j, v, i) => (v.node === capNode ? i : j), -1) : -1;
  const results = run.visits.map((v) => (v.inferred ? null : v.decided.result ?? jsonObject(nodes.get(v.node)?.result_preview) ?? jsonObject(nodes.get(v.node)?.session?.result)));
  const owed = evalsOwed(run.visits.map((v, i) => ({ node: v.node, inferred: v.inferred, result: results[i] })));
  const closed = raw ? closedGate(raw) : null;
  return run.visits.map((v: LineVisit, i) => {
    const node = v.inferred ? undefined : nodes.get(v.node);
    const step = model.steps[v.node];
    const s = node?.session ?? null;
    const sessionId = s?._id ?? v.sessionId ?? null;
    const pinned = clean(s?.state);
    const output = clean(node?.result_preview);
    const next = run.visits[i + 1];
    const isGate = !!raw?.gate_node_id && raw.gate_node_id === v.node;
    const card = isGate ? gateCard(raw, node?.outcome ?? v.decided.outcome) : null;
    const result = results[i];
    // A gate that came back with no answer records "failure": no choice was made, so it is no outcome.
    const unanswered = v.kind === "person" && !v.inferred && !card?.answer && v.status !== "live" && v.status !== "waiting" && (v.decided.outcome === "failure" || v.status === "failed");
    // The runner fails it ("failure"); the model reads it noted. Either way nothing it did failed. One that printed
    // output ran (a ship that refused a stale branch): its own words say what it did.
    const notRun = closed && !v.inferred && !output && LANDING_STATIONS.has(v.node) && (v.status === "failed" || v.status === "noted") ? `the decision was ${closed}` : null;
    const review = sessionId && v.kind === "agent" ? extra.reviews?.get(sessionId) ?? null : null;
    const checks = v.kind === "script" ? scriptChecks(result, node?.result_preview) : null;
    const errors = v.kind === "script" ? scriptErrors(result) : [];
    let produced = v.inferred ? null : visitOutput({
      kind: v.kind, status: v.status, decided: v.decided, reasoning: card?.note || v.why || pinned,
      raw: node?.result_preview, answer: card?.answer ?? null,
      sessionHref: sessionId ? `/conversation/${sessionId}` : null, caseTitle: run.caseTitle, caseRef: run.caseRef,
    });
    if (review) { const w = reviewWords(review); produced = { kind: "text", text: w.text, ...(w.bad ? { tone: "bad" as const } : {}) }; }
    // A script that only checked what an earlier step wrote (no errors, only paths) reads as what it checked: that step's headline.
    else if (v.kind === "script" && result && Array.isArray(result.errors) && !errors.length && Object.entries(result).every(([k, x]) => k === "errors" || isPathValue(x))) {
      const headline = results.slice(0, i).reverse().map((r) => r?.headline).find((h): h is string => typeof h === "string" && !!h.trim());
      if (headline) produced = { kind: "text", text: `checked: ${headline}` };
    }
    return {
      i,
      n: String(i + 1).padStart(width, "0"),
      node: v.node,
      label: v.label,
      kind: v.kind,
      status: v.status,
      inferred: v.inferred,
      tookMs: v.durationMs,
      outcome: unanswered ? null : v.decided.outcome,
      unanswered,
      produced,
      gist: visitOutputWords(produced),
      next: next ? { i: i + 1, node: next.node, label: next.label, when: v.decided.toWords } : null,
      session: sessionId ? { id: sessionId, short: node?.session_id ?? null, messages: s?.message_count ?? null, killed: !!s?.killed } : null,
      // A session that pinned itself blocked handed the problem back as surely as one that ran the handoff: its pin is
      // what it ended on, and it leads over whatever it said in chat after.
      handoff: s?.handoff && s.handoff.status !== "done" ? { status: s.handoff.status, note: s.handoff.note?.trim() || null }
        : s?.state_status === "blocked" && pinned ? { status: "blocked", note: pinned } : null,
      pinned,
      output,
      tokens: node?.tokens ?? null,
      costUsd: node?.cost_usd ?? null,
      command: step?.prompt?.kind === "script" ? step.prompt.text : null,
      // An agent's step that never got a session says so where its work would be ("It never started"): no reason line repeats it.
      ...(i === last && node && raw && stationEnd({ id: v.node, status: node.status as never, session: node.session as never, session_id: node.session_id, completed_at: node.completed_at }, raw as unknown as ReportRun)?.kind === "went_quiet" ? { quiet: true } : {}),
      failReason: i === last && v.status === "failed" && !notRun && raw?.fail_reason && !(v.kind === "agent" && !sessionId && !output && !pinned) ? stepFailWords(raw as unknown as ReportRun, v.node) : null,
      notRun,
      rounds: capFrom >= 0 && i >= capFrom && !v.inferred ? Number(capM![1]) : null,
      capped: capFrom === i,
      gate: isGate || (v.kind === "person" && !v.inferred) ? {
        ref: isGate ? raw?.gate_decision_short_id ?? null : null,
        question: card?.question ?? null,
        choices: card?.choices ?? [],
        answer: card?.answer ?? null,
        note: card?.note ?? null,
      } : null,
      checks,
      errors,
      review,
      owed: owed && owed.at === i ? { select: owed.select, files: owed.files } : null,
    };
  });
}


// ── what a command was run with ──────────────────────────────────────────────

/** A step's output as the runner keeps it under `<id>.json`: the whole text when it is JSON, else its last fenced json block. */
function jsonOf(text: string | null | undefined): unknown {
  const t = (text ?? "").trim();
  if (!t) return undefined;
  try { return JSON.parse(t); } catch { /* not whole JSON */ }
  const fences = [...t.matchAll(/```json[ \t]*\n([\s\S]*?)\n[ \t]*```/g)];
  const last = fences[fences.length - 1]?.[1];
  if (!last) return t.startsWith("{") ? headFields(t) : undefined;
  try { return JSON.parse(last); } catch { return undefined; }
}

/** What a run's steps put out, by step id: what a later command's `$<id>.output` and `$<id>.json.<path>` read. */
export type RunVars = { output: Map<string, string>; json: Map<string, unknown>; run: Map<string, string> };

/** The values a run's commands read, from its run row (each step's recorded output) and the model's reading of each visit. */
export function runVars(run: Pick<LineRunModel, "id" | "visits" | "caseId" | "caseRef" | "caseTitle">, raw: TraceRun | null | undefined): RunVars {
  const output = new Map<string, string>();
  const json = new Map<string, unknown>();
  for (const n of raw?.node_statuses ?? []) {
    if (!n.result_preview) continue;
    output.set(n.node_id, n.result_preview);
    const j = jsonOf(n.result_preview);
    if (j !== undefined) json.set(n.node_id, j);
  }
  for (const v of run.visits) if (!v.inferred && v.decided.result && !json.has(v.node)) json.set(v.node, v.decided.result);
  const vars = new Map<string, string>();
  vars.set("run_id", run.id);
  // The problem as a reader names it (ct-N); the row id it ran with is a hover away.
  if (run.caseRef || run.caseId) vars.set("task_id", (run.caseRef ?? run.caseId)!);
  if (run.caseRef) vars.set("task_ref", run.caseRef);
  if (run.caseTitle) vars.set("task_title", run.caseTitle);
  return { output, json, run: vars };
}

const valueWords = (v: unknown): string | null => (v == null ? null : typeof v === "object" ? JSON.stringify(v) : String(v));

/** A `$name` as the runner expanded it on this run (expandScriptVars), or null when the run kept no value for it. */
export function varValue(name: string, vars: RunVars): string | null {
  const [id, kind, ...path] = name.split(".");
  if (!kind) return vars.run.get(id) ?? null;
  if (kind === "output" && !path.length) return vars.output.get(id) ?? null;
  if (kind !== "json" || !vars.json.has(id)) return null;
  let at: unknown = vars.json.get(id);
  for (const p of path) {
    if (at == null || typeof at !== "object") return null;
    at = (at as Record<string, unknown>)[p];
  }
  return valueWords(at);
}

/** A piece of a command as it ran: written text, or a value put in for `name` (unset when the run kept none). */
export type CommandPart = { text: string; name?: string; unset?: boolean };

const TOKEN = /\$\{([A-Za-z_]\w*)(?::([+-])((?:[^{}]|\{[^}]*\})*))?\}|\$([a-zA-Z_][\w.]*)/g;
const ASSIGN = /(^|[;&|\n]\s*|\s)([A-Za-z_]\w*)=("(?:[^"\\]|\\.)*"|'[^']*'|[^\s;&|]*)/g;

/**
 * A command as the runner ran it (expandScriptVars, then the shell): every `$step.json.field` and `$task_id` set to
 * its value on this run, the shell's own assignments (`note="$dissolve.json.note"`) carried into `$note`, `${note}`,
 * `${note:+ text}` and `${note:-text}`. A `$name` the run kept no value for and the command never set reads as written;
 * a `$step.field` with no value is marked unset.
 */
export function expandCommand(template: string, resolve: (name: string) => string | null): CommandPart[] {
  const local = new Map<string, string>();
  const valueOf = (name: string): string | null => local.get(name) ?? resolve(name);
  const expand = (text: string): CommandPart[] => {
    const out: CommandPart[] = [];
    let at = 0;
    for (const m of text.matchAll(TOKEN)) {
      if (m.index! > at) out.push({ text: text.slice(at, m.index) });
      at = m.index! + m[0].length;
      const [whole, braced, op, word, bare] = m;
      const name = braced ?? bare;
      const value = valueOf(name);
      if (op === "+") { if (value) out.push(...expand(word ?? "")); continue; }
      if (op === "-") { if (value) out.push({ text: value, name }); else out.push(...expand(word ?? "")); continue; }
      if (value != null) out.push({ text: value, name });
      else out.push(name.includes(".") ? { text: whole, name, unset: true } : { text: whole });
    }
    if (at < text.length) out.push({ text: text.slice(at) });
    return out;
  };
  const flat = (parts: CommandPart[]) => parts.map((p) => (p.unset ? "" : p.text)).join("");
  // The shell's assignments, in order, so a later line reads what an earlier one set.
  for (const m of template.matchAll(ASSIGN)) {
    const raw = m[3];
    const inner = raw.startsWith("'") ? raw.slice(1, -1) : raw.startsWith('"') ? raw.slice(1, -1) : raw;
    local.set(m[2], raw.startsWith("'") ? inner : flat(expand(inner)));
  }
  // Adjacent written text joins, so a reader's line is one run of text between values.
  const parts = expand(template);
  return parts.reduce<CommandPart[]>((acc, p) => {
    const last = acc[acc.length - 1];
    if (last && !last.name && !p.name) last.text += p.text;
    else acc.push({ ...p });
    return acc;
  }, []);
}


/** A long text's head for reading in place: the first `lines` lines (and at most `chars`), and how many lines are left. */
export function textHead(text: string, lines = 14, chars = 1600): { head: string; more: number; total: number } {
  const all = text.replace(/\s+$/, "").split("\n");
  let head = all.slice(0, lines).join("\n");
  if (head.length > chars) head = head.slice(0, chars).replace(/\s+\S*$/, "") + " …";
  const shown = head.split("\n").length;
  return { head, more: Math.max(0, all.length - shown), total: all.length };
}

// ── a session's last word ────────────────────────────────────────────────────

/** The fields of a conversation message the trace reads. */
export type TraceMessage = {
  role: string;
  content?: string | null;
  tool_calls?: ReadonlyArray<{ id: string; name: string; input?: unknown }> | null;
  tool_results?: ReadonlyArray<{ tool_use_id: string; is_error?: boolean }> | null;
  timestamp?: number;
};

/** What an agent's session said last (its newest assistant text) and how many tool calls the loaded messages hold. */
export function lastWord(messages: ReadonlyArray<TraceMessage>): { text: string | null; at: number | null; tools: number } {
  let tools = 0;
  for (const m of messages) if (m.role === "assistant") tools += m.tool_calls?.length ?? 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    const text = m.role === "assistant" ? stripTags(m.content ?? "") : "";
    if (text) return { text, at: m.timestamp ?? null, tools };
  }
  return { text: null, at: null, tools };
}

/** One tool call an agent made: the tool, what it acted on (the command, the file, the pattern), and how it came back. */
export type ToolLogRow = { id: string; tool: string; target: string; status: "ok" | "error" | "open"; at: number | null };

/** An agent session's tool calls in the order it made them, each matched to its result (tool_use_id). */
export function toolLog(messages: ReadonlyArray<TraceMessage>): ToolLogRow[] {
  const results = new Map<string, boolean>();
  for (const m of messages) for (const r of m.tool_results ?? []) results.set(r.tool_use_id, !!r.is_error);
  const out: ToolLogRow[] = [];
  for (const m of messages) {
    if (m.role !== "assistant") continue;
    for (const c of m.tool_calls ?? []) {
      const err = results.get(c.id);
      out.push({ id: c.id, tool: c.name, target: toolCallGist(c.input, 160), status: err === undefined ? "open" : err ? "error" : "ok", at: m.timestamp ?? null });
    }
  }
  return out;
}

/** A message's words for a person: harness tags out, and a leading addressee tag a station wrote for whoever it took
 *  to be reading ("[the gate] Done: ..."), which names a routing hop, never anything the person reads. */
const stripTags = (t: string) => t.replace(/<(system-reminder|thinking)>[\s\S]*?<\/\1>/g, "").trim().replace(/^\[(?:to )?[a-z][a-z' -]{2,30}\]\s+/i, "");


/** What a step's row says it decided: its outcome in words, else its state; nothing when it only handed on. */
export function outcomeLabel(s: Pick<TraceStep, "outcome" | "status" | "inferred"> & { unanswered?: boolean }): string {
  if (s.inferred) return "";
  if (s.unanswered) return "no answer";
  if (s.status === "live") return "running";
  if (s.status === "waiting") return "waiting";
  // A gate's answer key ("a") is not words: the step's output names the choice.
  if (s.outcome && !isAnswerKey(s.outcome)) return s.outcome.replace(/_/g, " ");
  return s.status === "failed" ? "failed" : "";
}

/** A step's printed output as a person reads it: JSON laid out one field a line (its strings' escaped newlines as
 *  real ones), a JSON cut off by the record's cap unescaped the same way; anything else as printed. */
export function readableOutput(text: string): string {
  const t = text.trim();
  if (!t.startsWith("{") && !t.startsWith("[")) return text;
  try { return JSON.stringify(JSON.parse(t), null, 2).replace(/\\n/g, "\n  "); } catch { /* cut off */ }
  return t.replace(/\\n/g, "\n").replace(/\\"/g, '"').replace(/","/g, '",\n"');
}
