import { describe, expect, test } from "bun:test";
import { batchLooksUnclaimed, eligibilityFor, type MigrationCandidate, type MigrationDevice } from "./migrationPlan";

// The panel's eligibility mirror of convex/sessionMigrations planMigration:
// the same answers, so a greyed row here is a skipped row there.

const laptop: MigrationDevice = { device_id: "laptop", is_remote: false, online: true, label: "MacBook" };
const laptopOff: MigrationDevice = { device_id: "desk", is_remote: false, online: false, label: "Desk" };
const box: MigrationDevice = { device_id: "box", is_remote: true, online: false, label: "Linux box" };
const devices = [laptop, laptopOff, box];

function c(over: Partial<MigrationCandidate> = {}): MigrationCandidate {
  return {
    _id: "c1", short_id: "c1short", title: "A", owner_device_id: "laptop", agent_type: "claude_code", project_path: "/x",
    worktree_name: null, worktree_branch: null, updated_at: 0, has_pending_messages: false, migration: null,
    cloud_placement: null, inbox_stashed_at: null, inbox_dismissed_at: null, ...over,
  };
}

describe("eligibilityFor", () => {
  test("laptop → cloud, cloud → laptop", () => {
    expect(eligibilityFor(c(), box, devices)).toEqual({ ok: true, direction: "to_cloud" });
    expect(eligibilityFor(c({ owner_device_id: "box" }), laptop, devices)).toEqual({ ok: true, direction: "to_local" });
    expect(eligibilityFor(c({ owner_device_id: null }), box, devices)).toEqual({ ok: true, direction: "to_cloud" });
  });

  test("refusals name their reason", () => {
    expect(eligibilityFor(c(), undefined, devices)).toEqual({ ok: false, reason: "pick a destination" });
    expect(eligibilityFor(c({ owner_device_id: "box" }), box, devices)).toEqual({ ok: false, reason: "already here" });
    expect(eligibilityFor(c({ migration: { batch_id: "mg-1", migration_id: "m" } }), box, devices).ok).toBe(false);
    expect(eligibilityFor(c({ cloud_placement: "pending" }), box, devices).ok).toBe(false);
    expect(eligibilityFor(c({ agent_type: "codex" }), box, devices)).toEqual({ ok: false, reason: "only Claude Code sessions can be transferred" });
    expect(eligibilityFor(c(), laptopOff, devices)).toEqual({ ok: false, reason: "not on a cloud host (use Run on this device instead)" });
    expect(eligibilityFor(c({ owner_device_id: "box" }), laptopOff, devices)).toEqual({ ok: false, reason: "Desk is offline" });
    expect(eligibilityFor(c(), box, [laptopOff, box]).ok).toBe(false);
    expect(eligibilityFor(c({ owner_device_id: "desk" }), box, devices)).toEqual({ ok: false, reason: "Desk is offline" });
    expect(eligibilityFor(c({ owner_device_id: null }), box, [laptopOff, box])).toEqual({ ok: false, reason: "no online laptop can run the transfer" });
  });
});

describe("batchLooksUnclaimed", () => {
  const b = (statuses: string[], age: number) => ({ created_at: 1_000_000 - age, rows: statuses.map((status) => ({ status })) });
  test("only a batch with nothing started, past the grace, looks unclaimed", () => {
    expect(batchLooksUnclaimed(b(["queued"], 10_000), 1_000_000)).toBe(false);
    expect(batchLooksUnclaimed(b(["queued"], 60_000), 1_000_000)).toBe(true);
    expect(batchLooksUnclaimed(b(["queued", "transferring"], 60_000), 1_000_000)).toBe(false);
    expect(batchLooksUnclaimed(b(["done"], 60_000), 1_000_000)).toBe(false);
    expect(batchLooksUnclaimed(b(["cancelled"], 60_000), 1_000_000)).toBe(false);
  });
});
