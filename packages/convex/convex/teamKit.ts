// The kit: skills, commands, subagents and instruction fragments a workspace
// authored and shares (docs/architecture/team-kit.md).
//
// A kit lives in a workspace, `team:<id>` or `user:<id>`, written once by
// computeWorkspaceKey and read only as an equality against the caller's held
// keys. `team_id` rides along for routing and no reader here consults it.
//
// Versions are immutable and keyed by folder_hash, so publishing the same
// bytes twice is one version. Surfaces are derived here from the file list and
// the main body's frontmatter; a publisher never gets to say what its item runs.

import { v } from "convex/values";
import { getAuthUserId } from "@convex-dev/auth/server";
import {
  deriveExecutionSurfaces,
  formatCapabilitySlug,
  type CapabilityManifest,
  type ExecutionSurface,
} from "@codecast/shared/contracts";
import type { Id } from "./_generated/dataModel";
import { mutation, query } from "./functions";
import { verifyApiToken } from "./apiTokens";
import {
  computeWorkspaceKey,
  heldKeysFor,
  parseWorkspaceKey,
  requireTeamAdmin,
  requireTeamMembership,
  workspaceGrantsAccess,
} from "./lib/access";
import { recordConsent } from "./capabilityBindings";
import { ownDevice } from "./devices";
import { identityText, sanitizeReported } from "./capabilityState";
import {
  MAX_DESCRIPTION_CHARS,
  MAX_KIT_APPLIED_PER_DEVICE,
  MAX_KIT_ARCHIVE_BYTES,
  MAX_KIT_FILES,
  MAX_KIT_ITEMS,
  MAX_KIT_MAIN_BODY_CHARS,
  MAX_PATH_CHARS,
} from "./capabilitiesSchema";

export const KIT_KINDS = ["skill", "command", "subagent", "instructions"] as const;
export type KitKind = (typeof KIT_KINDS)[number];

export const KIT_APPLIED_STATUSES = ["installed", "pending_consent", "conflict", "error", "removed"] as const;

export interface KitFile {
  path: string;
  size: number;
  executable: boolean;
}

const kitFileValidator = v.object({ path: v.string(), size: v.number(), executable: v.boolean() });

/* ==========================================================================
 * Pure helpers
 * ========================================================================== */

/** The workspace a publish lands in: the named team (membership required),
 *  else the caller's personal kit. Never guessed from a pointer. */
async function kitWorkspaceFor(ctx: any, userId: Id<"users">, teamId: Id<"teams"> | undefined) {
  if (teamId) await requireTeamMembership(ctx, userId, teamId);
  const workspace = computeWorkspaceKey({ user_id: userId, team_id: teamId }, null);
  return { workspace, owner: String(teamId ?? userId), team_id: teamId };
}

/** `authored/<workspace owner id>/<kind>/<name>`, or null when unusable. */
export function kitSlug(owner: string, kind: string, name: string): string | null {
  if (!(KIT_KINDS as readonly string[]).includes(kind)) return null;
  return formatCapabilitySlug({ source: "authored", segments: [owner, kind, name] });
}

const SCRIPT_EXTENSIONS = /\.(sh|bash|zsh|fish|py|js|mjs|cjs|ts|mts|rb|pl|php|ps1|bat|cmd|lua|go|swift)$/i;

/** Frontmatter keys that turn prose into something more. A key counts when it
 *  carries a value inline or on the indented lines below it. */
function frontmatterKeys(body: string): Set<string> {
  const found = new Set<string>();
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(body);
  if (!match) return found;
  const lines = match[1]!.split(/\r?\n/);
  lines.forEach((line, i) => {
    const m = /^([A-Za-z][A-Za-z0-9_-]*)\s*:\s*(.*)$/.exec(line);
    if (!m) return;
    const next = lines[i + 1] ?? "";
    if (m[2]!.trim() !== "" || /^\s+\S/.test(next)) found.add(m[1]!.toLowerCase().replace(/_/g, "-"));
  });
  return found;
}

