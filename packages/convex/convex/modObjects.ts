import { v } from "convex/values";
import { mutation, query } from "./functions";
import { getAuthUserId } from "@convex-dev/auth/server";
import { verifyApiToken } from "./apiTokens";
import { isTeamMember } from "./privacy";
import { accessStampFromDoc, authorizedFor, computeWorkspaceKey, heldKeysFor } from "./lib/accessKeys";
import {
  OBJECT_PREFIX_RE, OBJECT_SHORT_ID_RE, RESERVED_OBJECT_PREFIXES,
  type ModManifest, type ModObjectKind,
} from "@codecast/shared/contracts/mods";
import type { Id } from "./_generated/dataModel";

/**
 * Objects of the kinds mods declare (plan pl-839, shared/contracts/mods.ts).
 * Access is the work-item rule: the row's stored `workspace` key, written by
 * computeWorkspaceKey, read through the pure stamp evaluator. A kind exists
 * only while some mod the creator can see declares it, so a typo never mints
 * a new prefix.
 */

const LIST_PER_WORKSPACE = 1000;

async function kindFor(ctx: any, userId: Id<"users">, teamId: Id<"teams"> | undefined, prefix: string): Promise<ModObjectKind | null> {
  const mine = await ctx.db.query("mods").withIndex("by_user_name", (q: any) => q.eq("user_id", userId)).collect();
  const team = teamId ? await ctx.db.query("mods").withIndex("by_team_id", (q: any) => q.eq("team_id", teamId)).collect() : [];
  for (const row of [...mine, ...team.filter((r: any) => r.shared)]) {
    const kind = ((row.manifest as ModManifest)?.objects ?? []).find((k) => k.prefix === prefix);
    if (kind) return kind;
  }
  return null;
}

type Patch = { title?: string; status?: string; fields?: Record<string, unknown>; body?: string; archived?: boolean };

function checkFields(kind: ModObjectKind, fields: Record<string, unknown> | undefined): string | null {
  if (!fields) return null;
  for (const [name, value] of Object.entries(fields)) {
    const f = kind.fields?.[name];
    if (!f) return `${kind.title} has no field "${name}"${kind.fields ? ` (fields: ${Object.keys(kind.fields).join(", ")})` : ""}`;
    if (value === null || value === undefined) continue;
    if (f.type === "enum" && !f.options?.includes(String(value))) return `${name} must be one of ${f.options?.join(", ")}`;
    if (f.type === "number" && typeof value !== "number") return `${name} must be a number`;
    if (f.type === "bool" && typeof value !== "boolean") return `${name} must be true or false`;
    if (f.type === "url" && !/^(https?:\/\/|mailto:)/i.test(String(value))) return `${name} must be an http(s) or mailto link`;
  }
  return null;
}

function checkStatus(kind: ModObjectKind, status: string | undefined): string | null {
  if (status === undefined || !kind.statuses?.length) return null;
  return kind.statuses.includes(status) ? null : `status must be one of ${kind.statuses.join(", ")}`;
}

async function createFor(ctx: any, userId: Id<"users">, args: { prefix: string; title: string; status?: string; fields?: any; body?: string; team_id?: Id<"teams">; client_key?: string }) {
  const prefix = args.prefix.toLowerCase();
  if (!OBJECT_PREFIX_RE.test(prefix) || RESERVED_OBJECT_PREFIXES.has(prefix)) return { error: `"${prefix}" is not an object kind` };
  const title = args.title.trim();
  if (!title) return { error: "an object needs a title" };
  if (args.client_key) {
    const existing = await ctx.db.query("mod_objects").withIndex("by_client_key", (q: any) => q.eq("client_key", args.client_key)).first();
    if (existing && String(existing.user_id) === String(userId)) return { id: existing._id, short_id: existing.short_id };
  }
  // Writes are explicit: a team the creator is not in is refused, never quietly made personal.
  if (args.team_id && !(await isTeamMember(ctx, userId, args.team_id))) return { error: "that team is not one you belong to" };
  const teamId = args.team_id;
  const kind = await kindFor(ctx, userId, teamId, prefix);
  if (!kind) return { error: `no mod you can see declares "${prefix}" objects (a mod's manifest lists its kinds under "objects")` };
  const status = args.status ?? kind.statuses?.[0];
  const bad = checkStatus(kind, status) ?? checkFields(kind, args.fields);
  if (bad) return { error: bad };
  const workspace = computeWorkspaceKey({ user_id: userId, team_id: teamId }, null);
  const last = await ctx.db
    .query("mod_objects")
    .withIndex("by_workspace_prefix_number", (q: any) => q.eq("workspace", workspace).eq("prefix", prefix))
    .order("desc")
    .first();
  const number = (last?.number ?? 0) + 1;
  const now = Date.now();
  const short_id = `${prefix}-${number}`;
  const id = await ctx.db.insert("mod_objects", {
    user_id: userId, team_id: teamId, workspace, prefix, number, short_id, title, status,
    fields: args.fields ?? {}, body: args.body, client_key: args.client_key, created_at: now, updated_at: now,
  });
  return { id, short_id };
}

