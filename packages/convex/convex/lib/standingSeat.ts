// A role's standing session reports to what the role reports to
// (org-staffing.md S28): under a role, the row carries that role's id in
// `org_role_id`, so it rides the parent lead's card in the host's inbox the
// way a hand rides its role and never surfaces on its own; under a person,
// the field is clear and the row is that person's own card. One helper, so
// provisioning, a role move, a retire and the backfill stamp the same thing.
export function standingReportsToFields(role: { reports_to?: { kind: "user" | "role"; role_id?: any } | null }): { org_role_id: any | undefined } {
  return { org_role_id: role.reports_to?.kind === "role" ? role.reports_to.role_id : undefined };
}
