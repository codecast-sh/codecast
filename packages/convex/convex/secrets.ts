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
// redaction list. An Ask first secret holds an agent's read until a person
// approves it for that session (a decision on the conversation). Rotate keeps
// the previous value for 7 days (`versions`, `restore`). Every refusal is a
// sentence that says what to do next.

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
import { askCore, peopleFor } from "./sessionDecisions";
import { APPROVE_FOR_SESSION, DENY, recordSecretEvent } from "./lib/secretApprovals";
import { displayName } from "./lib/displayNames";
import { findConversationByAnyRefWhere } from "./conversationSessionLookup";
import { pickOnlineLocalDevice } from "./cloud";
import { isConvexId } from "@codecast/shared/entities";
import {
  cleanSecretList,
  cleanSecretSites,
  envFor,
  envNameProblem,
  payloadFingerprint,
  redactionValuesOf,
  secretNameProblem,
  signinExpiresAt,
  validatePayload,
  SECRET_VERSION_TTL_MS,
  type LoginPayload,
  type SecretKind,
  type SecretMeta,
  type SecretNeedsApproval,
  type SecretPayload,
  type SecretReadPurpose,
  type SecretVersionMeta,
  type SigninPayload,
} from "@codecast/shared/contracts/secrets";
import { formatVaultReady, isHostedAgentType } from "@codecast/shared/contracts";

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


/** What a row stores about its value, computed when the value is written: nothing here is ever read by decrypting. */
function valueFields(kind: SecretKind, payload: SecretPayload) {
  return {
    fingerprint: payloadFingerprint(kind, payload),
    signin_expires_at: kind === "signin" ? signinExpiresAt(payload as SigninPayload) : undefined,
    has_otp: kind === "login" ? !!(payload as LoginPayload).totp_seed : undefined,
  };
}

const valueFieldValidators = {
  fingerprint: v.optional(v.string()),
  signin_expires_at: v.optional(v.number()),
  has_otp: v.optional(v.boolean()),
};

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
    updated_by_name: row.updated_by ? names.get(String(row.updated_by)) : undefined,
    has_otp: row.has_otp,
    ask_first: row.ask_first,
    version_count: row.version_count,
  };
}

const peopleOf = (r: SecretRow) => [r.created_by, r.requested_by, r.updated_by];

// ── Reads (metadata) ─────────────────────────────────────────────────────────

/** Every secret the caller can read, open requests first. */
export const list = query({
  args: { api_token: v.optional(v.string()) },
  handler: async (ctx, args): Promise<SecretMeta[]> => {
    const userId = await requireCaller(ctx, args.api_token);
    const rows = await rowsFor(ctx, userId);
    const names = await namesOf(ctx, rows.flatMap(peopleOf));
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
    return metaOf(row, await namesOf(ctx, peopleOf(row)));
  },
});

/**
 * The secret's recent activity, newest first, with who and from which
 * session. A deleted secret's trail is still found by its short id, inside
 * the workspaces the viewer holds.
 */
export const events = query({
  args: { api_token: v.optional(v.string()), ref: v.string() },
  handler: async (ctx, args) => {
    const userId = await requireCaller(ctx, args.api_token);
    const row = await findSecret(ctx, userId, args.ref);
    let evs: Doc<"secret_events">[];
    if (!("error" in row)) {
      evs = await ctx.db.query("secret_events").withIndex("by_secret_at", (q: any) => q.eq("secret_id", row._id)).order("desc").take(EVENTS_SHOWN);
    } else {
      const shortId = args.ref.trim().toLowerCase();
      if (!/^sec-\d+$/.test(shortId)) return row;
      const keys = await heldKeysFor(ctx, userId);
      evs = (await ctx.db.query("secret_events").withIndex("by_short_id_at", (q: any) => q.eq("secret_short_id", shortId)).order("desc").take(EVENTS_SHOWN))
        .filter((e) => keys.has(e.workspace));
      if (!evs.length) return row;
    }
    const names = await namesOf(ctx, evs.map((e) => e.actor_user_id));
    const decisions = new Map<string, string | undefined>();
    for (const id of new Set(evs.map((e) => e.decision_id).filter(Boolean).map(String))) {
      decisions.set(id, ((await ctx.db.get(id as Id<"session_decisions">)) as any)?.short_id);
    }
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
      decision_short_id: e.decision_id ? decisions.get(String(e.decision_id)) : undefined,
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
    ...valueFieldValidators,
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
    await recordSecretEvent(ctx, { _id: id, workspace: args.workspace, name: args.name, short_id }, "created", { actor: user_id });
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
    return { id: row._id, workspace: row.workspace, kind: row.kind, name: row.name, value_enc: row.value_enc };
  },
});

