// A line's facts in the one order every surface says them (cohesive build
// spec §5.1, §6, D13): owner · state · measure · date. A line, a sheet's head
// and a summary all read them here, so a fact is worded once. A slot with
// nothing to say is null, never an element that renders nothing: the facts
// line joins only what is there, and a line leaves the cell empty.
//
// The date column means one of two things, whatever the kind: a target day
// (a goal, a project) or "since …" (a role, a person).
import { createElement as h, type ReactNode } from "react";
import { metricReadings, type InitiativeRow } from "@codecast/shared/contracts/initiative";
import { projectTrouble } from "../../../lib/initiatives";
import { TargetDate } from "../../initiatives/InitiativeAtoms";
import type { OrgRole, StateCounts } from "../orgTypes";
import type { LineProject } from "./lineData";
import { liveWords } from "../company/nowModel";
import { GOAL_ENDED, GoalMeasure, GoalOwnerPick, GoalStatusPick, PersonPresence, ProjectLead, ProjectState, ProjectWork, RoleState, projectStatusSays } from "./lineAtoms";

export type LineFacts = { owner: ReactNode; state: ReactNode; measure: ReactNode; date: ReactNode };

const DIM = "var(--sol-text-dim)";
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** "since Jun", the year added when it is not this one. */
export function sinceWord(ts: number, now: number): string {
  const d = new Date(ts);
  const sameYear = d.getFullYear() === new Date(now).getFullYear();
  return `since ${d.toLocaleDateString("en-US", sameYear ? { month: "short" } : { month: "short", year: "numeric" })}`;
}

/** A goal: its owner, its status or health, its first number against its target, its target day. */
export function goalFacts(goal: InitiativeRow, now: number, editable: boolean): LineFacts {
  return {
    owner: h(GoalOwnerPick, { goal, editable }),
    state: h(GoalStatusPick, { goal, now, editable }),
    measure: metricReadings(goal)[0] ? h(GoalMeasure, { goal, now }) : null,
    date: goal.target_date ? h(TargetDate, { ts: goal.target_date, now, done: GOAL_ENDED.has(goal.status) }) : null,
  };
}

/** A project: its lead, what is moving in it, how much of its board is done, its target day. */
export function projectFacts(project: LineProject, now: number, editable: boolean): LineFacts {
  const moving = !!project.sessions && !!(project.sessions.working || project.sessions.needs_input);
  return {
    owner: h(ProjectLead, { project, editable }),
    state: moving || projectStatusSays(project.status) ? h(ProjectState, { project }) : null,
    measure: project.counts ? h(ProjectWork, { counts: project.counts }) : null,
    date: project.target_date ? h(TargetDate, { ts: project.target_date, now, local: true, done: project.status === "done" }) : null,
  };
}

/** What a project says when opened in place: its lead's standing line, and
 *  what it says against itself (projectTrouble). Null when it says nothing. */
export function projectSays(project: LineProject, now: number): { standing: OrgRole["standing"] | null; trouble: string | null } | null {
  const standing = project.lead?.standing?.state_line?.trim() ? project.lead.standing : null;
  const counts = project.counts && project.counts !== "counting" ? project.counts : { open: 0, done: 0 };
  const trouble = projectTrouble({ _id: project.id, title: project.title, status: project.status ?? "", target_date: project.target_date, risks: project.risks }, counts, now);
  return standing || trouble ? { standing, trouble } : null;
}

/** What a role line reads: the role, whom it reports to by name, and what it leads or owns. */
export type LineRole = {
  role: OrgRole;
  /** Who it reports to, by name. */
  reportsTo: { name: string } | null;
  /** The projects it leads and the goals it owns, by title. */
  leads: readonly { title: string }[];
  goals: readonly { title: string }[];
  charter?: string | null;
};

/** What it carries, in one phrase: "leads Calling program", "owns Win the network", else its charter. */
export function roleCarries(r: Pick<LineRole, "leads" | "goals" | "charter">): string | null {
  const more = (list: readonly unknown[]) => (list.length > 1 ? ` +${list.length - 1}` : "");
  if (r.leads.length) return `leads ${r.leads[0].title}${more(r.leads)}`;
  if (r.goals.length) return `owns ${r.goals[0].title}${more(r.goals)}`;
  return r.charter?.trim() || null;
}

/** A role: whom it reports to, its state, what it carries, since when it is
 *  here. `named`: the projects it leads and the goals it drives are named on
 *  lines of their own beside these facts (a summary's Serves and Carries), so
 *  the measure leaves them to those and says only a charter that nothing else does. */
export function roleFacts(r: LineRole, now: number, named = false): LineFacts {
  const carries = named && r.leads.length + r.goals.length > 0 ? null : roleCarries(r);
  return {
    owner: r.reportsTo ? h("span", { className: "truncate", style: { color: "var(--sol-text-muted)" }, title: `Reports to ${r.reportsTo.name}`, "data-role-reports-to": "" }, `↳ ${r.reportsTo.name}`) : null,
    state: h(RoleState, { role: r.role }),
    measure: carries ? h("span", { className: "truncate", style: { color: r.leads.length + r.goals.length ? "var(--sol-text-muted)" : DIM }, title: carries, "data-role-carries": "" }, carries) : null,
    date: r.role.created_at ? h("span", { "data-role-since": "" }, sinceWord(r.role.created_at, now)) : null,
  };
}

/** What a person line reads. */
export type LinePerson = {
  id: string;
  name: string;
  image?: string;
  me: boolean;
  /** Their handle: what opens them (personRefOf). */
  ref: string;
  access?: "owner" | "admin" | "member";
  presence?: "online" | "away" | "offline";
  sessions: StateCounts | null;
  joined_at?: number;
  roles: readonly unknown[];
  goals: readonly unknown[];
};

/** What they answer for, in one phrase: "1 goal · 2 roles · 2 sessions at
 *  work". Only live sessions count: a lifetime total says nothing about now.
 *  `rolesShown`: their roles are drawn as lines right under them. `named`:
 *  their goals and roles are named on lines of their own beside these facts
 *  (a summary's Serves and Carries), so the phrase keeps only what is live. */
export function personCarries(p: Pick<LinePerson, "goals" | "roles" | "sessions">, { rolesShown = false, named = false }: { rolesShown?: boolean; named?: boolean } = {}): string | null {
  const parts = [
    !named && p.goals.length ? plural(p.goals.length, "goal", "goals") : null,
    !named && !rolesShown && p.roles.length ? plural(p.roles.length, "role", "roles") : null,
    liveWords(p.sessions),
  ].filter(Boolean);
  return parts.length ? parts.join(" · ") : null;
}

/** A person: their place in the workspace, presence, what they answer for,
 *  since when (personCarries says what `rolesShown` and `named` leave out). */
export function personFacts(p: LinePerson, now: number, opts: { rolesShown?: boolean; named?: boolean } = {}): LineFacts {
  const carries = personCarries(p, opts);
  return {
    owner: p.access ? h("span", { style: { color: "var(--sol-text-muted)" }, "data-person-access": p.access }, p.access) : null,
    state: p.presence ? h(PersonPresence, { presence: p.presence }) : null,
    measure: carries ? h("span", { className: "truncate", title: carries, "data-person-carries": "" }, carries) : null,
    date: p.joined_at ? h("span", { "data-person-since": "" }, sinceWord(p.joined_at, now)) : null,
  };
}
