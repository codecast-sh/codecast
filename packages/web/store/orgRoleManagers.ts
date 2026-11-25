// Everyone a role reports to (org-people.md P3), as one edit of the tree: the
// first manager is the line the chart draws (`reports_to`), the rest ride
// `also_reports_to`, the way orgRoles.performSetRoleManagers stores them.
// orgSlice records the intent and replays it over every org.tree push.
import { roleManagers } from "@codecast/shared/contracts/orgLead";
import { sameParent, type OrgParentRef, type OrgTree } from "../components/org/orgTypes";
import { orgChainReaches } from "./orgTreeMoves";

export type RoleManagersIntent = { kind: "roleManagers"; id: string; role_id: string; managers: OrgParentRef[]; from: OrgParentRef[]; at: number };

const sameList = (a: readonly OrgParentRef[], b: readonly OrgParentRef[]) => a.length === b.length && a.every((m, i) => sameParent(m, b[i]));

/** Whether `m` may be among the role's managers: not itself, live, and no loop. */
export function roleManagerAllowed(tree: Pick<OrgTree, "people" | "roles">, roleId: string, m: OrgParentRef): boolean {
  if (m.kind === "role" && (m.role_id === roleId || !tree.roles.some((r) => r._id === m.role_id && r.status !== "retired"))) return false;
  return !orgChainReaches(tree, m, { kind: "role", role_id: roleId });
}

export function roleManagersIntent(tree: Pick<OrgTree, "roles">, id: string, roleId: string, managers: OrgParentRef[], at: number): RoleManagersIntent | null {
  const role = tree.roles.find((r) => r._id === roleId);
  if (!role || !managers.length) return null;
  const from = roleManagers<OrgParentRef>(role);
  return sameList(from, managers) ? null : { kind: "roleManagers", id, role_id: roleId, managers, from, at };
}

function write(tree: Pick<OrgTree, "roles"> | null | undefined, roleId: string, list: OrgParentRef[], at: number): void {
  const role = tree?.roles.find((r) => r._id === roleId);
  if (!role || !list.length) return;
  role.reports_to = list[0];
  if (list.length > 1) role.also_reports_to = list.slice(1);
  else delete role.also_reports_to;
  role.updated_at = Math.max(role.updated_at, at);
}

export const applyRoleManagers = (tree: Pick<OrgTree, "roles">, i: RoleManagersIntent) => write(tree, i.role_id, i.managers, i.at);
export const revertRoleManagers = (tree: Pick<OrgTree, "roles"> | null | undefined, i: RoleManagersIntent) => write(tree, i.role_id, i.from, i.at);

export function roleManagersSatisfied(tree: Pick<OrgTree, "roles">, i: RoleManagersIntent): boolean {
  const role = tree.roles.find((r) => r._id === i.role_id);
  return !role || sameList(roleManagers<OrgParentRef>(role), i.managers);
}
