// The chart's reporting lines as pure tree edits: whether a move would close
// a loop, and a change to whom a person reports (orgPeople.ts on the server:
// any number of people and roles, all equal). orgSlice records the intents
// and replays them through these.
import { roleManagers } from "@codecast/shared/contracts/orgLead";
import { sameParent, type OrgParentRef, type OrgPerson, type OrgTree } from "../components/org/orgTypes";

/** The whole list a person reports to after the move. */
export type MovePersonIntent = { kind: "movePerson"; id: string; user_id: string; managers: OrgParentRef[]; at: number; via_role?: string };

/** Everyone a person reports to on the tree. */
export function managersOfPerson(p: Pick<OrgPerson, "managers"> | undefined): OrgParentRef[] {
  return p?.managers ?? [];
}

/** The line a person's card is drawn on: the first manager the tree holds. */
export function drawnManager(tree: Pick<OrgTree, "people" | "roles">, p: Pick<OrgPerson, "managers" | "user_id"> | undefined): OrgParentRef | null {
  return managersOfPerson(p).find((m) => (m.kind === "user"
    ? m.user_id !== p?.user_id && tree.people.some((x) => x.user_id === m.user_id)
    : tree.roles.some((r) => r._id === m.role_id && r.status !== "retired"))) ?? null;
}

/** Everyone a person reports to besides the line their card is drawn on. */
export function otherManagers(tree: Pick<OrgTree, "people" | "roles">, p: Pick<OrgPerson, "managers" | "user_id"> | undefined): OrgParentRef[] {
  const drawn = drawnManager(tree, p);
  return managersOfPerson(p).filter((m) => !(drawn && sameParent(m, drawn)));
}

/** The list after moving a person off the line they are drawn on onto
 *  `target`, keeping their other managers. Null is the top of the chart:
 *  they report to nobody. */
export function managersAfterMove(tree: Pick<OrgTree, "people" | "roles">, userId: string, target: OrgParentRef | null): OrgParentRef[] {
  if (!target) return [];
  const p = tree.people.find((x) => x.user_id === userId);
  const from = drawnManager(tree, p);
  return [target, ...managersOfPerson(p).filter((m) => !(from && sameParent(m, from)) && !sameParent(m, target))];
}

/** Whether walking up from `start` reaches `needle` along any line, through
 *  people and roles alike (orgPeople.chainReaches on the server). */
export function orgChainReaches(tree: Pick<OrgTree, "people" | "roles">, start: OrgParentRef, needle: OrgParentRef): boolean {
  const seen = new Set<string>();
  const todo: OrgParentRef[] = [start];
  while (todo.length) {
    const at = todo.pop()!;
    if (sameParent(at, needle)) return true;
    const key = at.kind === "user" ? `user:${at.user_id}` : `role:${at.role_id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    // The server's bound (orgPeople.chainReaches): too deep reads as a loop.
    if (seen.size > 256) return true;
    if (at.kind === "role") {
      const role = tree.roles.find((r) => r._id === at.role_id && r.status !== "retired");
      if (role) todo.push(...roleManagers(role));
    } else todo.push(...managersOfPerson(tree.people.find((p) => p.user_id === at.user_id)));
  }
  return false;
}

/** Would making `userId` report to `target` close a loop? */
export function orgPersonReparentMakesCycle(tree: Pick<OrgTree, "people" | "roles">, userId: string, target: OrgParentRef): boolean {
  return orgChainReaches(tree, target, { kind: "user", user_id: userId });
}

/** Would making `role` report to `target` close a loop? */
export function orgRoleReparentMakesCycle(tree: Pick<OrgTree, "people" | "roles">, roleId: string, target: OrgParentRef): boolean {
  return orgChainReaches(tree, target, { kind: "role", role_id: roleId });
}

const sameList = (a: OrgParentRef[], b: OrgParentRef[]) => a.length === b.length && a.every((m) => b.some((n) => sameParent(m, n)));

/** Whether the change is a real one: the person is on the tree, the list differs, and no added manager closes a loop. */
export function personMoveApplies(tree: Pick<OrgTree, "people" | "roles">, userId: string, managers: OrgParentRef[]): boolean {
  const person = tree.people.find((p) => p.user_id === userId);
  if (!person) return false;
  const was = managersOfPerson(person);
  if (sameList(was, managers)) return false;
  return !managers.some((m) => !was.some((w) => sameParent(w, m)) && ((m.kind === "user" && m.user_id === userId) || orgPersonReparentMakesCycle(tree, userId, m)));
}

export function applyPersonMove(tree: Pick<OrgTree, "people" | "roles">, intent: MovePersonIntent): void {
  if (!personMoveApplies(tree, intent.user_id, intent.managers)) return;
  const person = tree.people.find((p) => p.user_id === intent.user_id)!;
  if (intent.managers.length) person.managers = intent.managers.map((m) => ({ ...m }));
  else delete person.managers;
}

export function personMoveSatisfied(tree: Pick<OrgTree, "people">, intent: MovePersonIntent): boolean {
  const person = tree.people.find((p) => p.user_id === intent.user_id);
  return !person || sameList(managersOfPerson(person), intent.managers ?? []);
}

/** The people a role keeps (orgPeople.rolePeopleIds on the server): everyone
 *  whose managers name it, then anyone its own list names only so it keeps
 *  their goals, a person the role reports up to (that line would loop). */
export function rolePeopleOnTree(tree: Pick<OrgTree, "people" | "roles">, roleId: string): OrgPerson[] {
  const goalsOnly = new Set(tree.roles.find((r) => r._id === roleId)?.reports_user_ids ?? []);
  return tree.people.filter((p) => goalsOnly.has(p.user_id) || managersOfPerson(p).some((m) => m.kind === "role" && m.role_id === roleId));
}

/** Whether a role's people entry for `userId` is goals only: the role already
 *  reports up to them, so they cannot report to it (orgRoles.performSetReports). */
export function goalsOnlyFor(tree: Pick<OrgTree, "people" | "roles">, roleId: string, userId: string): boolean {
  return orgChainReaches(tree, { kind: "role", role_id: roleId }, { kind: "user", user_id: userId });
}
