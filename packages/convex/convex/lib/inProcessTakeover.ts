// A person taking over a session that runs inside its parent's process
// (pl-1134). Owned by a person means its own process, and only the parent's
// tools reach the copy inside it, so the parent is told once to stop that copy
// and never message it again; the daemon holds the person's message until the
// copy has stopped, then resumes it as its own process (subagentPromotion.ts).
import type { Id } from "../_generated/dataModel";
import { runsInParentProcess } from "@codecast/shared/contracts/runsInParent";
import { mayEditOwners } from "@codecast/shared/contracts/sessionOwners";
import { isClosedHidden, isClosedSession } from "@codecast/shared/contracts";
import { enqueuePendingMessage, formatSessionMessage } from "../pendingMessages";
import { wakeCost, wakeFieldsOf } from "../wakeCost";
import { ownersModelOn, sessionOwnerFactsOf } from "../sessionOwners";
import { writeOwnersChange } from "./ownersChange";
import { personName } from "./sessionTell";

const shortIdOf = (c: any): string => c.short_id ?? String(c._id).slice(0, 7);

/** The SendMessage address of a Claude Code subagent: its session id is `agent-<id>`. */
export function claudeAgentIdOf(sessionId: string | null | undefined): string | null {
  return /^agent-([0-9a-f]{7,})$/.exec(sessionId ?? "")?.[1] ?? null;
}

export function takeoverLine(person: string, description: string, agentId: string, shortId: string): string {
  return `${person} took over your subagent "${description}" (agent ${agentId}). It now continues as its own session ${shortId}. If it is still running, stop it with TaskStop ${agentId}. Do not SendMessage it again; reach it with \`cast send ${shortId}\`.`;
}

/** Tell the parent of a Claude Code subagent that a person took it over.
 *  Unlike other product lines (sayIntoSession) it wakes a parent whose prompt
 *  cache went cold: a copy still running inside it is what the person's
 *  message waits on. A killed or closed parent runs nothing and only keeps it. */
export async function tellParentOfTakeover(ctx: { db: any }, personId: Id<"users">, child: any): Promise<void> {
  const agentId = claudeAgentIdOf(child.session_id);
  if (!agentId || !child.parent_conversation_id) return;
  const parent = await ctx.db.get(child.parent_conversation_id);
  if (!parent || parent.ended_at) return;
  const person = personName(await ctx.db.get(personId));
  const description = child.subagent_description || child.title || "subagent";
  const asleep = wakeCost({ ...parent, ...wakeFieldsOf(parent) }, Date.now()).killed || isClosedSession(parent) || isClosedHidden(parent);
  await enqueuePendingMessage(ctx, parent, personId, {
    content: formatSessionMessage("unknown", takeoverLine(person, description, agentId, shortIdOf(child)), { name: person }),
    client_id: `takeover:${child._id}`,
    hold: asleep,
  });
}

/**
 * A person's message to a session that runs inside its parent's process takes
 * it over, once: the parent is released (under session owners, by the one
 * owners write's take-over change, so the person owns it) and told to stop
 * its copy. A later message finds the parent released and changes nothing.
 */
export async function takeOverOnPersonSend(ctx: { db: any }, personId: Id<"users">, conversation: any): Promise<void> {
  if (!runsInParentProcess(conversation)) return;
  const row = await ctx.db.get(conversation._id);
  if (!row?.parent_conversation_id || row.parent_released_at != null) return;
  if (await ownersModelOn(ctx, row) && mayEditOwners(await sessionOwnerFactsOf(ctx, row), String(personId))) {
    await writeOwnersChange(ctx, personId, row, { takeOver: true }, { checkEdit: true, hold: "filed" });
  } else {
    await ctx.db.patch(row._id, { parent_released_at: Date.now() });
  }
  await tellParentOfTakeover(ctx, personId, row);
}
