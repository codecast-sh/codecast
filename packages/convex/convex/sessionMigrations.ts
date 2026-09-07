/**
 * Bulk session migration: move MANY sessions between a local machine and a
 * cloud host in one gesture, in either direction, while they may be mid-turn.
 *
 * Why a rail of its own. The single-session move (`devices.moveToRemote` →
 * `move_to_device` → `cast remote move`) runs inline in the source daemon's
 * command loop, one multi-minute SSH transfer at a time, under the queue's
 * 5-minute command TTL, and has no cloud→local twin from the web at all. A
 * batch of twenty would block every other command on that machine for an hour
 * and lose most of itself to the TTL.
 *
 * Shape:
 *   migration_batches   one row per gesture ("these N sessions → device X")
 *   session_migrations  one row per session; the unit of progress
 *   conversations.migration  the FENCE on the row being moved
 *
 * The web calls createBatch. It validates every session, derives the
 * direction per row (to_cloud: the owner is a laptop, the target a remote
 * host; to_local: the owner is a remote host, the target a laptop), picks an
 * EXECUTOR per row — always an online LOCAL daemon, because only laptops hold
 * the host registry and SSH key: the source for to_cloud, the destination for
 * to_local — and enqueues one `migrate_sessions` command per executor. The
 * daemon starts a detached `cast migrate run <batch>` and answers at once.
 *
 * The runner then drives each row through the mutations below:
 *   beginSession   → fence the conversation (no daemon delivers; messages
 *                    queue as pending), status waiting_idle
 *   sessionFacts   → poll the agent status until the current turn ends
 *   enqueueQuiesce → `quiesce_session` at the current owner: stop its backends
 *                    so the transcript on disk is final
 *   reportSession  → transferring / switching narration
 *   finishSession  → ONE transaction: owner + project_path flip, targeted
 *                    resume on the destination, release of the old owner, and
 *                    the fence cleared — so the queued messages become the
 *                    destination's the same instant it owns the row
 *   confirmSession → done / failed once the resume command reports
 *   failSession    → clear the fence and record why (any step)
 *
 * Nothing here moves files; that is the CLI (packages/cli/src/migrate).
 */

import { mutation, query, internalMutation } from "./functions";
import { v } from "convex/values";
import { getAuthUserId } from "@convex-dev/auth/server";
import { verifyApiToken } from "./apiTokens";
import { Id } from "./_generated/dataModel";
import { DEVICE_ONLINE_MS } from "./deviceRouting";
import { performMoveSessionToDevice } from "./devices";
import { findConversationByAnyRefWhere } from "./conversationSessionLookup";
import { resolveLabelConvIds } from "./buckets";
import { fromConvexAgentType } from "@codecast/shared/contracts";

async function getAuthenticatedUserId(ctx: { db: any }, apiToken?: string): Promise<Id<"users"> | null> {
  const sessionUserId = await getAuthUserId(ctx as any);
  if (sessionUserId) return sessionUserId;
  if (apiToken) {
    const result = await verifyApiToken(ctx, apiToken);
    if (result) return result.userId;
  }
  return null;
}

// ── Pure planning ────────────────────────────────────────────────────────────

export type MigrationDirection = "to_cloud" | "to_local";

export type MigrationStatus =
  | "queued"
  | "waiting_idle"
  | "quiescing"
  | "transferring"
  | "switching"
  | "resuming"
  | "done"
  | "failed"
  | "cancelled";

/** Statuses a runner is still advancing. */
export const IN_FLIGHT_STATUSES: ReadonlySet<MigrationStatus> = new Set<MigrationStatus>([
  "waiting_idle",
  "quiescing",
  "transferring",
  "switching",
  "resuming",
]);

export const TERMINAL_STATUSES: ReadonlySet<MigrationStatus> = new Set<MigrationStatus>([
  "done",
  "failed",
  "cancelled",
]);

type PlanDevice = {
  device_id: string;
  is_remote?: boolean;
  last_seen: number;
  label?: string;
};

type PlanConversation = {
  _id: string;
  session_id?: string;
  title?: string;
  short_id?: string;
  owner_device_id?: string;
  agent_type?: string;
  status?: string;
  inbox_killed_at?: number;
  is_subagent?: boolean;
  cloud_placement?: string;
  migration?: { batch_id: string } | null;
};

export type PlannedRow = {
  conversation_id: string;
  session_id?: string;
  title?: string;
  short_id?: string;
  direction: MigrationDirection;
  from_device_id?: string;
  to_device_id: string;
  executor_device_id: string;
};

export type SkippedRow = { conversation_id: string; short_id?: string; title?: string; reason: string };

