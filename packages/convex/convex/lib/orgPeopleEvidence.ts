// What each person did over the analysis window (docs/architecture/org-people.md
// P5): the evidence the Head of People's people pass reads before it proposes
// a profile. `cast org inputs` prints it per member. The tally is pure over
// rows the reader fetched, so a test drives it without a database.
import type { Id } from "../_generated/dataModel";
import { memberHandle } from "@codecast/shared/chat";
import { personName } from "./sessionTell";
import { proposedProfile } from "@codecast/shared/contracts/orgPersonProfile";
import type { PersonProfile } from "@codecast/shared/contracts/personProfile";
import { collectOrgSessions } from "../org";
import { readActivityCommits, reposFromScan, type WorkTasks } from "../orgHealth";
import { scopedFetch } from "../data";
import { ANALYSIS_CAPS, ANALYSIS_WINDOW_MS } from "./orgAnalysisCaps";

type Ctx = { db: any };

/** Rows read per source; a source at its cap reads as a floor (`truncated`). */
export const PEOPLE_EVIDENCE_CAPS = { decisions: 2000, calls: 500, projects_per_person: 8 } as const;

export type PersonEvidenceRow = {
  user_id: string;
  name: string;
  handle?: string;
  profile: PersonProfile;
  sessions: number;
  commits: number;
  tasks_closed: number;
  tasks_open: number;
  decisions_answered: number;
  calls_led: number;
  /** Busiest first: each project with the person's sessions and tasks in it. */
  projects: Array<{ title: string; short_id?: string; sessions: number; tasks: number }>;
};

export type PeopleEvidenceInput = {
  members: Array<{ user: any; membership: any }>;
  sessions: Array<{ id: string; owner: string | null; project_id: string | null }>;
  tasks: Array<{ assignee?: string | null; status: string; project_id?: string | null; updated_at: number; conversation_ids?: string[] }>;
  commits: Array<{ author_email?: string | null }>;
  decisions: Array<{ answered_by?: { kind: string; id: string } | null }>;
  calls: Array<{ started_by: string }>;
  projects: Map<string, { title: string; short_id?: string }>;
  since: number;
};

const CLOSED = new Set(["done", "dropped"]);

export function tallyPeopleEvidence(input: PeopleEvidenceInput): PersonEvidenceRow[] {
  const sessionOwner = new Map(input.sessions.map((s) => [s.id, s.owner]));
  const byEmail = new Map(input.members.filter((m) => m.user.email).map((m) => [String(m.user.email).toLowerCase(), String(m.user._id)]));
  const rows = new Map<string, PersonEvidenceRow & { by: Map<string, { sessions: number; tasks: number }> }>();
  for (const { user, membership } of input.members) {
    if (user.is_bot) continue;
    rows.set(String(user._id), {
      user_id: String(user._id), name: personName(user), ...(memberHandle(user) ? { handle: memberHandle(user)! } : {}),
      profile: proposedProfile(membership ?? {}),
      sessions: 0, commits: 0, tasks_closed: 0, tasks_open: 0, decisions_answered: 0, calls_led: 0, projects: [], by: new Map(),
    });
  }
  const touch = (who: string | null | undefined, project: string | null | undefined, k: "sessions" | "tasks") => {
    const r = who ? rows.get(who) : undefined;
    if (!r || !project || !input.projects.has(project)) return;
    const p = r.by.get(project) ?? { sessions: 0, tasks: 0 };
    p[k]++;
    r.by.set(project, p);
  };
  for (const s of input.sessions) {
    const r = s.owner ? rows.get(s.owner) : undefined;
    if (r) r.sessions++;
    touch(s.owner, s.project_id, "sessions");
  }
  for (const t of input.tasks) {
    // A task counts for whoever it is assigned to, and for every person whose session worked it.
    const who = new Set([t.assignee ?? "", ...(t.conversation_ids ?? []).map((c) => sessionOwner.get(c) ?? "")].filter(Boolean));
    for (const id of who) {
      const r = rows.get(id);
      if (!r) continue;
      if (t.status === "done" && t.updated_at >= input.since) r.tasks_closed++;
      else if (!CLOSED.has(t.status) && id === t.assignee) r.tasks_open++;
      touch(id, t.project_id, "tasks");
    }
  }
  for (const c of input.commits) { const r = rows.get(byEmail.get(String(c.author_email ?? "").toLowerCase()) ?? ""); if (r) r.commits++; }
  for (const d of input.decisions) if (d.answered_by?.kind === "user") { const r = rows.get(d.answered_by.id); if (r) r.decisions_answered++; }
  for (const c of input.calls) { const r = rows.get(String(c.started_by)); if (r) r.calls_led++; }
  return [...rows.values()].map(({ by, ...r }) => ({
    ...r,
    projects: [...by].sort((a, b) => b[1].sessions + b[1].tasks - (a[1].sessions + a[1].tasks)).slice(0, PEOPLE_EVIDENCE_CAPS.projects_per_person)
      .map(([id, n]) => ({ title: input.projects.get(id)!.title, ...(input.projects.get(id)!.short_id ? { short_id: input.projects.get(id)!.short_id } : {}), ...n })),
  })).sort((a, b) => b.sessions - a.sessions || a.name.localeCompare(b.name));
}

