// The Chief of Staff's opening, read from its row (org-staffing.md S30). A
// leaf, so anchors.ts (which builds every role's first turn) can name it
// without importing orgRoles.ts, which imports anchors.ts.
import { chiefOfStaffOpening } from "@codecast/shared/contracts/chiefOfStaffPrompt";
import { roleIdentity } from "@codecast/shared/contracts/orgIdentity";

export async function chiefOpeningFor(ctx: { db: any }, role: any, person: string): Promise<string> {
  const team = role.chief?.reach === "team" ? await ctx.db.get(role.chief.team_id) : null;
  return chiefOfStaffOpening({ name: roleIdentity(role, { teamName: team?.name ?? null }).name, person, reach: role.chief, team: team?.name ?? undefined });
}