/** The ONE rule for which direction a row moves and which daemon does the work. */
export function planMigration(opts: {
  conversations: PlanConversation[];
  devices: PlanDevice[];
  targetDeviceId: string;
  now: number;
}): { rows: PlannedRow[]; skipped: SkippedRow[] } {
  const { now } = opts;
  const byId = new Map(opts.devices.map((d) => [d.device_id, d]));
  const target = byId.get(opts.targetDeviceId);
  const online = (d: PlanDevice | undefined) => !!d && now - d.last_seen < DEVICE_ONLINE_MS;
  const mostRecentOnlineLocal = opts.devices
    .filter((d) => !d.is_remote && online(d))
    .sort((a, b) => b.last_seen - a.last_seen)[0];
  const rows: PlannedRow[] = [];
  const skipped: SkippedRow[] = [];
  const seen = new Set<string>();
  for (const c of opts.conversations) {
    const skip = (reason: string) => skipped.push({ conversation_id: c._id, short_id: c.short_id, title: c.title, reason });
    if (seen.has(c._id)) continue;
    seen.add(c._id);
    if (!target) { skip("the destination device is not registered"); continue; }
    if (c.status === "completed") { skip("the session has ended"); continue; }
    if (c.inbox_killed_at) { skip("the session was killed"); continue; }
    if (c.is_subagent) { skip("a subagent moves with its parent"); continue; }
    if (c.migration) { skip(`already migrating (${c.migration.batch_id})`); continue; }
    if (c.cloud_placement === "pending") { skip("still being placed on the cloud host"); continue; }
    if (fromConvexAgentType(c.agent_type) !== "claude") { skip("only Claude Code sessions can be transferred"); continue; }
    if (!c.session_id) { skip("the session has no transcript yet"); continue; }
    const owner = c.owner_device_id ? byId.get(c.owner_device_id) : undefined;
    if (c.owner_device_id === opts.targetDeviceId) { skip(`already on ${target.label ?? "that device"}`); continue; }
    if (target.is_remote) {
      if (owner?.is_remote) { skip("moving between two cloud hosts is not supported"); continue; }
      // The transcript and worktree live on the OWNER: only it can push them.
      // An unowned row (legacy) is a best-effort push from the freshest laptop.
      if (owner && !online(owner)) { skip(`${owner.label ?? "its machine"} is offline — it holds the session's files`); continue; }
      const executor = owner ? owner.device_id : mostRecentOnlineLocal?.device_id;
      if (!executor) { skip("no online local machine can run the transfer (start the codecast daemon on your laptop)"); continue; }
      rows.push({
        conversation_id: c._id, session_id: c.session_id, title: c.title, short_id: c.short_id,
        direction: "to_cloud", from_device_id: c.owner_device_id, to_device_id: target.device_id, executor_device_id: executor,
      });
    } else {
      if (!owner?.is_remote) { skip("only sessions on a cloud host can be brought back (use Run on this device for a laptop-to-laptop move)"); continue; }
      if (!online(target)) { skip(`${target.label ?? "the destination"} is offline`); continue; }
      rows.push({
        conversation_id: c._id, session_id: c.session_id, title: c.title, short_id: c.short_id,
        direction: "to_local", from_device_id: c.owner_device_id, to_device_id: target.device_id, executor_device_id: target.device_id,
      });
    }
  }
  return { rows, skipped };
}

/** A batch's roll-up from its rows: what the list card shows. */
export function summarizeBatch(rows: Array<{ status: MigrationStatus }>, cancelledAt?: number | null): {
  total: number; done: number; failed: number; cancelled: number; active: number; queued: number;
  state: "running" | "done" | "partial" | "failed" | "cancelled" | "empty";
} {
  const counts = { total: rows.length, done: 0, failed: 0, cancelled: 0, active: 0, queued: 0 };
  for (const r of rows) {
    if (r.status === "done") counts.done++;
    else if (r.status === "failed") counts.failed++;
    else if (r.status === "cancelled") counts.cancelled++;
    else if (r.status === "queued") counts.queued++;
    else counts.active++;
  }
  let state: "running" | "done" | "partial" | "failed" | "cancelled" | "empty";
  if (counts.total === 0) state = "empty";
  else if (counts.active > 0 || counts.queued > 0) state = "running";
  else if (counts.done === counts.total) state = "done";
  else if (counts.done === 0 && counts.cancelled === counts.total) state = "cancelled";
  else if (counts.done === 0 && cancelledAt && counts.failed === 0) state = "cancelled";
  else if (counts.done === 0) state = "failed";
  else state = "partial";
  return { ...counts, state };
}

/**
 * A fenced in-flight row whose runner has gone quiet this long is treated as
 * crashed: the fence is lifted so the session can be served again where it
 * still lives, and the row fails with a reason a human can act on.
 */
export const STALE_MIGRATION_MS = 30 * 60 * 1000;

export function isStaleMigration(row: { status: MigrationStatus; updated_at: number }, now: number): boolean {
  return IN_FLIGHT_STATUSES.has(row.status) && now - row.updated_at > STALE_MIGRATION_MS;
}

export const DEFAULT_WAIT_FOR_IDLE_MS = 10 * 60 * 1000;
export const MAX_WAIT_FOR_IDLE_MS = 6 * 60 * 60 * 1000;
export const DEFAULT_CONCURRENCY = 2;
export const MAX_CONCURRENCY = 4;
export const MAX_BATCH_ROWS = 200;

function newBatchId(): string {
  const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
  let out = "";
  for (let i = 0; i < 8; i++) out += alphabet[Math.floor(Math.random() * alphabet.length)];
  return `mg-${out}`;
}

// ── Batch creation ───────────────────────────────────────────────────────────

/**
 * The live, movable-in-principle sessions of a user, by owner device: every
 * conversation each device owns (plus the unowned ones) that has not ended,
 * been killed, or is a subagent. Bounded per device so a long history stays
 * one small pass. Shared by the web roster and the CLI selectors.
 */
