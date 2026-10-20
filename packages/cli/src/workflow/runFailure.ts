// Why a run failed, in the words the run row, the task and its stop card carry.
import { failReasonWords, handedBackWords, roundsOutWords } from "@codecast/shared/contracts/lineWords";
import { extractJsonOutput } from "./condition";
import type { WorkflowGraph, WorkflowRunState } from "./types";

/**
 * A dead end names the task fields its node's edges route on, as they read:
 * an implement that ended without a handoff says so, not a review_verdict no
 * edge of its own asks about.
 */
export function deadEndReason(graph: WorkflowGraph, nodeId: string, outcome: string, context: Record<string, string>): string {
  const routedOn = ["handoff", "review_verdict"].filter((k) =>
    k in context && graph.edges.some((e) => e.from === nodeId && new RegExp(`\\b${k}\\b`).test(e.condition ?? "")));
  return `no outgoing edge from ${nodeId} (outcome ${outcome}${routedOn.map((k) => `, ${k} ${context[k]}`).join("")})`;
}

/**
 * A run the daemon handed a runner that cannot read the line profile fails
 * with the profile's words. Left unreported it stayed taken until the server's
 * sweep called it unclaimed (a profile key newer than the machine's cast,
 * Union 2026-10-15).
 */
export function profileFailure(startNodeId: string, message: string) {
  return {
    current_node_id: startNodeId,
    node_id: startNodeId,
    node_status: "failed" as const,
    run_status: "failed" as const,
    fail_reason: `the line profile could not be read on this machine: ${message}`,
  };
}

export const quotedTitle = (context: Record<string, string>, fallback: string) => {
  const title = context["task_title"] || fallback;
  return `“${title.length > 80 ? `${title.slice(0, 79)}…` : title}”`;
};

// A fence that cannot be closed by the text inside it.
function fenced(text: string): string {
  const longest = Math.max(2, ...[...text.matchAll(/`{3,}/g)].map((m) => m[0].length));
  const fence = "`".repeat(longest + 1);
  return `${fence}text\n${text}\n${fence}`;
}

/**
 * What a station said when it failed, for a person reading cold. A check
 * that prints `{ steps: [{ name, ok, detail }], logs }` on stdout (line-
 * profile.md LP4) reads as a checklist; the rest of its output, the human
 * log, follows as a code block rather than prose a markdown renderer would
 * fold into one paragraph.
 */
export function stationFailureMarkdown(context: Record<string, string>, nodeId: string): string {
  let json: any;
  try { json = JSON.parse(context[`${nodeId}.json`] ?? ""); } catch {}
  const steps = Array.isArray(json?.steps) ? json.steps.filter((s: any) => typeof s?.name === "string") : [];
  const list = steps.map((s: any) => `- ${s.ok === false ? "✗" : "✓"} ${s.name}${s.ok === false && s.detail ? `: ${String(s.detail)}` : ""}`).join("\n");
  const raw = context[`${nodeId}.output`] || context["last_error"] || "";
  const log = raw.split("\n").filter((line) => !(json && /^\s*\{/.test(line) && extractJsonOutput(line) !== undefined)).join("\n").trim();
  const tail = log.length > 1500 ? `…${log.slice(-1500)}` : log;
  return [list, tail ? fenced(tail) : "", typeof json?.logs === "string" ? `Logs: ${json.logs}` : ""].filter(Boolean).join("\n\n");
}

/**
 * The failure path's card (the-line.md L4): a question that says what
 * stopped the run and a body that shows why, from the station that sent the
 * last round back. The blocker comment is `summary` over the same body.
 */
export function taskStopCard(graph: WorkflowGraph, state: WorkflowRunState, taskId: string): { question: string; summary: string; body: string } {
  const reason = state.failReason || "workflow failed";
  const label = (id: string) => graph.nodes.get(id)?.label || id;
  const title = quotedTitle(state.context, taskId);
  const handoff = state.context["handoff"];
  const at = state.currentNodeId;
  const hand = at ? state.context[`${at}.session_id`] : undefined;
  const footer = hand ? `\n\n${label(at)} session: ${hand}` : "";
  if (handoff === "blocked" || handoff === "needs_context") {
    const said = state.context["last_error"] ? fenced(state.context["last_error"].slice(0, 1500)) : "";
    return {
      question: `${label(at)} handed off ${handoff} on ${title}. What next?`,
      summary: handedBackWords(label(at), handoff),
      body: `${said}${footer}`.trim(),
    };
  }
  if (/max_visits/.test(reason)) {
    const visits = graph.nodes.get(at)?.max_visits ?? state.visitCounts[at] - 1;
    // The station that routed into the visit over the limit: its edge label
    // ("checks failed", "changes") is the reason the round was sent back.
    const from = state.completed[state.completed.length - 1];
    const sentBack = from && from !== at ? from : undefined;
    const edgeLabel = sentBack ? graph.edges.find((e) => e.from === sentBack && e.to === at)?.label : undefined;
    const says = sentBack ? `${label(sentBack)} still says “${edgeLabel || state.context[`${sentBack}.outcome`] || "failed"}”` : "";
    const lead = `**${label(at)} ran ${visits} times, the most this line allows${sentBack ? `, and ${label(sentBack)} sent the last round back` : ""}.** The task is parked in review as blocked.`;
    const detail = !sentBack ? ""
      : state.context[`${sentBack}.outcome`] === "failure" ? `\n\n**${label(sentBack)}**\n\n${stationFailureMarkdown(state.context, sentBack)}`
      : state.context["review_note"] ? `\n\n**${label(sentBack)}**\n\n${state.context["review_note"]}` : "";
    return {
      question: `${sentBack ? `${says} after` : "Stopped after"} ${visits} ${label(at)} rounds on ${title}. What next?`,
      summary: roundsOutWords(label(at)),
      body: `${lead}${detail}${footer}`,
    };
  }
  const detail = state.context["last_error"] ? fenced(state.context["last_error"].slice(0, 1500)) : "";
  return { question: `${title} failed. What next?`, summary: failReasonWords(reason, label), body: `${detail}${footer}`.trim() };
}
