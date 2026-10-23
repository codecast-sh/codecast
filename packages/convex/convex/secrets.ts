// Vault (docs/architecture/vault.md): the team's keys, logins, files and
// saved browser sign-ins, readable by every member and their agents, or by
// one person when personal.
//
// One handler set serves the web (session auth) and the CLI (api_token) the
// way agentDefinitions does. Rows are workspace scoped: reads are one equality
// per held key (heldKeysFor), and a write names its workspace (a team or
// personal), never a guess. The payload is encrypted under the deployment's
// connection key with the workspace in the HKDF info, so a ciphertext bound to
// one workspace fails to decrypt anywhere else, and it is kept in
// secret_values, apart from the row, so a metadata read never loads it. No
// query returns it: values
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
import { connectionKey } from "./tokenConnectors";
import { nextShortId } from "./counters";
import { emitNotification } from "./notificationRouter";
import { askCore, peopleFor, withdrawCore } from "./sessionDecisions";
import { APPROVE_FOR_SESSION, DENY, bumpRedaction, recordSecretEvent, redactionCounter } from "./lib/secretApprovals";
import { displayName } from "./lib/displayNames";
import { findConversationByAnyRefWhere } from "./conversationSessionLookup";
import { isConversationOwner } from "./privacy";
import { pickOnlineLocalDevice } from "./cloud";
import { isConvexId } from "@codecast/shared/entities";
import {
  cleanSecretList,
  cleanSecretSites,
  compareSecrets,
  siteProblem,
  ambiguousSecretName,
  envFor,
  envNameProblem,
  payloadFingerprint,
  pickSecretByName,
  redactionValuesOf,
  secretEnvProblem,
  secretNameProblem,
  signinExpiresAt,
  signinScopeProblem,
  validatePayload,
  SECRET_APPROVAL_TTL_MS,
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
import { formatVaultDeclined, formatVaultReady, isHostedAgentType } from "@codecast/shared/contracts";

type SecretRow = Doc<"secrets">;

const kindValidator = v.union(v.literal("key"), v.literal("login"), v.literal("signin"), v.literal("file"));
const purposeValidator = v.union(v.literal("get"), v.literal("run"), v.literal("env"), v.literal("otp"), v.literal("signin"));

/** Where a write lands: a team (membership checked) or the caller's personal workspace. Exactly one. */
const workspaceArgs = { team_id: v.optional(v.id("teams")), personal: v.optional(v.boolean()) };

const HKDF_PREFIX = "codecast-secret-v1:";
const MAX_NOTE = 2000;
const MAX_LIST = 32;
const EVENTS_SHOWN = 50;

const deploymentKey = () => connectionKey("Vault");

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
 * workspaces. A ref shaped like an id that finds nothing is tried as a name
 * (a name stored before secretNameProblem refused that shape). A name the
 * viewer holds in more than one workspace resolves by pickSecretByName:
 * `prefer` (the repo profile's workspace) or `status` settles it, else it is
 * refused with the short ids that tell the rows apart, for a read and a write
 * alike, so a team repo never reads or rewrites a person's own secret of the
 * same name.
 */
async function findSecret(
  ctx: any,
  userId: Id<"users">,
  ref: string,
  opts: { prefer?: string; status?: SecretRow["status"] } = {},
): Promise<SecretRow | { error: string }> {
  const r = ref.trim();
  const keys = await heldKeysFor(ctx, userId);
  let row: SecretRow | null = null;
  if (/^sec-\d+$/i.test(r)) row = await ctx.db.query("secrets").withIndex("by_short_id", (q: any) => q.eq("short_id", r.toLowerCase())).first();
  else if (isConvexId(r)) {
    const id = ctx.db.normalizeId("secrets", r);
    row = id ? await ctx.db.get(id) : null;
  }
  if (!row || !keys.has(row.workspace)) {
    const found: SecretRow[] = [];
    for (const key of keys) {
      const hit = await byName(ctx, key, r);
      if (hit) found.push(hit);
    }
    const picked = pickSecretByName(found, r, opts);
    if (picked && "ambiguous" in picked) return { error: ambiguousSecretName(r, picked.ambiguous) };
    row = picked;
  }
  if (!row) return { error: `No secret ${r} that you can read: cast vault lists them, and cast vault request ${r} asks a person for it` };
  return row;
}

/**
 * The session a request or a read names, when the caller owns it; else none.
 * A teammate's shared session is viewable, never the caller's to act from:
 * naming it would wake it with a "human" line, notify its people and put the
 * read on its record.
 */
async function resolveConversation(ctx: any, userId: Id<"users">, ref?: string): Promise<Doc<"conversations"> | null> {
  if (!ref) return null;
  return (await findConversationByAnyRefWhere(ctx, ref, (c: any) => isConversationOwner(ctx, userId, c))) as any;
}

// ── Values (secret_values) ───────────────────────────────────────────────────

/** Where a value's ciphertext is: its secret_values row, or inline on a row written before the split (LEGACY, moveValuesOut). */
type ValueRef = { value_id?: Id<"secret_values">; value_enc?: string };

const hasValue = (h: ValueRef) => !!(h.value_id || h.value_enc);

/** What an action carries to load a value later: the id, or the legacy inline ciphertext when there is none. */
const valueRefOf = (h: ValueRef): ValueRef => (h.value_id ? { value_id: h.value_id } : { value_enc: h.value_enc });

/** A holder's value as a secret_values row, moving a legacy inline ciphertext there first. */
async function valueIdOf(ctx: any, secret: { _id: Id<"secrets">; workspace: string }, h: ValueRef): Promise<Id<"secret_values"> | undefined> {
  if (h.value_id) return h.value_id;
  if (!h.value_enc) return undefined;
  return await ctx.db.insert("secret_values", { secret_id: secret._id, workspace: secret.workspace, value_enc: h.value_enc });
}

export const ciphertexts = internalQuery({
  args: { ids: v.array(v.id("secret_values")) },
  handler: async (ctx, args) => await Promise.all(args.ids.map(async (id) => (await ctx.db.get(id))?.value_enc ?? null)),
});

// A value runs to SECRET_PAYLOAD_MAX before encryption, so a handful per query
// keeps each read far under Convex's 16 MiB cap.
const CIPHER_BATCH = 8;

/** The ciphertexts refs point at, in order (null for one that is gone), read a batch per query. */
async function loadCiphertexts(ctx: any, refs: ValueRef[]): Promise<(string | null)[]> {
  const out = refs.map((r) => (r.value_id ? null : r.value_enc ?? null));
  const ids = refs.flatMap((r, i) => (r.value_id ? [[i, r.value_id] as const] : []));
  for (let i = 0; i < ids.length; i += CIPHER_BATCH) {
    const chunk = ids.slice(i, i + CIPHER_BATCH);
    const got: (string | null)[] = await ctx.runQuery(internal.secrets.ciphertexts, { ids: chunk.map(([, id]) => id) });
    chunk.forEach(([at], k) => { out[at] = got[k]; });
  }
  return out;
}

// ── Ask first approvals ──────────────────────────────────────────────────────

/** An approval lets its session read while the session is active, for SECRET_APPROVAL_TTL_MS at most. */
const approvalHolds = (a: Doc<"secret_approvals"> | null | undefined, conversation: any, now: number) =>
  a?.status === "approved" && now - a.at < SECRET_APPROVAL_TTL_MS && conversation?.status === "active";

/**
 * Drop a secret's approvals. After a new value, the approved ones: a person
 * approved the value they knew. When Ask first is switched or the secret
 * goes, every one, and a decision still open is withdrawn with `reason`, so
 * the queue keeps nothing that can no longer do anything.
 */
async function clearApprovals(ctx: any, row: SecretRow, which: "approved" | "all", reason = "") {
  const now = Date.now();
  for (const a of await ctx.db.query("secret_approvals").withIndex("by_secret_conversation", (q: any) => q.eq("secret_id", row._id)).collect()) {
    if (which === "approved" && a.status !== "approved") continue;
    // Deleted before the withdraw, so its settle finds no approval to mark denied.
    await ctx.db.delete(a._id);
    if (a.status !== "pending") continue;
    const decision = await ctx.db.get(a.decision_id);
    if (decision?.status === "pending") await withdrawCore(ctx, decision, now, undefined, reason);
  }
}

// ── Bookkeeping ──────────────────────────────────────────────────────────────

/** The version of a row's value a write-back names; a row stored before value_updated_at existed falls back to updated_at. */
const valueVersion = (row: SecretRow) => row.value_updated_at ?? row.updated_at;

/** The version a new value gets: the time, but always past the one it replaces, so two writes in one millisecond still differ. */
const nextValueVersion = (row: SecretRow, now: number) => Math.max(now, valueVersion(row) + 1);

/**
 * The fields a metadata write patches: who and when, for display. A row from
 * before value_updated_at gets it pinned first, so the edit does not look like
 * a new value to a machine about to write a sign-in back.
 */
const metaStamp = (row: SecretRow, by: Id<"users">) => ({ updated_by: by, updated_at: Date.now(), value_updated_at: valueVersion(row) });

async function redactionVersionFor(ctx: any, userId: Id<"users">): Promise<string> {
  const parts: string[] = [];
  for (const key of [...(await heldKeysFor(ctx, userId))].sort()) {
    const row = await ctx.db.query("counters").withIndex("by_name", (q: any) => q.eq("name", redactionCounter(key))).unique();
    parts.push(`${key}=${row?.value ?? 0}`);
  }
  return parts.join(",");
}

/** With `kind`, the vars the secret would inject (named, or derived from its name) are checked too (secretEnvProblem). */
function metaProblem(fields: { name?: string; kind?: SecretKind; env?: string[]; note?: string; sites?: string[] }): string | null {
  if (fields.name !== undefined) {
    const p = secretNameProblem(fields.name);
    if (p) return p;
  }
  for (const e of fields.env ?? []) {
    const p = envNameProblem(e);
    if (p) return p;
  }
  if (fields.name !== undefined && fields.kind) {
    const p = secretEnvProblem({ name: fields.name, kind: fields.kind, env: fields.env });
    if (p) return p;
  }
  if ((fields.note?.length ?? 0) > MAX_NOTE) return `A note holds at most ${MAX_NOTE} characters: keep the details in a doc and link it`;
  for (const site of fields.sites ?? []) {
    const p = siteProblem(site);
    if (p) return p;
  }
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
    value_updated_at: valueVersion(row),
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
      .sort(compareSecrets)
      .map((r) => metaOf(r, names));
  },
});

