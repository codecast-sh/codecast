import { v } from "convex/values";
import { mutation, query } from "./functions";
import { getAuthUserId } from "@convex-dev/auth/server";
import { verifyApiToken } from "./apiTokens";
import { isTeamMember } from "./privacy";
import { validateManifest } from "@codecast/shared/contracts/mods";
import type { Id } from "./_generated/dataModel";
import { LOG_CAP } from "./modLogs";

/**
 * Codecast mods (plan pl-839, shared/contracts/mods.ts). The CLI pushes a
 * bundled mod here; the web reads every mod the viewer may see into the store
 * and runs the enabled ones in a sandbox. Access is one rule, the saved_views
 * rule: you own the mod, or it is shared with a team you belong to. Only the
 * author writes it.
 */

/** A bundle bigger than this does not fit a row next to its manifest. */
const MAX_CODE = 900_000;

async function byName(ctx: any, userId: Id<"users">, name: string) {
  return await ctx.db
    .query("mods")
    .withIndex("by_user_name", (q: any) => q.eq("user_id", userId).eq("name", name))
    .first();
}

async function tokenUser(ctx: any, api_token: string): Promise<Id<"users"> | null> {
  const result = await verifyApiToken(ctx, api_token);
  return result ? (result.userId as Id<"users">) : null;
}

/** Every mod this viewer can see: their own, plus their teams' shared ones. Feeds the store's `mods` collection. */
export const webList = query({
  args: { team_id: v.optional(v.id("teams")) },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return [];
    const mine = await ctx.db
      .query("mods")
      .withIndex("by_user_name", (q: any) => q.eq("user_id", userId))
      .collect();
    let shared: any[] = [];
    if (args.team_id && (await isTeamMember(ctx, userId, args.team_id))) {
      const teamRows = await ctx.db
        .query("mods")
        .withIndex("by_team_id", (q: any) => q.eq("team_id", args.team_id!))
        .collect();
      shared = teamRows.filter((r: any) => r.shared && String(r.user_id) !== String(userId));
    }
    const owners = new Map<string, any>();
    const rows = [...mine, ...shared];
    for (const row of rows) {
      const key = String(row.user_id);
      if (!owners.has(key)) owners.set(key, await ctx.db.get(row.user_id));
    }
    // The local half runs in a daemon, never in the page: the web learns only that one exists.
    return rows.map(({ local_code, ...row }: any) => ({
      ...row,
      has_local: !!local_code,
      owner_name: owners.get(String(row.user_id))?.name ?? undefined,
      is_mine: String(row.user_id) === String(userId),
    }));
  },
});

export const webSetEnabled = mutation({
  args: { id: v.id("mods"), enabled: v.boolean() },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new Error("Not signed in");
    const row = await ctx.db.get(args.id);
    if (!row || String(row.user_id) !== String(userId)) throw new Error("Only the mod's author can turn it on or off");
    await ctx.db.patch(args.id, { enabled: args.enabled, updated_at: Date.now() });
  },
});

/**
 * `cast mod dev` and `cast mod publish`. Upserts the author's mod by name with
 * the new bundle; a publish also snapshots it, with its source, as a version.
 */
export const cliPush = mutation({
  args: {
    api_token: v.string(),
    manifest: v.any(),
    code: v.string(),
    local_code: v.optional(v.string()),
    local_hash: v.optional(v.string()),
    source: v.optional(v.any()),
    publish: v.optional(v.boolean()),
    note: v.optional(v.string()),
    team_id: v.optional(v.id("teams")),
    shared: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const userId = await tokenUser(ctx, args.api_token);
    if (!userId) return { error: "Unauthorized" };
    const check = validateManifest(args.manifest);
    if (!check.ok) return { error: `codecast-mod.json: ${check.errors.join("; ")}` };
    const manifest = check.manifest;
    if (args.code.length > MAX_CODE) return { error: `the bundle is ${Math.round(args.code.length / 1000)} KB; a mod holds at most ${MAX_CODE / 1000} KB` };
    let shared = args.shared;
    if (shared && (!args.team_id || !(await isTeamMember(ctx, userId, args.team_id)))) {
      return { error: "a shared mod needs a team you belong to (--team)" };
    }
    const now = Date.now();
    const existing = await byName(ctx, userId, manifest.name);
    let id: Id<"mods">;
    let rev = 1;
    let version = 0;
    if (existing) {
      rev = existing.rev + 1;
      version = existing.version + (args.publish ? 1 : 0);
      await ctx.db.patch(existing._id, {
        manifest,
        code: args.code,
        local_code: args.local_code,
        local_hash: args.local_hash,
        title: manifest.title,
        description: manifest.description,
        rev,
        version,
        updated_at: now,
        ...(args.team_id !== undefined ? { team_id: args.team_id } : {}),
        ...(shared !== undefined ? { shared } : {}),
      });
      id = existing._id;
    } else {
      version = args.publish ? 1 : 0;
      id = await ctx.db.insert("mods", {
        user_id: userId,
        team_id: args.team_id,
        shared: shared ?? false,
        name: manifest.name,
        title: manifest.title,
        description: manifest.description,
        manifest,
        code: args.code,
        local_code: args.local_code,
        local_hash: args.local_hash,
        rev,
        version,
        enabled: true,
        created_at: now,
        updated_at: now,
      });
    }
    if (args.publish) {
      await ctx.db.insert("mod_versions", { mod_id: id, version, manifest, code: args.code, source: args.source, note: args.note, created_at: now });
    }
    return { id, name: manifest.name, rev, version, created: !existing };
  },
});

