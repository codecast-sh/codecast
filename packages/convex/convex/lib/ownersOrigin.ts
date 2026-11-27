// Where a session came from, for the owners menu (sessionOwnership
// OwnersModelRead): read for one open conversation only (listOwners), never
// for the inbox cards. Split out of sessionOwnership.ts for its max-lines pin.
import type { Id } from "../_generated/dataModel";
import { releasedParentOf } from "@codecast/shared/contracts/sessionOwners";
import type { sessionOwnerFactsOf } from "../sessionOwners";
import type { OwnersModelRead } from "../sessionOwnership";
import { ADOPT_CHAIN_CAP, takeBackRefusal } from "./ownersChange";

// Whether `c` works for `ancestorId` at any depth (adoptableParentId's loop
// refusal): adopting it would make two sessions answer each other.
async function nestedUnder(ctx: { db: any }, c: any, ancestorId: unknown): Promise<boolean> {
  const seen = new Set<string>();
  let link: unknown = c.parent_conversation_id;
  while (link && !seen.has(String(link)) && seen.size < ADOPT_CHAIN_CAP) {
    if (String(link) === String(ancestorId)) return true;
    seen.add(String(link));
    link = (await ctx.db.get(link as Id<"conversations">))?.parent_conversation_id;
  }
  return false;
}

// Where it came from, for the owners menu (OwnersModelRead): the parent a
// person released it from, when the viewer may put it back; the role a change
// took off it; the session that spawned it, adoptable by the same rules.
export async function originRead(
  ctx: { db: any },
  authUserId: Id<"users">,
  conversation: any,
  facts: Awaited<ReturnType<typeof sessionOwnerFactsOf>>,
  role: string | null,
  titleFor: (c: any) => Promise<string | null>,
): Promise<Pick<OwnersModelRead, "released_parent" | "released_role" | "spawned_by">> {
  const sessionRef = async (c: any) => ({ conversation_id: String(c._id), short_id: c.short_id ?? String(c._id).slice(0, 7), title: await titleFor(c) });
  const releasedLink = conversation.parent_released_at != null ? releasedParentOf(facts) : null;
  const releasedDoc = releasedLink ? await ctx.db.get(releasedLink) : null;
  const roleDoc = conversation.released_role_id && String(conversation.released_role_id) !== role ? await ctx.db.get(conversation.released_role_id) : null;
  // A spawned peer (no parent link, started as itself) its spawner may adopt.
  const spawner = !conversation.parent_conversation_id && conversation.spawned_by_conversation_id ? await ctx.db.get(conversation.spawned_by_conversation_id) : null;
  const movable = !conversation.is_subagent && !conversation.is_workflow_sub && !conversation.parent_message_uuid;
  const adoptable = !!spawner && movable && String(spawner._id) !== String(conversation._id)
    && !(await nestedUnder(ctx, spawner, conversation._id)) && !(await takeBackRefusal(ctx, authUserId, conversation, spawner));
  return {
    released_parent: releasedDoc && !(await takeBackRefusal(ctx, authUserId, conversation, releasedDoc)) ? await sessionRef(releasedDoc) : null,
    released_role: roleDoc && roleDoc.status !== "retired"
      ? { role_id: String(roleDoc._id), short_id: roleDoc.short_id ?? null, handle: roleDoc.handle, name: roleDoc.name }
      : null,
    spawned_by: spawner ? { ...(await sessionRef(spawner)), adoptable } : null,
  };
}
