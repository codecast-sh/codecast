import { describe, expect, test } from "bun:test";
import { asMigrationCandidate, planBulkMove } from "./bulkMovePlan";
import type { Device } from "../components/DeviceBadge";

// Which rail each session in a bulk move takes: the migration batch for a
// laptop↔cloud hop, the plain re-home for laptop→laptop, and a named skip
// for everything the server would refuse.

const dev = (o: Partial<Device>): Device => ({
  device_id: "x", label: "X", platform: "darwin", last_seen: 0, is_remote: false, local_project_roots: [], online: true, ...o,
});
const laptop = dev({ device_id: "laptop", label: "MacBook" });
const desk = dev({ device_id: "desk", label: "Desk", online: true });
const deskOff = dev({ device_id: "desk", label: "Desk", online: false });
const box = dev({ device_id: "box", label: "Linux", platform: "linux", is_remote: true, online: false, last_seen: Date.now() - 60_000 });
const devices = [laptop, desk, box];

const row = (o: Record<string, unknown>) => ({ _id: "c", short_id: "c000000", agent_type: "claude_code", owner_device_id: "laptop", ...o });

describe("planBulkMove", () => {
  test("laptop → cloud host goes through the batch", () => {
    const p = planBulkMove([row({ _id: "a" }), row({ _id: "b", owner_device_id: "desk" })], box, devices);
    expect(p.batch.map((s) => s._id)).toEqual(["a", "b"]);
    expect(p.reassign).toEqual([]);
    expect(p.skipped).toEqual([]);
  });

  test("cloud host → laptop goes through the batch; laptop → laptop re-homes", () => {
    const p = planBulkMove([row({ _id: "a", owner_device_id: "box" }), row({ _id: "b", owner_device_id: "desk" })], laptop, devices);
    expect(p.batch.map((s) => s._id)).toEqual(["a"]);
    expect(p.reassign.map((s) => s._id)).toEqual(["b"]);
  });

  test("skips name their reason: already there, mid-migration, not Claude, offline laptop", () => {
    const p = planBulkMove([
      row({ _id: "here" }),
      row({ _id: "busy", owner_device_id: "desk", migration_batch_id: "mg-1" }),
      row({ _id: "codex", owner_device_id: "desk", agent_type: "codex" }),
      row({ _id: "dup", owner_device_id: "desk" }),
      row({ _id: "dup", owner_device_id: "desk" }),
    ], laptop, devices);
    expect(p.reassign.map((s) => s._id)).toEqual(["dup"]);
    expect(p.skipped.map((x) => [x.session._id, x.reason])).toEqual([
      ["here", "already here"],
      ["busy", "already migrating (mg-1)"],
      ["codex", "only Claude Code sessions can be transferred"],
    ]);
    const off = planBulkMove([row({ _id: "a" })], deskOff, [laptop, deskOff, box]);
    expect(off.skipped).toEqual([{ session: expect.objectContaining({ _id: "a" }), reason: "Desk is offline" }]);
  });

  test("an inbox row maps onto the migration candidate shape", () => {
    expect(asMigrationCandidate({ _id: "a", has_pending: true, migration_batch_id: "mg-9", cloud_placement: "pending" })).toMatchObject({
      _id: "a", has_pending_messages: true, migration: { batch_id: "mg-9" }, cloud_placement: "pending", short_id: null, agent_type: null,
    });
  });
});