/**
 * The execution surfaces a version has, from what it ships: executables and
 * anything under bin/ are `ships_bin`, script files are `ships_scripts`, and
 * `allowed-tools` / `hooks` in the main body's frontmatter declare their
 * surfaces. Every item is prose; one with nothing else installs without asking.
 */
export function deriveKitSurfaces(files: readonly KitFile[], mainBody: string): ExecutionSurface[] {
  const manifest: CapabilityManifest = {};
  const bin = files.filter((f) => f.executable || /(^|\/)bin\//.test(f.path)).map((f) => f.path);
  const scripts = files.filter((f) => SCRIPT_EXTENSIONS.test(f.path)).map((f) => f.path);
  if (bin.length) manifest.bin = bin;
  if (scripts.length) manifest.scripts = scripts;
  const keys = frontmatterKeys(mainBody);
  if (keys.has("allowed-tools")) manifest.allowedTools = ["(declared)"];
  if (keys.has("hooks")) manifest.hooks = ["(declared)"];
  return deriveExecutionSurfaces(manifest, ["prose"]);
}

/** A relative path inside the item, or null. */
function kitPath(value: string): string | null {
  const path = sanitizeReported(value, MAX_PATH_CHARS, "identity");
  if (!path || path.includes("\\")) return null;
  if (path.split("/").some((seg) => seg === "" || seg === "." || seg === "..")) return null;
  return path;
}

const FOLDER_HASH = /^[A-Za-z0-9:_-]{8,128}$/;

function itemView(row: any) {
  return {
    _id: row._id,
    slug: row.slug,
    team_id: row.team_id,
    workspace: row.workspace,
    kind: row.kind,
    name: row.name,
    description: row.description,
    author_user_id: row.author_user_id,
    current_version: row.current_version,
    current_hash: row.current_hash,
    surfaces: row.surfaces,
    removed_at: row.removed_at,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function versionView(row: any, includeBody: boolean) {
  return {
    _id: row._id,
    item_id: row.item_id,
    version: row.version,
    folder_hash: row.folder_hash,
    files: row.files,
    surfaces: row.surfaces,
    note: row.note,
    author_user_id: row.author_user_id,
    source_device_id: row.source_device_id,
    created_at: row.created_at,
    ...(includeBody ? { main_body: row.main_body } : {}),
  };
}

/** Everyone a workspace's items reach: the team's members, or its owner. */
async function workspaceMemberIds(ctx: any, workspace: string): Promise<string[]> {
  const ws = parseWorkspaceKey(workspace);
  if (!ws) return [];
  if (ws.type === "personal") return [String(ws.userId)];
  const rows = await ctx.db.query("team_memberships").withIndex("by_team_id", (q: any) => q.eq("team_id", ws.teamId)).collect();
  return rows.map((m: any) => String(m.user_id));
}

/** Make every member's machines re-plan on their next beat. */
async function bumpRevisions(ctx: any, userIds: readonly string[]) {
  for (const id of userIds) {
    const user = await ctx.db.get(id);
    if (user) await ctx.db.patch(id, { capability_revision: (user.capability_revision ?? 0) + 1 });
  }
}

/* ==========================================================================
 * Reads, through the workspace key
 * ========================================================================== */

/** Every item in the workspaces this user holds, optionally one workspace,
 *  optionally only rows updated after `since`. */
export async function listKitItemsFor(ctx: any, userId: Id<"users">, opts: { workspace?: string; since?: number } = {}) {
  const held = [...(await heldKeysFor(ctx, userId))];
  const keys = opts.workspace ? held.filter((k) => k === opts.workspace) : held;
  const out: any[] = [];
  for (const key of keys) {
    const rows = await ctx.db
      .query("team_kit_items")
      .withIndex("by_workspace_updated", (q: any) => {
        const scoped = q.eq("workspace", key);
        return opts.since === undefined ? scoped : scoped.gt("updated_at", opts.since);
      })
      .take(MAX_KIT_ITEMS);
    out.push(...rows);
  }
  return out.map(itemView);
}

/** The item at `slug`, or null when it does not exist or the caller holds no
 *  key for its workspace (the two are indistinguishable on purpose). */
async function readableItem(ctx: any, userId: Id<"users">, slug: string) {
  const item = await ctx.db.query("team_kit_items").withIndex("by_slug", (q: any) => q.eq("slug", slug)).first();
  if (!item || item.removed_at !== undefined) return null;
  return (await workspaceGrantsAccess(ctx, userId, item.workspace)) ? item : null;
}

async function requireTokenUser(ctx: any, token: string): Promise<Id<"users">> {
  const auth = await verifyApiToken(ctx, token);
  if (!auth) throw new Error("Unauthorized");
  return auth.userId as Id<"users">;
}

/* ==========================================================================
 * Publishing (CLI: /cli/cap/kit/upload-url, /cli/cap/kit/publish)
 * ========================================================================== */

export const kitUploadUrl = mutation({
  args: { api_token: v.string() },
  handler: async (ctx, args) => {
    await requireTokenUser(ctx, args.api_token);
    return { upload_url: await ctx.storage.generateUploadUrl() };
  },
});

export interface PublishKitArgs {
  team_id?: Id<"teams">;
  kind: string;
  name: string;
  description?: string;
  folder_hash: string;
  storage_id: Id<"_storage">;
  files: KitFile[];
  main_body: string;
  note?: string;
  device_id?: string;
}

type PublishResult =
  | { status: "rejected"; reason: string }
  | { status: "created" | "unchanged"; slug: string; item_id: string; version: number; folder_hash: string; surfaces: string[] };

/** The one publish: the CLI route calls it, and the daemon runs the same
 *  route when the web asks a machine to share an item. */
export async function publishKit(ctx: any, userId: Id<"users">, args: PublishKitArgs): Promise<PublishResult> {
  const rejected = (reason: string) => ({ status: "rejected" as const, reason });
  const { workspace, owner, team_id } = await kitWorkspaceFor(ctx, userId, args.team_id);
  const slug = kitSlug(owner, args.kind, args.name);
  if (!slug) return rejected("invalid_name");
  if (!FOLDER_HASH.test(args.folder_hash)) return rejected("invalid_folder_hash");
  if (args.files.length === 0 || args.files.length > MAX_KIT_FILES) return rejected("invalid_files");
  const files: KitFile[] = [];
  for (const f of args.files) {
    const path = kitPath(f.path);
    if (!path || !Number.isFinite(f.size) || f.size < 0) return rejected("invalid_files");
    files.push({ path, size: Math.floor(f.size), executable: f.executable });
  }
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  // A body the sanitizer refuses (control characters, a secret assignment at
  // the top) is refused whole rather than stored cleaned.
  const mainBody = args.main_body.trim() === "" ? "" : sanitizeReported(args.main_body, MAX_KIT_MAIN_BODY_CHARS, "body");
  if (mainBody === null) return rejected("main_body_rejected");
  const description = sanitizeReported(args.description, MAX_DESCRIPTION_CHARS, "text") ?? undefined;
  const note = sanitizeReported(args.note, MAX_DESCRIPTION_CHARS, "text") ?? undefined;
  const deviceId = args.device_id ? identityText(args.device_id, 200) : undefined;

  const blob = await ctx.db.system.get(args.storage_id);
  if (!blob) return rejected("archive_missing");
  if (typeof blob.size === "number" && blob.size > MAX_KIT_ARCHIVE_BYTES) {
    await ctx.storage.delete(args.storage_id);
    return rejected("archive_too_large");
  }

  const now = Date.now();
  let item = await ctx.db.query("team_kit_items").withIndex("by_slug", (q: any) => q.eq("slug", slug)).first();
  if (item && item.workspace !== workspace) return rejected("slug_in_other_workspace");

  if (item) {
    const same = await ctx.db
      .query("team_kit_versions")
      .withIndex("by_item_hash", (q: any) => q.eq("item_id", item._id).eq("folder_hash", args.folder_hash))
      .first();
    if (same) {
      // Same bytes: the existing version answers, and the fresh upload is
      // an orphan nobody will ever read.
      if (same.storage_id !== args.storage_id) await ctx.storage.delete(args.storage_id);
      // Republishing an older version's bytes makes it current again.
      if (item.current_hash !== same.folder_hash || item.removed_at !== undefined) {
        await ctx.db.patch(item._id, {
          current_version: same.version,
          current_hash: same.folder_hash,
          surfaces: same.surfaces,
          removed_at: undefined,
          updated_at: now,
        });
        await bumpRevisions(ctx, await workspaceMemberIds(ctx, workspace));
      }
      return { status: "unchanged", slug, item_id: item._id, version: same.version, folder_hash: same.folder_hash, surfaces: same.surfaces };
    }
  }

  const surfaces = deriveKitSurfaces(files, mainBody);
  let version = 1;
  if (item) {
    const latest = await ctx.db
      .query("team_kit_versions")
      .withIndex("by_item_version", (q: any) => q.eq("item_id", item._id))
      .order("desc")
      .first();
    version = (latest?.version ?? 0) + 1;
    await ctx.db.patch(item._id, {
      current_version: version,
      current_hash: args.folder_hash,
      surfaces,
      removed_at: undefined,
      ...(description !== undefined ? { description } : {}),
      updated_at: now,
    });
  } else {
    const itemId = await ctx.db.insert("team_kit_items", {
      slug,
      ...(team_id ? { team_id } : {}),
      workspace,
      kind: args.kind,
      name: args.name,
      description,
      author_user_id: userId,
      current_version: 1,
      current_hash: args.folder_hash,
      surfaces,
      created_at: now,
      updated_at: now,
    });
    item = { _id: itemId };
  }
  await ctx.db.insert("team_kit_versions", {
    item_id: item._id,
    workspace,
    version,
    folder_hash: args.folder_hash,
    storage_id: args.storage_id,
    files,
    main_body: mainBody,
    surfaces,
    note,
    author_user_id: userId,
    source_device_id: deviceId,
    created_at: now,
  });
  // A new current version must reach machines whose bindings did not change.
  if (version > 1) await bumpRevisions(ctx, await workspaceMemberIds(ctx, workspace));
  return { status: "created", slug, item_id: item._id, version, folder_hash: args.folder_hash, surfaces };
}

export const publishKitItem = mutation({
  args: {
    api_token: v.string(),
    team_id: v.optional(v.id("teams")),
    kind: v.string(),
    name: v.string(),
    description: v.optional(v.string()),
    folder_hash: v.string(),
    storage_id: v.id("_storage"),
    files: v.array(kitFileValidator),
    main_body: v.string(),
    note: v.optional(v.string()),
    device_id: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const userId = await requireTokenUser(ctx, args.api_token);
    const { api_token: _token, ...rest } = args;
    return await publishKit(ctx, userId, rest);
  },
});

/* ==========================================================================
 * Installing (CLI: /cli/cap/kit/version, /cli/cap/kit/list)
 * ========================================================================== */

/** One version of an item (current unless `version` is given): metadata and a
 *  download URL for the archive. Null when the caller cannot read it. */
export const getKitVersion = query({
  args: { api_token: v.string(), slug: v.string(), version: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const userId = await requireTokenUser(ctx, args.api_token);
    const item = await readableItem(ctx, userId, args.slug);
    if (!item) return null;
    const wanted = args.version ?? item.current_version;
    const row = await (ctx.db as any)
      .query("team_kit_versions")
      .withIndex("by_item_version", (q: any) => q.eq("item_id", item._id).eq("version", wanted))
      .first();
    if (!row) return null;
    return {
      slug: item.slug,
      kind: item.kind,
      name: item.name,
      description: item.description,
      workspace: item.workspace,
      team_id: item.team_id,
      current_version: item.current_version,
      ...versionView(row, true),
      download_url: await ctx.storage.getUrl(row.storage_id),
    };
  },
});

export const listKitItems = query({
  args: { api_token: v.string(), team_id: v.optional(v.id("teams")), personal: v.optional(v.boolean()) },
  handler: async (ctx, args) => {
    const userId = await requireTokenUser(ctx, args.api_token);
    const workspace = args.team_id ? `team:${args.team_id}` : args.personal ? `user:${userId}` : undefined;
    const items = await listKitItemsFor(ctx, userId, { workspace });
    return { items: items.filter((i) => i.removed_at === undefined) };
  },
});

/* ==========================================================================
 * Applied state: what each of my machines did with each kit slug
 * ========================================================================== */

/**
 * The reconciler's report for one device: the full set of kit slugs it
 * resolved this pass. Rows are written only when they change; a slug the
 * device stopped reporting turns `removed` rather than vanishing, so the
 * web's delta feed hears about it.
 */
export const reportKitApplied = mutation({
  args: {
    api_token: v.string(),
    device_id: v.string(),
    items: v.array(v.object({ slug: v.string(), hash: v.string(), status: v.string(), detail: v.optional(v.string()) })),
  },
  handler: async (ctx, args) => {
    const userId = await requireTokenUser(ctx, args.api_token);
    const deviceId = identityText(args.device_id, 200);
    if (!deviceId) return { status: "rejected" as const, reason: "invalid_device_id" };
    if (args.items.length > MAX_KIT_APPLIED_PER_DEVICE) return { status: "rejected" as const, reason: "too_many_items" };
    const now = Date.now();
    const existing = await (ctx.db as any)
      .query("team_kit_applied")
      .withIndex("by_user_device_slug", (q: any) => q.eq("user_id", userId).eq("device_id", deviceId))
      .collect();
    const bySlug = new Map<string, any>(existing.map((r: any) => [r.slug, r]));
    const seen = new Set<string>();
    let written = 0;
    for (const raw of args.items) {
      const slug = identityText(raw.slug, 200);
      const hash = identityText(raw.hash, 128);
      if (!slug?.startsWith("authored/") || !hash) continue;
      if (!(KIT_APPLIED_STATUSES as readonly string[]).includes(raw.status) || raw.status === "removed") continue;
      seen.add(slug);
      const detail = sanitizeReported(raw.detail, MAX_DESCRIPTION_CHARS, "diagnostic") ?? undefined;
      const row = bySlug.get(slug);
      if (row) {
        if (row.hash === hash && row.status === raw.status && row.detail === detail) continue;
        await ctx.db.patch(row._id, { hash, status: raw.status, detail, updated_at: now } as any);
      } else {
        await (ctx.db as any).insert("team_kit_applied", {
          user_id: userId, device_id: deviceId, slug, hash, status: raw.status, detail, updated_at: now,
        });
      }
      written++;
    }
    for (const row of existing) {
      if (seen.has(row.slug) || row.status === "removed") continue;
      await ctx.db.patch(row._id, { status: "removed", detail: undefined, updated_at: now } as any);
      written++;
    }
    return { status: "recorded" as const, written };
  },
});

/* ==========================================================================
 * The web
 * ========================================================================== */

/** Feeds the store's `teamKitItems` collection: every item in the viewer's
 *  workspaces, `since` for delta. */
export const webListTeamKitItems = query({
  args: { since: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return { items: [] as any[] };
    return { items: await listKitItemsFor(ctx, userId, { since: args.since }) };
  },
});

/** One item's versions, newest first, with their main bodies. Empty when
 *  the viewer holds no key for the item's workspace. */
export const webVersions = query({
  args: { item_id: v.id("team_kit_items") },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return [];
    const item = await ctx.db.get(args.item_id);
    if (!item || !(await workspaceGrantsAccess(ctx, userId, (item as any).workspace))) return [];
    const rows = await (ctx.db as any)
      .query("team_kit_versions")
      .withIndex("by_item_version", (q: any) => q.eq("item_id", args.item_id))
      .order("desc")
      .take(100);
    return rows.map((r: any) => ({
      version: r.version,
      folder_hash: r.folder_hash,
      note: r.note,
      author_user_id: r.author_user_id,
      created_at: r.created_at,
      main_body: r.main_body,
      files: r.files,
      surfaces: r.surfaces,
    }));
  },
});

/**
 * Take an item out of the kit: its author, or an admin of its team. The row
 * stays (marked removed) so the delta feed carries the removal, and every
 * binding that turns it on is switched off so machines uninstall it.
 */
export async function removeKitItem(ctx: any, userId: Id<"users">, itemId: Id<"team_kit_items">) {
  const item = await ctx.db.get(itemId);
  if (!item || !(await workspaceGrantsAccess(ctx, userId, item.workspace))) throw new Error("Not found");
  if (String(item.author_user_id) !== String(userId)) {
    const ws = parseWorkspaceKey(item.workspace);
    if (ws?.type !== "team") throw new Error("Forbidden: only the author can remove this item");
    await requireTeamAdmin(ctx, userId, ws.teamId);
  }
  if (item.removed_at !== undefined) return { status: "already_removed" as const, disabled: 0 };
  const now = Date.now();
  await ctx.db.patch(item._id, { removed_at: now, updated_at: now });

  // Bindings naming the slug: team-scope rows filed under the item's team,
  // and each workspace member's own rows.
  const memberIds = await workspaceMemberIds(ctx, item.workspace);
  const rows: any[] = [];
  for (const memberId of memberIds) {
    rows.push(...(await ctx.db.query("capability_bindings")
      .withIndex("by_user_scope", (q: any) => q.eq("user_id", memberId).eq("capability_slug", item.slug))
      .collect()));
  }
  let disabled = 0;
  for (const row of rows) {
    if (!row.enabled) continue;
    await ctx.db.patch(row._id, { enabled: false, updated_at: now });
    disabled++;
  }
  // Every member re-plans: a team binding applies to all of them.
  await bumpRevisions(ctx, memberIds);
  return { status: "removed" as const, disabled };
}

export const removeItem = mutation({
  args: { item_id: v.id("team_kit_items") },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new Error("Authentication required");
    return await removeKitItem(ctx, userId, args.item_id);
  },
});

/** The CLI's unpublish (`/cli/cap/kit/remove`), by slug. Same rule as the
 *  web's removeItem; an unknown or unreadable slug is "not_found". */
export const removeKitItemForToken = mutation({
  args: { api_token: v.string(), slug: v.string() },
  handler: async (ctx, args) => {
    const userId = await requireTokenUser(ctx, args.api_token);
    const item = await (ctx.db as any).query("team_kit_items").withIndex("by_slug", (q: any) => q.eq("slug", args.slug)).first();
    if (!item || !(await workspaceGrantsAccess(ctx, userId, item.workspace))) return { status: "not_found" as const, disabled: 0 };
    return await removeKitItem(ctx, userId, item._id);
  },
});

/**
 * The viewer's applied reports in one status (one row per device and slug is
 * already the latest), minus those the person already answered for that
 * hash: a consent for pending_consent, an adoption for conflict.
 */
async function awaitingAnswer(ctx: any, userId: Id<"users">, status: "pending_consent" | "conflict") {
  const purpose = status === "conflict" ? "adopt" : undefined;
  const rows = await ctx.db
    .query("team_kit_applied")
    .withIndex("by_user_updated", (q: any) => q.eq("user_id", userId))
    .take(MAX_KIT_APPLIED_PER_DEVICE * 4);
  const out: Array<{ device_id: string; slug: string; hash: string; detail?: string }> = [];
  for (const r of rows) {
    if (r.status !== status) continue;
    const answers = await ctx.db
      .query("capability_consents")
      .withIndex("by_user_device_slug", (q: any) => q.eq("user_id", userId).eq("device_id", r.device_id).eq("capability_slug", r.slug))
      .collect();
    if (answers.some((c: any) => c.manifest_hash === r.hash && c.purpose === purpose)) continue;
    out.push({ device_id: r.device_id, slug: r.slug, hash: r.hash, ...(purpose ? { detail: r.detail } : {}) });
  }
  return out;
}

/** Kit versions waiting on the viewer's Allow, per machine. */
export const webPendingConsents = query({
  args: {},
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx);
    return userId ? await awaitingAnswer(ctx, userId, "pending_consent") : [];
  },
});

