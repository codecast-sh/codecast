// A project's main session (session-projects.md SP4) as its sources read it:
// where a project trigger's runs land, and why they cannot. A leaf, so
// agentTasks and projectSources both read it without importing each other.
import type { Doc, Id } from "../_generated/dataModel";
import { projectDefaultSessionId } from "../sessionProjects";
import { isHostedAgentType } from "@codecast/shared/contracts";

export async function mainSessionFor(ctx: { db: any }, project: Doc<"projects">): Promise<Doc<"conversations"> | null> {
  const id = await projectDefaultSessionId(ctx, project);
  return id ? await ctx.db.get(id) : null;
}

/** Why a project trigger's runs cannot land in this main session: a machine
 *  turn goes only into a session its owner runs (sendMessageToSession's rule). */
export function mainSessionRefusal(main: Doc<"conversations"> | null, ownerId: Id<"users">): string | null {
  if (!main) return null;
  if (String(main.user_id) === String(ownerId) && !isHostedAgentType(main.agent_type)) return null;
  return `The project's main session ${main.short_id ?? main._id} is not run by this trigger's owner, so its runs cannot land there`;
}
