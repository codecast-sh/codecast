// The access KEYS: the stamp a row carries, the workspace key it is filed
// under, and the pure evaluators over them. This is the leaf every module may
// import at load: the change log and the sync log build stamps from here on
// every write, and functions.ts (the base of every entry) reaches them, so
// nothing in this file may reach a module that defines functions at load
// (sessionOwnership, pendingMessages, anything importing ./functions). The
// grants that read these keys, and the visibility patch that writes them,
// live in access.ts, which re-exports this file so callers see one layer.
import { Id } from "../_generated/dataModel";
import { isTeamMember, teamVisibleConvTeam } from "../privacy";

type AccessCtx = { db: any };

// ── The access STAMP: one builder, two evaluators, zero drift ──
// The sync log stores a copy of a row's access facts on every action row
// (sync-log-cargo E4) and getRange decides delivery from it. So the stamp is
// built HERE, next to the rules it encodes, and canAccessTask/Doc/Plan/Project
// are defined as "evaluate the stamp" — the log and the byIds queries cannot
// disagree by construction. `access_owner` is user_id; `access_key` is the
// workspace key (stored, else computed — never for conversations, whose rule is
// not owner-or-team and never reaches this layer); `access_grants` are explicit
// per-user grants (a task's assignee).
export type AccessStamp = {
  access_owner?: string;
  access_key?: string;
  access_grants?: string[];
};

/** Pure stamp from a document that already carries its stored workspace key. */
export function accessStampFromDoc(table: string, doc: any): AccessStamp | null {
  if (!doc?.user_id) return null;
  const stamp: AccessStamp = { access_owner: String(doc.user_id) };
  if (table !== "conversations" && typeof doc.workspace === "string" && doc.workspace) {
    stamp.access_key = doc.workspace;
  }
  if (table === "tasks" && isUserGrant(doc.assignee)) stamp.access_grants = [String(doc.assignee)];
  return stamp;
}

// A task's assignee is a user grant only when it names a user (`agent:<name>`
// assignees are not readers). Mirrored by the sync log's fan-out.
export function isUserGrant(assignee: unknown): assignee is string {
  return typeof assignee === "string" && assignee.length > 0 && !assignee.startsWith("agent:");
}

/** Stamp with the lazy key compute for rows minted before the backfill. */
export async function accessStampFor(ctx: AccessCtx, table: string, doc: any): Promise<AccessStamp | null> {
  const stamp = accessStampFromDoc(table, doc);
  if (!stamp) return null;
  if (table !== "conversations" && !stamp.access_key) {
    stamp.access_key = await resolveWorkspaceKey(ctx, doc);
  }
  return stamp;
}

/**
 * Pure evaluator: may `userId` read what the stamp guards, given the keys they
 * hold (`user:<id>` plus every `team:<id>` membership)? A stamp with no owner
 * grants NOTHING (fail closed, CLAUDE.md); unknown key variants match no held
 * key and grant nothing either.
 */
export function authorizedFor(
  stamp: AccessStamp | null | undefined,
  userId: string,
  heldKeys: ReadonlySet<string>,
): boolean {
  if (!stamp?.access_owner) return false;
  if (stamp.access_owner === userId) return true;
  if (stamp.access_grants?.includes(userId)) return true;
  if (stamp.access_key && heldKeys.has(stamp.access_key)) return true;
  return false;
}

/** The keys a user holds: their own personal key plus one per team membership. */
export async function heldKeysFor(ctx: AccessCtx, userId: Id<"users">): Promise<Set<string>> {
  const memberships = await ctx.db
    .query("team_memberships")
    .withIndex("by_user_id", (q: any) => q.eq("user_id", userId))
    .collect();
  return new Set([`user:${String(userId)}`, ...memberships.map((m: any) => `team:${String(m.team_id)}`)]);
}

/**
 * One caller judging MANY rows (a scope's tasks, a project's plans): the keys
 * the caller holds are read once, and each row goes through the pure
 * evaluator. canAccessTask per row costs a membership read per row that the
 * caller does not own, which on a project with 860 tasks filed by teammates
 * was 860 reads for one answer. Same stamp, same rule as canAccess*.
 */
export async function accessJudgeFor(ctx: AccessCtx, userId: Id<"users">): Promise<(table: string, doc: any) => Promise<boolean>> {
  const held = await heldKeysFor(ctx, userId);
  return async (table, doc) => authorizedFor(await accessStampFor(ctx, table, doc), String(userId), held);
}

export type AuthorizedWorkspace =
  | { type: "personal"; userId: Id<"users"> }
  | { type: "team"; teamId: Id<"teams"> };

