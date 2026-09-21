import { describe, expect, test } from "bun:test";
import { runOwnerOf, runOwnerWakeOf, runParentOf, runResultThreadOf } from "./triggerLifecycle";

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
  // A repeating trigger has no owner, so a clean run stays silent — that is
  // what --spawn buys. Its bad outcomes still reach the session that armed it:
  // the run nests there (runParentOf) and is therefore out of the inbox, so a
  // death or an ask that woke nobody would be buried rather than merely quiet.
  test.each(["failed", "unreported_exit", "attention"] as const)(
    "a repeating trigger's %s wakes the session that armed it",
    (outcome) => {
      expect(runOwnerWakeOf({ ...onceSpawn, schedule_type: "recurring" }, outcome)).toBe("creator");
    },
  );
  test("a repeating trigger's clean report wakes nobody, --wake or not", () => {
    expect(runOwnerWakeOf({ ...onceSpawn, schedule_type: "recurring" }, "reported")).toBeUndefined();
    expect(runOwnerWakeOf({ ...onceSpawn, schedule_type: "recurring", wake_creator: true }, "reported")).toBeUndefined();
  });
  test("a trigger armed outside any session wakes nobody", () => {
    expect(runOwnerWakeOf({ schedule_type: "recurring" }, "failed")).toBeUndefined();
  });
  test("an inject trigger has no fresh run, so nothing to wake", () => {
    expect(runOwnerWakeOf({ ...onceSpawn, originating_conversation_id: "home" }, "failed")).toBeUndefined();
  });
});

// Nesting is not posting. Every spawn run sits under the session that armed
// it, repeating included; runResultThreadOf stays narrow so a repeating
// trigger does not also post a line per firing into that session's thread.
describe("runParentOf", () => {
  test.each(["once", "recurring", "event"] as const)("a %s spawn run nests under its creator", (schedule_type) => {
    expect(runParentOf({ ...onceSpawn, schedule_type })).toBe("creator");
  });
  test("an inject trigger has no run of its own to nest", () => {
    expect(runParentOf({ ...onceSpawn, originating_conversation_id: "home" })).toBeUndefined();
  });
  test("a trigger armed outside any session has no parent", () => {
    expect(runParentOf({ schedule_type: "recurring" })).toBeUndefined();
  });
  test("a repeating run has a parent to nest under but no thread to post to", () => {
    const recurring = { ...onceSpawn, schedule_type: "recurring" };
    expect(runParentOf(recurring)).toBe("creator");
    expect(runResultThreadOf(recurring)).toBeUndefined();
  });
});

describe("runResultThreadOf", () => {
  test("--thread names the thread outright, else the owner", () => {
    expect(runResultThreadOf({ ...onceSpawn, target_conversation_id: "thread" })).toBe("thread");
    expect(runResultThreadOf(onceSpawn)).toBe("creator");
    expect(runResultThreadOf({ ...onceSpawn, schedule_type: "recurring" })).toBeUndefined();
  });
});
