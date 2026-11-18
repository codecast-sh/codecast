// The session driving a plan or a task, as unplaced work and a goal's open
// plans name it (orgUnplaced, initiatives). A leaf: it reads rows and defines
// no function, so any module may import it.

import type { Id } from "../_generated/dataModel";
import type { SessionRef } from "./orgCoverage";

type Ctx = { db: any };

/** Conversation id → SessionRef, each row read once. */
export function sessionRefs(ctx: Ctx) {
  const cache = new Map<string, SessionRef | null>();
  return async (id: unknown): Promise<SessionRef | null> => {
    if (!id) return null;
    const k = String(id);
    if (!cache.has(k)) {
      const c: any = await ctx.db.get(id as Id<"conversations">);
      cache.set(k, c ? { short_id: c.short_id ?? k.slice(0, 7), title: String(c.title ?? "").slice(0, 100), last_active_at: c.updated_at ?? c._creationTime } : null);
    }
    return cache.get(k)!;
  };
}

/** The session a task moves in: the newest it was linked to, else the one that filed it. */
export const taskSession = (t: any): unknown => (t.conversation_ids?.length ? t.conversation_ids[t.conversation_ids.length - 1] : undefined) ?? t.created_from_conversation ?? t.first_linked_conversation;

/** The session driving a plan: its current one, else the newest on its tasks, else the one that made it. */
export async function planDriver(refOf: ReturnType<typeof sessionRefs>, plan: any, tasks: any[]): Promise<SessionRef | null> {
  if (plan.current_session_id) { const r = await refOf(plan.current_session_id); if (r) return r; }
  const newest = [...tasks].filter(taskSession).sort((a, b) => (b.updated_at ?? 0) - (a.updated_at ?? 0))[0];
  if (newest) { const r = await refOf(taskSession(newest)); if (r) return r; }
  const last = plan.session_ids?.length ? plan.session_ids[plan.session_ids.length - 1] : undefined;
  return (await refOf(last)) ?? (await refOf(plan.created_from_conversation_id));
}

