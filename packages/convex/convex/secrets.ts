// Vault (docs/architecture/vault.md): the team's keys, logins, files and
// saved browser sign-ins, readable by every member and their agents, or by
// one person when personal.
//
// One handler set serves the web (session auth) and the CLI (api_token) the
// way agentDefinitions does. Rows are workspace scoped: reads are one equality
// per held key (heldKeysFor), and a write names its workspace (a team or
// personal), never a guess. The payload is encrypted under the deployment's
// connection key with the workspace in the HKDF info, so a ciphertext bound to
// one workspace fails to decrypt anywhere else. No query returns it: values
// leave through `reveal` (a signed-in person) and `cliRead` (an agent's
// token, naming its session), each recording an event before the value goes
// out, and through `redactionValues`, which feeds the caller's own daemon its
// redaction list. Every refusal is a sentence that says what to do next.

import { v } from "convex/values";
import { action, internalMutation, internalQuery, mutation, query } from "./functions";
import { getAuthUserId } from "@convex-dev/auth/server";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { enqueuePendingMessage, getAuthenticatedUserId } from "./pendingMessages";
import { canAccessConversation, heldKeysFor, requireTeamMembership, workspaceKey } from "./lib/access";
import { decryptRefreshToken, encryptRefreshToken } from "./googleOAuth";
import { CONNECTION_SECRETS_KEY_ENV } from "./tokenConnectors";
import { nextShortId } from "./counters";
import { emitNotification } from "./notificationRouter";
import { peopleFor } from "./sessionDecisions";
import { displayName } from "./lib/displayNames";
import { findConversationByAnyRefWhere } from "./conversationSessionLookup";
import { isConvexId } from "@codecast/shared/entities";
import {
  cleanSecretList,
  cleanSecretSites,
  envNameProblem,
  formatVaultReady,
  isHostedAgentType,
  payloadFingerprint,
  redactionValuesOf,
  secretNameProblem,
  signinExpiresAt,
  validatePayload,
  type LoginPayload,
  type SecretKind,
  type SecretMeta,
  type SecretPayload,
  type SigninPayload,
} from "@codecast/shared/contracts";

type SecretRow = Doc<"secrets">;

const kindValidator = v.union(v.literal("key"), v.literal("login"), v.literal("signin"), v.literal("file"));
const purposeValidator = v.union(v.literal("get"), v.literal("run"), v.literal("env"), v.literal("otp"), v.literal("signin"));

/** Where a write lands: a team (membership checked) or the caller's personal workspace. Exactly one. */
const workspaceArgs = { team_id: v.optional(v.id("teams")), personal: v.optional(v.boolean()) };

const HKDF_PREFIX = "codecast-secret-v1:";
const MAX_NOTE = 2000;
const MAX_LIST = 32;
const EVENTS_SHOWN = 50;

function deploymentKey(): string {
  const key = process.env[CONNECTION_SECRETS_KEY_ENV];
  if (!key) throw new Error(`Vault is not configured on this deployment: set ${CONNECTION_SECRETS_KEY_ENV} in its environment`);
  return key;
}

export async function encryptSecret(payload: SecretPayload, workspace: string): Promise<string> {
  return encryptRefreshToken(JSON.stringify(payload), deploymentKey(), HKDF_PREFIX + workspace);
}

/** The payload, or null when the ciphertext does not belong to this workspace (or the key changed). */
export async function decryptSecret(enc: string, workspace: string): Promise<SecretPayload | null> {
  const json = await decryptRefreshToken(enc, deploymentKey(), HKDF_PREFIX + workspace);
  return json === null ? null : JSON.parse(json);
}

const undecryptable = (row: { name: string }) =>
  `${row.name} no longer decrypts in its workspace (it was moved, or the deployment key changed): store its value again with cast vault rotate ${row.name}`;

// ── Access ───────────────────────────────────────────────────────────────────

async function requireCaller(ctx: any, apiToken?: string): Promise<Id<"users">> {
  const userId = await getAuthenticatedUserId(ctx, apiToken);
  if (!userId) throw new Error("Unauthorized: sign in, or run `cast auth` on this machine");
  return userId;
}

/** For actions, which have no db: the web session or the token's user. */
export const callerOf = internalQuery({
  args: { api_token: v.optional(v.string()) },
  handler: async (ctx, args) => await getAuthenticatedUserId(ctx, args.api_token),
});

