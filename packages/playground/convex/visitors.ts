// Anonymous identity (SPEC "Identity"). register mints an id and a secret once;
// the browser keeps both and sends them with every call. requireVisitor is the
// one door every public function goes through.
import { v } from "convex/values";
import { characterOf, normalizeCharacterFields } from "@codecast/shared/contracts/sessionCharacter";
import type { AvatarKey } from "@codecast/shared/contracts/orgAvatars";
import { mutation, query, type QueryCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { fail } from "./lib/errors";
import { newSecret, runtimeToken, sameToken, secretMatches, sha256Hex } from "./lib/identity";
import { takeRate } from "./limits";
import { visitorArgs } from "./validators";

export type VisitorCredentials = { visitor_id: string; secret: string };

/** A visitor as anyone else sees them: never the secret. */
export type PublicVisitor = { id: Id<"visitors">; avatar: AvatarKey; name: string };

export function publicVisitor(row: Doc<"visitors">): PublicVisitor {
  const { avatar, name } = characterOf(row);
  return { id: row._id, avatar, name };
}

/** The visitor these credentials prove, or null for a malformed id, a missing
 *  row or a wrong secret. */
export async function findVisitor(ctx: QueryCtx, creds: VisitorCredentials): Promise<Doc<"visitors"> | null> {
  const id = ctx.db.normalizeId("visitors", creds.visitor_id);
  const row = id ? await ctx.db.get(id) : null;
  return row && (await secretMatches(row.secret_hash, creds.secret)) ? row : null;
}

export async function requireVisitor(ctx: QueryCtx, creds: VisitorCredentials): Promise<Doc<"visitors">> {
  return (await findVisitor(ctx, creds)) ?? fail("unauthorized", "Unknown visitor. Register again.");
}

export type RuntimeCredentials = { visitor_id: string; app_id: string; token: string };

/** The visitor an app's SDK speaks for (lib/identity runtimeToken): proven
 *  for this one app only. */
export async function requireRuntimeVisitor(ctx: QueryCtx, creds: RuntimeCredentials): Promise<Doc<"visitors">> {
  const id = ctx.db.normalizeId("visitors", creds.visitor_id);
  const row = id ? await ctx.db.get(id) : null;
  const ok = row && sameToken(await runtimeToken(row.secret_hash, creds.app_id), creds.token);
  return ok ? row : fail("unauthorized", "This app is not connected to Clayground. Reload the page.");
}

/** Public views of several visitors, each read once. */
export async function publicVisitors(
  ctx: QueryCtx,
  ids: Iterable<Id<"visitors">>,
): Promise<Map<Id<"visitors">, PublicVisitor>> {
  const unique = [...new Set(ids)];
  const rows = await Promise.all(unique.map((id) => ctx.db.get(id)));
  return new Map(rows.flatMap((r) => (r ? [[r._id, publicVisitor(r)] as const] : [])));
}

/** Mint a visitor. The secret is returned once; only its hash is kept. */
export const register = mutation({
  args: {},
  handler: async (ctx) => {
    await takeRate(ctx, "register", "all");
    const secret = newSecret();
    const now = Date.now();
    const id = await ctx.db.insert("visitors", { secret_hash: await sha256Hex(secret), created_at: now, seen_at: now });
    const row = (await ctx.db.get(id))!;
    return { visitor_id: id, secret, visitor: publicVisitor(row) };
  },
});

/** Who these credentials are, or null when the browser should register again. */
export const me = query({
  args: visitorArgs,
  handler: async (ctx, args) => {
    const row = await findVisitor(ctx, args);
    return row ? { visitor: publicVisitor(row), chosen: characterOf(row).chosen } : null;
  },
});

/** Choose a face and/or a name. null clears a part back to the default;
 *  an omitted part is left alone. */
export const setCharacter = mutation({
  args: {
    ...visitorArgs,
    avatar: v.optional(v.union(v.string(), v.null())),
    name: v.optional(v.union(v.string(), v.null())),
  },
  handler: async (ctx, args) => {
    const row = await requireVisitor(ctx, args);
    const clean = normalizeCharacterFields({ character_avatar: args.avatar, character_name: args.name });
    await ctx.db.patch(row._id, {
      ...(args.avatar !== undefined ? { character_avatar: clean.character_avatar ?? undefined } : {}),
      ...(args.name !== undefined ? { character_name: clean.character_name ?? undefined } : {}),
    });
    return publicVisitor((await ctx.db.get(row._id))!);
  },
});
