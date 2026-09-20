// The one list of people and roles every picker offers (lib/assigneeOptions),
// read as a hook: the workspace's roles come from the org tree slice through
// a wake signature, and who is a person is read off the roster row.
import { useMemo } from "react";
import { rolesAndPeopleOptions, type AssigneeOption } from "../lib/assigneeOptions";
import { useOrgRoles } from "./useOrgRoles";
import type { RosterIdentity } from "./useTeamRoster";

export type { AssigneeOption };

export function useRolesAndPeopleOptions(teamMembers: readonly RosterIdentity[]): { people: AssigneeOption[]; roles: AssigneeOption[] } {
  const { roles: orgRoles } = useOrgRoles();
  return useMemo(() => rolesAndPeopleOptions(teamMembers, orgRoles), [orgRoles, teamMembers]);
}
