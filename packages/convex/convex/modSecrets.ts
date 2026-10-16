import { v } from "convex/values";
import { action, internalMutation, internalQuery, query } from "./functions";
import { getAuthUserId } from "@convex-dev/auth/server";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { MOD_SECRET_NAME_RE, type ModManifest } from "@codecast/shared/contracts/mods";
import { decryptRefreshToken, encryptRefreshToken } from "./googleOAuth";
import { CONNECTION_SECRETS_KEY_ENV } from "./tokenConnectors";
import { tokenUser } from "./modLocal";

/**
 * A mod's secrets (manifest `secrets`, shared/contracts/mods.ts ModSecret):
 * keys its requests need, set by the author and never sent to a browser. The
 * value is stored encrypted under the deployment's connection key with its own
 * derivation, so a ciphertext from here never decrypts as anything else's.
 * modServer.ts attaches one to a fetch bound for an origin it declares. The
 * mod row's `secrets_set` says which are set and when, for the Mods page.
 */

const MOD_SECRET_HKDF_INFO = "codecast-mod-secret-v1";
const MAX_SECRET = 8_000;

function deploymentKey(): string {
  const key = process.env[CONNECTION_SECRETS_KEY_ENV];
  if (!key) throw new Error(`mod secrets are not configured on this deployment (${CONNECTION_SECRETS_KEY_ENV})`);
  return key;
}

export async function decryptModSecret(enc: string): Promise<string | null> {
  return decryptRefreshToken(enc, deploymentKey(), MOD_SECRET_HKDF_INFO);
}

/** The author's mod by id or name, with the secret declared in its manifest; a refusal names what is wrong. */
export const ownedSecretTarget = internalQuery({
  args: { user_id: v.id("users"), mod_id: v.optional(v.id("mods")), name: v.optional(v.string()), secret: v.string() },
  handler: async (ctx, args) => {
    const mod = args.mod_id
      ? await ctx.db.get(args.mod_id)
      : await ctx.db.query("mods").withIndex("by_user_name", (q: any) => q.eq("user_id", args.user_id).eq("name", args.name ?? "")).first();
    if (!mod || String(mod.user_id) !== String(args.user_id)) return { error: args.name ? `no mod named "${args.name}" of yours (cast mod ls lists them)` : "only the mod's author sets its secrets" };
    const declared = ((mod.manifest as ModManifest)?.secrets ?? []).map((s) => s.name);
    if (!declared.includes(args.secret)) return { error: `${mod.name} declares no secret "${args.secret}" (declared: ${declared.join(", ") || "none"}; add it under "secrets" in codecast-mod.json and push)` };
    return { mod_id: mod._id };
  },
});

export const storeSecret = internalMutation({
  args: { mod_id: v.id("mods"), user_id: v.id("users"), name: v.string(), value_enc: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const existing = await ctx.db.query("mod_secrets").withIndex("by_mod_name", (q: any) => q.eq("mod_id", args.mod_id).eq("name", args.name)).first();
    const now = Date.now();
    if (args.value_enc === undefined) {
      if (existing) await ctx.db.delete(existing._id);
    } else if (existing) await ctx.db.patch(existing._id, { value_enc: args.value_enc, set_by: args.user_id, updated_at: now });
    else await ctx.db.insert("mod_secrets", { mod_id: args.mod_id, name: args.name, value_enc: args.value_enc, set_by: args.user_id, updated_at: now });
    const mod = await ctx.db.get(args.mod_id);
    const rest = (mod?.secrets_set ?? []).filter((s: any) => s.name !== args.name);
    await ctx.db.patch(args.mod_id, { secrets_set: args.value_enc === undefined ? rest : [...rest, { name: args.name, at: now }] });
  },
});

export const secretValueEnc = internalQuery({
  args: { mod_id: v.id("mods"), name: v.string() },
  handler: async (ctx, args) =>
    (await ctx.db.query("mod_secrets").withIndex("by_mod_name", (q: any) => q.eq("mod_id", args.mod_id).eq("name", args.name)).first())?.value_enc ?? null,
});

/** Set (or, with an empty value, clear) one secret. The value goes in and is never read back out. */
async function setSecret(ctx: any, userId: Id<"users">, target: { mod_id?: Id<"mods">; name?: string }, secret: string, value: string) {
  if (!MOD_SECRET_NAME_RE.test(secret)) return { error: `"${secret}" is not a secret name (A-Z, 0-9 and _, like UNION_KEY)` };
  const got = await ctx.runQuery(internal.modSecrets.ownedSecretTarget, { user_id: userId, ...target, secret });
  if ("error" in got) return got;
  const trimmed = value.trim();
  if (trimmed.length > MAX_SECRET) return { error: `a secret holds at most ${MAX_SECRET / 1000} KB` };
  const value_enc = trimmed ? await encryptRefreshToken(trimmed, deploymentKey(), MOD_SECRET_HKDF_INFO) : undefined;
  await ctx.runMutation(internal.modSecrets.storeSecret, { mod_id: got.mod_id, user_id: userId, name: secret, value_enc });
  return { ok: true, cleared: !trimmed };
}

export const webSet = action({
  args: { mod_id: v.id("mods"), secret: v.string(), value: v.string() },
  handler: async (ctx, args): Promise<{ ok?: boolean; cleared?: boolean; error?: string }> => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return { error: "Not signed in" };
    return await setSecret(ctx, userId, { mod_id: args.mod_id }, args.secret, args.value);
  },
});

export const cliSet = action({
  args: { api_token: v.string(), name: v.string(), secret: v.string(), value: v.string() },
  handler: async (ctx, args): Promise<{ ok?: boolean; cleared?: boolean; error?: string }> => {
    const userId = await ctx.runQuery(internal.modSecrets.tokenUserOf, { api_token: args.api_token });
    if (!userId) return { error: "Unauthorized" };
    return await setSecret(ctx, userId, { name: args.name }, args.secret, args.value);
  },
});

export const tokenUserOf = internalQuery({
  args: { api_token: v.string() },
  handler: async (ctx, args) => await tokenUser(ctx, args.api_token),
});

/** `cast mod secret ls`: each declared secret, whether it is set and when. Never a value. */
export const cliList = query({
  args: { api_token: v.string(), name: v.string() },
  handler: async (ctx, args) => {
    const userId = await tokenUser(ctx, args.api_token);
    if (!userId) return { error: "Unauthorized" };
    const mod = await ctx.db.query("mods").withIndex("by_user_name", (q: any) => q.eq("user_id", userId).eq("name", args.name)).first();
    if (!mod) return { error: `no mod named "${args.name}" of yours (cast mod ls lists them)` };
    const set = new Map(((mod.secrets_set ?? []) as { name: string; at: number }[]).map((s) => [s.name, s.at]));
    return { secrets: ((mod.manifest as ModManifest)?.secrets ?? []).map((s) => ({ ...s, set_at: set.get(s.name) ?? null })) };
  },
});
