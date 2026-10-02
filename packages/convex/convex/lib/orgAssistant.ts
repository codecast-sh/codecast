// The Executive Assistant's opening, read from its row (org-staffing.md S30). A
// leaf, so anchors.ts (which builds every role's first turn) can name it
// without importing orgRoles.ts, which imports anchors.ts.
import { executiveAssistantOpening } from "@codecast/shared/contracts/executiveAssistantPrompt";
import { roleIdentity } from "@codecast/shared/contracts/orgIdentity";

export async function assistantOpeningFor(ctx: { db: any }, role: any, person: string): Promise<string> {
  const team = role.assistant?.reach === "team" ? await ctx.db.get(role.assistant.team_id) : null;
  return executiveAssistantOpening({ name: roleIdentity(role, { teamName: team?.name ?? null }).name, person, reach: role.assistant, team: team?.name ?? undefined });
}