export async function collectMigrationCandidates(ctx: { db: any }, userId: Id<"users">, devices: Array<{ device_id: string }>): Promise<any[]> {
  const ownerIds: Array<string | undefined> = [...devices.map((d) => d.device_id), undefined];
  const out: any[] = [];
  for (const ownerId of ownerIds) {
    const rows = await ctx.db
      .query("conversations")
      .withIndex("by_owner_device", (q: any) => q.eq("user_id", userId).eq("owner_device_id", ownerId))
      .order("desc")
      .take(300);
    for (const c of rows) {
      if (c.status === "completed" || c.inbox_killed_at || c.is_subagent) continue;
      out.push(c);
    }
  }
  return out;
}

/**
 * A selector picks sessions by what they ARE rather than by id — the agent's
 * "move everything labeled x to the linux box". Selectors AND together; a
 * selector with nothing set matches nothing unless `all` is true.
 */
export type MigrationSelector = {
  label?: string;
  from_device_id?: string;
  /** A project path, or a substring of its last segment ("platform"). */
  project?: string;
  all?: boolean;
};

export function matchesProject(projectPath: string | undefined, project: string): boolean {
  if (!projectPath) return false;
  const needle = project.trim().replace(/\/+$/, "");
  if (!needle) return false;
  if (needle.startsWith("/")) return projectPath === needle || projectPath.startsWith(`${needle}/`);
  const segments = projectPath.split("/").filter(Boolean);
  // A worktree path (<repo>/.codecast/worktrees/<name>) is still the repo's.
  const repo = segments.includes(".codecast") ? segments[segments.indexOf(".codecast") - 1] : segments[segments.length - 1];
  const lower = needle.toLowerCase();
  return (repo ?? "").toLowerCase().includes(lower) || segments.some((seg) => seg.toLowerCase() === lower);
}

export async function resolveSelector(
  ctx: { db: any },
  userId: Id<"users">,
  devices: Array<{ device_id: string }>,
  selector: MigrationSelector,
): Promise<{ conversations: any[] } | { error: string }> {
  const hasTerm = !!(selector.label || selector.from_device_id || selector.project || selector.all);
  if (!hasTerm) return { conversations: [] };
  let labelIds: Set<string> | null = null;
  if (selector.label) {
    const resolved = await resolveLabelConvIds(ctx as any, userId, selector.label);
    if ("error" in resolved) return { error: resolved.error };
    labelIds = resolved.convIds;
  }
  const all = await collectMigrationCandidates(ctx, userId, devices);
  return {
    conversations: all.filter((c) =>
      (!labelIds || labelIds.has(c._id.toString())) &&
      (!selector.from_device_id || c.owner_device_id === selector.from_device_id) &&
      (!selector.project || matchesProject(c.project_path, selector.project))),
  };
}

/** Exported for tests; the mutation is the thin authenticated wrapper. */
export async function performCreateBatch(
  ctx: { db: any },
  userId: Id<"users">,
  args: {
    conversation_ids?: string[];
    selector?: MigrationSelector;
    to_device_id: string;
    wait_for_idle_ms?: number;
    concurrency?: number;
    /** Plan only: report rows and skips, write nothing. */
    dry_run?: boolean;
  },
  now: number = Date.now(),
): Promise<{
  batch_id: string | null;
  rows: Array<PlannedRow & { migration_id: string }>;
  skipped: SkippedRow[];
  command_ids: string[];
  dry_run: boolean;
}> {
  const ids = args.conversation_ids ?? [];
  if (ids.length === 0 && !args.selector) throw new Error("Pick at least one session");
  const devices = await ctx.db
    .query("devices")
    .withIndex("by_user_id", (q: any) => q.eq("user_id", userId))
    .collect();
  const conversations: PlanConversation[] = [];
  const skipped: SkippedRow[] = [];
  for (const raw of ids) {
    // Any ref: a conversation id, a short id, or a session UUID (the CLI
    // takes short ids; the web sends ids).
    const conv = await findConversationByAnyRefWhere(ctx, raw, (candidate: any) =>
      candidate.user_id.toString() === userId.toString());
    if (!conv) {
      skipped.push({ conversation_id: raw, reason: "not a session you run" });
      continue;
    }
    conversations.push(conv);
  }
  if (args.selector) {
    const picked = await resolveSelector(ctx, userId, devices, args.selector);
    if ("error" in picked) throw new Error(picked.error);
    conversations.push(...picked.conversations);
  }
  if (conversations.length > MAX_BATCH_ROWS) throw new Error(`At most ${MAX_BATCH_ROWS} sessions per batch (${conversations.length} matched) — narrow the selection`);
  const plan = planMigration({ conversations, devices, targetDeviceId: args.to_device_id, now });
  skipped.push(...plan.skipped);
  if (plan.rows.length === 0 || args.dry_run) {
    return {
      batch_id: null,
      rows: plan.rows.map((r) => ({ ...r, migration_id: "" })),
      skipped,
      command_ids: [],
      dry_run: !!args.dry_run,
    };
  }

  const waitForIdle = Math.min(MAX_WAIT_FOR_IDLE_MS, Math.max(0, Math.round(args.wait_for_idle_ms ?? DEFAULT_WAIT_FOR_IDLE_MS)));
  const concurrency = Math.min(MAX_CONCURRENCY, Math.max(1, Math.round(args.concurrency ?? DEFAULT_CONCURRENCY)));
  const executors = [...new Set(plan.rows.map((r) => r.executor_device_id))];
  const batchId = newBatchId();
  await ctx.db.insert("migration_batches", {
    user_id: userId,
    batch_id: batchId,
    to_device_id: args.to_device_id,
    created_at: now,
    updated_at: now,
    wait_for_idle_ms: waitForIdle,
    concurrency,
    executor_device_ids: executors,
  });
  const rows: Array<PlannedRow & { migration_id: string }> = [];
  let position = 0;
  for (const r of plan.rows) {
    const migrationId = await ctx.db.insert("session_migrations", {
      user_id: userId,
      batch_id: batchId,
      conversation_id: r.conversation_id,
      session_id: r.session_id,
      title: r.title,
      short_id: r.short_id,
      direction: r.direction,
      from_device_id: r.from_device_id,
      to_device_id: r.to_device_id,
      executor_device_id: r.executor_device_id,
      status: "queued" as const,
      position: position++,
      attempt: 0,
      created_at: now,
      updated_at: now,
    });
    rows.push({ ...r, migration_id: migrationId.toString() });
  }
  const commandIds: string[] = [];
  for (const executor of executors) {
    const id = await ctx.db.insert("daemon_commands", {
      user_id: userId,
      command: "migrate_sessions" as const,
      args: JSON.stringify({ batch_id: batchId }),
      created_at: now,
      target_device_id: executor,
    });
    commandIds.push(id.toString());
  }
  return { batch_id: batchId, rows, skipped, command_ids: commandIds, dry_run: false };
}

