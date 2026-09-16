// The CLI reading surfaces of the line (docs/architecture/the-line.md L10):
// what `cast task show` prints under a task (decisions, runs, evidence), the
// `cast workflow runs` table, and the one row shape `cast org feed` prints for
// every kind, run rows included. Everything here is a pure formatter over the
// rows the server returns; index.ts fetches and prints.
import { c } from "./colors.js";
import { decisionHandle, describeResolution, formatAge, type DecisionRow } from "./decideCommand.js";

// One row of workflow_runs.listRuns (L8): the run plus the joins it ships.
export interface RunRow {
  _id: string;
  status: string;
  workflow_name?: string;
  workflow_slug?: string;
  task_short_id?: string;
  task_title?: string;
  plan_short_id?: string;
  current_node_id?: string;
  current_node_label?: string;
  gate_decision_short_id?: string;
  gate_decision_status?: string;
  fail_reason?: string;
  created_at?: number;
  updated_at: number;
}

// tasks.evidence (L6), as /cli/work/evidence returns it.
export interface EvidencePage {
  slug: string;
  title: string;
  version: number;
  kind: string;
  station: string | null;
  href: string;
  updated_at: number;
}
export interface TaskEvidence {
  task: { id: string; short_id: string; station: string };
  pages: EvidencePage[];
  stations: Array<{ station: string; pages: EvidencePage[] }>;
  docs: Array<{ id: string; title: string; doc_type: string; updated_at: number; href: string }>;
  images: Array<{ url: string; conversation_id: string; message_id: string; timestamp: number }>;
  files_changed: string[];
  verification_evidence: string | null;
  execution_status: string | null;
  pr_url: string | null;
  review_verdict: { verdict: string; at: number; note?: string } | null;
}

// The three objects `cast task show --json` carries beside the task row.
export interface TaskLine {
  decisions: DecisionRow[];
  runs: RunRow[];
  evidence: TaskEvidence | null;
}

// A task's station is its refined status when the team has one (L3).
export function stationOf(task: { status?: string; status_id?: string }): string | undefined {
  return task.status_id ?? task.status;
}

// A pending blocking decision at the task's current station holds it there
// (L5). Nothing is stored for a hold; it is derived here as the task page does.
export function isHolding(decision: DecisionRow, task: { status?: string; status_id?: string }): boolean {
  return decision.status === "pending" && decision.blocking && !!decision.station && decision.station === stationOf(task);
}

const head = (text: string, max = 88): string => {
  const first = (text ?? "").split("\n")[0].trim();
  return first.length > max ? `${first.slice(0, max - 1)}…` : first;
};

export function formatTaskDecisions(rows: DecisionRow[], task: { status?: string; status_id?: string }, now: number = Date.now()): string[] {
  if (rows.length === 0) return [];
  const lines = [`\n  ${c.bold}Decisions (${rows.length})${c.reset} ${c.dim}cast decide show <id>${c.reset}`];
  for (const r of rows) {
    const mark = r.status === "pending" ? `${c.yellow}●${c.reset}` : `${c.dim}○${c.reset}`;
    const state = r.status === "pending" ? `open ${formatAge(now - r.created_at)}` : describeResolution(r);
    const station = r.station ? ` at ${r.station}` : "";
    const held = isHolding(r, task) ? `  ${c.red}holds the task here${c.reset}` : "";
    lines.push(`  ${mark} ${c.cyan}${decisionHandle(r)}${c.reset}  ${head(r.question)}`);
    lines.push(`      ${c.dim}${state}${station}${r.blocking ? "" : " (advisory)"}${c.reset}${held}`);
  }
  return lines;
}

const RUN_MARKS: Record<string, string> = {
  running: `${c.green}●${c.reset}`,
  paused: `${c.yellow}◐${c.reset}`,
  completed: `${c.dim}●${c.reset}`,
  failed: `${c.red}✗${c.reset}`,
  cancelled: `${c.dim}✕${c.reset}`,
};

// The run's one line: status, workflow, current node, the gate's decision.
export function runSummary(run: RunRow): string {
  const node = run.current_node_label ?? run.current_node_id;
  const gate = run.gate_decision_short_id ? `  gate ${c.cyan}${run.gate_decision_short_id}${c.reset}` : "";
  const fail = run.status === "failed" && run.fail_reason ? `  ${c.red}${head(run.fail_reason, 60)}${c.reset}` : "";
  return `${run.status}  ${c.bold}${run.workflow_name ?? "run"}${c.reset}${node ? `  ${c.dim}at ${node}${c.reset}` : ""}${gate}${fail}`;
}