async function readable(ctx: any, userId: Id<"users">, row: any, held?: Set<string>): Promise<boolean> {
  if (!row) return false;
  return authorizedFor(accessStampFromDoc("mod_objects", row), String(userId), held ?? (await heldKeysFor(ctx, userId)));
}

async function updateFor(ctx: any, userId: Id<"users">, row: any, patch: Patch) {
  if (!(await readable(ctx, userId, row))) return { error: "not found" };
  const kind = await kindFor(ctx, row.user_id, row.team_id, row.prefix) ?? (await kindFor(ctx, userId, row.team_id, row.prefix));
  if (kind) {
    const bad = checkStatus(kind, patch.status) ?? checkFields(kind, patch.fields);
    if (bad) return { error: bad };
  }
  const next: Record<string, unknown> = { updated_at: Date.now() };
  if (patch.title !== undefined) next.title = patch.title.trim() || row.title;
  if (patch.status !== undefined) next.status = patch.status;
  if (patch.body !== undefined) next.body = patch.body;
  if (patch.archived !== undefined) next.archived = patch.archived;
  if (patch.fields !== undefined) next.fields = { ...(row.fields ?? {}), ...patch.fields };
  await ctx.db.patch(row._id, next);
  return { id: row._id, short_id: row.short_id };
}

/** One object by short id, the newest the caller can read (a short id repeats across workspaces). */
/**
 * One object by short id among the caller's own workspaces only (one indexed
 * read per workspace they hold, never a scan of other tenants' rows). A short
 * id counts per workspace, so two can match; the newest wins.
 */
async function byShortId(ctx: any, userId: Id<"users">, shortId: string) {
  const m = OBJECT_SHORT_ID_RE.exec(shortId.toLowerCase());
  if (!m) return null;
  const [, prefix, n] = m;
  const found = [];
  for (const key of await heldKeysFor(ctx, userId)) {
    const row = await ctx.db
      .query("mod_objects")
      .withIndex("by_workspace_prefix_number", (q: any) => q.eq("workspace", key).eq("prefix", prefix).eq("number", Number(n)))
      .first();
    if (row) found.push(row);
  }
  return found.sort((a, b) => b.updated_at - a.updated_at)[0] ?? null;
}

const patchArgs = {
  title: v.optional(v.string()),
  status: v.optional(v.string()),
  fields: v.optional(v.any()),
  body: v.optional(v.string()),
  archived: v.optional(v.boolean()),
};

/** Every object the viewer can read, newest first per workspace. Feeds the store's modObjects collection. */
export const webList = query({
  args: {},
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return [];
    const held = await heldKeysFor(ctx, userId);
    const out: any[] = [];
    for (const key of held) {
      const rows = await ctx.db
        .query("mod_objects")
        .withIndex("by_workspace_updated", (q: any) => q.eq("workspace", key))
        .order("desc")
        .take(LIST_PER_WORKSPACE);
      for (const r of rows) if (!r.archived) out.push(r);
    }
    return out;
  },
});

export const webCreate = mutation({
  args: { prefix: v.string(), title: v.string(), status: v.optional(v.string()), fields: v.optional(v.any()), body: v.optional(v.string()), team_id: v.optional(v.id("teams")), client_key: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new Error("Not signed in");
    const res = await createFor(ctx, userId, args);
    if ("error" in res) throw new Error(res.error);
    return res;
  },
});

export const webUpdate = mutation({
  args: { id: v.id("mod_objects"), ...patchArgs },
  handler: async (ctx, { id, ...patch }) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new Error("Not signed in");
    const res = await updateFor(ctx, userId, await ctx.db.get(id), patch);
    if ("error" in res) throw new Error(res.error);
    return res;
  },
});

