// Who a piece of work can belong to, as picker options: people, then roles,
// each under its own heading and drawn with its face (org-roles-run-work.md
// R5: roles are colleagues). One list for every picker that offers both: the
// task board's assignee filter and an initiative's owner.
//
// A role's seat is a bot user on the team roster. That user is not a person to
// pick (the role is), so it is left out of the people.
import { useMemo } from "react";
import { roleAssigneeInfo } from "@codecast/shared/contracts/orgAssignee";
import type { FilterOption } from "../components/FilterDropdown";
import { AssigneeFace } from "../components/identity/AssigneeFace";
import { memberAvatarUrl, memberDisplayName } from "../lib/liveEntities";
import { useOrgRoles } from "./useOrgRoles";
import type { RosterIdentity } from "./useTeamRoster";

export function useRolesAndPeopleOptions(teamMembers: readonly RosterIdentity[]): { people: FilterOption[]; roles: FilterOption[] } {
  const { roles: orgRoles, roleBotUserIds } = useOrgRoles();
  return useMemo(() => {
    const roles = orgRoles
      .filter((r) => r.status !== "retired")
      .map((r) => ({ key: r._id, label: r.name, section: "Roles", face: <AssigneeFace info={roleAssigneeInfo(r)} size={14} hover={false} /> }))
      .sort((a, b) => a.label.localeCompare(b.label));
    const people = teamMembers.filter((m) => !roleBotUserIds.has(m._id)).map((m) => {
      const name = memberDisplayName(m, m._id);
      return { key: m._id, label: name, section: roles.length ? "People" : undefined, face: <AssigneeFace info={{ name, image: memberAvatarUrl(m) }} size={14} /> };
    });
    return { people, roles };
  }, [orgRoles, roleBotUserIds, teamMembers]);
}