/** Kit items whose target collides with a file the installer did not write,
 *  per machine, with the reconciler's detail. */
export const webKitConflicts = query({
  args: {},
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx);
    return userId ? await awaitingAnswer(ctx, userId, "conflict") : [];
  },
});

/** The answer on one of the viewer's own machines: run this build (Allow),
 *  or replace the colliding file with the kit's copy (adopt). */
async function answerOnOwnDevice(ctx: any, args: { device_id: string; slug: string; hash: string }, purpose?: "adopt") {
  const userId = await getAuthUserId(ctx);
  if (!userId) throw new Error("Authentication required");
  if (!(await ownDevice(ctx, userId, args.device_id))) throw new Error("Unknown device");
  return await recordConsent(
    ctx,
    String(userId),
    { device_id: args.device_id, capability_slug: args.slug, manifest_hash: args.hash },
    purpose,
  );
}

export const grantConsent = mutation({
  args: { device_id: v.string(), slug: v.string(), hash: v.string() },
  handler: async (ctx, args) => await answerOnOwnDevice(ctx, args),
});

export const adoptKitItem = mutation({
  args: { device_id: v.string(), slug: v.string(), hash: v.string() },
  handler: async (ctx, args) => await answerOnOwnDevice(ctx, args, "adopt"),
});

