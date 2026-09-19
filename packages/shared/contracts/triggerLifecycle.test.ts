import { describe, expect, test } from "bun:test";
import { runOwnerOf, runOwnerWakeOf, runResultThreadOf } from "./triggerLifecycle";

// A fresh run's owner is the session that armed a once trigger; every other
// shape has none. The owner is woken for outcomes it must act on, and for a
// clean report only when the trigger asked (--wake).
const onceSpawn = { schedule_type: "once", created_by_conversation_id: "creator" };

describe("runOwnerOf", () => {
  test("a once spawn trigger is owned by its creator", () => {
    expect(runOwnerOf(onceSpawn)).toBe("creator");
  });
  test("a repeating spawn trigger belongs to nobody", () => {
    expect(runOwnerOf({ ...onceSpawn, schedule_type: "recurring" })).toBeUndefined();
  });
  test("an inject trigger has no fresh run to own", () => {
    expect(runOwnerOf({ ...onceSpawn, originating_conversation_id: "home" })).toBeUndefined();
  });
  test("a trigger armed outside any session has no owner", () => {
    expect(runOwnerOf({ schedule_type: "once" })).toBeUndefined();
  });
});

describe("runOwnerWakeOf", () => {
  test.each(["failed", "unreported_exit", "attention"] as const)("%s wakes the owner", (outcome) => {
    expect(runOwnerWakeOf(onceSpawn, outcome)).toBe("creator");
  });
  test("a clean report wakes the owner only when the trigger asked", () => {
    expect(runOwnerWakeOf(onceSpawn, "reported")).toBeUndefined();
    expect(runOwnerWakeOf({ ...onceSpawn, wake_creator: true }, "reported")).toBe("creator");
  });
  test("no owner, no wake, whatever the outcome", () => {
    expect(runOwnerWakeOf({ ...onceSpawn, schedule_type: "recurring", wake_creator: true }, "failed")).toBeUndefined();
  });
});

describe("runResultThreadOf", () => {
  test("--thread names the thread outright, else the owner", () => {
    expect(runResultThreadOf({ ...onceSpawn, target_conversation_id: "thread" })).toBe("thread");
    expect(runResultThreadOf(onceSpawn)).toBe("creator");
    expect(runResultThreadOf({ ...onceSpawn, schedule_type: "recurring" })).toBeUndefined();
  });
});
