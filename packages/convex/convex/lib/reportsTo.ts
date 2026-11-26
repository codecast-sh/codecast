// Who a session reports to, and the line that tells it when that changes
// (sessionOwnership's reparent path).
import type { Id } from "../_generated/dataModel";
import { personName } from "./sessionTell";

export type ReportsTo =
  | { kind: "user"; user_id: Id<"users">; name: string }
  | { kind: "role"; role_id: Id<"org_roles">; short_id: string; handle: string; name: string }
  // Under the owners model: the session it works for (its parent, unreleased).
  | { kind: "session"; conversation_id: Id<"conversations">; short_id: string; name: string };

export function reportsToLine(to: ReportsTo, opts: { note?: string; handoff?: string } = {}): string {
  const head = to.kind === "role"
    ? `You now report to ${to.name} (@${to.handle}): what you need from a person goes to it first, and \`cast send @${to.handle}\` reaches it.`
    : to.kind === "session"
      ? `You now report to session ${to.short_id} “${to.name}”: your questions go to it, and \`cast send ${to.short_id}\` reaches it.`
      : `You now report to ${to.name}: your questions and decisions go to them.`;
  const note = opts.note?.trim();
  const handoff = opts.handoff?.trim();
  return [head, note, handoff && `Note handed to ${to.name} with this session: "${handoff}"`].filter(Boolean).join(" ");
}

// Who a session reports to: its role, else (under the owners model,
// `ownersModel`) the session it works for, a live unreleased parent, else its
// primary owner (the owner_user_id cache, which the chart files by;
// syncPrimaryOwnerCache is its one writer).
// `read` is the doc read (a batch passes its memo, so a hundred sessions of
// one host read that host once); `row` is the conversation when the caller
// already holds it as it stands.
export async function reportsToOf(ctx: { db: any }, conversationId: Id<"conversations">, roleId: Id<"org_roles"> | undefined, known: { read?: (id: any) => Promise<any>; row?: any; ownersModel?: boolean } = {}): Promise<ReportsTo | null> {
  const read = known.read ?? ((id: any) => ctx.db.get(id));
  if (roleId) {
    const role = await read(roleId);
    if (role) return { kind: "role", role_id: role._id, short_id: role.short_id, handle: role.handle, name: role.name };
  }
  const row = known.row ?? await ctx.db.get(conversationId);
  if (known.ownersModel && row?.parent_conversation_id && row.parent_released_at == null) {
    const parent = await ctx.db.get(row.parent_conversation_id);
    if (parent && !parent.inbox_killed_at) return { kind: "session", conversation_id: parent._id, short_id: parent.short_id ?? String(parent._id).slice(0, 7), name: parent.title || "Untitled session" };
  }
  const primary = row?.owner_user_id;
  const user = primary ? await read(primary) : null;
  return user ? { kind: "user", user_id: user._id, name: personName(user) } : null;
}

export const reportsToKey = (r: ReportsTo | null): string => !r ? "" : r.kind === "role" ? `role:${r.role_id}` : r.kind === "session" ? `session:${r.conversation_id}` : `user:${r.user_id}`;
