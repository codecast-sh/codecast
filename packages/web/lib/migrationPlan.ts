/**
 * Client-side mirror of the server's migration planning rule
 * (convex/sessionMigrations.ts planMigration): which sessions can go to a
 * chosen destination, and why the rest cannot. The server re-derives this
 * when the batch is created, so this only decides what the list greys out and
 * what the confirm dialog says. Pure, so it is testable.
 */

export type MigrationCandidate = {
  _id: string;
  short_id: string | null;
  title: string | null;
  owner_device_id: string | null;
  agent_type: string | null;
  project_path: string | null;
  worktree_name: string | null;
  worktree_branch: string | null;
  updated_at: number;
  has_pending_messages: boolean;
  migration: { batch_id: string; migration_id: string } | null;
  cloud_placement: string | null;
  inbox_stashed_at: number | null;
  inbox_dismissed_at: number | null;
  /** Why the server will not move it on its own (a workflow step, an in-process subagent). */
  held_reason?: string | null;
};

export type MigrationDevice = {
  device_id: string;
  is_remote: boolean;
  online: boolean;
  label?: string;
};

export type Eligibility =
  | { ok: true; direction: "to_cloud" | "to_local" }
  | { ok: false; reason: string };

const CLAUDE_TYPES = new Set(["claude", "claude_code", "claude-code", ""]);

export function eligibilityFor(
  c: MigrationCandidate,
  target: MigrationDevice | undefined,
  devices: MigrationDevice[],
): Eligibility {
  if (!target) return { ok: false, reason: "pick a destination" };
  if (c.held_reason) return { ok: false, reason: c.held_reason };
  if (c.migration) return { ok: false, reason: `already migrating (${c.migration.batch_id})` };
  if (c.cloud_placement === "pending") return { ok: false, reason: "still being placed on the cloud host" };
  if (!CLAUDE_TYPES.has((c.agent_type ?? "").toLowerCase())) return { ok: false, reason: "only Claude Code sessions can be transferred" };
  if (c.owner_device_id === target.device_id) return { ok: false, reason: "already here" };
  const owner = devices.find((d) => d.device_id === c.owner_device_id);
  if (target.is_remote) {
    if (owner?.is_remote) return { ok: false, reason: "cloud-to-cloud moves are not supported" };
    // Only the owner holds the transcript and worktree; it must be up to push them.
    if (owner && !owner.online) return { ok: false, reason: `${owner.label ?? "its machine"} is offline` };
    const anyLocalOnline = devices.some((d) => !d.is_remote && d.online);
    if (!anyLocalOnline) return { ok: false, reason: "no online laptop can run the transfer" };
    return { ok: true, direction: "to_cloud" };
  }
  if (!owner?.is_remote) return { ok: false, reason: "not on a cloud host (use Run on this device instead)" };
  if (!target.online) return { ok: false, reason: `${target.label ?? "the destination"} is offline` };
  return { ok: true, direction: "to_local" };
}

export type MigrationRowStatus =
  | "queued" | "waiting_idle" | "quiescing" | "transferring" | "switching" | "resuming" | "done" | "failed" | "cancelled";

export const ROW_STATUS_LABEL: Record<MigrationRowStatus, string> = {
  queued: "queued",
  waiting_idle: "waiting for turn",
  quiescing: "stopping",
  transferring: "transferring",
  switching: "handing off",
  resuming: "resuming",
  done: "done",
  failed: "failed",
  cancelled: "cancelled",
};

export function isRowActive(status: string): boolean {
  return status === "waiting_idle" || status === "quiescing" || status === "transferring" || status === "switching" || status === "resuming";
}

export function isRowTerminal(status: string): boolean {
  return status === "done" || status === "failed" || status === "cancelled";
}

/** One session in a migration batch, as sessionMigrations.listBatches returns it. */
export type MigrationBatchRow = {
  migration_id: string;
  conversation_id: string;
  title: string | null;
  short_id: string | null;
  direction: "to_cloud" | "to_local";
  from_device_id: string | null;
  to_device_id: string;
  executor_device_id: string;
  status: MigrationRowStatus;
  stage: string | null;
  error: string | null;
  attempt: number;
  started_at: number | null;
  finished_at: number | null;
  updated_at: number;
  destination_path: string | null;
  verification: string | null;
};

export type MigrationBatch = {
  resource_offload?: import("@codecast/shared/contracts/resourceOffloadIntent").ResourceOffloadIntent;
  batch_id: string;
  to_device_id: string;
  created_at: number;
  updated_at: number;
  cancelled_at: number | null;
  wait_for_idle_ms: number;
  concurrency: number;
  executor_device_ids: string[];
  total: number;
  done: number;
  failed: number;
  cancelled: number;
  active: number;
  queued: number;
  state: "running" | "done" | "partial" | "failed" | "cancelled" | "empty";
  rows: MigrationBatchRow[];
};