async function cliMod(ctx: any, api_token: string, name: string) {
  const userId = await tokenUser(ctx, api_token);
  if (!userId) return { error: "Unauthorized" as const };
  const row = await byName(ctx, userId, name);
  if (!row) return { error: `no mod named "${name}" (cast mod ls lists yours)` };
  return { userId, row };
}

export const cliList = query({
  args: { api_token: v.string() },
  handler: async (ctx, args) => {
    const userId = await tokenUser(ctx, args.api_token);
    if (!userId) return { error: "Unauthorized" };
    const rows = await ctx.db.query("mods").withIndex("by_user_name", (q: any) => q.eq("user_id", userId)).collect();
    const mods = [];
    for (const row of rows) {
      const last = await ctx.db.query("mod_logs").withIndex("by_mod_created", (q: any) => q.eq("mod_id", row._id)).order("desc").first();
      mods.push({
        name: row.name, title: row.title, description: row.description, rev: row.rev, version: row.version,
        enabled: row.enabled, shared: row.shared ?? false, updated_at: row.updated_at, bytes: row.code.length,
        manifest: row.manifest, last_log: last ? { level: last.level, text: last.text, at: last.created_at } : null,
      });
    }
    return { mods };
  },
});

export const cliLogs = query({
  args: { api_token: v.string(), name: v.string(), since: v.optional(v.number()), limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const got = await cliMod(ctx, args.api_token, args.name);
    if ("error" in got) return got;
    const rows = await ctx.db
      .query("mod_logs")
      .withIndex("by_mod_created", (q: any) => q.eq("mod_id", got.row._id).gt("created_at", args.since ?? 0))
      .order("desc")
      .take(Math.min(args.limit ?? 100, LOG_CAP));
    return { rev: got.row.rev, logs: rows.reverse().map((r: any) => ({ level: r.level, text: r.text, at: r.created_at })) };
  },
});

export const cliSetEnabled = mutation({
  args: { api_token: v.string(), name: v.string(), enabled: v.boolean() },
  handler: async (ctx, args) => {
    const got = await cliMod(ctx, args.api_token, args.name);
    if ("error" in got) return got;
    await ctx.db.patch(got.row._id, { enabled: args.enabled, updated_at: Date.now() });
    return { ok: true };
  },
});

export const cliRemove = mutation({
  args: { api_token: v.string(), name: v.string() },
  handler: async (ctx, args) => {
    const got = await cliMod(ctx, args.api_token, args.name);
    if ("error" in got) return got;
    const versions = await ctx.db.query("mod_versions").withIndex("by_mod_version", (q) => q.eq("mod_id", got.row._id)).collect();
    const logs = await ctx.db.query("mod_logs").withIndex("by_mod_created", (q) => q.eq("mod_id", got.row._id)).collect();
    for (const r of [...versions, ...logs]) await ctx.db.delete(r._id);
    await ctx.db.delete(got.row._id);
    return { ok: true };
  },
});

export const cliVersions = query({
  args: { api_token: v.string(), name: v.string() },
  handler: async (ctx, args) => {
    const got = await cliMod(ctx, args.api_token, args.name);
    if ("error" in got) return got;
    const rows = await ctx.db.query("mod_versions").withIndex("by_mod_version", (q: any) => q.eq("mod_id", got.row._id)).collect();
    return {
      current: got.row.version,
      rev: got.row.rev,
      versions: rows.map((r: any) => ({ version: r.version, note: r.note, at: r.created_at, bytes: r.code.length, files: r.source ? Object.keys(r.source).length : 0 })),
    };
  },
});

/** One version's manifest and source: `cast mod pull` and `cast mod diff`. Readable by anyone who can see the mod. */
export const cliGetVersion = query({
  args: { api_token: v.string(), name: v.string(), version: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const got = await cliMod(ctx, args.api_token, args.name);
    if ("error" in got) return got;
    const version = args.version ?? got.row.version;
    const row = await ctx.db
      .query("mod_versions")
      .withIndex("by_mod_version", (q: any) => q.eq("mod_id", got.row._id).eq("version", version))
      .first();
    if (!row) return { error: `"${args.name}" has no version ${version}${got.row.version === 0 ? " (it has never been published)" : ""}` };
    return { version: row.version, manifest: row.manifest, source: row.source ?? {}, note: row.note, at: row.created_at };
  },
});

export const cliRollback = mutation({
  args: { api_token: v.string(), name: v.string(), version: v.number() },
  handler: async (ctx, args) => {
    const got = await cliMod(ctx, args.api_token, args.name);
    if ("error" in got) return got;
    const row = await ctx.db
      .query("mod_versions")
      .withIndex("by_mod_version", (q: any) => q.eq("mod_id", got.row._id).eq("version", args.version))
      .first();
    if (!row) return { error: `"${args.name}" has no version ${args.version}` };
    const rev = got.row.rev + 1;
    await ctx.db.patch(got.row._id, { manifest: row.manifest, code: row.code, title: row.manifest?.title, description: row.manifest?.description, rev, updated_at: Date.now() });
    return { ok: true, rev, version: args.version };
  },
});
