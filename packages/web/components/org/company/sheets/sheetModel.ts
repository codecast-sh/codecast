// What the four sheets work out alike, without React: the crumb that says
// where an object sits, the names a Serves line links, whom a role reports
// to, and what a role is doing this minute.
import type { InitiativeRow } from "@codecast/shared/contracts/initiative";
import { pathUnderRoot } from "@codecast/shared/contracts";
import { personRefOf } from "@codecast/shared/entities";
import type { OrgRole, OrgSession, OrgTree } from "../../orgTypes";
import { sessionsLine } from "../nowModel";
import type { Member } from "../objects";
import type { Named } from "../SheetFrame";
import type { CompanyRows } from "../useCompanyRows";

/** The company itself, first in every crumb: its step closes the sheets. */
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
    return parent ? { kind: "role", ref: parent.short_id, title: parent.name } : null;
  }
  const uid = role.reports_to.user_id;
  const person = tree?.people.find((p) => p.user_id === uid);
  const member = members.find((m) => String(m._id) === uid);
  const name = person?.name ?? member?.name;
  return name ? { kind: "person", ref: personRefOf({ _id: uid, github_username: member?.github_username }), title: name } : null;
}

/** The chain of whom a role reports to, the top first. */
export function reportsChain(tree: OrgTree | null, members: readonly Member[], role: OrgRole): Named[] {
  const out: Named[] = [];
  let at: OrgRole | undefined = role;
  while (at && out.length < 8) {
    const up = reportsToNamed(tree, members, at);
    if (!up || out.some((n) => n.ref === up.ref)) break;
    out.unshift(up);
    at = up.kind === "role" ? tree?.roles.find((r) => r.short_id === up.ref) : undefined;
  }
  return out;
}

const newest = (sessions: readonly OrgSession[], state: OrgSession["state"]) =>
  sessions.filter((s) => s.state === state).sort((a, b) => b.updated_at - a.updated_at)[0];

/** What a role is doing this minute, said the same way on every sheet: its
 *  own state line when it wrote one, else how many of its sessions are at
 *  work or waiting on input, and the session it is on (the newest at work,
 *  else the newest waiting). Null when none of its sessions is live. */
export function roleNow(role: OrgRole): { words: string; current: OrgSession | null } | null {
  const live = sessionsLine(role.sessions);
  if (!live) return null;
  const current = newest(role.sessions, "working") ?? newest(role.sessions, "needs_input") ?? null;
  return { words: role.standing?.state_line?.trim() || live.line, current };
}


/** A folder as a person writes it, "~/src/app" or "/Users/x/src/app", in one form to compare. */
const folderKey = (path: string | null | undefined): string | null => {
  const p = path?.trim().replace(/\/+$/, "");
  return p ? p.replace(/^~(?=\/|$)/, "").replace(/^\/(?:Users|home)\/[^/]+(?=\/|$)/, "") : null;
};

/** The people with sessions at work in the project's folder, each with those sessions. */
export type ProjectPerson = { person: OrgTree["people"][number]; sessions: OrgSession[] };
export function peopleOnProject(tree: OrgTree | null, folder: string | null | undefined): ProjectPerson[] {
  const root = folderKey(folder);
  if (!tree || !root) return [];
  return tree.people.flatMap((person) => {
    const sessions = person.sessions.filter((s) => { const at = folderKey(s.project_path); return !!at && pathUnderRoot(at, root); });
    return sessions.length ? [{ person, sessions }] : [];
  });
}