/**
 * The conversation a record inherits workspace visibility from, if any.
 * This is THE canonical linkage rule — teamScopeSweep and the workspace
 * compute both use it. Explicit creation links win over association links.
 * Note `created_from_conversation_id`: the PLAN spelling of the same edge —
 * omitting it made plans silently skip inheritance entirely.
 */
export function linkedConversationId(record: any): string | undefined {
  if (record.created_from_conversation) return String(record.created_from_conversation);
  if (record.created_from_conversation_id) return String(record.created_from_conversation_id);
  if (record.conversation_id) return String(record.conversation_id);
  if (record.related_conversation_ids?.[0]) return String(record.related_conversation_ids[0]);
  if (record.conversation_ids?.[0]) return String(record.conversation_ids[0]);
  return undefined;
}

// ── Stored workspace key (the ACCESS axis) ──────────────────────────────────
//
// One stored value per row answers "who may read this": `team:<teamId>` or
// `user:<userId>`. It is INDEPENDENT state, not a projection of team_id:
//   • team_id stays ROUTING (which team's surfaces/feeds/notifications the row
//     shows in) and no access path may consult it.
//   • workspace is ACCESS and no routing path may consult it.
// The split is what makes "routed to team T but readable only by its owner"
// expressible (team_id: T, workspace: user:<owner>) — a product requirement,
// not a migration convenience.
//
// The key is written at WRITE time by computeWorkspaceKey (below) and
// recomputed ONLY when a linked conversation's visibility changes
// (recomputeWorkspaceForConversation). Reads are a single equality against
// the viewer's active workspace key. The format is a discriminated string so
// a future `restricted:<ref>` variant (subset sharing, session_owners-style
// join table behind it) is additive; parseWorkspaceKey returns null for
// unknown variants so every reader fails CLOSED on them.

export type WorkspaceKey = string;

/** The one constructor for a workspace key. */
export function workspaceKey(ws: AuthorizedWorkspace): WorkspaceKey {
  return ws.type === "team" ? `team:${ws.teamId}` : `user:${ws.userId}`;
}

/** Null for unknown/absent variants — callers must treat null as NO access. */
export function parseWorkspaceKey(key: string | null | undefined): AuthorizedWorkspace | null {
  if (!key) return null;
  if (key.startsWith("team:")) return { type: "team", teamId: key.slice(5) as Id<"teams"> };
  if (key.startsWith("user:")) return { type: "personal", userId: key.slice(5) as Id<"users"> };
  return null;
}

/**
 * WRITE-time compute of a row's workspace key from today's effective-access
 * rules. Pure: the caller supplies the linked conversation row (or null).
 * A linked conversation decides: team-visible → its team, otherwise the row is
 * personal TO ITS OWNER (user_id — never the caller running the compute).
 * Without a link, the raw team tag decides. This is the ONLY place the access
 * axis may read team_id — it is the writer, not a reader.
 */
export function computeWorkspaceKey(
  record: { user_id: Id<"users">; team_id?: Id<"teams"> },
  linkedConv:
    | { team_id?: Id<"teams">; is_private?: boolean; auto_shared?: boolean; team_visibility?: string }
    | null
    | undefined,
): WorkspaceKey {
  if (linkedConv) {
    const teamId = teamVisibleConvTeam(linkedConv);
    return teamId ? `team:${teamId}` : `user:${record.user_id}`;
  }
  return record.team_id ? `team:${record.team_id}` : `user:${record.user_id}`;
}

/** computeWorkspaceKey with the linked conversation fetched from the db. */
export async function computeWorkspaceKeyDb(ctx: AccessCtx, record: any): Promise<WorkspaceKey> {
  const cid = linkedConversationId(record);
  const conv = cid ? await ctx.db.get(cid) : null;
  return computeWorkspaceKey(record, conv);
}

/**
 * The stored key when present, else the lazy compute — migration scaffolding
 * for rows minted before the backfill. Once the backfill has run, the stored
 * branch is the only one taken.
 */
export async function resolveWorkspaceKey(ctx: AccessCtx, record: any): Promise<WorkspaceKey> {
  if (typeof record.workspace === "string" && record.workspace) return record.workspace;
  return computeWorkspaceKeyDb(ctx, record);
}

/**
 * Does this user belong to the workspace the key names? The ONE access
 * predicate for key-carrying rows: personal keys match only that user; team
 * keys require membership; unknown variants (future `restricted:`) and absent
 * keys grant NOTHING here — fail closed.
 */
export async function workspaceGrantsAccess(
  ctx: AccessCtx,
  userId: Id<"users">,
  key: WorkspaceKey | null | undefined,
): Promise<boolean> {
  const ws = parseWorkspaceKey(key);
  if (!ws) return false;
  if (ws.type === "personal") return String(ws.userId) === String(userId);
  return await isTeamMember(ctx, userId, ws.teamId);
}

// Loaded by functions.ts on every entry; keep this file free of function definitions.