async function writeKey(
  ctx: any,
  userId: Id<"users">,
  args: { team_id?: Id<"teams">; personal?: boolean },
): Promise<{ workspace: string; team_id?: Id<"teams"> } | { error: string }> {
  if (args.team_id && args.personal) return { error: "Choose one place for the secret: a team or personal, not both" };
  if (args.team_id) {
    await requireTeamMembership(ctx, userId, args.team_id);
    return { workspace: workspaceKey({ type: "team", teamId: args.team_id }), team_id: args.team_id };
  }
  if (args.personal) return { workspace: workspaceKey({ type: "personal", userId }) };
  return { error: "Say where the secret goes: --team <team> for the team, or --personal for you alone" };
}

async function byName(ctx: any, workspace: string, name: string): Promise<SecretRow | null> {
  return await ctx.db.query("secrets").withIndex("by_workspace_name", (q: any) => q.eq("workspace", workspace).eq("name", name)).first();
}

/** All rows across the workspaces the viewer holds a key for. */
async function rowsFor(ctx: any, userId: Id<"users">): Promise<SecretRow[]> {
  const rows: SecretRow[] = [];
  for (const key of await heldKeysFor(ctx, userId)) {
    rows.push(...(await ctx.db.query("secrets").withIndex("by_workspace", (q: any) => q.eq("workspace", key)).collect()));
  }
  return rows;
}

/**
 * A secret by short id (`sec-4`), Convex id or name, inside the viewer's
 * workspaces. A name the viewer holds in more than one workspace is refused
 * with the short ids that tell them apart; `preferWorkspace` settles it first.
 */
async function findSecret(ctx: any, userId: Id<"users">, ref: string, preferWorkspace?: string): Promise<SecretRow | { error: string }> {
  const r = ref.trim();
  const keys = await heldKeysFor(ctx, userId);
  let row: SecretRow | null = null;
  if (/^sec-\d+$/i.test(r)) row = await ctx.db.query("secrets").withIndex("by_short_id", (q: any) => q.eq("short_id", r.toLowerCase())).first();
  else if (isConvexId(r)) {
    const id = ctx.db.normalizeId("secrets", r);
    row = id ? await ctx.db.get(id) : null;
  } else {
    if (preferWorkspace && keys.has(preferWorkspace)) row = await byName(ctx, preferWorkspace, r);
    if (!row) {
      const found: SecretRow[] = [];
      for (const key of keys) {
        const hit = await byName(ctx, key, r);
        if (hit) found.push(hit);
      }
      const personal = found.find((f) => f.workspace === workspaceKey({ type: "personal", userId }));
      if (found.length > 1 && !personal) {
        return { error: `${r} is in ${found.length} workspaces (${found.map((f) => f.short_id).join(", ")}): name it by its short id` };
      }
      row = personal ?? found[0] ?? null;
    }
  }
  if (!row || !keys.has(row.workspace)) return { error: `No secret ${r} that you can read: cast vault lists them, and cast vault request ${r} asks a person for it` };
  return row;
}

async function resolveConversation(ctx: any, userId: Id<"users">, ref?: string): Promise<Doc<"conversations"> | null> {
  if (!ref) return null;
  return (await findConversationByAnyRefWhere(ctx, ref, (c: any) => canAccessConversation(ctx, userId, c))) as any;
}

// ── Bookkeeping ──────────────────────────────────────────────────────────────

async function recordEvent(
  ctx: any,
  row: Pick<SecretRow, "_id" | "workspace" | "name">,
  kind: Doc<"secret_events">["kind"],
  fields: { actor?: Id<"users">; conversation_id?: Id<"conversations">; purpose?: string } = {},
) {
  await ctx.db.insert("secret_events", {
    secret_id: row._id,
    workspace: row.workspace,
    secret_name: row.name,
    kind,
    actor_user_id: fields.actor,
    conversation_id: fields.conversation_id,
    purpose: fields.purpose,
    at: Date.now(),
  });
}

// The redaction version is one counter per workspace, bumped on every value
// write and delete, so a daemon polls a few counter reads instead of
// decrypting every value it can read.
const redactionCounter = (workspace: string) => `secrets-redaction:${workspace}`;