const selectorValidator = v.object({
  label: v.optional(v.string()),
  from_device_id: v.optional(v.string()),
  project: v.optional(v.string()),
  all: v.optional(v.boolean()),
});

export const createBatch = mutation({
  args: {
    api_token: v.optional(v.string()),
    conversation_ids: v.optional(v.array(v.string())),
    selector: v.optional(selectorValidator),
    to_device_id: v.string(),
    wait_for_idle_ms: v.optional(v.number()),
    concurrency: v.optional(v.number()),
    dry_run: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const userId = await getAuthenticatedUserId(ctx, args.api_token);
    if (!userId) throw new Error("Authentication required");
    return performCreateBatch(ctx, userId, args);
  },
});

async function loadBatch(ctx: { db: any }, userId: Id<"users">, batchId: string): Promise<any | null> {
  const batch = await ctx.db
    .query("migration_batches")
    .withIndex("by_batch_id", (q: any) => q.eq("batch_id", batchId))
    .first();
  if (!batch || batch.user_id.toString() !== userId.toString()) return null;
  return batch;
}

async function batchRowsOf(ctx: { db: any }, batchId: string): Promise<any[]> {
  return await ctx.db
    .query("session_migrations")
    .withIndex("by_batch", (q: any) => q.eq("batch_id", batchId))
    .collect();
}

/** Lift the fence, but only the one THIS migration put there. */
async function clearFence(ctx: { db: any }, row: any): Promise<void> {
  const conv = await ctx.db.get(row.conversation_id);
  if (!conv?.migration) return;
  if (conv.migration.migration_id.toString() !== row._id.toString()) return;
  await ctx.db.patch(conv._id, { migration: undefined, updated_at: Date.now() });
}

export async function performCancelBatch(ctx: { db: any }, userId: Id<"users">, batchId: string, now = Date.now()): Promise<{ cancelled: number }> {
  const batch = await loadBatch(ctx, userId, batchId);
  if (!batch) throw new Error("no such batch");
  let cancelled = 0;
  for (const row of await batchRowsOf(ctx, batchId)) {
    if (row.status !== "queued") continue;
    await ctx.db.patch(row._id, { status: "cancelled" as const, finished_at: now, updated_at: now, stage: undefined });
    cancelled++;
  }
  await ctx.db.patch(batch._id, { cancelled_at: now, updated_at: now });
  return { cancelled };
}

export const cancelBatch = mutation({
  args: { api_token: v.optional(v.string()), batch_id: v.string() },
  handler: async (ctx, args) => {
    const userId = await getAuthenticatedUserId(ctx, args.api_token);
    if (!userId) throw new Error("Authentication required");
    return performCancelBatch(ctx, userId, args.batch_id);
  },
});

/**
 * Re-queue the failed rows of a batch and wake the executors again. Rows keep
 * their ids and attempt counts; a row whose session moved meanwhile is
 * re-validated by beginSession, not here.
 */
export async function performRetryFailed(ctx: { db: any }, userId: Id<"users">, batchId: string, now = Date.now()): Promise<{ requeued: number; command_ids: string[] }> {
  const batch = await loadBatch(ctx, userId, batchId);
  if (!batch) throw new Error("no such batch");
  const executors = new Set<string>();
  let requeued = 0;
  for (const row of await batchRowsOf(ctx, batchId)) {
    if (row.status !== "failed" && row.status !== "cancelled") continue;
    await ctx.db.patch(row._id, {
      status: "queued" as const, error: undefined, stage: undefined, finished_at: undefined, started_at: undefined,
      resume_command_id: undefined, updated_at: now,
    });
    executors.add(row.executor_device_id);
    requeued++;
  }
  const commandIds: string[] = [];
  if (requeued > 0) {
    await ctx.db.patch(batch._id, { cancelled_at: undefined, updated_at: now });
    for (const executor of executors) {
      const id = await ctx.db.insert("daemon_commands", {
        user_id: userId,
        command: "migrate_sessions" as const,
        args: JSON.stringify({ batch_id: batchId }),
        created_at: now,
        target_device_id: executor,
      });
      commandIds.push(id.toString());
    }
  }
  return { requeued, command_ids: commandIds };
}