/** The people slice of `cast org inputs`: every member's evidence and current
 *  profile. A personal workspace has no memberships, and so no people. */
export async function readPeopleEvidence(ctx: Ctx, userId: Id<"users">, teamId: Id<"teams"> | undefined, now: number, work: WorkTasks) {
  if (!teamId) return { window_days: ANALYSIS_WINDOW_MS / 86_400_000, members: [], truncated: { decisions: false, calls: false } };
  const since = now - ANALYSIS_WINDOW_MS;
  const fetchOpts = { userId, workspace: "team" as const, teamId };
  const [scan, projects, plans, decisions, calls] = await Promise.all([
    collectOrgSessions(ctx, userId, teamId, now),
    scopedFetch(ctx, "projects", { ...fetchOpts, limit: ANALYSIS_CAPS.projects }).then((r) => r.records),
    scopedFetch(ctx, "plans", { ...fetchOpts, limit: ANALYSIS_CAPS.plans, stripFields: ["body"] }).then((r) => r.records),
    ctx.db.query("session_decisions").withIndex("by_team_status_created", (q: any) => q.eq("team_id", teamId).eq("status", "answered").gte("created_at", since)).take(PEOPLE_EVIDENCE_CAPS.decisions),
    ctx.db.query("transcripts").withIndex("by_team_started", (q: any) => q.eq("team_id", teamId).gte("started_at", since)).take(PEOPLE_EVIDENCE_CAPS.calls),
  ]);
  const taskProject = new Map(work.tasks.map((t: any) => [String(t._id), t.project_id ? String(t.project_id) : null]));
  const planProject = new Map(plans.map((p: any) => [String(p._id), p.project_id ? String(p.project_id) : null]));
  const sessions = [...scan.sessions.values()].map(({ session, raw }) => ({
    id: String(session._id),
    owner: String(session.owner_user_id ?? raw.user_id),
    // A session's project: its own, else its task's, else its plan's.
    project_id: (raw.project_id ? String(raw.project_id) : null) ?? (raw.active_task_id ? taskProject.get(String(raw.active_task_id)) ?? null : null) ?? (raw.active_plan_id ? planProject.get(String(raw.active_plan_id)) ?? null : null),
  }));
  const commits = await readActivityCommits(ctx, reposFromScan(scan), since, { teamId, userId, sessionIds: new Set(scan.sessions.keys()) });
  const members = await Promise.all(scan.memberships.slice(0, ANALYSIS_CAPS.members).map(async (membership: any) => ({ membership, user: await ctx.db.get(membership.user_id) })));
  return {
    window_days: ANALYSIS_WINDOW_MS / 86_400_000,
    members: tallyPeopleEvidence({
      members: members.filter((m) => m.user),
      sessions,
      tasks: work.tasks.map((t: any) => ({ assignee: t.assignee ?? null, status: t.status, project_id: t.project_id ? String(t.project_id) : null, updated_at: t.updated_at ?? t._creationTime, conversation_ids: (t.conversation_ids ?? []).map(String) })),
      commits,
      // The reader's own view only: a decision counts when its session is one
      // the scan let them see, a call when they were among its people. The
      // team_id indexes above route the read; they grant nothing.
      decisions: decisions.filter((d: any) => scan.sessions.has(String(d.conversation_id))).map((d: any) => ({ answered_by: d.answered_by ?? null })),
      calls: calls.filter((c: any) => (c.recorded_people ?? []).some((u: any) => String(u) === String(userId))).map((c: any) => ({ started_by: String(c.started_by) })),
      projects: new Map(projects.map((p: any) => [String(p._id), { title: p.title, ...(p.short_id ? { short_id: p.short_id } : {}) }])),
      since,
    }),
    truncated: { decisions: decisions.length >= PEOPLE_EVIDENCE_CAPS.decisions, calls: calls.length >= PEOPLE_EVIDENCE_CAPS.calls },
  };
}