async function bumpRedaction(ctx: any, workspace: string) {
  const name = redactionCounter(workspace);
  const row = await ctx.db.query("counters").withIndex("by_name", (q: any) => q.eq("name", name)).unique();
  if (row) await ctx.db.patch(row._id, { value: row.value + 1 });
  else await ctx.db.insert("counters", { name, value: 1 });
}

async function redactionVersionFor(ctx: any, userId: Id<"users">): Promise<string> {
  const parts: string[] = [];
  for (const key of [...(await heldKeysFor(ctx, userId))].sort()) {
    const row = await ctx.db.query("counters").withIndex("by_name", (q: any) => q.eq("name", redactionCounter(key))).unique();
    parts.push(`${key}=${row?.value ?? 0}`);
  }
  return parts.join(",");
}

function metaProblem(fields: { name?: string; env?: string[]; note?: string; sites?: string[] }): string | null {
  if (fields.name !== undefined) {
    const p = secretNameProblem(fields.name);
    if (p) return p;
  }
  for (const e of fields.env ?? []) {
    const p = envNameProblem(e);
    if (p) return p;
  }
  if ((fields.note?.length ?? 0) > MAX_NOTE) return `A note holds at most ${MAX_NOTE} characters: keep the details in a doc and link it`;
  if ((fields.sites ?? []).some((s) => !s.trim() || /\s/.test(s.trim()))) return "Sites are hostnames like dashboard.stripe.com, one per entry";
  return null;
}


function valueFields(kind: SecretKind, payload: SecretPayload) {
  return {
    fingerprint: payloadFingerprint(kind, payload),
    signin_expires_at: kind === "signin" ? signinExpiresAt(payload as SigninPayload) : undefined,
  };
}

