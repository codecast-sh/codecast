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