/** A row of a batch being cancelled reads cancelled while queued, so a stale push cannot flash it back. */
export function effectiveRowStatus(b: { cancelled_at: number | null }, r: { status: MigrationRowStatus }): MigrationRowStatus {
  return b.cancelled_at && r.status === "queued" ? "cancelled" : r.status;
}

/** A just-created batch the server has not echoed yet: its rows still carry the client stub ids. */
export function batchAwaitingEcho(b: { batch_id: string; rows: Array<{ migration_id: string }> }): boolean {
  return b.rows.some((r) => r.migration_id.startsWith(`${b.batch_id}:`));
}

/** Wait-for-idle presets, in ms. 0 = interrupt a running turn immediately. */
export const WAIT_PRESETS: Array<{ value: number; label: string }> = [
  { value: 0, label: "Interrupt right away" },
  { value: 2 * 60_000, label: "Wait up to 2 minutes" },
  { value: 10 * 60_000, label: "Wait up to 10 minutes" },
  { value: 30 * 60_000, label: "Wait up to 30 minutes" },
  { value: 60 * 60_000, label: "Wait up to an hour" },
];

/** Sessions the batch hand-off should mention as mid-turn. */
export const MID_TURN_STATUSES: ReadonlySet<string> = new Set(["working", "thinking", "compacting"]);

/** How long a batch may sit with nothing started before the UI suspects the executor never picked it up. */
export const BATCH_UNCLAIMED_WARN_MS = 45_000;

export function batchLooksUnclaimed(b: { created_at: number; rows: Array<{ status: string }> }, now: number): boolean {
  const started = b.rows.some((r) => r.status !== "queued" && r.status !== "cancelled");
  return !started && b.rows.some((r) => r.status === "queued") && now - b.created_at > BATCH_UNCLAIMED_WARN_MS;
}

/** The newest migration of one conversation in the batch list, with its batch. */
export function conversationMigrationOf(
  batches: MigrationBatch[] | null | undefined,
  conversationId: string | undefined,
): { batch: MigrationBatch; row: MigrationBatchRow } | null {
  if (!batches || !conversationId) return null;
  let best: { batch: MigrationBatch; row: MigrationBatchRow } | null = null;
  for (const batch of batches) {
    const row = batch.rows.find((r) => r.conversation_id === conversationId);
    if (row && (!best || batch.created_at > best.batch.created_at)) best = { batch, row };
  }
  return best;
}

// How long a landed move's green line and a failed move's retry stay up.
export const MIGRATION_DONE_LINGER_MS = 8_000;
export const MIGRATION_FAILED_LINGER_MS = 10 * 60_000;

export type MigrationMoveView =
  | { phase: "moving"; status: MigrationRowStatus; label: string; detail: string | null; tone: "active" | "warn"; startedAt: number; cancellable: boolean }
  | { phase: "done"; label: string }
  | { phase: "failed"; label: string };

/**
 * What a conversation's move between machines says right now, from its
 * migration row: one line of where it stands, or null once it has settled
 * long enough ago that the session's own status speaks again. `dest` and
 * `from` are display names. A row can be cancelled until its transfer starts
 * (the runner honours a cancelled batch while it waits for the turn to end).
 */
export function migrationMoveView(
  m: { batch: MigrationBatch; row: MigrationBatchRow } | null,
  names: { dest: string; from: string; executor: string },
  now: number,
): MigrationMoveView | null {
  if (!m) return null;
  const status = effectiveRowStatus(m.batch, m.row);
  const settledAt = m.row.finished_at ?? m.row.updated_at;
  if (status === "done") return now - settledAt < MIGRATION_DONE_LINGER_MS ? { phase: "done", label: `Now running on ${names.dest}` } : null;
  if (status === "cancelled") return null;
  if (status === "failed") {
    return now - settledAt < MIGRATION_FAILED_LINGER_MS
      ? { phase: "failed", label: `Move to ${names.dest} failed${m.row.error ? ` · ${m.row.error}` : ""}` }
      : null;
  }
  const unclaimed = status === "queued" && batchLooksUnclaimed(m.batch, now);
  const detail: Record<Exclude<MigrationRowStatus, "done" | "failed" | "cancelled">, string> = {
    queued: unclaimed ? `waiting for ${names.executor} to start it` : "starting",
    waiting_idle: "waiting for the current turn to end",
    quiescing: `stopping the agent on ${names.from}`,
    transferring: "copying work and transcript",
    switching: "handing off",
    resuming: `starting on ${names.dest}`,
  };
  return {
    phase: "moving",
    status,
    label: `Moving to ${names.dest}`,
    detail: detail[status],
    tone: unclaimed ? "warn" : "active",
    startedAt: m.row.started_at ?? m.batch.created_at,
    cancellable: status === "queued" || status === "waiting_idle",
  };
}
