import { describe, expect, test } from "bun:test";
import {
  INBOX_BUCKETS,
  classifyWorkState,
  computeBucketStale,
  digestProjection,
  emptyInboxTally,
  fnv1a32,
  inboxEpoch,
  isHardBlocked,
  placeInboxRow,
  type InboxPlacementInput,
} from "./inboxProjection";

function input(partial: Partial<InboxPlacementInput> = {}): InboxPlacementInput {
  return {
    agentStatus: undefined,
    isIdle: true,
    awaitingInput: false,
    hasPending: false,
    isUnresponsive: false,
    messageCount: 5,
    dismissed: false,
    stashed: false,
    pinned: false,
    isAnchor: false,
    asking: false,
    ...partial,
  };
}

describe("digestProjection", () => {
  test("fnv1a32 matches the reference vectors", () => {
    expect(fnv1a32("")).toBe(0x811c9dc5);
    expect(fnv1a32("a")).toBe(0xe40c292c);
  });

  // The fixed vector: the server and every client must produce exactly this
  // string for exactly these pairs. Change it only with a projection version bump.
  test("fixed test vector", () => {
    const pairs: Array<[string, string]> = [
      ["conv_a", "working"],
      ["conv_b", "needs_input"],
      ["conv_c", "hidden"],
    ];
    expect(digestProjection(pairs)).toBe("f57ff86dff1ad249");
  });

  test("empty set digests to sixteen zeros", () => {
    expect(digestProjection([])).toBe("0000000000000000");
  });

  test("order independent, bucket sensitive, id sensitive", () => {
    const a = digestProjection([["x", "working"], ["y", "done"]]);
    expect(digestProjection([["y", "done"], ["x", "working"]])).toBe(a);
    expect(digestProjection([["x", "done"], ["y", "working"]])).not.toBe(a);
    expect(digestProjection([["x", "working"], ["z", "done"]])).not.toBe(a);
    expect(a).toMatch(/^[0-9a-f]{16}$/);
  });
});

describe("inboxEpoch", () => {
  test("quantizes to the minute", () => {
    expect(inboxEpoch(1_700_000_059_999)).toBe(1_700_000_040_000);
    expect(inboxEpoch(1_700_000_040_000)).toBe(1_700_000_040_000);
  });
});

describe("classifyWorkState — the pending API error rule", () => {
  test("an unresolved banner on a row with content is needs_input over every live signal", () => {
    expect(classifyWorkState(input({ pendingApiError: true, agentStatus: "working", isIdle: false }))).toBe("needs_input");
    expect(classifyWorkState(input({ pendingApiError: true, hasPending: true }))).toBe("needs_input");
    expect(classifyWorkState(input({ pendingApiError: true, agentStatus: "done" }))).toBe("needs_input");
  });

  test("a blank row with a banner is still idle, and a killed row still idle", () => {
    expect(classifyWorkState(input({ pendingApiError: true, messageCount: 0 }))).toBe("idle");
    expect(classifyWorkState(input({ pendingApiError: true, killed: true }))).toBe("idle");
  });
});