export const storeValue = internalMutation({
  args: {
    user_id: v.id("users"),
    id: v.id("secrets"),
    workspace: v.string(),
    value_enc: v.string(),
    ...valueFieldValidators,
    event: v.union(v.literal("rotated"), v.literal("fulfilled"), v.literal("refreshed")),
    // refresh: the updated_at this machine read the row at; a row changed since refuses the write-back.
    expected_updated_at: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.id);
    // The ciphertext is bound to the workspace it was encrypted for; a row
    // that moved or vanished meanwhile must not take it.
    if (!row || row.workspace !== args.workspace) return { error: "The secret changed while saving: try again" };
    if (!(await heldKeysFor(ctx, args.user_id)).has(row.workspace)) return { error: `You can no longer write ${row.name}: ask someone in its team` };
    if (args.expected_updated_at !== undefined && row.updated_at !== args.expected_updated_at) {
      return {
        stale: true as const,
        updated_at: row.updated_at,
        message: `${row.name} changed since this machine read it (a person or another browser wrote it): read it again before writing cookies back`,
      };
    }
    const now = Date.now();
    const wasRequest = row.status === "requested";
    // A sign-in's cookie refresh replaces in place; every other value write keeps the one it replaces.
    if (row.value_enc && args.event !== "refreshed") await keepVersion(ctx, row, args.user_id, now);
    await ctx.db.patch(row._id, {
      value_enc: args.value_enc,
      status: "ready",
      fingerprint: args.fingerprint,
      signin_expires_at: args.signin_expires_at,
      has_otp: args.has_otp,
      updated_by: args.user_id,
      updated_at: now,
      ...(args.event === "rotated" ? { rotated_at: now } : {}),
    });
    await recordSecretEvent(ctx, row, args.event, { actor: args.user_id });
    await bumpRedaction(ctx, row.workspace);
    const delivered = wasRequest && args.event === "fulfilled" ? await deliverReady(ctx, { ...row, status: "ready" }, args.user_id, !!args.has_otp) : false;
    return { id: String(row._id), short_id: row.short_id, name: row.name, delivered, updated_at: now };
  },
});

/** The row's current value as a version, restorable for SECRET_VERSION_TTL_MS. */
async function keepVersion(ctx: any, row: SecretRow, by: Id<"users">, now: number) {
  await ctx.db.insert("secret_versions", {
    secret_id: row._id,
    workspace: row.workspace,
    value_enc: row.value_enc!,
    fingerprint: row.fingerprint,
    signin_expires_at: row.signin_expires_at,
    has_otp: row.has_otp,
    rotated_at: now,
    rotated_by: by,
    expires_at: now + SECRET_VERSION_TTL_MS,
  });
  await ctx.db.patch(row._id, { version_count: (row.version_count ?? 0) + 1 });
}

// The "is ready" line into the session that asked, waking it like a decision
// answer does. A hosted conversation takes input from its owner alone.
async function deliverReady(ctx: any, row: SecretRow, fulfiller: Id<"users">, hasOtp: boolean): Promise<boolean> {
  if (!row.requested_from_conversation) return false;
  const conversation: any = await ctx.db.get(row.requested_from_conversation);
  if (!conversation) return false;
  if (isHostedAgentType(conversation.agent_type) && String(fulfiller) !== String(conversation.user_id)) return false;
  await enqueuePendingMessage(ctx, conversation, fulfiller, {
    content: formatVaultReady({ short_id: row.short_id, name: row.name, kind: row.kind, vars: envFor(row).map((b) => b.var), sites: row.sites, has_otp: hasOtp }),
    client_id: `vault-ready:${String(row._id)}`,
    human: true,
    wake_cause: "approval",
  });
  return true;
}