export const retryFailed = mutation({
  args: { api_token: v.optional(v.string()), batch_id: v.string() },
  handler: async (ctx, args) => {
    const userId = await getAuthenticatedUserId(ctx, args.api_token);
    if (!userId) throw new Error("Authentication required");
    return performRetryFailed(ctx, userId, args.batch_id);
  },
});

// ── The runner's rail (api-token authed, one executor daemon) ────────────────

/** Everything `cast migrate run <batch>` needs: the batch and ITS rows. */
export const runnerBatch = query({
  args: { api_token: v.optional(v.string()), batch_id: v.string(), device_id: v.string() },
  handler: async (ctx, args) => {
    const userId = await getAuthenticatedUserId(ctx, args.api_token);
    if (!userId) return null;
    const batch = await loadBatch(ctx, userId, args.batch_id);
    if (!batch) return null;
    const rows = (await batchRowsOf(ctx, args.batch_id))
      .filter((r: any) => r.executor_device_id === args.device_id)
      .sort((a: any, b: any) => a.position - b.position);
    return {
      batch_id: batch.batch_id,
      to_device_id: batch.to_device_id,
      cancelled_at: batch.cancelled_at ?? null,
      wait_for_idle_ms: batch.wait_for_idle_ms,
      concurrency: batch.concurrency,
      rows: rows.map((r: any) => ({
        migration_id: r._id,
        conversation_id: r.conversation_id,
        session_id: r.session_id ?? null,
        title: r.title ?? null,
        short_id: r.short_id ?? null,
        direction: r.direction,
        from_device_id: r.from_device_id ?? null,
        to_device_id: r.to_device_id,
        status: r.status,
        attempt: r.attempt,
        position: r.position,
        source_path: r.source_path ?? null,
        destination_path: r.destination_path ?? null,
      })),
    };
  },
});

/**
 * Claim one row and fence its conversation. Returns the facts the transfer
 * needs, or a refusal (the row was cancelled, the session moved, ...).
 */
export async function performBeginSession(
  ctx: { db: any },
  userId: Id<"users">,
  args: { migration_id: Id<"session_migrations">; device_id: string },
  now = Date.now(),
): Promise<
  | { ok: false; reason: string }
  | {
      ok: true;
      conversation_id: string;
      session_id: string;
      direction: MigrationDirection;
      owner_device_id: string | null;
      owner_is_remote: boolean;
      owner_online: boolean;
      owner_label: string | null;
      to_device_id: string;
      to_label: string | null;
      project_path: string | null;
      git_root: string | null;
      git_remote_url: string | null;
      worktree_name: string | null;
      worktree_branch: string | null;
      agent_status: string | null;
      title: string | null;
    }
> {
  const row = await ctx.db.get(args.migration_id);
  if (!row || row.user_id.toString() !== userId.toString()) return { ok: false, reason: "no such migration" };
  if (row.executor_device_id !== args.device_id) return { ok: false, reason: "another machine executes this row" };
  if (row.status !== "queued") return { ok: false, reason: `row is ${row.status}` };
  const batch = await loadBatch(ctx, userId, row.batch_id);
  if (!batch) return { ok: false, reason: "no such batch" };
  if (batch.cancelled_at) {
    await ctx.db.patch(row._id, { status: "cancelled" as const, finished_at: now, updated_at: now });
    return { ok: false, reason: "batch cancelled" };
  }
  const conv = await ctx.db.get(row.conversation_id);
  if (!conv || conv.user_id.toString() !== userId.toString()) {
    await ctx.db.patch(row._id, { status: "failed" as const, error: "the session no longer exists", finished_at: now, updated_at: now });
    return { ok: false, reason: "conversation gone" };
  }
  const fail = async (error: string) => {
    await ctx.db.patch(row._id, { status: "failed" as const, error, finished_at: now, updated_at: now });
    return { ok: false as const, reason: error };
  };
  if (conv.migration && conv.migration.migration_id.toString() !== row._id.toString()) {
    return fail(`already migrating (${conv.migration.batch_id})`);
  }
  if (conv.status === "completed") return fail("the session has ended");
  if (conv.inbox_killed_at) return fail("the session was killed");
  if (conv.owner_device_id === row.to_device_id) return fail("already on the destination");
  if (!conv.session_id) return fail("the session has no transcript yet");

  const devices = await ctx.db
    .query("devices")
    .withIndex("by_user_id", (q: any) => q.eq("user_id", userId))
    .collect();
  const owner = conv.owner_device_id ? devices.find((d: any) => d.device_id === conv.owner_device_id) : undefined;
  const target = devices.find((d: any) => d.device_id === row.to_device_id);
  if (!target) return fail("the destination device is no longer registered");
  // The direction was decided at planning time; refuse if the world moved.
  if (row.direction === "to_cloud" && owner?.is_remote) return fail("the session is already on a cloud host");
  if (row.direction === "to_local" && !owner?.is_remote) return fail("the session is no longer on a cloud host");

  const managed = conv.session_id
    ? await ctx.db
        .query("managed_sessions")
        .withIndex("by_session_id", (q: any) => q.eq("session_id", conv.session_id))
        .first()
    : null;

  await ctx.db.patch(conv._id, {
    migration: { batch_id: row.batch_id, migration_id: row._id, to_device_id: row.to_device_id, started_at: now },
    updated_at: now,
  });
  await ctx.db.patch(row._id, {
    status: "waiting_idle" as const,
    stage: "checking whether a turn is in progress",
    started_at: now,
    updated_at: now,
    attempt: (row.attempt ?? 0) + 1,
    from_device_id: conv.owner_device_id ?? row.from_device_id,
    error: undefined,
  });
  return {
    ok: true,
    conversation_id: conv._id.toString(),
    session_id: conv.session_id,
    direction: row.direction,
    owner_device_id: conv.owner_device_id ?? null,
    owner_is_remote: !!owner?.is_remote,
    owner_online: !!owner && now - owner.last_seen < DEVICE_ONLINE_MS,
    owner_label: owner?.label ?? null,
    to_device_id: row.to_device_id,
    to_label: target.label ?? null,
    project_path: conv.project_path ?? null,
    git_root: conv.git_root ?? null,
    git_remote_url: conv.git_remote_url ?? null,
    worktree_name: conv.worktree_name ?? null,
    worktree_branch: conv.worktree_branch ?? null,
    agent_status: managed?.agent_status ?? null,
    title: conv.title ?? null,
  };
}