async function tokenUser(ctx: any, api_token: string): Promise<Id<"users"> | null> {
  const result = await verifyApiToken(ctx, api_token);
  return result ? (result.userId as Id<"users">) : null;
}

export const cliCreate = mutation({
  args: { api_token: v.string(), prefix: v.string(), title: v.string(), status: v.optional(v.string()), fields: v.optional(v.any()), body: v.optional(v.string()), team_id: v.optional(v.id("teams")) },
  handler: async (ctx, { api_token, ...args }) => {
    const userId = await tokenUser(ctx, api_token);
    if (!userId) return { error: "Unauthorized" };
    return await createFor(ctx, userId, args);
  },
});

export const cliUpdate = mutation({
  args: { api_token: v.string(), short_id: v.string(), ...patchArgs },
  handler: async (ctx, { api_token, short_id, ...patch }) => {
    const userId = await tokenUser(ctx, api_token);
    if (!userId) return { error: "Unauthorized" };
    const row = await byShortId(ctx, userId, short_id);
    if (!row) return { error: `no object ${short_id} you can read` };
    return await updateFor(ctx, userId, row, patch);
  },
});

export const cliGet = query({
  args: { api_token: v.string(), short_id: v.string() },
  handler: async (ctx, args) => {
    const userId = await tokenUser(ctx, args.api_token);
    if (!userId) return { error: "Unauthorized" };
    if (!OBJECT_SHORT_ID_RE.test(args.short_id.toLowerCase())) return { error: `"${args.short_id}" is not an object id (<prefix>-<number>)` };
    const row = await byShortId(ctx, userId, args.short_id);
    if (!row) return { error: `no object ${args.short_id} you can read` };
    const kind = await kindFor(ctx, row.user_id, row.team_id, row.prefix);
    return { object: row, kind };
  },
});

export const cliList = query({
  args: { api_token: v.string(), prefix: v.optional(v.string()), status: v.optional(v.string()), limit: v.optional(v.number()), team_id: v.optional(v.id("teams")) },
  handler: async (ctx, args) => {
    const userId = await tokenUser(ctx, args.api_token);
    if (!userId) return { error: "Unauthorized" };
    const held = await heldKeysFor(ctx, userId);
    const keys = args.team_id ? [`team:${args.team_id}`].filter((k) => held.has(k)) : [...held];
    const out: any[] = [];
    for (const key of keys) {
      const q = args.prefix
        ? ctx.db.query("mod_objects").withIndex("by_workspace_prefix_number", (x: any) => x.eq("workspace", key).eq("prefix", args.prefix!.toLowerCase())).order("desc")
        : ctx.db.query("mod_objects").withIndex("by_workspace_updated", (x: any) => x.eq("workspace", key)).order("desc");
      for (const r of await q.take(500)) if (!r.archived && (!args.status || r.status === args.status)) out.push(r);
    }
    out.sort((a, b) => b.updated_at - a.updated_at);
    // The kinds behind what is listed, so the CLI can name statuses and fields.
    const kinds: Record<string, ModObjectKind> = {};
    for (const r of out) if (!kinds[r.prefix]) { const k = await kindFor(ctx, r.user_id, r.team_id, r.prefix); if (k) kinds[r.prefix] = k; }
    return { objects: out.slice(0, Math.min(args.limit ?? 50, 500)), kinds };
  },
});

/** The object kinds the caller can create: declared by their own mods and their teams' shared ones. */
export const cliKinds = query({
  args: { api_token: v.string() },
  handler: async (ctx, args) => {
    const userId = await tokenUser(ctx, args.api_token);
    if (!userId) return { error: "Unauthorized" };
    const held = await heldKeysFor(ctx, userId);
    const rows = await ctx.db.query("mods").withIndex("by_user_name", (q: any) => q.eq("user_id", userId)).collect();
    for (const key of held) {
      if (!key.startsWith("team:")) continue;
      const teamRows = await ctx.db.query("mods").withIndex("by_team_id", (q: any) => q.eq("team_id", key.slice(5))).collect();
      rows.push(...teamRows.filter((r: any) => r.shared && String(r.user_id) !== String(userId)));
    }
    const kinds: (ModObjectKind & { mod: string })[] = [];
    for (const r of rows) for (const k of (r.manifest as ModManifest)?.objects ?? []) if (!kinds.some((x) => x.prefix === k.prefix)) kinds.push({ ...k, mod: r.name });
    return { kinds };
  },
});
