// Who a piece of work can belong to, as picker rows: people, then roles, each
// under its own heading and drawn with its face (org-roles-run-work.md R5:
// roles are colleagues). ONE list for every picker that offers both (the board's
// assignee filter, an initiative's owner, the create task modal, the task
// context menu's Assign submenu, the palette's assign mode), built here and
// read through hooks/useRolesAndPeopleOptions.
//
// Who is a person is ONE rule, read off the roster row: `is_bot`. A role's
// seat is a bot user on the team roster (named after the role), and so is the
// workspace anchor; neither is a person to pick, the role is. The rule needs
// no org tree, so a cold deep link (a task page opened first) lists the same
// people as the board does.
import { roleAssigneeInfo, type AssigneeInfo, type AssigneeRole } from "@codecast/shared/contracts/orgAssignee";
import type { FilterOption } from "../components/FilterDropdown";
import { AssigneeFace } from "../components/identity/AssigneeFace";
import { memberAvatarUrl, memberDisplayName } from "./liveEntities";

/** A picker row plus who it names, in the contract's shape, so a picker can
 *  draw the face its own way and hand the info to whatever it writes. */
export type AssigneeOption = FilterOption & { info: AssigneeInfo; /** "@handle" for a role. */ hint?: string };

type RosterRow = { _id: string; name?: string | null; email?: string | null; image?: string | null; github_avatar_url?: string | null; github_username?: string | null; is_bot?: boolean };
type RoleRow = AssigneeRole & { status?: string };

export function rolesAndPeopleOptions(teamMembers: readonly RosterRow[], orgRoles: readonly RoleRow[]): { people: AssigneeOption[]; roles: AssigneeOption[] } {
  const roles: AssigneeOption[] = orgRoles
    .filter((r) => r.status !== "retired")
    .map((r) => {
      const info = roleAssigneeInfo(r);
      return { key: String(r._id), label: r.name, hint: `@${r.handle}`, section: "Roles", info, face: <AssigneeFace info={info} size={14} hover={false} /> };
    })
    .sort((a, b) => a.label.localeCompare(b.label));
  const people: AssigneeOption[] = teamMembers.filter((m) => m && !m.is_bot).map((m) => {
    const name = memberDisplayName(m as any);
    const info: AssigneeInfo = { name, image: memberAvatarUrl(m as any), github_username: m.github_username ?? undefined };
    return { key: m._id, label: name, section: roles.length ? "People" : undefined, info, face: <AssigneeFace info={info} size={14} /> };
  });
  return { people, roles };
}