describe("placeInboxRow — bucket precedence", () => {
  test("dismissed outranks everything, stashed next", () => {
    expect(placeInboxRow(input({ dismissed: true, stashed: true, asking: true, pinned: true })).bucket).toBe("dismissed");
    expect(placeInboxRow(input({ stashed: true, asking: true, pinned: true })).bucket).toBe("stashed");
  });

  test("an anchor is hidden unless hard blocked", () => {
    expect(placeInboxRow(input({ isAnchor: true })).bucket).toBe("hidden");
    expect(placeInboxRow(input({ isAnchor: true, pinned: true, asking: true })).bucket).toBe("hidden");
    expect(placeInboxRow(input({ isAnchor: true, awaitingInput: true, asking: true })).bucket).toBe("questions");
    expect(placeInboxRow(input({ isAnchor: true, agentStatus: "permission_blocked" })).bucket).toBe("needs_input");
    expect(placeInboxRow(input({ isAnchor: true, pendingApiError: true })).bucket).toBe("needs_input");
    expect(placeInboxRow(input({ isAnchor: true, agentStatus: "stopped" })).bucket).toBe("needs_input");
    expect(placeInboxRow(input({ isAnchor: true, isUnresponsive: true })).bucket).toBe("needs_input");
    // A dead anchor with no content is not blocked on anyone.
    expect(placeInboxRow(input({ isAnchor: true, agentStatus: "stopped", messageCount: 0 })).bucket).toBe("hidden");
  });

  test("asking outranks pinned, pinned outranks the work buckets", () => {
    expect(placeInboxRow(input({ asking: true, pinned: true })).bucket).toBe("questions");
    const pinned = placeInboxRow(input({ pinned: true }));
    expect(pinned.bucket).toBe("pinned");
    // …and the verdict is still stamped underneath the pin.
    expect(pinned.work_state).toBe("needs_input");
    expect(placeInboxRow(input({ pinned: true, agentStatus: "working", isIdle: false })).work_state).toBe("working");
  });

  test("a blank row is new; content rows take their work state", () => {
    expect(placeInboxRow(input({ messageCount: 0 })).bucket).toBe("new");
    expect(placeInboxRow(input({})).bucket).toBe("needs_input");
    expect(placeInboxRow(input({ agentStatus: "done" })).bucket).toBe("done");
    expect(placeInboxRow(input({ agentStatus: "dormant" })).bucket).toBe("dormant");
    expect(placeInboxRow(input({ agentStatus: "working", isIdle: false })).bucket).toBe("working");
    expect(placeInboxRow(input({ killed: true })).bucket).toBe("idle");
  });

  test("a child's ask reaches the parent only through the asking flag", () => {
    expect(placeInboxRow(input({ asking: true })).bucket).toBe("questions");
    expect(placeInboxRow(input({ asking: false })).bucket).toBe("needs_input");
  });

  test("every bucket the function can produce is in the alphabet", () => {
    const seen = new Set<string>();
    for (const i of [
      input({ dismissed: true }), input({ stashed: true }), input({ isAnchor: true }), input({ asking: true }),
      input({ pinned: true }), input({ messageCount: 0 }), input({}), input({ agentStatus: "done" }),
      input({ agentStatus: "dormant" }), input({ agentStatus: "working", isIdle: false }), input({ killed: true }),
    ]) seen.add(placeInboxRow(i).bucket);
    expect([...seen].sort()).toEqual([...INBOX_BUCKETS].sort());
    expect(Object.keys(emptyInboxTally()).sort()).toEqual([...INBOX_BUCKETS].sort());
  });
});

describe("isHardBlocked", () => {
  test("each blocking condition", () => {
    expect(isHardBlocked(input({}))).toBe(false);
    expect(isHardBlocked(input({ awaitingInput: true }))).toBe(true);
    expect(isHardBlocked(input({ pendingApiError: true }))).toBe(true);
    expect(isHardBlocked(input({ pendingApiError: true, messageCount: 0 }))).toBe(false);
    expect(isHardBlocked(input({ agentStatus: "permission_blocked" }))).toBe(true);
    expect(isHardBlocked(input({ agentStatus: "stopped" }))).toBe(true);
    expect(isHardBlocked(input({ agentStatus: "stopped", messageCount: 0 }))).toBe(false);
    expect(isHardBlocked(input({ isUnresponsive: true }))).toBe(true);
  });
});

describe("computeBucketStale", () => {
  const T = 1_700_000_000_000;

  test("returns the earliest deadline whose passing changes the bucket, and the bucket there", () => {
    // Working until T+30s (grace), then needs_input; the T+10s deadline flips nothing.
    const placeAt = (now: number) =>
      placeInboxRow(input({ isIdle: now > T + 30_000, agentStatus: undefined }));
    const r = computeBucketStale(
      { deadlines: [T + 60_000, T + 10_000, T + 30_000, T - 5, null, undefined, NaN], placeAt, current: "working" },
      T,
    );
    expect(r).toEqual({ bucket_stale_at: T + 30_000, stale_bucket: "needs_input" });
  });

  test("null when no deadline flips the bucket", () => {
    const placeAt = () => placeInboxRow(input({}));
    expect(computeBucketStale({ deadlines: [T + 1, T + 2], placeAt, current: "needs_input" }, T))
      .toEqual({ bucket_stale_at: null, stale_bucket: null });
    expect(computeBucketStale({ deadlines: [], placeAt, current: "needs_input" }, T))
      .toEqual({ bucket_stale_at: null, stale_bucket: null });
  });

  test("deadlines at or before the placement clock are ignored", () => {
    let calls = 0;
    const placeAt = () => { calls++; return placeInboxRow(input({ agentStatus: "done" })); };
    computeBucketStale({ deadlines: [T, T - 1], placeAt, current: "needs_input" }, T);
    expect(calls).toBe(0);
  });
});
