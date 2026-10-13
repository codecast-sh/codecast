// A run's detail read like a debugger trace (line-workspace.md LW1), pure and
// tested: where the problem came from (its findings, their source and judge),
// then every step the run visited in order with what it was given, what it
// did and where it sent the run. The model (lineModel) says what each visit
// decided; the run row's own node record adds the nuts and bolts the model
// leaves out: the session and its size, the script's printed output, tokens,
// cost, how the run failed.
import { toolCallGist } from "../toolCallGist";
import { signalQuotes } from "@codecast/shared/contracts/causeHistory";
import type { LineModel, LineRunModel, LineVisit, StepKind } from "./lineModel";
import { closedGate, LANDING_STATIONS, stationEnd, stepFailWords, type ReportRun, type StepState } from "./runReport";
import { headFields, isAnswerKey, jsonObject, visitOutput, visitOutputWords, type VisitOutput } from "./visitOutput";
import { evalsOwed, isPathValue, reviewWords, scriptChecks, scriptErrors, type ReviewVerdict, type ScriptChecks } from "./scriptReport";

// ── where the problem came from ──────────────────────────────────────────────

/** The fields of a finding (a signals row) the source block reads. */
export type TraceSignal = {
  _id: string;
  short_id?: string;
  source: string;
  title: string;
  detail_md?: string;
  evidence_url?: string;
  judge?: string;
  severity?: number;
  /** A codecast judge's finding: the moment it read (mo-N) and the expectation it cites. */
  moment?: string;
  subject?: string;
  observed_at: number;
  created_at: number;
  task_id: string;
};

export type RunSource = {
  /** Findings the problem held when the run started (loaded here). */
  count: number;
  /** Findings loaded here that came in after the run started. */
  later: number;
  /** Each source and how many findings it gave by the start, most first. */
  sources: Array<{ source: string; count: number }>;
  /** Every finding the problem held at the start, newest first: the set its steps were given. */
  findings: Array<{ id: string; ref: string | null; source: string; judge: string | null; title: string; at: number; line: string }>;
  /** The finding the run started on: the newest by its start, then the most severe. */
  lead: {
    id: string;
    ref: string | null;
    source: string;
    judge: string | null;
    severity: number | null;
    title: string;
    /** The finder's own bold line, when it differs from the title. */
    headline: string | null;
    /** The first thing the finding quotes (the customer's or the agent's words). */
    quote: string | null;
    evidenceUrl: string | null;
    /** The moment a codecast judge read for it, and the expectation it cites. */
    moment: string | null;
    expectation: string | null;
    at: number;
  } | null;
};

/** A finding's own line in a list: its title, unless other findings share it (an expectation's name, "Not met: …"),
 *  then what sets it apart: the words it quotes, else its bold head, else the first line of its detail that is not
 *  the title. */