export const beginSession = mutation({
  args: { api_token: v.optional(v.string()), migration_id: v.id("session_migrations"), device_id: v.string() },
  handler: async (ctx, args) => {
    const userId = await getAuthenticatedUserId(ctx, args.api_token);
    if (!userId) throw new Error("Authentication required");
    return performBeginSession(ctx, userId, args);
  },
});

/** What the idle wait polls: the live agent status and whether the batch was cancelled. */
export const sessionFacts = query({
  args: { api_token: v.optional(v.string()), migration_id: v.id("session_migrations") },
  handler: async (ctx, args) => {
    const userId = await getAuthenticatedUserId(ctx, args.api_token);
    if (!userId) return null;
    const row = await ctx.db.get(args.migration_id);
    if (!row || row.user_id.toString() !== userId.toString()) return null;
    const conv = await ctx.db.get(row.conversation_id);
    const batch = await loadBatch(ctx, userId, row.batch_id);
    const managed = conv?.session_id
      ? await ctx.db
          .query("managed_sessions")
          .withIndex("by_session_id", (q: any) => q.eq("session_id", conv.session_id))
          .first()
      : null;
    const owner = conv?.owner_device_id
      ? await ctx.db
          .query("devices")
          .withIndex("by_user_device", (q: any) => q.eq("user_id", userId).eq("device_id", conv.owner_device_id))
          .first()
      : null;
    const now = Date.now();
    return {
      status: row.status,
      batch_cancelled: !!batch?.cancelled_at,
      owner_device_id: conv?.owner_device_id ?? null,
      owner_online: !!owner && now - owner.last_seen < DEVICE_ONLINE_MS,
      agent_status: managed?.agent_status ?? null,
      agent_status_updated_at: managed?.agent_status_updated_at ?? null,
      fenced: !!conv?.migration && conv.migration.migration_id.toString() === row._id.toString(),
    };
  },
});

/** Progress narration from the runner; also the liveness heartbeat the reaper reads. */
export const reportSession = mutation({
  args: {
    api_token: v.optional(v.string()),
    migration_id: v.id("session_migrations"),
    status: v.optional(v.union(
      v.literal("waiting_idle"), v.literal("quiescing"), v.literal("transferring"), v.literal("switching"), v.literal("resuming"),
    )),
    stage: v.optional(v.string()),
    source_path: v.optional(v.string()),
    destination_path: v.optional(v.string()),
    verification: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const userId = await getAuthenticatedUserId(ctx, args.api_token);
    if (!userId) throw new Error("Authentication required");
    const row = await ctx.db.get(args.migration_id);
    if (!row || row.user_id.toString() !== userId.toString()) throw new Error("no such migration");
    if (TERMINAL_STATUSES.has(row.status)) return { ok: false, status: row.status };
    await ctx.db.patch(row._id, {
      ...(args.status ? { status: args.status } : {}),
      ...(args.stage !== undefined ? { stage: args.stage } : {}),
      ...(args.source_path !== undefined ? { source_path: args.source_path } : {}),
      ...(args.destination_path !== undefined ? { destination_path: args.destination_path } : {}),
      ...(args.verification !== undefined ? { verification: args.verification } : {}),
      updated_at: Date.now(),
    });
    return { ok: true, status: args.status ?? row.status };
  },
});

/**
 * Ask the CURRENT owner to stop the session's backends. The command goes in
 * the runner user's queue, targeted at the owner device — for a move to the
 * cloud that is the executor itself; for a move back it is the cloud host.
 */
export async function performEnqueueQuiesce(
  ctx: { db: any },
  userId: Id<"users">,
  args: { migration_id: Id<"session_migrations">; mode: "idle" | "force" },
  now = Date.now(),
): Promise<{ command_id: string | null; target_device_id: string | null }> {
  const row = await ctx.db.get(args.migration_id);
  if (!row || row.user_id.toString() !== userId.toString()) throw new Error("no such migration");
  const conv = await ctx.db.get(row.conversation_id);
  if (!conv) throw new Error("the session no longer exists");
  // An unowned row moving to the cloud can only be running on the executor
  // (it holds the transcript); a move back always has a remote owner.
  const target: string | undefined = conv.owner_device_id ?? (row.direction === "to_cloud" ? row.executor_device_id : undefined);
  if (!target) return { command_id: null, target_device_id: null };
  const id = await ctx.db.insert("daemon_commands", {
    user_id: userId,
    command: "quiesce_session" as const,
    args: JSON.stringify({ conversation_id: conv._id, session_id: conv.session_id, mode: args.mode, migration_id: row._id }),
    created_at: now,
    target_device_id: target,
  });
  await ctx.db.patch(row._id, { status: "quiescing" as const, stage: args.mode === "force" ? "interrupting the turn and stopping the agent" : "stopping the agent", updated_at: now });
  return { command_id: id.toString(), target_device_id: target };
}

