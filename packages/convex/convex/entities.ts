import { v } from "convex/values";
import { query } from "./functions";
import { getAuthUserId } from "@convex-dev/auth/server";

// Entity tables addressable by pill/link surfaces, in resolution order.
// Mirrors EntityType in @codecast/shared/entities.
const ID_TYPE_TABLES = [
  ["docs", "doc"],
  ["tasks", "task"],
  ["plans", "plan"],
  ["conversations", "session"],
  ["projects", "project"],
] as const;

/**
 * Resolve which entity table a bare 32-char Convex id belongs to, so the
 * client can render the right pill for ids that carry no type prefix (docs
 * have no short id at all — their raw Convex id is their only handle in agent
 * prose). normalizeId is a structural check on the id's encoded table — no
 * document is read, so this leaks only "this id shape belongs to table X",
 * never content or existence; the per-type webGet a pill runs next enforces
 * real access. Returns null for anything that isn't one of our entity tables
 * (message ids, hashes), which callers render as plain text.
 */
export const resolveIdType = query({
  args: { id: v.string() },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return null;
    for (const [table, type] of ID_TYPE_TABLES) {
      if (ctx.db.normalizeId(table, args.id)) return type;
    }
    return null;
  },
});
