// Taking over a session that runs inside its parent's process (pl-1134). Only
// the parent's tools reach the copy inside it, and delivering any message to
// the child resumes it as its own process once that copy has stopped (the
// daemon holds it until then, subagentPromotion.ts). So every message that
// reaches such a child takes it over: the parent is released, and told once to
// stop its copy and never message it again.
import type { Id } from "../_generated/dataModel";
import { runsInParentProcess } from "@codecast/shared/contracts/runsInParent";
import { mayEditOwners, ownersLeftRefusal, type OwnersChange } from "@codecast/shared/contracts/sessionOwners";
import { isClosedHidden, isClosedSession } from "@codecast/shared/contracts";
import { enqueuePendingMessage, formatSessionMessage } from "../pendingMessages";
import { wakeCost, wakeFieldsOf } from "../wakeCost";
import { ownersModelOn, sessionOwnerFactsOf } from "../sessionOwners";
import { writeOwnersChange } from "./ownersChange";
import { personName } from "./sessionTell";

const shortIdOf = (c: any): string => c.short_id ?? String(c._id).slice(0, 7);

/** A Claude Code subagent's agent id: its session id is `agent-<id>`, where a
 *  Task subagent's id is hex and a named agent's is `a<name>-<16 hex>`. */
export function claudeAgentIdOf(sessionId: string | null | undefined): string | null {
  return /^agent-(.+)$/.exec(sessionId ?? "")?.[1] ?? null;
}

/** The name a parent sends a named agent by (SendMessage `to`), or null for a Task subagent. */
export function claudeAgentNameOf(agentId: string): string | null {
  return /^a(.+)-[0-9a-f]{16}$/.exec(agentId)?.[1] ?? null;
}

export function takeoverLine(person: string, description: string, agentId: string, shortId: string): string {
  const name = claudeAgentNameOf(agentId);
  const reach = `It now continues as its own session ${shortId}. If it is still running, stop it with TaskStop ${agentId}.`;
  return name
    ? `${person} took over your agent ${name} ("${description}", agent id ${agentId}). ${reach} Do not SendMessage ${name} again; reach it with \`cast send ${shortId}\`.`
    : `${person} took over your subagent "${description}" (agent ${agentId}). ${reach} Do not SendMessage it again; reach it with \`cast send ${shortId}\`.`;
}

/** Tell the parent of a Claude Code subagent that a person took it over.
 *  Unlike other product lines (sayIntoSession) it wakes a parent whose prompt
 *  cache went cold: a copy still running inside it is what the person's
 *  message waits on. A killed or closed parent runs nothing and only keeps it. */
export async function tellParentOfTakeover(ctx: { db: any }, personId: Id<"users">, child: any): Promise<void> {
  const agentId = child.agent_type === "claude_code" ? claudeAgentIdOf(child.session_id) : null;
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
 * A message into a session that runs inside its parent's process takes it
 * over, once. Under session owners it goes through the one owners write, so
 * owners_changed_at is stamped and clients refetch: a person who may edit its
 * owners takes it over (and owns it); anyone else, and a machine's message,
 * only releases the parent, unless that would leave it with no owner at all,
 * when the sender takes it. Off the model the release is the stamp. A later
 * message finds the parent released and changes nothing.
 */
export async function takeOverInProcessChild(ctx: { db: any }, senderId: Id<"users">, conversation: any, opts: { person: boolean }): Promise<void> {
  if (!runsInParentProcess(conversation)) return;
  const row = await ctx.db.get(conversation._id);
  if (!row?.parent_conversation_id || row.parent_released_at != null) return;
  if (await ownersModelOn(ctx, row)) {
    const facts = await sessionOwnerFactsOf(ctx, row);
    const at = { actor: String(senderId), now: Date.now() };
    const release: OwnersChange = { releaseParent: true };
    const takeOver = opts.person && mayEditOwners(facts, String(senderId));
    const change = takeOver || ownersLeftRefusal(facts, release, at) ? { takeOver: true } : release;
    await writeOwnersChange(ctx, senderId, row, change, { checkEdit: takeOver, hold: "filed" });
  } else {
    await ctx.db.patch(row._id, { parent_released_at: Date.now() });
  }
  await tellParentOfTakeover(ctx, senderId, row);
}

/** After an owners change (sessionOwnership reparent): when it released the
 *  parent of a session running in its process, the parent stops its copy. */
export async function tellParentIfReleased(ctx: { db: any }, actorId: Id<"users">, before: any, change: OwnersChange): Promise<void> {
  if (before.parent_released_at != null || change.adoptParent || !runsInParentProcess(before)) return;
  if ((await ctx.db.get(before._id))?.parent_released_at != null) await tellParentOfTakeover(ctx, actorId, before);
}
