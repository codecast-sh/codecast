/**
 * Which rail each session in a bulk move takes (components/BulkMoveSessions):
 * the migration batch for a laptop↔cloud hop, the plain device re-home for
 * laptop→laptop, and a named skip for what the server would refuse. Mirrors
 * lib/migrationPlan's eligibility so a menu never offers a refused move.
 */
import { deviceDisplayName, type Device } from "../components/DeviceBadge";
import { eligibilityFor, type MigrationCandidate, type MigrationDevice } from "./migrationPlan";

/** The eligibility rule reads the migration-panel candidate shape; an inbox row carries the same facts under its own names. */
export function asMigrationCandidate(s: any): MigrationCandidate {
  return {
    _id: s._id,
    short_id: s.short_id ?? null,
    title: s.title ?? null,
    owner_device_id: s.owner_device_id ?? null,
    agent_type: s.agent_type ?? null,
    project_path: s.project_path ?? null,
    worktree_name: s.worktree_name ?? null,
    worktree_branch: s.worktree_branch ?? null,
    updated_at: s.updated_at ?? 0,
    has_pending_messages: !!s.has_pending,
    migration: s.migration_batch_id ? { batch_id: s.migration_batch_id, migration_id: "" } : null,
    cloud_placement: s.cloud_placement ?? null,
    inbox_stashed_at: s.inbox_stashed_at ?? null,
    inbox_dismissed_at: s.inbox_dismissed_at ?? null,
  };
}

export function asPlanDevices(devices: Device[]): MigrationDevice[] {
  return devices.map((d) => ({ device_id: d.device_id, is_remote: d.is_remote, online: d.online, label: deviceDisplayName(d) }));
}

export type BulkMovePlan = {
  /** Sessions the migration batch takes (a cloud host is on one end). */
  batch: any[];
  /** Local-to-local re-homes: the destination laptop already holds (or can clone) the checkout. */
  reassign: any[];
  /** Sessions that stay, and why. */
  skipped: Array<{ session: any; reason: string }>;
};

/** Which rail each session takes to `device`; pure, so the split is testable. */
export function planBulkMove(sessions: any[], device: Device, devices: Device[]): BulkMovePlan {
  const target = asPlanDevices([device])[0];
  const plan = asPlanDevices(devices);
  const out: BulkMovePlan = { batch: [], reassign: [], skipped: [] };
  const seen = new Set<string>();
  for (const s of sessions) {
    if (!s?._id || seen.has(s._id)) continue;
    seen.add(s._id);
    const e = eligibilityFor(asMigrationCandidate(s), target, plan);
    if (e.ok) { out.batch.push(s); continue; }
    // Laptop → laptop is the existing re-home, not a migration: the plan
    // refuses it with this reason precisely so a caller can route it there.
    if (!device.is_remote && e.reason.startsWith("not on a cloud host")) {
      if (!device.online) out.skipped.push({ session: s, reason: `${deviceDisplayName(device)} is offline` });
      else out.reassign.push(s);
      continue;
    }
    out.skipped.push({ session: s, reason: e.reason });
  }
  return out;
}