const LOGIN_FIELDS = ["username", "password", "totp_seed", "url"] as const;

/** A login rotate changes only the fields it names: an absent field keeps its stored value, an empty one clears it. */
function mergeLogin(stored: LoginPayload, raw: unknown): unknown {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return raw;
  const next: Record<string, unknown> = { ...(raw as Record<string, unknown>) };
  for (const k of LOGIN_FIELDS) if (next[k] === undefined && stored[k] !== undefined) next[k] = stored[k];
  return next;
}

async function writeValue(
  ctx: any,
  args: { api_token?: string; ref: string; payload: unknown; expected_updated_at?: number },
  want: "ready" | "requested",
  event: "rotated" | "fulfilled" | "refreshed",
) {
  const userId = await ctx.runQuery(internal.secrets.callerOf, { api_token: args.api_token });
  if (!userId) return { error: "Unauthorized: sign in, or run `cast auth` on this machine" };
  const target = await ctx.runQuery(internal.secrets.valueTarget, { user_id: userId, ref: args.ref, want });
  if ("error" in target) return target;
  let raw = args.payload;
  if (event === "rotated" && target.kind === "login" && target.value_enc) {
    // One that no longer decrypts is replaced whole: rotate is how it gets fixed.
    const stored = await decryptSecret(target.value_enc, target.workspace);
    if (stored) raw = mergeLogin(stored as LoginPayload, raw);
  }
  const checked = validatePayload(target.kind as SecretKind, raw);
  if ("error" in checked) return checked;
  return await ctx.runMutation(internal.secrets.storeValue, {
    user_id: userId,
    id: target.id,
    workspace: target.workspace,
    value_enc: await encryptSecret(checked.payload, target.workspace),
    ...valueFields(target.kind, checked.payload),
    event,
    expected_updated_at: args.expected_updated_at,
  });
}

const valueArgs = { api_token: v.optional(v.string()), ref: v.string(), payload: v.any() };

/** Replace a secret's value; the previous one stays restorable for 7 days. A login keeps the fields the new payload leaves out. */
export const rotate = action({
  args: valueArgs,
  handler: async (ctx, args): Promise<any> => writeValue(ctx, args, "ready", "rotated"),
});

/**
 * A browser wrote a used sign-in's newer cookies back, so the saved session
 * stays alive. `expected_updated_at` is the row's updated_at when this
 * machine read it (cliRead returns it); a row written since answers
 * `{ stale: true, updated_at, message }` and stores nothing. No version is kept.
 */
export const refresh = action({
  args: { ...valueArgs, expected_updated_at: v.optional(v.number()) },
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
    await recordSecretEvent(ctx, { ...row, name: patch.name ?? row.name }, "updated", { actor: userId });
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
    await recordSecretEvent(ctx, row, "deleted", { actor: userId });
    for (const r of await ctx.db.query("secret_versions").withIndex("by_secret", (q) => q.eq("secret_id", row._id)).collect()) await ctx.db.delete(r._id);
    for (const r of await ctx.db.query("secret_approvals").withIndex("by_secret_conversation", (q) => q.eq("secret_id", row._id)).collect()) await ctx.db.delete(r._id);
    await ctx.db.delete(row._id);
    await bumpRedaction(ctx, row.workspace);
    return { removed: true, short_id: row.short_id, name: row.name };
  },
});

/**
 * Ask first on or off. On, an agent's read from a session needs a person's
 * approval for that session (cliRead files the decision); a person's own
 * reveal on the web is never gated. The web's dispatch side effect calls this.
 */