function findingLine(s: TraceSignal, repeated: ReadonlySet<string>): string {
  if (!repeated.has(s.title)) return s.title;
  const own = signalQuotes(s.detail_md)[0] ?? boldHead(s.detail_md)
    ?? (s.detail_md ?? "").split("\n").map((l) => l.replace(/^[#>*\-\s]+/, "").trim()).find((l) => l && l !== s.title && !s.title.startsWith(l));
  return own || s.title;
}

/** What a run's diagnosis re-targeted the problem to: the cause code its Investigate named, its statement, and what
 *  Refine kept and evicted of the findings (with its own word: "refined", "wrong_cause"). Null when neither said. */
export type RunRetarget = { cause: string | null; statement: string | null; refine: string | null; kept: number | null; evicted: number | null; evidence: string | null };

export function runRetarget(raw: Pick<TraceRun, "node_statuses"> | null | undefined): RunRetarget | null {
  let cause: string | null = null;
  let statement: string | null = null;
  let refine: string | null = null;
  let kept: number | null = null;
  let evicted: number | null = null;
  let evidence: string | null = null;
  for (const n of raw?.node_statuses ?? []) {
    const j = jsonOf(n.result_preview || n.session?.result || n.session?.state) as Record<string, unknown> | undefined;
    if (!j || typeof j !== "object") continue;
    if (typeof j.cause === "string" && /^C\d+$/i.test(j.cause.trim())) {
      cause = j.cause.trim();
      statement = typeof j.statement === "string" ? j.statement : statement;
    }
    if (n.node_id === "refine" || typeof j.kept === "number" || typeof j.evicted === "number") {
      if (typeof j.outcome === "string") refine = j.outcome;
      if (typeof j.kept === "number") kept = j.kept;
      if (typeof j.evicted === "number") evicted = j.evicted;
      if (typeof j.evidence === "string" && j.evidence.trim()) evidence = j.evidence.trim();
    }
  }
  return cause || kept != null || evicted != null ? { cause, statement, refine, kept, evicted, evidence } : null;
}

/** The bold line a finder opens its detail with ("**Contact declined …** (severity 9/10)"). */
function boldHead(detail: string | undefined): string | null {
  const m = detail?.match(/^\s*\*\*(.+?)\*\*/);
  return m ? m[1].trim() : null;
}

/** The severity a finder wrote into its detail ("(severity 9/10, …)") when the row carries none. */
function severityIn(detail: string | undefined): number | null {
  const m = detail?.match(/\bseverity\s+(\d+(?:\.\d+)?)\s*\/\s*10\b/i);
  return m ? Number(m[1]) : null;
}

/**
 * Where a run came from: the problem's findings as they stood when the run started (observed at or before
 * `startedAt`), by source, led by the newest of them, the one the run was started on. Findings that came in
 * after the run started are `later`, never its source. Without `startedAt`, every finding counts.
 */
export function runSource(signals: ReadonlyArray<TraceSignal>, caseId: string | null, startedAt?: number | null): RunSource {
  const seen = new Set<string>();
  const all = caseId ? signals.filter((s) => s.task_id === caseId && !seen.has(s._id) && !!seen.add(s._id)) : [];
  const at = (s: TraceSignal) => s.observed_at || s.created_at;
  const mine = startedAt == null ? all : all.filter((s) => at(s) <= startedAt);
  const by = new Map<string, number>();
  for (const s of mine) by.set(s.source, (by.get(s.source) ?? 0) + 1);
  const sources = [...by].map(([source, count]) => ({ source, count })).sort((a, b) => b.count - a.count || a.source.localeCompare(b.source));
  const sev = (s: TraceSignal) => s.severity ?? severityIn(s.detail_md);
  const top = [...mine].sort((a, b) => at(b) - at(a) || (sev(b) ?? -1) - (sev(a) ?? -1))[0];
  const head = top ? boldHead(top.detail_md) : null;
  const titles = new Map<string, number>();
  for (const x of mine) titles.set(x.title, (titles.get(x.title) ?? 0) + 1);
  const repeated = new Set([...titles].filter(([, n]) => n > 1).map(([t]) => t));
  return {
    count: mine.length,
    later: all.length - mine.length,
    sources,
    findings: [...mine].sort((a, b) => at(b) - at(a)).map((s) => ({ id: s._id, ref: s.short_id ?? null, source: s.source, judge: s.judge ?? null, title: s.title, at: at(s), line: findingLine(s, repeated) })),
    lead: top ? {
      id: top._id,
      ref: top.short_id ?? null,
      source: top.source,
      judge: top.judge ?? null,
      severity: sev(top),
      title: top.title,
      headline: head && head !== top.title ? head : null,
      quote: signalQuotes(top.detail_md)[0] ?? null,
      evidenceUrl: top.evidence_url ?? null,
      moment: top.moment ?? null,
      expectation: top.moment ? top.subject ?? null : null,
      at: at(top),
    } : null,
  };
}

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

/** A run's totals across its steps: how many of each kind, tokens and cost where recorded. */
export function traceTotals(steps: ReadonlyArray<TraceStep>): { agent: number; script: number; person: number; tokens: number; costUsd: number } {
  const t = { agent: 0, script: 0, person: 0, tokens: 0, costUsd: 0 };
  for (const s of steps) {
    if (s.kind === "agent" || s.kind === "script" || s.kind === "person") t[s.kind]++;
    t.tokens += s.tokens ?? 0;
    t.costUsd += s.costUsd ?? 0;
  }
  return t;
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

/** The fields later steps read from a step (`$<id>.json.<field>`, `$<id>.output`), each with the steps that read it. */
export function readsOf(model: Pick<LineModel, "steps" | "order">, stepId: string): Array<{ name: string; field: string; by: string[]; byIds: string[] }> {
  const out = new Map<string, { name: string; field: string; by: string[]; byIds: string[] }>();
  for (const id of model.order) {
    const st = model.steps[id];
    if (!st?.prompt || id === stepId) continue;
    for (const n of namedInputs(st.prompt.text)) {
      const [owner, kind, ...path] = n.split(".");
      if (owner !== stepId || !kind) continue;
      const row = out.get(n) ?? { name: n, field: kind === "json" ? path.join(".") : kind, by: [], byIds: [] };
      if (!row.by.includes(st.label)) { row.by.push(st.label); row.byIds.push(id); }
      out.set(n, row);
    }
  }
  return [...out.values()];
}

/**
 * A `$name`'s value as it was put into a prompt: the template's own text on either side of `$name` found in the prompt
 * the session was handed, and what sits between. Recovers what a script wrote when the run kept no copy, from the
 * step that read it. Null when the template's text around it is too short to anchor on or is not in the prompt.
 */
export function valueFromRendered(template: string, rendered: string, name: string): string | null {
  const token = `$${name}`;
  const NAME = /\$[a-zA-Z_][\w.]*/;
  for (let i = template.indexOf(token); i >= 0; i = template.indexOf(token, i + 1)) {
    // `$a.b` must not match inside `$a.bc`.
    if (/[\w]/.test(template[i + token.length] ?? "") || (template[i + token.length] === "." && /\w/.test(template[i + token.length + 1] ?? ""))) continue;
    const before = template.slice(Math.max(0, i - 80), i).split(NAME).pop()!.replace(/^\s+/, "");
    const after = template.slice(i + token.length).split(NAME)[0].slice(0, 40);
    if (before.trim().length < 4) continue;
    const at = rendered.indexOf(before);
    if (at < 0) continue;
    const start = at + before.length;
    const end = after.trim() ? rendered.indexOf(after.replace(/\s+$/, "") || after, start) : rendered.indexOf("\n", start);
    const value = (end >= start ? rendered.slice(start, end) : rendered.slice(start)).trim();
    if (value) return value;
  }
  return null;
}

/** The `$names` a command or prompt reads, in order, once each. */
export function namedInputs(text: string | null | undefined): string[] {
  const out: string[] = [];
  for (const m of (text ?? "").matchAll(/\$([a-zA-Z_][\w.]*)/g)) if (!out.includes(m[1])) out.push(m[1]);
  return out;
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

/** Money as the trace says it: "$0.41", "<$0.01". */
export const usdWords = (n: number) => (n <= 0 ? "" : n < 0.01 ? "<$0.01" : `$${n.toFixed(2)}`);
/** Tokens as the trace says them: "812", "12.3k", "1.2M". */
export const tokenWords = (n: number) => (n <= 0 ? "" : n < 1000 ? String(n) : n < 1_000_000 ? `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k` : `${(n / 1_000_000).toFixed(1)}M`);

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