/** One secret's metadata (`cast vault show`). `status` settles a name in several workspaces the way a fill does (`cast vault fill` asks for the request). */
export const show = query({
  args: { api_token: v.optional(v.string()), ref: v.string(), status: v.optional(v.union(v.literal("ready"), v.literal("requested"))) },
  handler: async (ctx, args): Promise<SecretMeta | { error: string }> => {
    const userId = await requireCaller(ctx, args.api_token);
    const row = await findSecret(ctx, userId, args.ref, { status: args.status });
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
    const { user_id, value_enc, ...fields } = args;
    const short_id = await nextShortId(ctx.db as any, "sec");
    const id = await ctx.db.insert("secrets", { ...fields, short_id, status: "ready", created_by: user_id, created_at: now, updated_by: user_id, updated_at: now, value_updated_at: now } as any);
    await ctx.db.patch(id, { value_id: await valueIdOf(ctx, { _id: id, workspace: args.workspace }, { value_enc }) });
    await recordSecretEvent(ctx, { _id: id, workspace: args.workspace, name: args.name, short_id }, "created", { actor: user_id });
    await bumpRedaction(ctx, args.workspace);
    return { id: String(id), short_id, name: args.name, value_updated_at: now };
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
  handler: async (ctx, args): Promise<{ id: string; short_id: string; name: string; value_updated_at: number } | { error: string }> => {
    const userId = await ctx.runQuery(internal.secrets.callerOf, { api_token: args.api_token });
    if (!userId) return { error: "Unauthorized: sign in, or run `cast auth` on this machine" };
    const name = args.name.trim();
    const env = cleanSecretList(args.env);
    const sites = cleanSecretSites(args.sites);
    const note = args.note?.trim() || undefined;
    const problem = metaProblem({ name, kind: args.kind, env, sites, note });
    if (problem) return { error: problem };
    const checked = validatePayload(args.kind as SecretKind, args.payload);
    if ("error" in checked) return checked;
    if (args.kind === "signin") {
      const outside = signinScopeProblem(checked.payload as SigninPayload, sites);
      if (outside) return { error: outside };
    }
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

const alreadyFilled = (row: SecretRow) => `${row.name} already has a value: replace it with cast vault rotate ${row.name}`;

/** The row an action is about to write a value into, checked for access. */
export const valueTarget = internalQuery({
  args: { user_id: v.id("users"), ref: v.string(), want: v.union(v.literal("ready"), v.literal("requested")) },
  handler: async (ctx, args) => {
    // A fill means the request: of one name in two workspaces, the requested row.
    const row = await findSecret(ctx, args.user_id, args.ref, args.want === "requested" ? { status: "requested" } : {});
    if ("error" in row) return row;
    if (row.status !== args.want) {
      return { error: args.want === "ready" ? `${row.name} has no value yet (${row.short_id} is a request): fill it with cast vault fulfill ${row.name}` : alreadyFilled(row) };
    }
    return { id: row._id, workspace: row.workspace, kind: row.kind, name: row.name, sites: row.sites, value_updated_at: valueVersion(row), ...valueRefOf(row) };
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
    // refresh: the value_updated_at this machine read the row at; a value written since refuses the write-back.
    // A login rotate passes the version it merged from, so a write in between is merged again rather than lost.
    expected_updated_at: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.id);
    // The ciphertext is bound to the workspace it was encrypted for; a row
    // that moved or vanished meanwhile must not take it.
    if (!row || row.workspace !== args.workspace) return { error: "The secret changed while saving: try again" };
    if (!(await heldKeysFor(ctx, args.user_id)).has(row.workspace)) return { error: `You can no longer write ${row.name}: ask someone in its team` };
    // A refresh names the value it read; naming none is as stale as naming an old one, so a blind overwrite never lands.
    if ((args.event === "refreshed" || args.expected_updated_at !== undefined) && valueVersion(row) !== args.expected_updated_at) {
      return {
        stale: true as const,
        value_updated_at: valueVersion(row),
        message: `${row.name} changed since this machine read it (a person or another browser wrote it): read it again before writing cookies back`,
      };
    }
    // A fill is the request's: a second fill that read the row while it was
    // still a request lands after the first, and would replace its value and
    // record a second fill.
    if (args.event === "fulfilled" && row.status !== "requested") return { error: alreadyFilled(row) };
    const now = Date.now();
    const version = nextValueVersion(row, now);
    const wasRequest = row.status === "requested";
    // A sign-in's cookie refresh replaces in place; every other value write
    // keeps the one it replaces, and ends the approvals given for it.
    let value_id = row.value_id;
    if (args.event === "refreshed" && value_id) await ctx.db.patch(value_id, { value_enc: args.value_enc });
    else {
      if (args.event !== "refreshed" && hasValue(row)) {
        await keepVersion(ctx, row, args.user_id, now);
        await clearApprovals(ctx, row, "approved");
      }
      value_id = await valueIdOf(ctx, row, { value_enc: args.value_enc });
    }
    await ctx.db.patch(row._id, {
      value_id,
      value_enc: undefined,
      status: "ready",
      fingerprint: args.fingerprint,
      signin_expires_at: args.signin_expires_at,
      has_otp: args.has_otp,
      updated_by: args.user_id,
      updated_at: now,
      value_updated_at: version,
      ...(args.event === "rotated" ? { rotated_at: now } : {}),
    });
    await recordSecretEvent(ctx, row, args.event, { actor: args.user_id });
    await bumpRedaction(ctx, row.workspace);
    const delivered = wasRequest && args.event === "fulfilled" ? await deliverReady(ctx, { ...row, status: "ready" }, args.user_id, !!args.has_otp) : false;
    return { id: String(row._id), short_id: row.short_id, name: row.name, delivered, value_updated_at: version };
  },
});

/** The row's current value as a version, restorable for SECRET_VERSION_TTL_MS. */
async function keepVersion(ctx: any, row: SecretRow, by: Id<"users">, now: number) {
  await ctx.db.insert("secret_versions", {
    secret_id: row._id,
    workspace: row.workspace,
    value_id: await valueIdOf(ctx, row, row),
    fingerprint: row.fingerprint,
    signin_expires_at: row.signin_expires_at,
    has_otp: row.has_otp,
    rotated_at: now,
    rotated_by: by,
    expires_at: now + SECRET_VERSION_TTL_MS,
  });
  await ctx.db.patch(row._id, { version_count: (row.version_count ?? 0) + 1 });
}

/** Every session that asked for a requested secret, the first asker first. */
const askersOf = (row: SecretRow): Id<"conversations">[] =>
  [...new Set([row.requested_from_conversation, ...(row.also_requested_from ?? [])].filter((c): c is Id<"conversations"> => !!c))];

// A line from a person into every session that asked, waking each like a
// decision answer does. A hosted conversation takes input from its owner alone.
async function tellAskers(ctx: any, row: SecretRow, from: Id<"users">, content: string, clientId: string): Promise<boolean> {
  let delivered = false;
  for (const id of askersOf(row)) {
    const conversation: any = await ctx.db.get(id);
    if (!conversation) continue;
    if (isHostedAgentType(conversation.agent_type) && String(from) !== String(conversation.user_id)) continue;
    await enqueuePendingMessage(ctx, conversation, from, { content, client_id: clientId, human: true, wake_cause: "approval" });
    delivered = true;
  }
  return delivered;
}

const deliverReady = (ctx: any, row: SecretRow, fulfiller: Id<"users">, hasOtp: boolean) =>
  tellAskers(ctx, row, fulfiller, formatVaultReady({ short_id: row.short_id, name: row.name, kind: row.kind, vars: envFor(row).map((b) => b.var), sites: row.sites, has_otp: hasOtp }), `vault-ready:${String(row._id)}`);

const LOGIN_FIELDS = ["username", "password", "totp_seed", "url"] as const;

/** A login rotate changes only the fields it names: an absent field keeps its stored value, an empty one clears it. */
function mergeLogin(stored: LoginPayload, raw: unknown): unknown {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return raw;
  const next: Record<string, unknown> = { ...(raw as Record<string, unknown>) };
  for (const k of LOGIN_FIELDS) if (next[k] === undefined && stored[k] !== undefined) next[k] = stored[k];
  return next;
}

/** How many times a login rotate merges again after another write landed between its read and its write. */
const MERGE_ATTEMPTS = 3;

async function writeValue(
  ctx: any,
  args: { api_token?: string; ref: string; payload: unknown; expected_updated_at?: number },
  want: "ready" | "requested",
  event: "rotated" | "fulfilled" | "refreshed",
) {
  const userId = await ctx.runQuery(internal.secrets.callerOf, { api_token: args.api_token });
  if (!userId) return { error: "Unauthorized: sign in, or run `cast auth` on this machine" };
  for (let attempt = 1; ; attempt++) {
    const target = await ctx.runQuery(internal.secrets.valueTarget, { user_id: userId, ref: args.ref, want });
    if ("error" in target) return target;
    // A refresh keeps no version, so it is only ever a sign-in's cookie upkeep; a new value for anything else is a rotate.
    if (event === "refreshed" && target.kind !== "signin") {
      return { error: `${target.name} is a ${target.kind}, and refresh only writes a saved sign-in's cookies back: replace its value with cast vault rotate ${target.name}, which keeps the old one for 7 days` };
    }
    let raw = args.payload;
    // A merged login is written only over the value it merged from.
    let expected = args.expected_updated_at;
    if (event === "rotated" && target.kind === "login" && hasValue(target)) {
      // One that no longer decrypts is replaced whole: rotate is how it gets fixed.
      const [enc] = await loadCiphertexts(ctx, [target]);
      const stored = enc ? await decryptSecret(enc, target.workspace) : null;
      if (stored) {
        raw = mergeLogin(stored as LoginPayload, raw);
        expected = target.value_updated_at;
      }
    }
    const checked = validatePayload(target.kind as SecretKind, raw);
    if ("error" in checked) return checked;
    if (target.kind === "signin") {
      const outside = signinScopeProblem(checked.payload as SigninPayload, target.sites);
      if (outside) return { error: outside };
    }
    const res = await ctx.runMutation(internal.secrets.storeValue, {
      user_id: userId,
      id: target.id,
      workspace: target.workspace,
      value_enc: await encryptSecret(checked.payload, target.workspace),
      ...valueFields(target.kind, checked.payload),
      event,
      expected_updated_at: expected,
    });
    if (!res.stale || event !== "rotated") return res;
    if (attempt === MERGE_ATTEMPTS) return { error: `${target.name} kept changing while saving: try again` };
  }
}

const valueArgs = { api_token: v.optional(v.string()), ref: v.string(), payload: v.any() };

/** Replace a secret's value; the previous one stays restorable for 7 days. A login keeps the fields the new payload leaves out. */
export const rotate = action({
  args: valueArgs,
  handler: async (ctx, args): Promise<any> => writeValue(ctx, args, "ready", "rotated"),
});

/**
 * A browser wrote a used sign-in's newer cookies back, so the saved session
 * stays alive. `expected_updated_at` is the row's value_updated_at when this
 * machine read it (cliRead returns it); a value written since, or no
 * expected_updated_at at all, answers `{ stale: true, value_updated_at,
 * message }` and stores nothing. A metadata edit (a note, Ask first) moves
 * updated_at only, so it never makes a write-back stale. No version is kept,
 * so only a ready sign-in takes one: any other kind is refused toward rotate.
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
    // A saved sign-in's next write-back captures the browser's cookies for every
    // site it names, so a site added to one is a person's call, never a token's.
    const widens = patch.sites?.some((s) => !row.sites?.includes(s));
    if (widens && row.kind === "signin" && row.status === "ready" && !(await getAuthUserId(ctx))) {
      return { error: `Only a person adds a site to a saved sign-in: add it in ${row.name}'s panel on the Vault page, or save a sign-in for that site with cast vault save-signin` };
    }
    const problem = metaProblem({ name: patch.name, env: patch.env, sites: patch.sites, note: patch.note })
      ?? secretEnvProblem({ name: patch.name ?? row.name, kind: row.kind, env: "env" in patch ? patch.env : row.env });
    if (problem) return { error: problem };
    if (patch.name && patch.name !== row.name) {
      const twin = await byName(ctx, row.workspace, patch.name);
      if (twin) return { error: `${patch.name} is already taken here (${twin.short_id}): pick another name, or remove that one first` };
    }
    await ctx.db.patch(row._id, { ...patch, ...metaStamp(row, userId) });
    // Redaction markers carry the name, so daemons fetch the values again.
    if (patch.name && patch.name !== row.name) await bumpRedaction(ctx, row.workspace);
    await recordSecretEvent(ctx, { ...row, name: patch.name ?? row.name }, "updated", { actor: userId });
    return { id: String(row._id), short_id: row.short_id, name: patch.name ?? row.name };
  },
});

/** Delete a secret, or decline an open request: the sessions that asked are told no and wake. Its events stay, carrying its name. */
export const remove = mutation({
  args: { api_token: v.optional(v.string()), ref: v.string() },
  handler: async (ctx, args) => {
    const userId = await requireCaller(ctx, args.api_token);
    const row = await findSecret(ctx, userId, args.ref);
    if ("error" in row) return row;
    if (row.status === "requested") await tellAskers(ctx, row, userId, formatVaultDeclined(row.name), `vault-declined:${String(row._id)}`);
    await recordSecretEvent(ctx, row, "deleted", { actor: userId });
    for (const r of await ctx.db.query("secret_versions").withIndex("by_secret", (q) => q.eq("secret_id", row._id)).collect()) await ctx.db.delete(r._id);
    for (const r of await ctx.db.query("secret_values").withIndex("by_secret", (q) => q.eq("secret_id", row._id)).collect()) await ctx.db.delete(r._id);
    await clearApprovals(ctx, row, "all", `${row.name} was removed from the Vault`);
    await ctx.db.delete(row._id);
    await bumpRedaction(ctx, row.workspace);
    return { removed: true, short_id: row.short_id, name: row.name };
  },
});

/**
 * Ask first on or off. On, an agent's read from a session needs a person's
 * approval for that session (cliRead files the decision); a person's own
 * reveal on the web is never gated. Anyone may turn it on, a token included;
 * turning it off takes a person signed in to the app, since an api token is
 * what the gated agent itself holds. The web's dispatch side effect calls this.
 */
export const setAskFirst = mutation({
  args: { api_token: v.optional(v.string()), ref: v.string(), ask_first: v.boolean() },
  handler: async (ctx, args) => {
    const userId = args.ask_first ? await requireCaller(ctx, args.api_token) : await getAuthUserId(ctx);
    if (!userId) return { error: "Only a person turns Ask first off: switch it off in the secret's panel on the Vault page" };
    const row = await findSecret(ctx, userId, args.ref);
    if ("error" in row) return row;
    if (!!row.ask_first !== args.ask_first) {
      await ctx.db.patch(row._id, { ask_first: args.ask_first, ...metaStamp(row, userId) });
      await recordSecretEvent(ctx, row, args.ask_first ? "ask_first_on" : "ask_first_off", { actor: userId });
      // Switched either way, earlier approvals end: re-armed, every session asks afresh.
      await clearApprovals(ctx, row, "all", args.ask_first ? `${row.name} was set to Ask first again: read it again to ask afresh` : `${row.name} is no longer Ask first: read it again`);
      // The daemon feed holds an Ask first value only after an approval, so the switch changes what it holds.
      await bumpRedaction(ctx, row.workspace);
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
      return { error: args.version ? `That version of ${row.name} is gone (versions last 7 days): cast vault restore ${row.name} lists the ones left` : `${row.name} has no earlier value to restore: rotate keeps one for 7 days` };
    }
    if (ver.workspace !== row.workspace || !hasValue(row)) return { error: undecryptable(row) };
    // A swap: the current value becomes a version, so a wrong restore is undone the same way.
    await keepVersion(ctx, row, args.user_id, now);
    await clearApprovals(ctx, row, "approved");
    await ctx.db.delete(ver._id);
    await ctx.db.patch(row._id, {
      value_id: await valueIdOf(ctx, row, ver),
      value_enc: undefined,
      version_count: row.version_count ?? 1,
      fingerprint: ver.fingerprint,
      signin_expires_at: ver.signin_expires_at,
      has_otp: ver.has_otp,
      updated_by: args.user_id,
      updated_at: now,
      value_updated_at: nextValueVersion(row, now),
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
      if (ver.value_id) await ctx.db.delete(ver.value_id);
      const row = await ctx.db.get(ver.secret_id);
      if (row) await ctx.db.patch(row._id, { version_count: Math.max(0, (row.version_count ?? 1) - 1) });
    }
    // The redaction feed carries live versions; one gone changes what it holds.
    for (const workspace of new Set(expired.map((ver) => ver.workspace))) await bumpRedaction(ctx, workspace);
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
    /** Left out, a new request is a key and an open one keeps its kind. */
    kind: v.optional(kindValidator),
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
    let row = await byName(ctx, where.workspace, name);
    if (row?.status === "ready") {
      return { exists: true, id: String(row._id), short_id: row.short_id, name, message: `${name} already exists (${row.short_id}): read it with cast vault get ${name}` };
    }
    // The first asker's kind decides the form the person fills: a later ask
    // naming another kind is refused rather than turning a login into a key.
    if (row && args.kind && args.kind !== row.kind) {
      return { error: `${name} is already requested as a ${row.kind} (${row.short_id}): ask with --kind ${row.kind}, or pick another name` };
    }
    const kind = row?.kind ?? args.kind ?? "key";
    const envProblem = secretEnvProblem({ name, kind, env });
    if (envProblem) return { error: envProblem };
    if (row) {
      // Asked again: the first asker stays the asker, a new session joins the
      // ones the fill wakes, and what this ask leaves out keeps the first's.
      const askers = askersOf(row);
      const joins = !!conversation && !askers.some((c) => String(c) === String(conversation._id)) && askers.length < MAX_LIST;
      await ctx.db.patch(row._id, {
        env: env ?? row.env,
        sites: sites ?? row.sites,
        request_why: why ?? row.request_why,
        requested_by: row.requested_by ?? userId,
        ...(!joins ? {}
          : row.requested_from_conversation ? { also_requested_from: [...(row.also_requested_from ?? []), conversation!._id] }
          : { requested_from_conversation: conversation!._id }),
        updated_by: userId,
        updated_at: now,
      });
    } else {
      const short_id = await nextShortId(ctx.db as any, "sec");
      const id = await ctx.db.insert("secrets", {
        workspace: where.workspace,
        team_id: where.team_id,
        short_id,
        name,
        kind,
        status: "requested",
        env,
        sites,
        request_why: why,
        requested_by: userId,
        requested_from_conversation: conversation?._id,
        created_by: userId,
        created_at: now,
        updated_by: userId,
        updated_at: now,
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
  // check: only count the site's cookies there (vault_check_signin), so the dialog shows what a share hands over before it is confirmed.
  args: { site: v.string(), name: v.optional(v.string()), device_id: v.string(), check: v.optional(v.boolean()), ...workspaceArgs },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return { error: "Sign in to codecast to save a sign-in" };
    const site = cleanSecretSites([args.site])?.[0];
    if (!site) return { error: "Name the site like github.com" };
    const siteWrong = siteProblem(site);
    if (siteWrong) return { error: siteWrong };
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
      command: args.check ? ("vault_check_signin" as const) : ("vault_capture_signin" as const),
      args: JSON.stringify({ site, ...(name ? { name } : {}), ...(where.team_id ? { team_id: where.team_id } : { personal: true }) }),
      created_at: Date.now(),
      target_device_id: laptop.device_id,
    });
    return { command_id, device_id: laptop.device_id, label: laptop.label };
  },
});

// ── Values out ───────────────────────────────────────────────────────────────

export const readTargets = internalQuery({
  args: { user_id: v.id("users"), refs: v.array(v.string()), conversation: v.optional(v.string()), prefer: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const rows: ({ id: Id<"secrets">; short_id: string; name: string; kind: SecretKind; workspace: string; env?: string[]; sites?: string[]; value_updated_at: number } & ValueRef)[] = [];
    for (const ref of args.refs) {
      const row = await findSecret(ctx, args.user_id, ref, { prefer: args.prefer });
      if ("error" in row) return row;
      if (row.status !== "ready" || !hasValue(row)) {
        return { error: `${row.name} has no value yet (${row.short_id} is a request): wait for a person to fill it on the Vault page` };
      }
      rows.push({ id: row._id, short_id: row.short_id, name: row.name, kind: row.kind, workspace: row.workspace, ...valueRefOf(row), env: row.env, sites: row.sites, value_updated_at: valueVersion(row) });
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
 * (or the open one reused, its why rewritten when a newer one comes) and the
 * read answers with it instead of values.
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
  // An ended session's approval lends nothing: its id is visible to every other session of the user.
  if (!conversation || !conversation.session_id || String(conversation.user_id) !== String(userId) || conversation.status !== "active") {
    return { error: `${gated[0].name} is Ask first: a person approves each session's use, so read it from inside your own live agent session` };
  }
  const now = Date.now();
  const approvals: { decision: string; secret: string }[] = [];
  for (const row of gated) {
    const existing = await ctx.db
      .query("secret_approvals")
      .withIndex("by_secret_conversation", (q: any) => q.eq("secret_id", row._id).eq("conversation_id", conversation._id))
      .first();
    if (approvalHolds(existing, conversation, now)) continue;
    // The why is the agent's own words, so it is the context's first line rather than part of the question.
    const reason = why?.trim() ? `Why: ${why.trim()}` : `To ${purpose === "signin" && row.sites?.[0] ? `sign in to ${row.sites[0]}` : PURPOSE_PHRASE[purpose]}.`;
    const context_md = `${reason}\n\n${row.name} (${row.short_id}) is Ask first in the Vault. Approve lets this session read it until the session ends, for ${SECRET_APPROVAL_TTL_MS / 3_600_000} hours at most, and a new value asks again.`;
    const open = existing?.status === "pending" ? await ctx.db.get(existing.decision_id) : null;
    if (open?.status === "pending") {
      // A newer why rewrites the open decision in place; a repeat without one leaves it as asked.
      if (why?.trim() && open.context_md !== context_md) await ctx.db.patch(open._id, { context_md, updated_at: now });
      approvals.push({ decision: open.short_id, secret: row.name });
      continue;
    }
    const asked = await askCore(ctx, { userId: conversation.user_id }, {
      session_id: conversation.session_id,
      question: `${conversation.title || conversation.short_id || "A session"} asks to use ${row.name}`,
      options: [{ label: APPROVE_FOR_SESSION }, { label: DENY }],
      context_md,
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
async function openRows(ctx: any, rows: ({ name: string; workspace: string } & ValueRef)[]): Promise<{ payloads: SecretPayload[] } | { error: string }> {
  const encs = await loadCiphertexts(ctx, rows);
  const out: SecretPayload[] = [];
  for (const [i, row] of rows.entries()) {
    const payload = encs[i] ? await decryptSecret(encs[i], row.workspace) : null;
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
    const opened = await openRows(ctx, got.rows);
    if ("error" in opened) return opened;
    return { payload: opened.payloads[0] };
  },
});

/**
 * Values for an agent: `cast vault get|run|env|otp` and the browser's
 * sign-in. Each secret read records one event naming the session, and bumps
 * its use, before any value is returned. An Ask first secret this session has
 * no approval for answers `SecretNeedsApproval` instead (no values at all),
 * with the decision a person answers; `why` is that decision's first context line.
 * `prefer` is the workspace key (`team:<id>`) whose row a name held in several
 * workspaces means: the repo profile's.
 */
export const cliRead = action({
  args: {
    api_token: v.string(),
    refs: v.array(v.string()),
    conversation: v.optional(v.string()),
    purpose: purposeValidator,
    why: v.optional(v.string()),
    prefer: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<any> => {
    const userId = await ctx.runQuery(internal.secrets.callerOf, { api_token: args.api_token });
    if (!userId) return { error: "Unauthorized: run `cast auth` on this machine" };
    const refs = [...new Set(args.refs.map((r) => r.trim()).filter(Boolean))];
    if (!refs.length) return { error: "Name the secrets to read: cast vault lists them" };
    if (refs.length > MAX_LIST) return { error: `Read at most ${MAX_LIST} secrets at once` };
    const got = await ctx.runQuery(internal.secrets.readTargets, { user_id: userId, refs, conversation: args.conversation, prefer: args.prefer });
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
    const opened = await openRows(ctx, got.rows);
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
        value_updated_at: r.value_updated_at,
        payload: opened.payloads[i],
      })),
    };
  },
});

/** Whether one of the user's own sessions holds a live approval (approvalHolds) to read this Ask first secret, so the value reaches an agent of theirs. */
async function approvedForUser(ctx: any, row: SecretRow, userId: Id<"users">, now: number): Promise<boolean> {
  const approvals = await ctx.db.query("secret_approvals").withIndex("by_secret_conversation", (q: any) => q.eq("secret_id", row._id)).collect();
  for (const a of approvals) {
    if (a.status !== "approved") continue;
    const conversation: any = await ctx.db.get(a.conversation_id);
    if (conversation && String(conversation.user_id) === String(userId) && approvalHolds(a, conversation, now)) return true;
  }
  return false;
}

/**
 * The rows whose values go to the user's daemon, each with its current value
 * and the previous ones still restorable: a value rotated away after a leak
 * still sits in logs and files an agent may print. An Ask first secret goes
 * only while one of the user's own sessions holds an approval for it: before
 * that no agent of theirs holds the value, and a feed with it would hand it
 * to whatever holds the token, the gated agent included. Value refs only; the
 * action loads the ciphertexts a batch at a time.
 */
export const redactionRows = internalQuery({
  args: { user_id: v.id("users") },
  handler: async (ctx, args) => {
    const now = Date.now();
    const rows: { id: Id<"secrets">; name: string; kind: SecretKind; workspace: string; values: ValueRef[]; ask_first: boolean }[] = [];
    for (const r of await rowsFor(ctx, args.user_id)) {
      if (r.status !== "ready" || !hasValue(r)) continue;
      if (r.ask_first && !(await approvedForUser(ctx, r, args.user_id, now))) continue;
      const kept = (await liveVersions(ctx, r._id, now)).filter((ver) => ver.workspace === r.workspace).map(valueRefOf);
      rows.push({ id: r._id, name: r.name, kind: r.kind, workspace: r.workspace, values: [valueRefOf(r), ...kept], ask_first: !!r.ask_first });
    }
    return { version: await redactionVersionFor(ctx, args.user_id), rows };
  },
});

/**
 * One redaction_sync event per workspace per fetch, with how many values went
 * to the caller's daemon, and one more per Ask first secret among them,
 * naming it, so its trail shows every copy that left.
 */
export const recordRedactionSync = internalMutation({
  args: { user_id: v.id("users"), counts: v.array(v.object({ workspace: v.string(), count: v.number() })), ask_first: v.array(v.id("secrets")) },
  handler: async (ctx, args) => {
    const at = Date.now();
    for (const { workspace, count } of args.counts) {
      await ctx.db.insert("secret_events", { workspace, kind: "redaction_sync", actor_user_id: args.user_id, count, at });
    }
    for (const id of args.ask_first) {
      const row = await ctx.db.get(id);
      if (row) await recordSecretEvent(ctx, row, "redaction_sync", { actor: args.user_id });
    }
  },
});

/**
 * Every value the caller can read, current and kept (redactionRows), flattened for the daemon's
 * known-value redaction (memory only), with the version it matches. Not an
 * agent's read: nothing is recorded per ordinary secret, since the daemon
 * refetches on every version change and the values never reach a session;
 * each fetch records one redaction_sync per workspace, and one per Ask first
 * secret it carries.
 */
export const redactionValues = action({
  args: { api_token: v.string() },
  handler: async (ctx, args): Promise<{ version: string; values: { name: string; value: string }[] } | { error: string }> => {
    const userId = await ctx.runQuery(internal.secrets.callerOf, { api_token: args.api_token });
    if (!userId) return { error: "Unauthorized: run `cast auth` on this machine" };
    const got = await ctx.runQuery(internal.secrets.redactionRows, { user_id: userId });
    const values: { name: string; value: string }[] = [];
    const counts = new Map<string, number>();
    const askFirst: Id<"secrets">[] = [];
    const encs = await loadCiphertexts(ctx, got.rows.flatMap((row) => row.values));
    let at = 0;
    for (const row of got.rows) {
      const found = new Set<string>();
      let opened = false;
      for (const enc of encs.slice(at, (at += row.values.length))) {
        const payload = enc ? await decryptSecret(enc, row.workspace) : null;
        if (!payload) continue;
        opened = true;
        for (const value of redactionValuesOf(row.kind, payload)) found.add(value);
      }
      if (!opened) continue;
      for (const value of found) values.push({ name: row.name, value });
      counts.set(row.workspace, (counts.get(row.workspace) ?? 0) + found.size);
      if (row.ask_first) askFirst.push(row.id);
    }
    if (counts.size) {
      await ctx.runMutation(internal.secrets.recordRedactionSync, { user_id: userId, counts: [...counts].map(([workspace, count]) => ({ workspace, count })), ask_first: askFirst });
    }
    return { version: got.version, values };
  },
});

/**
 * One-off, after the ciphertext moved to secret_values (run with
 * packages/convex/run.sh secrets:moveValuesOut): moves each row's and each
 * version's inline value_enc there, a page at a time, secrets first.
 */
export const moveValuesOut = internalMutation({
  args: { table: v.optional(v.union(v.literal("secrets"), v.literal("secret_versions"))), cursor: v.optional(v.union(v.string(), v.null())) },
  handler: async (ctx, args) => {
    const table = args.table ?? "secrets";
    const page = await (ctx.db.query(table) as any).paginate({ cursor: args.cursor ?? null, numItems: 20 });
    let moved = 0;
    for (const r of page.page as any[]) {
      if (!r.value_enc) continue;
      const secret = table === "secrets" ? r : { _id: r.secret_id, workspace: r.workspace };
      await ctx.db.patch(r._id, { value_id: await valueIdOf(ctx, secret, r), value_enc: undefined });
      moved++;
    }
    if (!page.isDone) await ctx.scheduler.runAfter(0, internal.secrets.moveValuesOut, { table, cursor: page.continueCursor });
    else if (table === "secrets") await ctx.scheduler.runAfter(0, internal.secrets.moveValuesOut, { table: "secret_versions" });
    return { table, moved, done: page.isDone };
  },
});