async function namesOf(ctx: any, ids: (Id<"users"> | undefined)[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (const id of new Set(ids.filter(Boolean).map(String))) out.set(id, displayName(await ctx.db.get(id as Id<"users">)));
  return out;
}

/** A row as every surface sees it: metadata only. Built field by field so a new column never leaks by default. */
function metaOf(row: SecretRow, names: Map<string, string>): SecretMeta {
  return {
    _id: String(row._id),
    short_id: row.short_id,
    name: row.name,
    kind: row.kind,
    status: row.status,
    workspace: row.workspace,
    team_id: row.team_id ? String(row.team_id) : undefined,
    env: row.env,
    sites: row.sites,
    note: row.note,
    fingerprint: row.fingerprint,
    signin_expires_at: row.signin_expires_at,
    created_by: String(row.created_by),
    created_by_name: names.get(String(row.created_by)),
    created_at: row.created_at,
    updated_at: row.updated_at,
    rotated_at: row.rotated_at,
    last_used_at: row.last_used_at,
    last_used_by_conversation: row.last_used_by_conversation ? String(row.last_used_by_conversation) : undefined,
    use_count: row.use_count,
    requested_by: row.requested_by ? String(row.requested_by) : undefined,
    requested_by_name: row.requested_by ? names.get(String(row.requested_by)) : undefined,
    requested_from_conversation: row.requested_from_conversation ? String(row.requested_from_conversation) : undefined,
    request_why: row.request_why,
  };
}

// ── Reads (metadata) ─────────────────────────────────────────────────────────

/** Every secret the caller can read, open requests first. */
export const list = query({
  args: { api_token: v.optional(v.string()) },
  handler: async (ctx, args): Promise<SecretMeta[]> => {
    const userId = await requireCaller(ctx, args.api_token);
    const rows = await rowsFor(ctx, userId);
    const names = await namesOf(ctx, rows.flatMap((r) => [r.created_by, r.requested_by]));
    return rows
      .sort((a, b) => (a.status === b.status ? a.name.localeCompare(b.name) : a.status === "requested" ? -1 : 1))
      .map((r) => metaOf(r, names));
  },
});

/** One secret's metadata (`cast vault show`). */
export const show = query({
  args: { api_token: v.optional(v.string()), ref: v.string() },
  handler: async (ctx, args): Promise<SecretMeta | { error: string }> => {
    const userId = await requireCaller(ctx, args.api_token);
    const row = await findSecret(ctx, userId, args.ref);
    if ("error" in row) return row;
    return metaOf(row, await namesOf(ctx, [row.created_by, row.requested_by]));
  },
});

/** The secret's recent activity, newest first, with who and from which session. */
export const events = query({
  args: { api_token: v.optional(v.string()), ref: v.string() },
  handler: async (ctx, args) => {
    const userId = await requireCaller(ctx, args.api_token);
    const row = await findSecret(ctx, userId, args.ref);
    if ("error" in row) return row;
    const evs = await ctx.db
      .query("secret_events")
      .withIndex("by_secret_at", (q: any) => q.eq("secret_id", row._id))
      .order("desc")
      .take(EVENTS_SHOWN);
    const names = await namesOf(ctx, evs.map((e) => e.actor_user_id));
    const convs = new Map<string, any>();
    for (const id of new Set(evs.map((e) => e.conversation_id).filter(Boolean).map(String))) {
      const c: any = await ctx.db.get(id as Id<"conversations">);
      // A session the viewer cannot open is named as a session, never by its title.
      if (c) convs.set(id, (await canAccessConversation(ctx, userId, c)) ? { short_id: c.short_id, title: c.title } : { short_id: c.short_id });
    }
    return evs.map((e) => ({
      _id: String(e._id),
      kind: e.kind,
      at: e.at,
      purpose: e.purpose,
      actor_name: e.actor_user_id ? names.get(String(e.actor_user_id)) : undefined,
      conversation_id: e.conversation_id ? String(e.conversation_id) : undefined,
      session_short_id: e.conversation_id ? convs.get(String(e.conversation_id))?.short_id : undefined,
      session_title: e.conversation_id ? convs.get(String(e.conversation_id))?.title : undefined,
    }));
  },
});

/** Cheap poll for daemons: changes whenever any value the caller can read is written or deleted, or their workspaces change. */
export const redactionVersion = query({
  args: { api_token: v.string() },
  handler: async (ctx, args) => ({ version: await redactionVersionFor(ctx, await requireCaller(ctx, args.api_token)) }),
});

// ── Writes ───────────────────────────────────────────────────────────────────

export const resolveCreate = internalQuery({
  args: { user_id: v.id("users"), name: v.string(), ...workspaceArgs },
  handler: async (ctx, args) => {
    const where = await writeKey(ctx, args.user_id, args);
    if ("error" in where) return where;
    const twin = await byName(ctx, where.workspace, args.name);
    if (twin) return { error: duplicate(twin) };
    return where;
  },
});

const duplicate = (twin: SecretRow) =>
  twin.status === "requested"
    ? `${twin.name} is already requested (${twin.short_id}): fill it with cast vault fulfill ${twin.name}, or on the Vault page`
    : `${twin.name} already exists here (${twin.short_id}): replace its value with cast vault rotate ${twin.name}`;

export const insertSecret = internalMutation({
  args: {
    user_id: v.id("users"),
    workspace: v.string(),
    team_id: v.optional(v.id("teams")),
    name: v.string(),
    kind: kindValidator,
    value_enc: v.string(),
    fingerprint: v.optional(v.string()),
    signin_expires_at: v.optional(v.number()),
    env: v.optional(v.array(v.string())),
    sites: v.optional(v.array(v.string())),
    note: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    // Checked again inside the transaction: two creates of one name race past resolveCreate.
    const twin = await byName(ctx, args.workspace, args.name);
    if (twin) return { error: duplicate(twin) };
    const now = Date.now();
    const { user_id, ...fields } = args;
    const short_id = await nextShortId(ctx.db as any, "sec");
    const id = await ctx.db.insert("secrets", { ...fields, short_id, status: "ready", created_by: user_id, created_at: now, updated_by: user_id, updated_at: now } as any);
    await recordEvent(ctx, { _id: id, workspace: args.workspace, name: args.name }, "created", { actor: user_id });
    await bumpRedaction(ctx, args.workspace);
    return { id: String(id), short_id, name: args.name };
  },
});

/** Store a new secret. The workspace is explicit: a team the caller is in, or personal. */
export const create = action({
  args: {
    api_token: v.optional(v.string()),
    name: v.string(),
    kind: kindValidator,
    payload: v.any(),
    env: v.optional(v.array(v.string())),
    sites: v.optional(v.array(v.string())),
    note: v.optional(v.string()),
    ...workspaceArgs,
  },
  handler: async (ctx, args): Promise<{ id: string; short_id: string; name: string } | { error: string }> => {
    const userId = await ctx.runQuery(internal.secrets.callerOf, { api_token: args.api_token });
    if (!userId) return { error: "Unauthorized: sign in, or run `cast auth` on this machine" };
    const name = args.name.trim();
    const env = cleanSecretList(args.env);
    const sites = cleanSecretSites(args.sites);
    const note = args.note?.trim() || undefined;
    const problem = metaProblem({ name, env, sites, note });
    if (problem) return { error: problem };
    const checked = validatePayload(args.kind as SecretKind, args.payload);
    if ("error" in checked) return checked;
    const where = await ctx.runQuery(internal.secrets.resolveCreate, { user_id: userId, name, team_id: args.team_id, personal: args.personal });
    if ("error" in where) return where;
    return await ctx.runMutation(internal.secrets.insertSecret, {
      user_id: userId,
      workspace: where.workspace,
      team_id: where.team_id,
      name,
      kind: args.kind,
      value_enc: await encryptSecret(checked.payload, where.workspace),
      ...valueFields(args.kind, checked.payload),
      env,
      sites,
      note,
    });
  },
});

/** The row an action is about to write a value into, checked for access. */
export const valueTarget = internalQuery({
  args: { user_id: v.id("users"), ref: v.string(), want: v.union(v.literal("ready"), v.literal("requested")) },
  handler: async (ctx, args) => {
    const row = await findSecret(ctx, args.user_id, args.ref);
    if ("error" in row) return row;
    if (row.status !== args.want) {
      return {
        error: args.want === "ready"
          ? `${row.name} has no value yet (${row.short_id} is a request): fill it with cast vault fulfill ${row.name}`
          : `${row.name} already has a value: replace it with cast vault rotate ${row.name}`,
      };
    }
    return { id: row._id, workspace: row.workspace, kind: row.kind, name: row.name };
  },
});

export const storeValue = internalMutation({
  args: {
    user_id: v.id("users"),
    id: v.id("secrets"),
    workspace: v.string(),
    value_enc: v.string(),
    fingerprint: v.optional(v.string()),
    signin_expires_at: v.optional(v.number()),
    event: v.union(v.literal("rotated"), v.literal("fulfilled"), v.literal("refreshed")),
    has_otp: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.id);
    // The ciphertext is bound to the workspace it was encrypted for; a row
    // that moved or vanished meanwhile must not take it.
    if (!row || row.workspace !== args.workspace) return { error: "The secret changed while saving: try again" };
    if (!(await heldKeysFor(ctx, args.user_id)).has(row.workspace)) return { error: `You can no longer write ${row.name}: ask someone in its team` };
    const now = Date.now();
    const wasRequest = row.status === "requested";
    await ctx.db.patch(row._id, {
      value_enc: args.value_enc,
      status: "ready",
      fingerprint: args.fingerprint,
      signin_expires_at: args.signin_expires_at,
      updated_by: args.user_id,
      updated_at: now,
      ...(args.event === "rotated" ? { rotated_at: now } : {}),
    });
    await recordEvent(ctx, row, args.event, { actor: args.user_id });
    await bumpRedaction(ctx, row.workspace);
    const delivered = wasRequest && args.event === "fulfilled" ? await deliverReady(ctx, { ...row, status: "ready" }, args.user_id, !!args.has_otp) : false;
    return { id: String(row._id), short_id: row.short_id, name: row.name, delivered };
  },
});

