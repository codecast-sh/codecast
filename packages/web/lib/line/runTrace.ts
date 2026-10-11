// A run's detail read like a debugger trace (line-workspace.md LW1), pure and
// tested: where the problem came from (its findings, their source and judge),
// then every step the run visited in order with what it was given, what it
// did and where it sent the run. The model (lineModel) says what each visit
// decided; the run row's own node record adds the nuts and bolts the model
// leaves out: the session and its size, the script's printed output, tokens,
// cost, how the run failed.
import { signalQuotes } from "@codecast/shared/contracts/causeHistory";
import type { LineModel, LineRunModel, LineVisit, StepKind } from "./lineModel";
import type { StepState } from "./runReport";

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
  observed_at: number;
  created_at: number;
  task_id: string;
};

export type RunSource = {
  /** Findings the problem holds. */
  count: number;
  /** Each source and how many findings it gave, most first. */
  sources: Array<{ source: string; count: number }>;
  /** The finding the problem leads with: the most severe, then the newest. */
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
    at: number;
  } | null;
};

/** The bold line a finder opens its detail with ("**Contact declined …** (severity 9/10)"). */
function boldHead(detail: string | undefined): string | null {
  const m = detail?.match(/^\s*\*\*(.+?)\*\*/);
  return m ? m[1].trim() : null;
}

/** Where a problem came from: its findings, by source, with the one it leads with. */
export function runSource(signals: ReadonlyArray<TraceSignal>, caseId: string | null): RunSource {
  const mine = caseId ? signals.filter((s) => s.task_id === caseId) : [];
  const by = new Map<string, number>();
  for (const s of mine) by.set(s.source, (by.get(s.source) ?? 0) + 1);
  const sources = [...by].map(([source, count]) => ({ source, count })).sort((a, b) => b.count - a.count || a.source.localeCompare(b.source));
  const top = [...mine].sort((a, b) => (b.severity ?? -1) - (a.severity ?? -1) || b.created_at - a.created_at)[0];
  const head = top ? boldHead(top.detail_md) : null;
  return {
    count: mine.length,
    sources,
    lead: top ? {
      id: top._id,
      ref: top.short_id ?? null,
      source: top.source,
      judge: top.judge ?? null,
      severity: top.severity ?? null,
      title: top.title,
      headline: head && head !== top.title ? head : null,
      quote: signalQuotes(top.detail_md)[0] ?? null,
      evidenceUrl: top.evidence_url ?? null,
      at: top.observed_at || top.created_at,
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
  session?: { _id: string; title?: string; state?: string; message_count?: number; killed?: boolean } | null;
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
  gate_answer?: string;
  gate_response?: string;
  gate_decision_short_id?: string;
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
  /** What it decided, as a key ("proved"), null when it only handed on. */
  outcome: string | null;
  /** One line: what it concluded or printed. */
  gist: string | null;
  /** Where it sent the run, and the edge's words for that way. */
  next: { i: number; node: string; label: string; when: string | null } | null;
  /** Its session (an agent step), with how much happened in it. */
  session: { id: string; short: string | null; messages: number | null; killed: boolean } | null;
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
  /** A person's card at this step: the decision it was asked on, the choices, the answer. */
  gate: { ref: string | null; choices: string[]; answer: string | null; note: string | null } | null;
};

const JSON_FENCE = /```json[ \t]*\n[\s\S]*?\n[ \t]*```/g;
const clean = (t: string | null | undefined) => (t ?? "").replace(JSON_FENCE, "").trim() || null;
const firstLine = (t: string | null) => (t ? t.split("\n").map((l) => l.replace(/^[#>*\-\s]+/, "").trim()).find(Boolean) ?? null : null);
const GENERIC = new Set(["Done", "Running", "Failed", "Waiting", "Handed on"]);

/** Every visit of a run as a trace, numbered, each with its nuts and bolts from the run row. */
export function runTrace(model: Pick<LineModel, "steps">, run: Pick<LineRunModel, "visits">, raw: TraceRun | null | undefined): TraceStep[] {
  const nodes = new Map((raw?.node_statuses ?? []).map((n) => [n.node_id, n]));
  const width = Math.max(2, String(run.visits.length).length);
  const last = run.visits.length - 1;
  return run.visits.map((v: LineVisit, i) => {
    const node = v.inferred ? undefined : nodes.get(v.node);
    const step = model.steps[v.node];
    const s = node?.session ?? null;
    const sessionId = s?._id ?? v.sessionId ?? null;
    const pinned = clean(s?.state);
    const output = clean(node?.result_preview);
    const said = v.decided.words && !GENERIC.has(v.decided.words) ? v.decided.words : null;
    const gist = v.inferred ? null : said ?? firstLine(pinned) ?? firstLine(output) ?? firstLine(clean(node?.activity));
    const next = run.visits[i + 1];
    const isGate = !!raw?.gate_node_id && raw.gate_node_id === v.node;
    return {
      i,
      n: String(i + 1).padStart(width, "0"),
      node: v.node,
      label: v.label,
      kind: v.kind,
      status: v.status,
      inferred: v.inferred,
      tookMs: v.durationMs,
      outcome: v.decided.outcome,
      gist,
      next: next ? { i: i + 1, node: next.node, label: next.label, when: v.decided.toWords } : null,
      session: sessionId ? { id: sessionId, short: node?.session_id ?? null, messages: s?.message_count ?? null, killed: !!s?.killed } : null,
      pinned,
      output,
      tokens: node?.tokens ?? null,
      costUsd: node?.cost_usd ?? null,
      command: step?.prompt?.kind === "script" ? step.prompt.text : null,
      failReason: i === last && v.status === "failed" ? raw?.fail_reason ?? null : null,
      gate: isGate || (v.kind === "person" && !v.inferred) ? {
        ref: isGate ? raw?.gate_decision_short_id ?? null : null,
        choices: isGate ? (raw?.gate_choices ?? []).map((c) => c.label) : [],
        answer: isGate ? raw?.gate_answer ?? null : null,
        note: isGate ? raw?.gate_response ?? null : null,
      } : null,
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
export type TraceMessage = { role: string; content?: string | null; tool_calls?: ReadonlyArray<unknown> | null; timestamp?: number };

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

const stripTags = (t: string) => t.replace(/<(system-reminder|thinking)>[\s\S]*?<\/\1>/g, "").trim();

/** Money as the trace says it: "$0.41", "<$0.01". */
export const usdWords = (n: number) => (n <= 0 ? "" : n < 0.01 ? "<$0.01" : `$${n.toFixed(2)}`);
/** Tokens as the trace says them: "812", "12.3k", "1.2M". */
export const tokenWords = (n: number) => (n <= 0 ? "" : n < 1000 ? String(n) : n < 1_000_000 ? `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k` : `${(n / 1_000_000).toFixed(1)}M`);

/** What a step's row says it decided: its outcome in words, "ok" when it only handed on, else its state. */
export function outcomeLabel(s: Pick<TraceStep, "outcome" | "status" | "inferred">): string {
  if (s.inferred) return "";
  if (s.status === "live") return "running";
  if (s.status === "waiting") return "waiting";
  if (s.outcome) return s.outcome.replace(/_/g, " ");
  return s.status === "failed" ? "failed" : "ok";
}
