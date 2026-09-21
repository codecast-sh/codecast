import { describe, expect, test } from "bun:test";
import { STALE_MACHINE_MS, canRemoveMachine, isStaleMachine, splitStaleMachines } from "../staleMachines";

const NOW = 1_800_000_000_000;
const m = (over: Record<string, any>) => ({ device_id: "d", online: false, last_seen: NOW, platform: "darwin", is_remote: false, ...over });

describe("staleMachines", () => {
  test("an online machine cannot be removed, however old its last_seen reads", () => {
    const d = m({ online: true, last_seen: NOW - 10 * STALE_MACHINE_MS });
    expect(canRemoveMachine(d)).toBe(false);
    expect(isStaleMachine(d, NOW)).toBe(false);
  });

  test("offline is removable at once, stale only after a day", () => {
    expect(canRemoveMachine(m({ last_seen: NOW - 60_000 * 10 }))).toBe(true);
    expect(isStaleMachine(m({ last_seen: NOW - STALE_MACHINE_MS + 1 }), NOW)).toBe(false);
    expect(isStaleMachine(m({ last_seen: NOW - STALE_MACHINE_MS }), NOW)).toBe(true);
  });

  test("a cloud box that wakes on use is asleep, not gone: never swept into the cleanup group", () => {
    const box = m({ is_remote: true, platform: "linux", last_seen: NOW - 5 * STALE_MACHINE_MS });
    expect(canRemoveMachine(box)).toBe(true);
    expect(isStaleMachine(box, NOW)).toBe(false);
  });

  test("split keeps order inside each group", () => {
    const a = m({ device_id: "a", online: true });
    const b = m({ device_id: "b", last_seen: NOW - 2 * STALE_MACHINE_MS });
    const c = m({ device_id: "c", last_seen: NOW - 3_600_000 });
    const e = m({ device_id: "e", last_seen: NOW - 3 * STALE_MACHINE_MS });
    const { current, stale } = splitStaleMachines([a, b, c, e], NOW);
    expect(current.map((d) => d.device_id)).toEqual(["a", "c"]);
    expect(stale.map((d) => d.device_id)).toEqual(["b", "e"]);
  });
});