// The "is ready" line into the session that asked, waking it like a decision
// answer does. A hosted conversation takes input from its owner alone.
async function deliverReady(ctx: any, row: SecretRow, fulfiller: Id<"users">, hasOtp: boolean): Promise<boolean> {
  if (!row.requested_from_conversation) return false;
  const conversation: any = await ctx.db.get(row.requested_from_conversation);
  if (!conversation) return false;
  if (isHostedAgentType(conversation.agent_type) && String(fulfiller) !== String(conversation.user_id)) return false;
  await enqueuePendingMessage(ctx, conversation, fulfiller, {
    content: formatVaultReady({ short_id: row.short_id, name: row.name, kind: row.kind, env: row.env, sites: row.sites, has_otp: hasOtp }),
    client_id: `vault-ready:${String(row._id)}`,
    human: true,
    wake_cause: "approval",
  });
  return true;
}

async function writeValue(
  ctx: any,
  args: { api_token?: string; ref: string; payload: unknown },
  want: "ready" | "requested",
  event: "rotated" | "fulfilled" | "refreshed",
) {
  const userId = await ctx.runQuery(internal.secrets.callerOf, { api_token: args.api_token });
  if (!userId) return { error: "Unauthorized: sign in, or run `cast auth` on this machine" };
  const target = await ctx.runQuery(internal.secrets.valueTarget, { user_id: userId, ref: args.ref, want });
  if ("error" in target) return target;
  const checked = validatePayload(target.kind as SecretKind, args.payload);
  if ("error" in checked) return checked;
  return await ctx.runMutation(internal.secrets.storeValue, {
    user_id: userId,
    id: target.id,
    workspace: target.workspace,
    value_enc: await encryptSecret(checked.payload, target.workspace),
    ...valueFields(target.kind, checked.payload),
    event,
    has_otp: target.kind === "login" && !!(checked.payload as LoginPayload).totp_seed,
  });
}

