// What an object's page and a role's page work out, without React: the
// crumb that says where an object sits, the names a Serves line links, whom
// a role reports to, and what a role is doing this minute.
import type { InitiativeRow } from "@codecast/shared/contracts/initiative";
import { personRefOf } from "@codecast/shared/entities";
import type { OrgRole, OrgSession, OrgTree } from "../../orgTypes";
import { sessionsLine } from "../nowModel";
import { roleWords } from "../../orgStaffingTypes";
import type { Member } from "../objects";
import type { Named } from "../SheetFrame";
import type { CompanyRows } from "../useCompanyRows";

/** The company itself, first in every crumb: its step leads to the list. */
export const workspaceCrumb = (rows: Pick<CompanyRows, "tree">): Named => ({ kind: "initiative", ref: "", title: rows.tree?.workspace.name || "Company" });

export const goalNamed = (g: InitiativeRow): Named => ({ kind: "initiative", ref: g.short_id || g.client_key || g._id, title: g.title });

/** A goal's ancestors, the top first. Capped, so a loop in bad data ends. */
export function goalAncestors(goals: readonly InitiativeRow[], goal: InitiativeRow | undefined): InitiativeRow[] {
  const out: InitiativeRow[] = [];
  let at = goal?.parent_initiative_id ? goals.find((g) => g._id === goal.parent_initiative_id) : undefined;
  while (at && out.length < 8 && !out.includes(at)) {
    out.unshift(at);
    at = at.parent_initiative_id ? goals.find((g) => g._id === at!.parent_initiative_id) : undefined;
  }
  return out;
}

/** Whom a role reports to, as the sheet that opens them: a role, or a person by handle. */
export function reportsToNamed(tree: OrgTree | null, members: readonly Member[], role: OrgRole): Named | null {
  if (role.reports_to.kind === "role") {
    const id = role.reports_to.role_id;
    const parent = tree?.roles.find((r) => r._id === id);
    return parent ? { kind: "role", ref: parent.short_id, title: roleWords(parent).title } : null;
  }
  const uid = role.reports_to.user_id;
  const person = tree?.people.find((p) => p.user_id === uid);
  const member = members.find((m) => String(m._id) === uid);
  const name = person?.name ?? member?.name;
  return name ? { kind: "person", ref: personRefOf({ _id: uid, github_username: member?.github_username }), title: name } : null;
}

const newest = (sessions: readonly OrgSession[], state: OrgSession["state"]) =>
  sessions.filter((s) => s.state === state).sort((a, b) => b.updated_at - a.updated_at)[0];

/** What a role is doing, said the same way on every sheet: its own state
 *  line when it wrote one, else how many of its sessions are at work or
 *  waiting on input, and the session it is on (the newest at work, else the
 *  newest waiting). With nothing live it is the state line alone, with the
 *  time it was written, so a quiet role still says what it is on. `live`
 *  tells the two apart. Null when nothing is live and it wrote no line. */
export function roleNow(role: OrgRole): { words: string; current: OrgSession | null; live: boolean; at: number | null } | null {
  const live = sessionsLine(role.sessions);
  const line = role.standing?.state_line?.trim() || null;
  const at = line ? role.standing?.state_at ?? null : null;
  if (!live) return line ? { words: line, current: null, live: false, at } : null;
  const current = newest(role.sessions, "working") ?? newest(role.sessions, "needs_input") ?? null;
  return { words: line || live.line, current, live: true, at };
}
