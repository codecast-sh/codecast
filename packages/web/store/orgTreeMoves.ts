// The chart's reporting lines as pure tree edits: whether a move would close
// a loop, and a person's move under a person (orgPeople.ts on the server).
// orgSlice records the intents and replays them through these.
import type { OrgParentRef, OrgTree } from "../components/org/orgTypes";

export type MovePersonIntent = { kind: "movePerson"; id: string; user_id: string; reports_to_user_id: string | null; at: number };

/** Would making `userId` report to `managerId` close a loop? Walk up from the manager. */
export function orgPersonReparentMakesCycle(tree: Pick<OrgTree, "people">, userId: string, managerId: string): boolean {
  const up = new Map(tree.people.map((p) => [p.user_id, p.reports_to_user_id]));
  let cur: string | undefined = managerId;
  for (let depth = 0; cur && depth < 64; depth++) {
    if (cur === userId) return true;
    cur = up.get(cur);
  }
  return false;
}

/** Would making `role` report to `target` close a loop? Walk up from the target. */
export function orgRoleReparentMakesCycle(tree: OrgTree, roleId: string, target: OrgParentRef): boolean {
  let cur: OrgParentRef | undefined = target;
  for (let depth = 0; cur && depth < 32; depth++) {
    if (cur.kind === "user") return false;
    if (cur.role_id === roleId) return true;
    cur = tree.roles.find((r) => r._id === (cur as any).role_id)?.reports_to;
  }
  return false;
}

/** Whether the move is a real one: the person is on the tree, not already there, and no loop closes. */
export function personMoveApplies(tree: Pick<OrgTree, "people">, userId: string, to: string | null): boolean {
  const person = tree.people.find((p) => p.user_id === userId);
  if (!person || (person.reports_to_user_id ?? null) === to) return false;
  return !(to && orgPersonReparentMakesCycle(tree, userId, to));
}

export function applyPersonMove(tree: Pick<OrgTree, "people">, intent: MovePersonIntent): void {
  if (!personMoveApplies(tree, intent.user_id, intent.reports_to_user_id)) return;
  const person = tree.people.find((p) => p.user_id === intent.user_id)!;
  if (intent.reports_to_user_id) person.reports_to_user_id = intent.reports_to_user_id;
  else delete person.reports_to_user_id;
}

export function personMoveSatisfied(tree: Pick<OrgTree, "people">, intent: MovePersonIntent): boolean {
  const person = tree.people.find((p) => p.user_id === intent.user_id);
  return !person || (person.reports_to_user_id ?? null) === intent.reports_to_user_id;
}