export const enqueueQuiesce = mutation({
  args: {
    api_token: v.optional(v.string()),
    migration_id: v.id("session_migrations"),
    mode: v.union(v.literal("idle"), v.literal("force")),
  },
  handler: async (ctx, args) => {
    const userId = await getAuthenticatedUserId(ctx, args.api_token);
    if (!userId) throw new Error("Authentication required");
    return performEnqueueQuiesce(ctx, userId, args);
  },
});

/** Poll a daemon command the runner enqueued (quiesce, resume). */
export const commandStatus = query({
  args: { api_token: v.optional(v.string()), command_id: v.id("daemon_commands") },
  handler: async (ctx, args) => {
    const userId = await getAuthenticatedUserId(ctx, args.api_token);
    if (!userId) return null;
    const cmd = await ctx.db.get(args.command_id);
    if (!cmd || cmd.user_id.toString() !== userId.toString()) return null;
    return {
      command: cmd.command,
      created_at: cmd.created_at,
      executed_at: cmd.executed_at ?? null,
      result: cmd.result ?? null,
      error: cmd.error ?? null,
      claimed_at: cmd.claimed_at ?? null,
    };
  },
});

/**
 * The flip. One transaction: ownership + project path move to the
 * destination, a targeted resume is enqueued there, the previous owner is
 * told to release, and the fence comes off — so the messages that queued
 * during the transfer belong to the destination the instant it owns the row.
 */
export async function performFinishSession(
  ctx: { db: any },
  userId: Id<"users">,
  args: {
    migration_id: Id<"session_migrations">;
    project_path: string;
    git_root?: string;
    verification?: string;
    source_path?: string;
  },
  now = Date.now(),
): Promise<{ ok: true; resume_command_id: string | null; owner_device_id: string } | { ok: false; reason: string }> {
  const row = await ctx.db.get(args.migration_id);
  if (!row || row.user_id.toString() !== userId.toString()) return { ok: false, reason: "no such migration" };
  if (!IN_FLIGHT_STATUSES.has(row.status)) return { ok: false, reason: `row is ${row.status}` };
  const conv = await ctx.db.get(row.conversation_id);
  if (!conv) return { ok: false, reason: "the session no longer exists" };
  const moved = await performMoveSessionToDevice(ctx, userId, {
    conversation_id: row.conversation_id,
    owner_device_id: row.to_device_id,
    project_path: args.project_path,
    resume: true,
  });
  await ctx.db.patch(row.conversation_id, {
    migration: undefined,
    session_error: undefined,
    ...(args.git_root ? { git_root: args.git_root } : {}),
    updated_at: now,
  });
  await ctx.db.patch(row._id, {
    status: "resuming" as const,
    stage: "resuming on the destination",
    destination_path: args.project_path,
    ...(args.source_path !== undefined ? { source_path: args.source_path } : {}),
    ...(args.verification !== undefined ? { verification: args.verification } : {}),
    resume_command_id: moved.command_id ?? undefined,
    updated_at: now,
  });
  return { ok: true, resume_command_id: moved.command_id ?? null, owner_device_id: moved.owner_device_id };
}

export const finishSession = mutation({
  args: {
    api_token: v.optional(v.string()),
    migration_id: v.id("session_migrations"),
    project_path: v.string(),
    git_root: v.optional(v.string()),
    verification: v.optional(v.string()),
    source_path: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const userId = await getAuthenticatedUserId(ctx, args.api_token);
    if (!userId) throw new Error("Authentication required");
    return performFinishSession(ctx, userId, args);
  },
});

/** done / failed after the resume was observed (or gave up). */
export const confirmSession = mutation({
  args: {
    api_token: v.optional(v.string()),
    migration_id: v.id("session_migrations"),
    ok: v.boolean(),
    error: v.optional(v.string()),
    stage: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const userId = await getAuthenticatedUserId(ctx, args.api_token);
    if (!userId) throw new Error("Authentication required");
    const row = await ctx.db.get(args.migration_id);
    if (!row || row.user_id.toString() !== userId.toString()) throw new Error("no such migration");
    if (TERMINAL_STATUSES.has(row.status)) return { ok: false, status: row.status };
    const now = Date.now();
    await ctx.db.patch(row._id, {
      status: args.ok ? ("done" as const) : ("failed" as const),
      stage: args.stage ?? (args.ok ? "running on the destination" : undefined),
      error: args.ok ? undefined : (args.error ?? "unknown error"),
      finished_at: now,
      updated_at: now,
    });
    return { ok: true, status: args.ok ? "done" : "failed" };
  },
});

/** Any step failed: lift the fence, record why. The session stays where it was. */
export async function performFailSession(
  ctx: { db: any },
  userId: Id<"users">,
  args: { migration_id: Id<"session_migrations">; error: string; cancelled?: boolean },
  now = Date.now(),
): Promise<{ ok: boolean; status: MigrationStatus }> {
  const row = await ctx.db.get(args.migration_id);
  if (!row || row.user_id.toString() !== userId.toString()) throw new Error("no such migration");
  if (TERMINAL_STATUSES.has(row.status)) return { ok: false, status: row.status };
  await clearFence(ctx, row);
  const status = args.cancelled ? ("cancelled" as const) : ("failed" as const);
  await ctx.db.patch(row._id, {
    status,
    error: args.cancelled ? undefined : args.error.slice(0, 2000),
    stage: args.cancelled ? args.error.slice(0, 200) : undefined,
    finished_at: now,
    updated_at: now,
  });
  return { ok: true, status };
}

