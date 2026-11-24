// The pure half of bulk session migration (sessionMigrations.ts): the row
// statuses, the one rule for which direction a session moves and which daemon
// does the work, a batch's roll-up, and the staleness and batch limits.

import { fromConvexAgentType, isClosedSession } from "@codecast/shared/contracts";
import { DEVICE_ONLINE_MS } from "../deviceRouting";

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

export type PlanConversation = {
  _id: string;
  session_id?: string;
  title?: string;
  short_id?: string;
  owner_device_id?: string;
  agent_type?: string;
  status?: string;
  inbox_killed_at?: number;
  inbox_dismissed_at?: number;
  inbox_closed_at?: number;
  is_subagent?: boolean;
  /** Why it cannot move on its own (heldReason), set by annotateHeld before planning. */
  held?: string | null;
  cloud_placement?: string;
  migration?: { batch_id: string } | null;
  register_only?: boolean;
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
  /** The executor is offline: the row waits in its queue and starts when that
   *  machine's daemon checks in (reissueWaitingMigrations). Its label. */
  waits_for?: string;
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
    if (c.register_only) { skip("a registered session can't move devices"); continue; }
    // An ended session can still come home: its files and transcript are on the host.
    if (c.status === "completed" && target.is_remote) { skip("the session has ended"); continue; }
    if (c.inbox_killed_at) { skip("the session was killed"); continue; }
    // A bulk move leaves a closed session where it is, as it does a killed one
    // (a move would have to resume it there). It wakes on its old machine.
    if (isClosedSession(c)) { skip("the session was closed"); continue; }
    if (c.held) { skip(c.held); continue; }
    if (c.migration) { skip(`already migrating (${c.migration.batch_id})`); continue; }
    if (c.cloud_placement === "pending") { skip("still being placed on the cloud host"); continue; }
    if (fromConvexAgentType(c.agent_type) !== "claude") { skip("only Claude Code sessions can be transferred"); continue; }
    if (!c.session_id) { skip("the session has no transcript yet"); continue; }
    const owner = c.owner_device_id ? byId.get(c.owner_device_id) : undefined;
    if (c.owner_device_id === opts.targetDeviceId) { skip(`already on ${target.label ?? "that device"}`); continue; }
    if (target.is_remote) {
      if (owner?.is_remote) { skip("moving between two cloud hosts is not supported"); continue; }
      // The transcript and worktree live on the OWNER: only it can push them,
      // so an offline owner's row waits for it. An unowned row (legacy) is a
      // best-effort push from the freshest laptop.
      const executor = owner ?? mostRecentOnlineLocal;
      if (!executor) { skip("no online local machine can run the transfer (start the codecast daemon on your laptop)"); continue; }
      rows.push({
        conversation_id: c._id, session_id: c.session_id, title: c.title, short_id: c.short_id,
        direction: "to_cloud", from_device_id: c.owner_device_id, to_device_id: target.device_id, executor_device_id: executor.device_id,
        ...(online(executor) ? {} : { waits_for: executor.label ?? "its machine" }),
      });
    } else {
      if (!owner?.is_remote) { skip("only sessions on a cloud host can be brought back (use Run on this device for a laptop-to-laptop move)"); continue; }
      // The destination runs the transfer, so an offline destination's row
      // waits for it rather than being refused: a laptop whose heartbeat is
      // late under load is still the machine that will pull it.
      rows.push({
        conversation_id: c._id, session_id: c.session_id, title: c.title, short_id: c.short_id,
        direction: "to_local", from_device_id: c.owner_device_id, to_device_id: target.device_id, executor_device_id: target.device_id,
        ...(online(target) ? {} : { waits_for: target.label ?? "the destination" }),
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