const valueArgs = { api_token: v.optional(v.string()), ref: v.string(), payload: v.any() };

/** Replace a secret's value. */
export const rotate = action({
  args: valueArgs,
  handler: async (ctx, args): Promise<any> => writeValue(ctx, args, "ready", "rotated"),
});

/** A browser wrote a used sign-in's newer cookies back, so the saved session stays alive. */
export const refresh = action({
  args: valueArgs,
  handler: async (ctx, args): Promise<any> => writeValue(ctx, args, "ready", "refreshed"),
});

/** Fill a requested secret; the session that asked is told it is ready (never the value) and wakes. */
export const fulfill = action({
  args: valueArgs,
  handler: async (ctx, args): Promise<any> => writeValue(ctx, args, "requested", "fulfilled"),
});

/** Name, note, env and sites; never the value. The web's dispatch side effect calls this too. */
export const updateMeta = mutation({
  args: {
    api_token: v.optional(v.string()),
    ref: v.string(),
    name: v.optional(v.string()),
    note: v.optional(v.string()),
    env: v.optional(v.array(v.string())),
    sites: v.optional(v.array(v.string())),
  },
  handler: async (ctx, args) => {
    const userId = await requireCaller(ctx, args.api_token);
    const row = await findSecret(ctx, userId, args.ref);
    if ("error" in row) return row;
    const patch: Partial<SecretRow> = {};
    if (args.name !== undefined) patch.name = args.name.trim();
    if (args.note !== undefined) patch.note = args.note.trim() || undefined;
    if (args.env !== undefined) patch.env = cleanSecretList(args.env)?.length ? cleanSecretList(args.env) : undefined;
    if (args.sites !== undefined) patch.sites = cleanSecretSites(args.sites)?.length ? cleanSecretSites(args.sites) : undefined;
    const problem = metaProblem({ name: patch.name, env: patch.env, sites: patch.sites, note: patch.note });
    if (problem) return { error: problem };
    if (patch.name && patch.name !== row.name) {
      const twin = await byName(ctx, row.workspace, patch.name);
      if (twin) return { error: `${patch.name} is already taken here (${twin.short_id}): pick another name, or remove that one first` };
    }
    await ctx.db.patch(row._id, { ...patch, updated_by: userId, updated_at: Date.now() });
    await recordEvent(ctx, { ...row, name: patch.name ?? row.name }, "updated", { actor: userId });
    return { id: String(row._id), short_id: row.short_id, name: patch.name ?? row.name };
  },
});

/** Delete a secret. Its events stay, carrying its name. */
export const remove = mutation({
  args: { api_token: v.optional(v.string()), ref: v.string() },
  handler: async (ctx, args) => {
    const userId = await requireCaller(ctx, args.api_token);
    const row = await findSecret(ctx, userId, args.ref);
    if ("error" in row) return row;
    await recordEvent(ctx, row, "deleted", { actor: userId });
    await ctx.db.delete(row._id);
    await bumpRedaction(ctx, row.workspace);
    return { removed: true, short_id: row.short_id, name: row.name };
  },
});

/**
 * An agent (or a person) asks for a secret that does not exist yet: a row
 * with no value, pinned at the top of the Vault page with a field to fill,
 * and a notice to the people the asking session answers to. Asking again
 * for the same name refreshes the open request rather than stacking one.
 */
