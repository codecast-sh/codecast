// One session under a role, in its brief, as `cast brief` and `cast role show` print it.
// Kept out of index.ts so a test can pin the field names against the
// server's BriefHand shape (org.ts): `state` is the work state, and the task
// carries its handoff status and review verdict.
import { c } from "./colors.js";
import { goalStateLine, type GoalProgress } from "@codecast/shared/contracts/roleGoals";
import { isWholeWorkspaceRole } from "@codecast/shared/contracts/orgLead";

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

const SCOPE_PLANS_NAMED = 5;
const PLANS_LISTED = 8;

/** What a role that names no projects and no plans looks after (org-staffing.md
 *  S26): nothing of its own, unless it is the Head of People. */
export function noScopeWords(handle?: string): string {
  return isWholeWorkspaceRole({ _id: "", handle }) ? "the whole workspace, apart from what a lead looks after" : "no area of its own";
}

/** A role's scope in one line: its projects by name, the few plans that sit
 *  outside them, and a count for the rest. A plan inside a listed project is
 *  named by its project. */
export function briefScopeLine(scope: { projects: Array<{ id: string; title: string }>; plans: Array<{ short_id: string; title: string; project_id?: string }> }, handle?: string): string {
  const projectIds = new Set(scope.projects.map((p) => String(p.id)));
  const loose = scope.plans.filter((p) => !p.project_id || !projectIds.has(String(p.project_id)));
  const names = [
    ...scope.projects.map((p) => `project ${p.title}`),
    ...loose.slice(0, SCOPE_PLANS_NAMED).map((p) => `plan ${p.short_id} ${p.title}`),
    ...(loose.length > SCOPE_PLANS_NAMED ? [`and ${loose.length - SCOPE_PLANS_NAMED} more plans`] : []),
  ];
  return names.length ? names.join(", ") : noScopeWords(handle);
}

/** The plans worth a line: active ones that hold tasks, newest first, a few
 *  at most, then a count. A draft, finished or empty plan is not listed. */
export function briefPlanLines(plans: Array<{ short_id: string; title: string; status: string; updated_at?: number; progress: { total: number; done: number; in_progress: number } }>): string[] {
  const active = plans.filter((p) => p.status === "active" && p.progress.total > 0).sort((a, b) => (b.updated_at ?? 0) - (a.updated_at ?? 0));
  const lines = active.slice(0, PLANS_LISTED).map((p) => `  plan ${p.short_id} ${p.title}: ${p.progress.done}/${p.progress.total} done, ${p.progress.in_progress} in progress`);
  if (active.length > PLANS_LISTED) lines.push(`  ${c.dim}and ${active.length - PLANS_LISTED} more active plans${c.reset}`);
  return lines;
}
