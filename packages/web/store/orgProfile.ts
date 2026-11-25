// A person's profile in the store (docs/architecture/org-people.md P4). The
// short fields (title, focus, labels) live on the org tree's person row, so
// an edit is an intent replayed over every org.tree push until the tree
// agrees; the long `about` lives on the person's detail row
// (orgPersonDetails, fed by orgPeople.person), a localFirst collection that
// holds the field itself. orgSlice records the intents and runs these.
import { roleManagers } from "@codecast/shared/contracts/orgLead";
import { sameParent, type OrgParentRef, type OrgPerson, type OrgTree } from "../components/org/orgTypes";

export type PersonShortProfile = Pick<OrgPerson, "title" | "focus" | "labels">;
const SHORT_KEYS = ["title", "focus", "labels"] as const;

/** The edit of a person's short fields; `from` holds what each was before. */
export type PersonProfileIntent = { kind: "personProfile"; id: string; user_id: string; fields: PersonShortProfile; from: PersonShortProfile; at: number };

/** The long version of one person as the store holds it, keyed by
 *  orgPersonDetailId. The short fields and the reporting lines are not here:
 *  the tree's person row is their one home. */
export type OrgPersonDetail = {
  _id: string;
  team_id: string;
  user_id: string;
  about?: string;
  /** Projects they decide for, by title. */
  areas: string[];
  takes_decisions: boolean;
  profile_updated: { by: string; at: number } | null;
};

export const orgPersonDetailId = (teamId: string, userId: string) => `${teamId}:${userId}`;

/** orgPeople.person's answer as a detail row, or none. */
export function personDetailRow(teamId: string, d: { user_id: string; about?: string; areas: string[]; takes_decisions: boolean; profile_updated: { by: string; at: number } | null } | null | undefined): OrgPersonDetail[] | undefined {
  if (d === undefined) return undefined;
  if (!d) return [];
  return [{ _id: orgPersonDetailId(teamId, String(d.user_id)), team_id: teamId, user_id: String(d.user_id), about: d.about ?? "", areas: d.areas, takes_decisions: d.takes_decisions, profile_updated: d.profile_updated }];
}

export function shortProfileKeys(fields: PersonShortProfile): (typeof SHORT_KEYS)[number][] {
  return SHORT_KEYS.filter((k) => fields[k] !== undefined);
}

const isEmpty = (v: unknown) => v === undefined || v === "" || (Array.isArray(v) && v.length === 0);
const same = (a: unknown, b: unknown) => JSON.stringify(isEmpty(a) ? null : a) === JSON.stringify(isEmpty(b) ? null : b);

/** Write `keys` of `fields` onto a person row; an empty value clears it, the
 *  way the server stores it. */
function writeShort(p: OrgPerson, fields: PersonShortProfile, keys: readonly (typeof SHORT_KEYS)[number][]): void {
  for (const k of keys) {
    const v = fields[k];
    if (isEmpty(v)) delete p[k];
    else (p as Record<string, unknown>)[k] = Array.isArray(v) ? [...v] : v;
  }
}

/** The intent for an edit; null when the row is not on the tree or nothing
 *  changes. `from` is what the server last said (`server`, the tree before
 *  any intent), so a refusal goes back to the stored value even after an
 *  earlier edit of the same field that was never confirmed. */
export function personProfileIntent(tree: Pick<OrgTree, "people">, id: string, userId: string, fields: PersonShortProfile, at: number, server?: Pick<OrgTree, "people"> | null): PersonProfileIntent | null {
  const p = tree.people.find((x) => x.user_id === userId);
  const keys = shortProfileKeys(fields).filter((k) => p && !same(p[k], fields[k]));
  if (!p || !keys.length) return null;
  const stored = server?.people.find((x) => x.user_id === userId) ?? p;
  const pick = (src: PersonShortProfile) => Object.fromEntries(keys.map((k) => [k, src[k] ?? (k === "labels" ? [] : "")])) as PersonShortProfile;
  return { kind: "personProfile", id, user_id: userId, fields: pick(fields), from: pick(stored), at };
}

export function applyPersonProfile(tree: Pick<OrgTree, "people">, intent: PersonProfileIntent): void {
  const p = tree.people.find((x) => x.user_id === intent.user_id);
  if (p) writeShort(p, intent.fields, shortProfileKeys(intent.fields));
}

export function revertPersonProfile(tree: Pick<OrgTree, "people"> | null | undefined, intent: PersonProfileIntent): void {
  const p = tree?.people.find((x) => x.user_id === intent.user_id);
  if (p) writeShort(p, intent.from, shortProfileKeys(intent.fields));
}

/** The tree shows the edit: the server stored it. A person gone from the
 *  tree has nothing left to show. */
export function personProfileSatisfied(tree: Pick<OrgTree, "people">, intent: PersonProfileIntent): boolean {
  const p = tree.people.find((x) => x.user_id === intent.user_id);
  return !p || shortProfileKeys(intent.fields).every((k) => same(p[k], intent.fields[k]));
}

/** Who may change which of a person's managers (orgPeople.mayEditManagersAs):
 *  an admin or the person, any; one of their managers, only the managers they
 *  answer for (themself, or a role they are among the managers of); anyone
 *  else, nothing. */
export function managerEditRule(tree: Pick<OrgTree, "people" | "roles">, subjectId: string): (m: OrgParentRef) => boolean {
  const me = tree.people.find((p) => p.is_me);
  if (!me) return () => false;
  if (me.role === "admin" || me.user_id === subjectId) return () => true;
  const mine: OrgParentRef = { kind: "user", user_id: me.user_id };
  const answers = (m: OrgParentRef) => m.kind === "user" ? m.user_id === me.user_id : !!tree.roles.find((r) => r._id === m.role_id && roleManagers(r).some((x) => sameParent(x, mine)));
  const manages = (tree.people.find((p) => p.user_id === subjectId)?.managers ?? []).some(answers);
  return (m) => manages && answers(m);
}

/** Whether changing a person's managers to `next` is the viewer's to do:
 *  something changes, and the rule covers every manager added or removed. */
export function mayChangeManagers(tree: Pick<OrgTree, "people" | "roles">, subjectId: string, next: OrgParentRef[]): boolean {
  const current = tree.people.find((p) => p.user_id === subjectId)?.managers ?? [];
  const touched = [...next.filter((m) => !current.some((c) => sameParent(c, m))), ...current.filter((c) => !next.some((m) => sameParent(c, m)))];
  const rule = managerEditRule(tree, subjectId);
  return touched.length > 0 && touched.every(rule);
}

/** Who may edit a person's profile (orgPeople.performSetProfile): the person or a team admin. */
export function mayEditProfile(tree: Pick<OrgTree, "people" | "workspace">, subjectId: string): boolean {
  const me = tree.people.find((p) => p.is_me);
  return tree.workspace.kind === "team" && !!me && (me.role === "admin" || me.user_id === subjectId);
}