export const request = mutation({
  args: {
    api_token: v.optional(v.string()),
    name: v.string(),
    kind: kindValidator,
    why: v.optional(v.string()),
    env: v.optional(v.array(v.string())),
    sites: v.optional(v.array(v.string())),
    conversation: v.optional(v.string()),
    ...workspaceArgs,
  },
  handler: async (ctx, args) => {
    const userId = await requireCaller(ctx, args.api_token);
    const name = args.name.trim();
    const env = cleanSecretList(args.env);
    const sites = cleanSecretSites(args.sites);
    const why = args.why?.trim() || undefined;
    const problem = metaProblem({ name, env, sites, note: why });
    if (problem) return { error: problem };
    const where = await writeKey(ctx, userId, args);
    if ("error" in where) return where;
    const conversation = await resolveConversation(ctx, userId, args.conversation);
    const now = Date.now();
    const fields = {
      kind: args.kind,
      env,
      sites,
      request_why: why,
      requested_by: userId,
      requested_from_conversation: conversation?._id,
      updated_by: userId,
      updated_at: now,
    };
    let row = await byName(ctx, where.workspace, name);
    if (row?.status === "ready") {
      return { exists: true, id: String(row._id), short_id: row.short_id, name, message: `${name} already exists (${row.short_id}): read it with cast vault get ${name}` };
    }
    if (row) await ctx.db.patch(row._id, fields);
    else {
      const short_id = await nextShortId(ctx.db as any, "sec");
      const id = await ctx.db.insert("secrets", {
        workspace: where.workspace,
        team_id: where.team_id,
        short_id,
        name,
        status: "requested",
        created_by: userId,
        created_at: now,
        ...fields,
      });
      row = (await ctx.db.get(id))!;
    }
    await recordEvent(ctx, row, "requested", { actor: userId, conversation_id: conversation?._id });
    if (conversation) {
      const people = await peopleFor(ctx, conversation);
      await emitNotification(ctx as any, {
        event_type: "permission_request",
        // No actor: the asker is usually the person's own agent, and the
        // router skips the actor, which would skip the one person to tell.
        actor_name: conversation.title || "An agent",
        entity_type: "conversation",
        entity_id: String(conversation._id),
        conversation_id: conversation._id,
        message: `needs ${name} from the Vault${why ? `: ${why}` : ""}`,
        link: `/vault?s=${row.short_id}`,
        recipient_ids: people,
      });
    }
    return { id: String(row._id), short_id: row.short_id, name, requested: true };
  },
});

// ── Values out ───────────────────────────────────────────────────────────────

export const readTargets = internalQuery({
  args: { user_id: v.id("users"), refs: v.array(v.string()), conversation: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const rows: { id: Id<"secrets">; short_id: string; name: string; kind: SecretKind; workspace: string; value_enc: string; env?: string[]; sites?: string[] }[] = [];
    for (const ref of args.refs) {
      const row = await findSecret(ctx, args.user_id, ref);
      if ("error" in row) return row;
      if (row.status !== "ready" || !row.value_enc) {
        return { error: `${row.name} has no value yet (${row.short_id} is a request): wait for a person to fill it on the Vault page` };
      }
      rows.push({ id: row._id, short_id: row.short_id, name: row.name, kind: row.kind, workspace: row.workspace, value_enc: row.value_enc, env: row.env, sites: row.sites });
    }
    const conversation = await resolveConversation(ctx, args.user_id, args.conversation);
    return { rows, conversation_id: conversation?._id };
  },
});

export const recordReads = internalMutation({
  args: {
    user_id: v.id("users"),
    ids: v.array(v.id("secrets")),
    kind: v.union(v.literal("read"), v.literal("revealed")),
    conversation_id: v.optional(v.id("conversations")),
    purpose: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const now = Date.now();
    for (const id of args.ids) {
      const row = await ctx.db.get(id);
      if (!row) continue;
      await recordEvent(ctx, row, args.kind, { actor: args.user_id, conversation_id: args.conversation_id, purpose: args.purpose });
      if (args.kind === "read") {
        await ctx.db.patch(row._id, { last_used_at: now, last_used_by_conversation: args.conversation_id, use_count: (row.use_count ?? 0) + 1 });
      }
    }
  },
});