export const failSession = mutation({
  args: { api_token: v.optional(v.string()), migration_id: v.id("session_migrations"), error: v.string(), cancelled: v.optional(v.boolean()) },
  handler: async (ctx, args) => {
    const userId = await getAuthenticatedUserId(ctx, args.api_token);
    if (!userId) throw new Error("Authentication required");
    return performFailSession(ctx, userId, args);
  },
});

// ── The web's view ───────────────────────────────────────────────────────────

/**
 * Sessions the user can migrate, grouped by the device that runs them. Read
 * through by_owner_device per device (bounded per device), so an account with
 * years of history still answers in one small pass. Live status is joined by
 * the web from its inbox rows; this is the roster.
 */
export const candidates = query({
  args: { api_token: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const userId = await getAuthenticatedUserId(ctx, args.api_token);
    if (!userId) return null;
    const devices = await ctx.db
      .query("devices")
      .withIndex("by_user_id", (q: any) => q.eq("user_id", userId))
      .collect();
    const out: any[] = [];
    {
      for (const c of await collectMigrationCandidates(ctx, userId, devices)) {
        out.push({
          _id: c._id,
          short_id: c.short_id ?? null,
          title: c.title ?? null,
          owner_device_id: c.owner_device_id ?? null,
          agent_type: c.agent_type ?? null,
          project_path: c.project_path ?? null,
          worktree_name: c.worktree_name ?? null,
          worktree_branch: c.worktree_branch ?? null,
          updated_at: c.updated_at ?? 0,
          has_pending_messages: !!c.has_pending_messages,
          migration: c.migration ? { batch_id: c.migration.batch_id, migration_id: c.migration.migration_id } : null,
          cloud_placement: c.cloud_placement ?? null,
          inbox_stashed_at: c.inbox_stashed_at ?? null,
          inbox_dismissed_at: c.inbox_dismissed_at ?? null,
        });
      }
    }
    out.sort((a, b) => b.updated_at - a.updated_at);
    return out;
  },
});

const MAX_LISTED_BATCHES = 12;

export const listBatches = query({
  args: { api_token: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const userId = await getAuthenticatedUserId(ctx, args.api_token);
    if (!userId) return null;
    const batches = await ctx.db
      .query("migration_batches")
      .withIndex("by_user_created", (q: any) => q.eq("user_id", userId))
      .order("desc")
      .take(MAX_LISTED_BATCHES);
    const out: any[] = [];
    for (const b of batches) {
      const rows = await batchRowsOf(ctx, b.batch_id);
      const summary = summarizeBatch(rows, b.cancelled_at);
      out.push({
        batch_id: b.batch_id,
        to_device_id: b.to_device_id,
        created_at: b.created_at,
        updated_at: Math.max(b.updated_at, ...rows.map((r: any) => r.updated_at ?? 0)),
        cancelled_at: b.cancelled_at ?? null,
        wait_for_idle_ms: b.wait_for_idle_ms,
        concurrency: b.concurrency,
        executor_device_ids: b.executor_device_ids,
        ...summary,
        rows: rows
          .sort((a: any, b2: any) => a.position - b2.position)
          .map((r: any) => ({
            migration_id: r._id,
            conversation_id: r.conversation_id,
            session_id: r.session_id ?? null,
            title: r.title ?? null,
            short_id: r.short_id ?? null,
            direction: r.direction,
            from_device_id: r.from_device_id ?? null,
            to_device_id: r.to_device_id,
            executor_device_id: r.executor_device_id,
            status: r.status,
            stage: r.stage ?? null,
            error: r.error ?? null,
            attempt: r.attempt,
            started_at: r.started_at ?? null,
            finished_at: r.finished_at ?? null,
            updated_at: r.updated_at,
            source_path: r.source_path ?? null,
            destination_path: r.destination_path ?? null,
            verification: r.verification ?? null,
          })),
      });
    }
    return out;
  },
});

// ── Reaper ───────────────────────────────────────────────────────────────────

/**
 * A runner that died mid-row (laptop closed, daemon restarted) leaves a fenced
 * conversation nobody serves. Every few minutes: any in-flight row that has
 * not reported for STALE_MIGRATION_MS fails and its fence lifts, so messages
 * flow again to wherever the session still lives.
 */
export async function performReapStale(ctx: { db: any }, now = Date.now()): Promise<{ reaped: number }> {
  const recent = await ctx.db
    .query("session_migrations")
    .withIndex("by_user_created")
    .order("desc")
    .take(500);
  let reaped = 0;
  for (const row of recent) {
    if (!isStaleMigration(row, now)) continue;
    await clearFence(ctx, row);
    await ctx.db.patch(row._id, {
      status: "failed" as const,
      error: "the migration runner stopped reporting (its machine may have gone offline); the session stays where it was",
      stage: undefined,
      finished_at: now,
      updated_at: now,
    });
    reaped++;
  }
  return { reaped };
}

export const reapStale = internalMutation({
  args: {},
  handler: async (ctx) => performReapStale(ctx),
});
