// The person's own keyboard bindings, read and written by `cast shortcuts` from any
// session. They live where the app keeps them, client_state.ui.key_bindings,
// stamped like any per-user preference, so a write here reaches every open
// window at once and wins over older edits made in the app.
import { v } from "convex/values";
import { mutation, query } from "./functions";
import { verifyApiToken } from "./apiTokens";
import { parseChord, type KeyBindingOverride } from "@codecast/shared/contracts/keyBindings";
import { SHORTCUTS } from "@codecast/shared/contracts/shortcutCatalog";

async function clientStateRow(ctx: any, userId: any) {
  return await ctx.db.query("client_state").withIndex("by_user_id", (q: any) => q.eq("user_id", userId)).first();
}

export const get = query({
  args: { api_token: v.string() },
  handler: async (ctx, args): Promise<{ key_bindings: KeyBindingOverride[] }> => {
    const auth = await verifyApiToken(ctx, args.api_token);
    if (!auth) throw new Error("Unauthorized");
    const row = await clientStateRow(ctx, auth.userId);
    const list = row?.ui?.key_bindings;
    return { key_bindings: Array.isArray(list) ? list : [] };
  },
});

/** Replaces the whole override list. The CLI computes it from what it read,
 *  as the app does; every entry is checked here so a bad write cannot reach
 *  the catalog. */
export const set = mutation({
  args: {
    api_token: v.string(),
    key_bindings: v.array(v.object({ action: v.string(), keys: v.array(v.string()) })),
  },
  handler: async (ctx, args): Promise<{ key_bindings: KeyBindingOverride[] }> => {
    const auth = await verifyApiToken(ctx, args.api_token);
    if (!auth) throw new Error("Unauthorized");
    const known = new Set(SHORTCUTS.filter((d) => !d.fixed).map((d) => d.action));
    const list: KeyBindingOverride[] = [];
    for (const o of args.key_bindings) {
      if (!known.has(o.action as any)) throw new Error(`Unknown or fixed action: ${o.action}`);
      const keys: string[] = [];
      for (const k of o.keys) {
        const parsed = parseChord(k);
        if (!parsed.ok) throw new Error(`${o.action}: ${parsed.error}`);
        keys.push(parsed.chord);
      }
      list.push({ action: o.action, keys });
    }
    const row = await clientStateRow(ctx, auth.userId);
    const now = Date.now();
    const ui = { ...(row?.ui ?? {}), key_bindings: list, "key_bindings:ts": now };
    if (row) await ctx.db.patch(row._id, { ui, updated_at: now });
    else await ctx.db.insert("client_state", { user_id: auth.userId, ui, updated_at: now });
    return { key_bindings: list };
  },
});