/** Decrypt rows whose read was already recorded; one that no longer decrypts refuses the whole read. */
async function openRows(rows: { name: string; workspace: string; value_enc: string }[]): Promise<{ payloads: SecretPayload[] } | { error: string }> {
  const out: SecretPayload[] = [];
  for (const row of rows) {
    const payload = await decryptSecret(row.value_enc, row.workspace);
    if (!payload) return { error: undecryptable(row) };
    out.push(payload);
  }
  return { payloads: out };
}

/** One secret's value for a signed-in person on the web. The reveal is recorded before the value leaves. */
export const reveal = action({
  args: { ref: v.string() },
  handler: async (ctx, args): Promise<{ payload: SecretPayload } | { error: string }> => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return { error: "Sign in to codecast to reveal a secret" };
    const got = await ctx.runQuery(internal.secrets.readTargets, { user_id: userId, refs: [args.ref] });
    if ("error" in got) return got;
    await ctx.runMutation(internal.secrets.recordReads, { user_id: userId, ids: got.rows.map((r) => r.id), kind: "revealed" });
    const opened = await openRows(got.rows);
    if ("error" in opened) return opened;
    return { payload: opened.payloads[0] };
  },
});

/**
 * Values for an agent: `cast vault get|run|env|otp` and the browser's
 * sign-in. Each secret read records one event naming the session, and bumps
 * its use, before any value is returned.
 */
export const cliRead = action({
  args: {
    api_token: v.string(),
    refs: v.array(v.string()),
    conversation: v.optional(v.string()),
    purpose: purposeValidator,
  },
  handler: async (ctx, args): Promise<any> => {
    const userId = await ctx.runQuery(internal.secrets.callerOf, { api_token: args.api_token });
    if (!userId) return { error: "Unauthorized: run `cast auth` on this machine" };
    const refs = [...new Set(args.refs.map((r) => r.trim()).filter(Boolean))];
    if (!refs.length) return { error: "Name the secrets to read: cast vault lists them" };
    if (refs.length > MAX_LIST) return { error: `Read at most ${MAX_LIST} secrets at once` };
    const got = await ctx.runQuery(internal.secrets.readTargets, { user_id: userId, refs, conversation: args.conversation });
    if ("error" in got) return got;
    await ctx.runMutation(internal.secrets.recordReads, {
      user_id: userId,
      ids: got.rows.map((r) => r.id),
      kind: "read",
      conversation_id: got.conversation_id,
      purpose: args.purpose,
    });
    const opened = await openRows(got.rows);
    if ("error" in opened) return opened;
    return {
      secrets: got.rows.map((r, i) => ({
        id: String(r.id),
        short_id: r.short_id,
        name: r.name,
        kind: r.kind,
        env: r.env,
        sites: r.sites,
        payload: opened.payloads[i],
      })),
    };
  },
});

export const redactionRows = internalQuery({
  args: { user_id: v.id("users") },
  handler: async (ctx, args) => ({
    version: await redactionVersionFor(ctx, args.user_id),
    rows: (await rowsFor(ctx, args.user_id))
      .filter((r) => r.status === "ready" && r.value_enc)
      .map((r) => ({ name: r.name, kind: r.kind, workspace: r.workspace, value_enc: r.value_enc! })),
  }),
});

/**
 * Every value the caller can read, flattened for the daemon's known-value
 * redaction (memory only), with the version it matches. Not an agent's read:
 * nothing is recorded per secret, since the daemon refetches on every
 * version change and the values never reach a session.
 */
export const redactionValues = action({
  args: { api_token: v.string() },
  handler: async (ctx, args): Promise<{ version: string; values: { name: string; value: string }[] } | { error: string }> => {
    const userId = await ctx.runQuery(internal.secrets.callerOf, { api_token: args.api_token });
    if (!userId) return { error: "Unauthorized: run `cast auth` on this machine" };
    const got = await ctx.runQuery(internal.secrets.redactionRows, { user_id: userId });
    const values: { name: string; value: string }[] = [];
    for (const row of got.rows) {
      const payload = await decryptSecret(row.value_enc, row.workspace);
      if (!payload) continue;
      for (const value of redactionValuesOf(row.kind, payload)) values.push({ name: row.name, value });
    }
    return { version: got.version, values };
  },
});
