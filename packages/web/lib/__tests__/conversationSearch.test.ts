import { describe, expect, test } from "bun:test";
import {
  ACTIVATION_DEADLINE_MS,
  MOUNT_GRACE_MS,
  instancesFromMatches,
  planActivation,
  skipDeadHit,
  stepIndex,
  walkSearchPages,
  type ActivationView,
  type PendingHit,
} from "../conversationSearch";

const view = (over: Partial<ActivationView> = {}): ActivationView => ({
  loaded: true, rowIndex: 3, expandKey: null, expanded: false, mounted: true, markCount: 2, canJump: true, elapsedMs: 100, ...over,
});
const hit = (over: Partial<PendingHit> = {}): PendingHit => ({
  messageId: "m1", localIndex: 1, timestamp: 10, dir: 1, startedAt: 0, jumped: false, skipped: 0, ...over,
});

describe("instancesFromMatches / stepIndex", () => {
  test("one instance per hit, in transcript order", () => {
    expect(instancesFromMatches([{ message_id: "a", timestamp: 1, match_count: 2 }, { message_id: "b", timestamp: 2, match_count: 1 }]))
      .toEqual([{ messageId: "a", localIndex: 0, timestamp: 1 }, { messageId: "a", localIndex: 1, timestamp: 1 }, { messageId: "b", localIndex: 0, timestamp: 2 }]);
  });
  test("wraps both ways", () => {
    expect(stepIndex(0, -1, 7)).toBe(6);
    expect(stepIndex(6, 1, 7)).toBe(0);
    expect(stepIndex(0, 1, 0)).toBe(0);
  });
});

describe("walkSearchPages", () => {
  test("appends pages in order and reports done on the last one", async () => {
    const pages = [
      { matches: [{ message_id: "a", timestamp: 1, match_count: 1 }], next_after_ts: 100 },
      { matches: [], next_after_ts: 200 },
      { matches: [{ message_id: "b", timestamp: 300, match_count: 2 }], next_after_ts: null },
    ];
    const asked: (number | undefined)[] = [];
    const seen: [number, boolean][] = [];
    await walkSearchPages(async (after) => { asked.push(after); return pages[asked.length - 1]; }, (all, done) => seen.push([all.length, done]), () => false);
    expect(asked).toEqual([undefined, 100, 200]);
    expect(seen).toEqual([[1, false], [1, false], [2, true]]);
  });
  test("a cancelled walk lands no page", async () => {
    let calls = 0;
    const seen: number[] = [];
    await walkSearchPages(async () => { calls++; return { matches: [], next_after_ts: 5 }; }, (all) => seen.push(all.length), () => calls >= 2);
    expect(seen).toEqual([0]);
    expect(calls).toBe(2);
  });
});

describe("planActivation", () => {
  test("a hit outside the loaded window asks the server once, then waits", () => {
    expect(planActivation(hit(), view({ loaded: false }))).toEqual({ kind: "jump" });
    expect(planActivation(hit({ jumped: true }), view({ loaded: false }))).toEqual({ kind: "wait" });
    expect(planActivation(hit(), view({ loaded: false, canJump: false }))).toEqual({ kind: "wait" });
  });
  test("a loaded message with no row at this density is dead", () => {
    expect(planActivation(hit(), view({ rowIndex: -1 }))).toEqual({ kind: "dead" });
  });
  test("a folded row opens before anything scrolls", () => {
    expect(planActivation(hit(), view({ expandKey: "turn-9", mounted: false }))).toEqual({ kind: "expand", key: "turn-9" });
    expect(planActivation(hit(), view({ expandKey: "turn-9", expanded: true, mounted: false }))).toEqual({ kind: "scrollRow", index: 3 });
  });
  test("an unmounted row is scrolled to by index; a mounted one without marks gets a grace period", () => {
    expect(planActivation(hit(), view({ mounted: false }))).toEqual({ kind: "scrollRow", index: 3 });
    expect(planActivation(hit(), view({ markCount: 0, elapsedMs: MOUNT_GRACE_MS - 1 }))).toEqual({ kind: "wait" });
    expect(planActivation(hit(), view({ markCount: 0, elapsedMs: MOUNT_GRACE_MS }))).toEqual({ kind: "dead" });
  });
  test("activates the requested mark, clamped to what rendered", () => {
    expect(planActivation(hit({ localIndex: 1 }), view({ markCount: 2 }))).toEqual({ kind: "activate", markIndex: 1 });
    expect(planActivation(hit({ localIndex: 5 }), view({ markCount: 2 }))).toEqual({ kind: "activate", markIndex: 1 });
  });
  test("everything gives up at the deadline", () => {
    expect(planActivation(hit(), view({ loaded: false, elapsedMs: ACTIVATION_DEADLINE_MS }))).toEqual({ kind: "dead" });
  });
});

describe("skipDeadHit", () => {
  const instances = instancesFromMatches([{ message_id: "a", timestamp: 1, match_count: 1 }, { message_id: "b", timestamp: 2, match_count: 1 }, { message_id: "c", timestamp: 3, match_count: 1 }]);
  test("moves one step in the direction of travel and counts the skip", () => {
    const next = skipDeadHit(hit({ dir: -1 }), 0, instances, 999);
    expect(next?.index).toBe(2);
    expect(next?.hit).toMatchObject({ messageId: "c", dir: -1, startedAt: 999, jumped: false, skipped: 1 });
  });
  test("stops once every hit has been tried", () => {
    expect(skipDeadHit(hit({ skipped: 2 }), 0, instances, 0)).toBeNull();
  });
});