/**
 * "Share with team" on an item one of my machines reports: ask that machine
 * to publish it. No team_id publishes to the personal kit.
 */
export async function requestKitPublish(
  ctx: any,
  userId: Id<"users">,
  args: { device_id: string; kind: string; name: string; team_id?: Id<"teams">; note?: string; client_key?: string },
) {
  const device = await ownDevice(ctx, userId, args.device_id);
  if (!device) throw new Error("Unknown device");
  const { owner } = await kitWorkspaceFor(ctx, userId, args.team_id);
  const slug = kitSlug(owner, args.kind, args.name);
  if (!slug) throw new Error("Invalid kit item name");
  const note = sanitizeReported(args.note, MAX_DESCRIPTION_CHARS, "text") ?? undefined;
  const commandId = await ctx.db.insert("daemon_commands", {
    user_id: userId,
    command: "cap_publish" as const,
    args: JSON.stringify({ kind: args.kind, name: args.name, ...(args.team_id ? { team_id: args.team_id } : {}), ...(note ? { note } : {}) }),
    created_at: Date.now(),
    target_device_id: device.device_id,
  });
  return { command_id: commandId, slug, client_key: args.client_key };
}

export const requestTeamKitPublish = mutation({
  args: {
    device_id: v.string(),
    kind: v.string(),
    name: v.string(),
    team_id: v.optional(v.id("teams")),
    note: v.optional(v.string()),
    /** The web's optimistic stub key; the real item supersedes it by slug. */
    client_key: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new Error("Authentication required");
    return await requestKitPublish(ctx, userId, args);
  },
});