export function formatTaskRuns(runs: RunRow[], now: number = Date.now()): string[] {
  if (runs.length === 0) return [];
  const lines = [`\n  ${c.bold}Runs (${runs.length})${c.reset} ${c.dim}newest first${c.reset}`];
  for (const r of runs) {
    lines.push(`  ${RUN_MARKS[r.status] ?? `${c.dim}○${c.reset}`} ${runSummary(r)}  ${c.dim}${formatAge(now - r.updated_at)}${c.reset}`);
  }
  return lines;
}

const hasEvidence = (ev: TaskEvidence): boolean =>
  ev.pages.length > 0 || ev.docs.length > 0 || ev.images.length > 0 || ev.files_changed.length > 0 ||
  !!ev.verification_evidence || !!ev.pr_url || !!ev.review_verdict;

// Pages print grouped by the station that produced them, each with its /a/
// url on the web origin the CLI is configured for.
export function formatTaskEvidence(ev: TaskEvidence | null, webUrl: string): string[] {
  if (!ev || !hasEvidence(ev)) return [];
  const base = webUrl.replace(/\/$/, "");
  const lines = [`\n  ${c.bold}Evidence${c.reset}`];
  if (ev.stations.length > 0) {
    lines.push(`  ${c.dim}Pages${c.reset}`);
    for (const group of ev.stations) {
      const station = group.station || "unfiled";
      for (const p of group.pages) {
        lines.push(`    ${c.dim}${station}${c.reset}  ${p.title}  ${c.dim}${base}${p.href}${c.reset}`);
      }
    }
  }
  if (ev.docs.length > 0) {
    lines.push(`  ${c.dim}Docs${c.reset}`);
    for (const d of ev.docs) lines.push(`    ${d.title}  ${c.dim}${base}${d.href}${c.reset}`);
  }
  if (ev.images.length > 0) lines.push(`  ${c.dim}Images:${c.reset} ${ev.images.length}`);
  if (ev.files_changed.length > 0) lines.push(`  ${c.dim}Files changed:${c.reset} ${ev.files_changed.join(", ")}`);
  if (ev.pr_url) lines.push(`  ${c.dim}PR:${c.reset} ${ev.pr_url}`);
  if (ev.verification_evidence) {
    lines.push(`  ${c.dim}Verification:${c.reset}`);
    for (const l of ev.verification_evidence.split("\n")) lines.push(`    ${l}`);
  }
  if (ev.review_verdict) {
    const v = ev.review_verdict;
    const color = v.verdict === "approve" ? c.green : v.verdict === "reject" ? c.red : c.yellow;
    lines.push(`  ${c.dim}Review:${c.reset} ${color}${v.verdict}${c.reset}${v.note ? ` ${c.dim}${head(v.note)}${c.reset}` : ""}`);
  }
  return lines;
}

// `cast workflow runs`: one table across workflows.
export function formatRunsTable(runs: RunRow[], now: number = Date.now()): string {
  if (runs.length === 0) return "No runs.";
  const rows = runs.map((r) => [
    formatAge(now - r.updated_at),
    r.status,
    r.workflow_name ?? r.workflow_slug ?? "run",
    r.task_short_id ?? r.plan_short_id ?? "-",
    r.current_node_label ?? r.current_node_id ?? "-",
    r.gate_decision_short_id ?? "-",
  ]);
  const header = ["age", "status", "workflow", "task", "node", "gate"];
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((row) => row[i].length)));
  const line = (cols: string[]) => cols.map((col, i) => (i === cols.length - 1 ? col : col.padEnd(widths[i]))).join("  ");
  return [`${c.dim}${line(header)}${c.reset}`, ...rows.map(line)].join("\n");
}

// `cast org feed`: every kind prints the same shape. A run row's title is its
// workflow and its state is "status · node", so the one printer covers it.
export interface FeedRowLike {
  kind: string;
  short_id?: string;
  title: string;
  state?: string;
  actor?: { name?: string };
  preview?: string;
}

export function formatFeedRow(row: FeedRowLike, age: string, color: string): string[] {
  const who = row.actor?.name ? ` ${c.dim}· ${row.actor.name}${c.reset}` : "";
  const lines = [`${color}${row.kind.padEnd(8)}${c.reset} ${c.dim}${(row.short_id ?? "").padEnd(8)}${c.reset} ${row.title}${row.state ? ` ${c.dim}· ${row.state}${c.reset}` : ""}${who} ${c.dim}${age}${c.reset}`];
  if (row.preview) lines.push(`         ${c.dim}${row.preview}${c.reset}`);
  return lines;
}