export const setAskFirst = mutation({
  args: { api_token: v.optional(v.string()), ref: v.string(), ask_first: v.boolean() },
  handler: async (ctx, args) => {
    const userId = await requireCaller(ctx, args.api_token);
    const row = await findSecret(ctx, userId, args.ref);
    if ("error" in row) return row;
    if (!!row.ask_first !== args.ask_first) {
      await ctx.db.patch(row._id, { ask_first: args.ask_first, updated_by: userId, updated_at: Date.now() });
      await recordSecretEvent(ctx, row, args.ask_first ? "ask_first_on" : "ask_first_off", { actor: userId });
    }
    return { id: String(row._id), short_id: row.short_id, name: row.name, ask_first: args.ask_first };
  },
});

async function liveVersions(ctx: any, secretId: Id<"secrets">, now: number): Promise<Doc<"secret_versions">[]> {
  const rows: Doc<"secret_versions">[] = await ctx.db.query("secret_versions").withIndex("by_secret", (q: any) => q.eq("secret_id", secretId)).order("desc").collect();
  return rows.filter((r) => r.expires_at > now);
}

/** A secret's previous values, newest first: metadata only. */
export const versions = query({
  args: { api_token: v.optional(v.string()), ref: v.string() },
  handler: async (ctx, args): Promise<SecretVersionMeta[] | { error: string }> => {
    const userId = await requireCaller(ctx, args.api_token);
    const row = await findSecret(ctx, userId, args.ref);
    if ("error" in row) return row;
    const rows = await liveVersions(ctx, row._id, Date.now());
    const names = await namesOf(ctx, rows.map((r) => r.rotated_by));
    return rows.map((r) => ({
      _id: String(r._id),
      rotated_at: r.rotated_at,
      rotated_by_name: names.get(String(r.rotated_by)),
      fingerprint: r.fingerprint,
      expires_at: r.expires_at,
    }));
  },
});

export const restoreVersion = internalMutation({
  args: { user_id: v.id("users"), ref: v.string(), version: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const row = await findSecret(ctx, args.user_id, args.ref);
    if ("error" in row) return row;
    const now = Date.now();
    const kept = await liveVersions(ctx, row._id, now);
    const ver = args.version ? kept.find((k) => String(k._id) === args.version) : kept[0];
    if (!ver) {
      return { error: args.version ? `That version of ${row.name} is gone (versions last 7 days): cast vault versions ${row.name} lists the ones left` : `${row.name} has no earlier value to restore: rotate keeps one for 7 days` };
    }
    if (ver.workspace !== row.workspace || !row.value_enc) return { error: undecryptable(row) };
    // A swap: the current value becomes a version, so a wrong restore is undone the same way.
    await ctx.db.insert("secret_versions", {
      secret_id: row._id,
      workspace: row.workspace,
      value_enc: row.value_enc,
      fingerprint: row.fingerprint,
      signin_expires_at: row.signin_expires_at,
      has_otp: row.has_otp,
      rotated_at: now,
      rotated_by: args.user_id,
      expires_at: now + SECRET_VERSION_TTL_MS,
    });
    await ctx.db.delete(ver._id);
    await ctx.db.patch(row._id, {
      value_enc: ver.value_enc,
      fingerprint: ver.fingerprint,
      signin_expires_at: ver.signin_expires_at,
      has_otp: ver.has_otp,
      updated_by: args.user_id,
      updated_at: now,
      rotated_at: now,
    });
    await recordSecretEvent(ctx, row, "restored", { actor: args.user_id });
    await bumpRedaction(ctx, row.workspace);
    return { id: String(row._id), short_id: row.short_id, name: row.name, restored_from: ver.rotated_at };
  },
});

/** Put a previous value back (the newest, or `version` from `versions`); the value it replaces becomes a version. */
export const restore = action({
  args: { api_token: v.optional(v.string()), ref: v.string(), version: v.optional(v.string()) },
  handler: async (ctx, args): Promise<{ id: string; short_id: string; name: string; restored_from: number } | { error: string }> => {
    const userId = await ctx.runQuery(internal.secrets.callerOf, { api_token: args.api_token });
    if (!userId) return { error: "Unauthorized: sign in, or run `cast auth` on this machine" };
    return await ctx.runMutation(internal.secrets.restoreVersion, { user_id: userId, ref: args.ref, version: args.version });
  },
});

