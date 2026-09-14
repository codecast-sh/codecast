// One hand of a role's brief, as `cast brief` and `cast role show` print it.
// Kept out of index.ts so a test can pin the field names against the
// server's BriefHand shape (org.ts): `state` is the work state, and the task
// carries its handoff status and review verdict.
import { c } from "./colors.js";

export type BriefHandRow = {
  short_id: string;
  title: string;
  state: string;
  task?: { short_id: string; status: string; execution_status?: string; review_verdict?: string } | null;
};

export function briefHandLine(h: BriefHandRow): string {
  const task = h.task
    ? ` · ${h.task.short_id} ${h.task.status}${h.task.execution_status ? ` (${h.task.execution_status})` : ""}${h.task.review_verdict ? ` · review ${h.task.review_verdict}` : ""}`
    : "";
  return `    ${c.dim}${h.short_id}${c.reset} ${h.title} ${c.dim}· ${h.state}${task}${c.reset}`;
}
