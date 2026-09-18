// One hand of a role's brief, as `cast brief` and `cast role show` print it.
// Kept out of index.ts so a test can pin the field names against the
// server's BriefHand shape (org.ts): `state` is the work state, and the task
// carries its handoff status and review verdict.
import { c } from "./colors.js";
import { goalStateLine, type GoalProgress } from "@codecast/shared/contracts/roleGoals";

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

// The people who report to the role (org-roles-run-work.md R6), as `cast
// brief` prints them: each person's goals from the brief with what moved and
// what stalled, then the sessions of theirs that changed since the last frame.
export type BriefPersonRow = {
  name: string;
  has_section: boolean;
  goals: Array<GoalProgress & { text: string; priority: string | null }>;
  sessions_changed: Array<{ short_id: string; title: string; state: string; state_line: string | null }>;
};

export function briefPeopleLines(people: BriefPersonRow[], now: number): string[] {
  const out: string[] = [];
  for (const p of people) {
    out.push(`    ${c.cyan}${p.name}${c.reset} ${c.dim}· ${p.goals.length} goal${p.goals.length === 1 ? "" : "s"} · ${p.sessions_changed.length} session${p.sessions_changed.length === 1 ? "" : "s"} changed${c.reset}`);
    if (!p.has_section) out.push(`      ${c.dim}no goals yet: write them under "## Goals: ${p.name}" in the brief${c.reset}`);
    p.goals.forEach((g, i) => {
      const tone = g.stalled ? c.yellow : "";
      out.push(`      ${i + 1}. ${g.text}${g.priority ? ` ${c.dim}(${g.priority})${c.reset}` : ""} ${tone}${c.dim}· ${goalStateLine(g, now)}${c.reset}`);
    });
    for (const s of p.sessions_changed) out.push(`      ${c.dim}${s.short_id}${c.reset} ${s.title} ${c.dim}· ${s.state}${s.state_line ? ` — ${s.state_line}` : ""}${c.reset}`);
  }
  return out;
}

// The charter block of `cast brief`: the humans' statement of the job, which
// every frame tells the role to read here. Absent charter says so.
export function briefCharterLines(charter: string): string[] {
  const body = charter.trim() ? charter.split("\n").map((l) => `  ${l}`) : ["  (no charter yet: a person writes it on the role page)"];
  return ["", `  ${c.bold}## Charter${c.reset}`, ...body];
}
