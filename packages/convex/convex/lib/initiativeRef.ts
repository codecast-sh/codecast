import { normalizeInitiativeRef } from "@codecast/shared/contracts/initiative";
import type { Id } from "../_generated/dataModel";
import { canAccessInitiative } from "./access";
import { notFound } from "./auth";

// Naming an initiative: `in-N` (any case, or the bare number), its id, or the
// `client_key` of a create the caller made that the server has not echoed
// yet (the web's stub id, so an edit made before the echo lands on the real
// row instead of being dropped). Kept apart from convex/initiatives.ts so a
// module that only filters by an initiative (tasks.list) reads it without
// importing the org's write paths.

type Ctx = { db: any };

/** The initiative, or null when it is absent or not the caller's to read. */
export async function findInitiative(ctx: Ctx, userId: Id<"users">, ref: string): Promise<any | null> {
  const key = normalizeInitiativeRef(ref);
  const id = /^in-\d+$/.test(key) ? null : ctx.db.normalizeId("initiatives", key);
  const row = id
    ? await ctx.db.get(id)
    : /^in-\d+$/.test(key)
      ? await ctx.db.query("initiatives").withIndex("by_short_id", (q: any) => q.eq("short_id", key)).first()
      // A client key is the caller's own: only their rows are searched.
      : (await ctx.db.query("initiatives").withIndex("by_user_id", (q: any) => q.eq("user_id", userId)).collect())
          .find((r: any) => r.client_key === key) ?? null;
  return row && (await canAccessInitiative(ctx, userId, row)) ? row : null;
}

export async function requireInitiative(ctx: Ctx, userId: Id<"users">, ref: string): Promise<any> {
  return (await findInitiative(ctx, userId, ref)) ?? notFound("Initiative not found");
}
