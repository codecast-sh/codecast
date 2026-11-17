import { describe, expect, test } from "bun:test";
import { batchLooksUnclaimed, conversationMigrationOf, eligibilityFor, migrationMoveView, MIGRATION_DONE_LINGER_MS, type MigrationBatch, type MigrationCandidate, type MigrationDevice } from "./migrationPlan";

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

describe("migrationMoveView", () => {
  const NOW = 1_000_000;
  const names = { dest: "Main Mac", from: "union-line-1", executor: "Main Mac" };
  const batch = (rowPatch: Record<string, unknown>, batchPatch: Record<string, unknown> = {}): MigrationBatch => ({
    batch_id: "mg-1", to_device_id: "mac", created_at: NOW - 60_000, updated_at: NOW, cancelled_at: null, wait_for_idle_ms: 0,
    concurrency: 1, executor_device_ids: ["mac"], total: 1, done: 0, failed: 0, cancelled: 0, active: 1, queued: 0, state: "running",
    rows: [{ migration_id: "r1", conversation_id: "c1", title: null, short_id: null, direction: "to_local", from_device_id: "box", to_device_id: "mac",
      executor_device_id: "mac", status: "transferring", stage: null, error: null, attempt: 1, started_at: NOW - 30_000, finished_at: null,
      updated_at: NOW, destination_path: null, verification: null, ...rowPatch } as any],
    ...batchPatch,
  });
  const view = (b: MigrationBatch, now = NOW) => migrationMoveView(conversationMigrationOf([b], "c1"), names, now);

  test("a running move names its destination and phase, and can be cancelled only before copying starts", () => {
    expect(view(batch({}))).toMatchObject({ phase: "moving", label: "Moving to Main Mac", detail: "copying work and transcript", cancellable: false, startedAt: NOW - 30_000 });
    expect(view(batch({ status: "waiting_idle" }))).toMatchObject({ detail: "waiting for the current turn to end", cancellable: true });
  });

  test("a queued move nobody picked up warns about the machine that should run it", () => {
    expect(view(batch({ status: "queued", started_at: null }, { created_at: NOW - 120_000 }))).toMatchObject({ tone: "warn", detail: "waiting for Main Mac to start it" });
  });

  test("a landed move says so briefly; a failed one carries the reason; a cancelled one says nothing", () => {
    expect(view(batch({ status: "done", finished_at: NOW - 1000 }))).toEqual({ phase: "done", label: "Now running on Main Mac" });
    expect(view(batch({ status: "done", finished_at: NOW - MIGRATION_DONE_LINGER_MS - 1 }))).toBeNull();
    expect(view(batch({ status: "failed", error: "worktree pull failed", finished_at: NOW }))).toEqual({ phase: "failed", label: "Move to Main Mac failed · worktree pull failed" });
    expect(view(batch({ status: "queued" }, { cancelled_at: NOW }))).toBeNull();
  });

  test("the newest batch holding the conversation wins", () => {
    const old = batch({ status: "failed" }, { batch_id: "mg-0", created_at: NOW - 600_000 });
    expect(conversationMigrationOf([old, batch({})], "c1")?.batch.batch_id).toBe("mg-1");
    expect(conversationMigrationOf([old], "other")).toBeNull();
  });
});