/** Versions past their 7 days (crons.ts), a page at a time. */
export const purgeExpiredVersions = internalMutation({
  args: {},
  handler: async (ctx) => {
    const expired = await ctx.db.query("secret_versions").withIndex("by_expires_at", (q: any) => q.lte("expires_at", Date.now())).take(200);
    for (const ver of expired) {
      await ctx.db.delete(ver._id);
      const row = await ctx.db.get(ver.secret_id);
      if (row) await ctx.db.patch(row._id, { version_count: Math.max(0, (row.version_count ?? 1) - 1) });
    }
    if (expired.length === 200) await ctx.scheduler.runAfter(5_000, internal.secrets.purgeExpiredVersions, {});
    return { purged: expired.length };
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
    await recordSecretEvent(ctx, row, "requested", { actor: userId, conversation_id: conversation?._id });
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

/**
 * Save sign-in "From my Chrome": ask one of the person's online laptops to
 * read a site's cookies out of their Chrome and store them here itself (the
 * `vault_capture_signin` daemon command, secrets/signinCommand.ts). Only the
 * site, the name and the workspace go through this row; the cookies go from
 * that laptop into the encrypted secret, and the outcome comes back on the
 * command (users.getCommandResult). Never parked on an offline laptop, the
 * way a browser carry is not (cloud.pickOnlineLocalDevice).
 */
export const requestSigninCapture = mutation({
  args: { site: v.string(), name: v.optional(v.string()), device_id: v.string(), ...workspaceArgs },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return { error: "Sign in to codecast to save a sign-in" };
    const site = cleanSecretSites([args.site])?.[0];
    if (!site || /\s/.test(site)) return { error: "Name the site like github.com" };
    const name = args.name?.trim() || undefined;
    if (name) {
      const p = secretNameProblem(name);
      if (p) return { error: p };
    }
    const where = await writeKey(ctx, userId, args);
    if ("error" in where) return where;
    const devices = await ctx.db.query("devices").withIndex("by_user_id", (q: any) => q.eq("user_id", userId)).collect();
    const laptop = pickOnlineLocalDevice(devices as any, Date.now(), args.device_id);
    if (!laptop) return { error: "That laptop is not online: wake it or pick another, or sign in through the agent browser" };
    const command_id = await ctx.db.insert("daemon_commands", {
      user_id: userId,
      command: "vault_capture_signin" as const,
      args: JSON.stringify({ site, ...(name ? { name } : {}), ...(where.team_id ? { team_id: where.team_id } : { personal: true }) }),
      created_at: Date.now(),
      target_device_id: laptop.device_id,
    });
    return { command_id, device_id: laptop.device_id, label: laptop.label };
  },
});

// ── Values out ───────────────────────────────────────────────────────────────

export const readTargets = internalQuery({
  args: { user_id: v.id("users"), refs: v.array(v.string()), conversation: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const rows: { id: Id<"secrets">; short_id: string; name: string; kind: SecretKind; workspace: string; value_enc: string; env?: string[]; sites?: string[]; updated_at: number }[] = [];
    for (const ref of args.refs) {
      const row = await findSecret(ctx, args.user_id, ref);
      if ("error" in row) return row;
      if (row.status !== "ready" || !row.value_enc) {
        return { error: `${row.name} has no value yet (${row.short_id} is a request): wait for a person to fill it on the Vault page` };
      }
      rows.push({ id: row._id, short_id: row.short_id, name: row.name, kind: row.kind, workspace: row.workspace, value_enc: row.value_enc, env: row.env, sites: row.sites, updated_at: row.updated_at });
    }
    const conversation = await resolveConversation(ctx, args.user_id, args.conversation);
    return { rows, conversation_id: conversation?._id };
  },
});

const PURPOSE_PHRASE: Record<SecretReadPurpose, string> = {
  get: "read it",
  run: "run a command with it",
  env: "export it into a shell",
  otp: "make a 2FA code",
  signin: "sign in",
};

/**
 * Ask first: every gated secret of an agent's read needs an approval for
 * that conversation. Without one, a decision is filed on the conversation
 * (or the open one reused) and the read answers with it instead of values.
 * Only the conversation's owner reads under its approval, so naming someone
 * else's approved session lends nothing.
 */
async function askFirstGate(
  ctx: any,
  userId: Id<"users">,
  rows: SecretRow[],
  conversationId: Id<"conversations"> | undefined,
  purpose: SecretReadPurpose,
  why: string | undefined,
): Promise<SecretNeedsApproval | { error: string } | null> {
  const gated = rows.filter((r) => r.ask_first);
  if (!gated.length) return null;
  const conversation: any = conversationId ? await ctx.db.get(conversationId) : null;
  if (!conversation || !conversation.session_id || String(conversation.user_id) !== String(userId)) {
    return { error: `${gated[0].name} is Ask first: a person approves each session's use, so read it from inside your own agent session` };
  }
  const now = Date.now();
  const approvals: { decision: string; secret: string }[] = [];
  for (const row of gated) {
    const existing = await ctx.db
      .query("secret_approvals")
      .withIndex("by_secret_conversation", (q: any) => q.eq("secret_id", row._id).eq("conversation_id", conversation._id))
      .first();
    if (existing?.status === "approved") continue;
    const open = existing?.status === "pending" ? await ctx.db.get(existing.decision_id) : null;
    if (open?.status === "pending") {
      approvals.push({ decision: open.short_id, secret: row.name });
      continue;
    }
    const doing = why?.trim() || (purpose === "signin" && row.sites?.[0] ? `sign in to ${row.sites[0]}` : PURPOSE_PHRASE[purpose]);
    const asked = await askCore(ctx, { userId: conversation.user_id }, {
      session_id: conversation.session_id,
      question: `${conversation.title || conversation.short_id || "A session"} wants ${row.name} to ${doing}`,
      options: [{ label: APPROVE_FOR_SESSION }, { label: DENY }],
      context_md: `${row.name} (${row.short_id}) is Ask first in the Vault. Approve lets this session read it until the session ends.`,
      category: "access",
      blocking: true,
    });
    if (asked?.error) return { error: `Could not ask for ${row.name}: ${asked.error}` };
    const fields = { decision_id: asked.id, status: "pending" as const, approved_by: undefined, at: now };
    if (existing) await ctx.db.patch(existing._id, fields);
    else await ctx.db.insert("secret_approvals", { secret_id: row._id, workspace: row.workspace, conversation_id: conversation._id, ...fields });
    await recordSecretEvent(ctx, row, "approval_requested", { actor: userId, conversation_id: conversation._id, purpose, decision_id: asked.id });
    approvals.push({ decision: asked.short_id, secret: row.name });
  }
  if (!approvals.length) return null;
  const ids = approvals.map((a) => a.decision).join(", ");
  const names = approvals.map((a) => a.secret).join(", ");
  return {
    needs_approval: approvals[0],
    approvals,
    message: `${names} ${approvals.length > 1 ? "are" : "is"} Ask first: a person approves this session in ${ids}. End your turn dormant naming ${ids}; the answer wakes you, then run the same command again.`,
  };
}

export const recordReads = internalMutation({
  args: {
    user_id: v.id("users"),
    ids: v.array(v.id("secrets")),
    kind: v.union(v.literal("read"), v.literal("revealed")),
    conversation_id: v.optional(v.id("conversations")),
    purpose: v.optional(purposeValidator),
    why: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<SecretNeedsApproval | { error: string } | null> => {
    if (args.kind === "read") {
      const rows = (await Promise.all(args.ids.map((id) => ctx.db.get(id)))).filter((r): r is SecretRow => !!r);
      const held = await askFirstGate(ctx, args.user_id, rows, args.conversation_id, args.purpose ?? "get", args.why);
      if (held) return held;
    }
    const now = Date.now();
    for (const id of args.ids) {
      const row = await ctx.db.get(id);
      if (!row) continue;
      // A browser's read of a saved sign-in is the moment an agent was signed in with it.
      const kind = args.kind === "read" && args.purpose === "signin" ? "signed_in" : args.kind;
      await recordSecretEvent(ctx, row, kind, { actor: args.user_id, conversation_id: args.conversation_id, purpose: args.purpose });
      if (args.kind === "read") {
        await ctx.db.patch(row._id, { last_used_at: now, last_used_by_conversation: args.conversation_id, use_count: (row.use_count ?? 0) + 1 });
      }
    }
    return null;
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
 * its use, before any value is returned. An Ask first secret this session has
 * no approval for answers `SecretNeedsApproval` instead (no values at all),
 * with the decision a person answers; `why` words that decision's question.
 */
export const cliRead = action({
  args: {
    api_token: v.string(),
    refs: v.array(v.string()),
    conversation: v.optional(v.string()),
    purpose: purposeValidator,
    why: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<any> => {
    const userId = await ctx.runQuery(internal.secrets.callerOf, { api_token: args.api_token });
    if (!userId) return { error: "Unauthorized: run `cast auth` on this machine" };
    const refs = [...new Set(args.refs.map((r) => r.trim()).filter(Boolean))];
    if (!refs.length) return { error: "Name the secrets to read: cast vault lists them" };
    if (refs.length > MAX_LIST) return { error: `Read at most ${MAX_LIST} secrets at once` };
    const got = await ctx.runQuery(internal.secrets.readTargets, { user_id: userId, refs, conversation: args.conversation });
    if ("error" in got) return got;
    const held = await ctx.runMutation(internal.secrets.recordReads, {
      user_id: userId,
      ids: got.rows.map((r) => r.id),
      kind: "read",
      conversation_id: got.conversation_id,
      purpose: args.purpose,
      why: args.why,
    });
    if (held) return held;
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
        // A sign-in's write-back passes this to refresh as expected_updated_at.
        updated_at: r.updated_at,
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

/** One redaction_sync event per workspace per fetch: how many values went to the caller's daemon. */
export const recordRedactionSync = internalMutation({
  args: { user_id: v.id("users"), counts: v.array(v.object({ workspace: v.string(), count: v.number() })) },
  handler: async (ctx, args) => {
    const at = Date.now();
    for (const { workspace, count } of args.counts) {
      await ctx.db.insert("secret_events", { workspace, kind: "redaction_sync", actor_user_id: args.user_id, count, at });
    }
  },
});

/**
 * Every value the caller can read, flattened for the daemon's known-value
 * redaction (memory only), with the version it matches. Not an agent's read:
 * nothing is recorded per secret, since the daemon refetches on every
 * version change and the values never reach a session; each fetch records
 * one redaction_sync per workspace instead.
 */
export const redactionValues = action({
  args: { api_token: v.string() },
  handler: async (ctx, args): Promise<{ version: string; values: { name: string; value: string }[] } | { error: string }> => {
    const userId = await ctx.runQuery(internal.secrets.callerOf, { api_token: args.api_token });
    if (!userId) return { error: "Unauthorized: run `cast auth` on this machine" };
    const got = await ctx.runQuery(internal.secrets.redactionRows, { user_id: userId });
    const values: { name: string; value: string }[] = [];
    const counts = new Map<string, number>();
    for (const row of got.rows) {
      const payload = await decryptSecret(row.value_enc, row.workspace);
      if (!payload) continue;
      const found = redactionValuesOf(row.kind, payload);
      for (const value of found) values.push({ name: row.name, value });
      counts.set(row.workspace, (counts.get(row.workspace) ?? 0) + found.length);
    }
    if (counts.size) {
      await ctx.runMutation(internal.secrets.recordRedactionSync, { user_id: userId, counts: [...counts].map(([workspace, count]) => ({ workspace, count })) });
    }
    return { version: got.version, values };
  },
});
