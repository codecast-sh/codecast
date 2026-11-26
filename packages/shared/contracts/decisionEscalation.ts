// Who an escalated decision reaches (convex decisionHandoff.escalateCore): the
// owner's manager when that manager is a person in the workspace, else the
// workspace's admins who are people. Never the owner, never the person
// escalating (an admin escalating a teammate's decision sends it to the other
// admins, not to themself), never a bot. One rule
// for the server, which reads it from team_memberships, and for the clients,
// which read it from the roster they hold so the row moves at once.

export type EscalationMember = { user_id: string; role?: string; is_bot?: boolean };

export function escalationTargetIds(ownerId: string, managerId: string | null | undefined, members: ReadonlyArray<EscalationMember>, byId?: string): string[] {
  const people = members.filter((m) => !m.is_bot && String(m.user_id) !== String(ownerId) && String(m.user_id) !== String(byId ?? ownerId));
  const manager = managerId ? people.find((m) => String(m.user_id) === String(managerId)) : undefined;
  if (manager) return [String(manager.user_id)];
  return people.filter((m) => m.role === "admin").map((m) => String(m.user_id));
}
