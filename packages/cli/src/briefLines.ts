// One session under a role, in its brief, as `cast brief` and `cast role show` print it.
// Kept out of index.ts so a test can pin the field names against the
// server's BriefHand shape (org.ts): `state` is the work state, and the task
// carries its handoff status and review verdict.
import { c } from "./colors.js";
import { goalStateLine, type GoalProgress } from "@codecast/shared/contracts/roleGoals";
import { isWholeWorkspaceRole } from "@codecast/shared/contracts/orgLead";
import { roleIdentity } from "@codecast/shared/contracts/orgIdentity";
import { autonomyOn, autonomyWords } from "@codecast/shared/contracts/roleAutonomy";
import { formatDateSmart, relTimeUntil } from "@codecast/shared/time";
import { WAKE_TUNE_HINT, playbookGuideLines, roleWakeOf, wakeWords, type RoleWake } from "@codecast/shared/contracts/rolePlaybook";

/** A role in one line, as every `cast role` and `cast brief` read heads it. */
export function roleLine(r: any): string {
  const id = roleIdentity(r, { teamName: r.team_name ?? null });
  return `${c.bold}${id.name}${c.reset} ${c.dim}${id.subtitle} · @${r.handle} · ${r.short_id} · ${r.status} · ${autonomyWords(autonomyOn(r.trust))}${r.review_backend ? ` · review on ${r.review_backend}` : ""}${c.reset}`;
}

/** The role's routine (org-staffing.md S25): when it checks its area next. */
export function routineLine(r: { short_id: string | null; status: string; run_at: number | null } | null | undefined, now: number): string {
  if (!r) return " · no trigger yet";
  if (r.status === "paused") return ` · check paused (${r.short_id ?? "trigger"})`;
  if (!r.run_at) return "";
  // A span still to come reads forward and CEILS (relTimeUntil): a check 1h59m
  // off that read "1h" would promise something sooner than the truth.
  return ` · next check ${r.run_at - now > 60_000 ? `in ${relTimeUntil(r.run_at, now)}` : "due now"} (${r.short_id ?? "trigger"})`;
}

/** How the role's check runs (org-staffing.md S38), read off its trigger:
 *  the cadence, the gate, the focus and why it last changed, then the one
 *  command that changes them. Nothing for a role with no trigger yet. */
export function wakeLine(routine: { interval_ms?: number | null; wake?: RoleWake } | null | undefined): string[] {
  if (!routine) return [];
  return [`  ${c.dim}its check runs ${wakeWords(routine.wake ?? roleWakeOf(routine))} · ${WAKE_TUNE_HINT}${c.reset}`];
}

/** The role's standing session as the org card reads it: id, work state, pinned
 *  status and line, and when it checks next. A reader of another role's brief
 *  (the Head of People over a lead, org-staffing.md S29) sees where the role
 *  itself stands without a second read of the session. */
export function standingSessionLine(role: { standing_short_id?: string | null; routine?: { short_id: string | null; status: string; run_at: number | null } | null }, standing: { state?: string | null; state_status?: string | null; state_line?: string | null } | null | undefined, now: number): string {
  const word = (standing?.state_status ?? standing?.state ?? "").replace("_", " ");
  const state = standing ? `${word ? ` · ${word}` : ""}${standing.state_line ? ` · ${standing.state_line}` : ""}` : "";
  return `  ${c.dim}standing session: ${role.standing_short_id ?? "none"}${state}${routineLine(role.routine, now)}${c.reset}`;
}

/** The initiatives the role serves, as `cast brief` prints them: the ones it
 *  owns first (its daily check refreshes their health), each with its health
 *  as last said and when, then its numbers against their targets. */
export type BriefInitiativeRow = { short_id: string; title: string; health: string; health_at: number | null; owned: boolean; metrics: string[]; chain: string[] };
export function briefInitiativeLines(rows: BriefInitiativeRow[], now: number): string[] {
  if (!rows.length) return [];
  const health = (r: BriefInitiativeRow) => r.health === "none" || !r.health ? "no update yet" : `${r.health.replace("_", " ")}, said ${r.health_at ? formatDateSmart(r.health_at, now) : "at no date"}`;
  return [
    `  initiatives it serves:`,
    ...rows.map((r) => `    ${c.dim}${r.short_id}${c.reset} ${r.title} ${c.dim}· ${r.owned ? "owns it" : "its project carries it"} · ${health(r)}${r.chain.length ? ` · under ${r.chain.join(", under ")}` : ""}${r.metrics.length ? ` · ${r.metrics.join("; ")}` : ""}${c.reset}`),
  ];
}

/** The grants a role holds outside codecast, the expired ones left out. */
export function authorityLine(role: { authority?: Array<{ kind: string; label: string; expires_at?: number | null }> }, now: number): string {
  const held = (role.authority ?? []).filter((g) => !g.expires_at || g.expires_at > now);
  return `  ${c.dim}authority outside codecast: ${held.length ? held.map((g) => `${g.kind} (${g.label}${g.expires_at ? `, until ${formatDateSmart(g.expires_at, now)}` : ""})`).join("; ") : "none granted"}${c.reset}`;
}

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

/**
 * `cast brief` as it prints, from what /cli/brief/get answers (org.brief):
 * the role, its live facts, the people who report to it, the charter and the
 * narrative. The eval worlds render a synthetic brief's text from its --json
 * through this, so a fixture reads what prod would print.
 */
export function briefTextLines(brief: any, now: number): string[] {
  const f = brief.facts;
  const u = f.usage;
  const st = Object.entries(f.tasks.by_status ?? {}).filter(([, n]) => (n as number) > 0).map(([k, n]) => `${n} ${k}`).join(", ");
  const pr = Object.entries(f.tasks.by_priority ?? {}).filter(([, n]) => (n as number) > 0).map(([k, n]) => `${n} ${k}`).join(", ");
  return [
    roleLine(brief.role),
    `  ${c.dim}scope: ${briefScopeLine(f.scope, brief.role.handle)}${c.reset}`,
    authorityLine(brief.role, now),
    standingSessionLine(brief.role, f.standing, now),
    ...wakeLine(brief.role.routine),
    `  tasks: ${f.tasks.total} in scope, ${f.tasks.open} open${st ? ` · ${st}` : ""}${pr ? ` · priority ${pr}` : ""}`,
    ...briefPlanLines(f.plans),
    ...briefInitiativeLines(f.initiatives ?? [], now),
    `  decisions: ${f.decisions.open} open, ${f.decisions.answered_today} answered today`,
    // What moved since the role last read this (S25): the section its scheduled check acts on.
    `  changed since ${formatDateSmart(f.changed_since, now)}:${f.changed.length ? "" : " nothing"}`,
    ...f.changed.map((ch: any) => `    ${ch.kind} ${ch.short_id ?? ""} ${ch.title} → ${ch.status}`),
    `  today: ${u.wakes}/${u.caps.wakes_per_day} wakes · ${u.hands}/${u.caps.hands_per_day} sessions started · ${u.tokens}/${u.caps.tokens_per_day} tokens${u.uncounted_sessions ? ` ${c.dim}(tokens not counted for ${u.uncounted_sessions} session${u.uncounted_sessions === 1 ? "" : "s"})${c.reset}` : ""}`,
    ...(f.hands.length ? [`  sessions under it:`, ...f.hands.map(briefHandLine)] : []),
    ...(f.people?.length ? [`  people who report to it:`, ...briefPeopleLines(f.people, now)] : []),
    ...briefCharterLines(String(brief.charter ?? "")),
    "",
    `  ${c.bold}## Brief${c.reset}`,
    ...String(brief.narrative || "(no narrative yet: cast brief edit -)").split("\n").map((line) => `  ${line}`),
    // The playbook (S38): how full the brief is, and the shape of what it lacks.
    ...playbookGuideLines(brief.narrative).map((line, i) => `${i === 0 ? "\n" : ""}  ${c.dim}${line}${c.reset}`),
  ];
}
