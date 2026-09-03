import { deriveLiveAt, rowLiveDeadlines, type LiveFactsRow } from "./inboxProjection";
import { describe, expect, test } from "bun:test";
import {
  INBOX_BUCKETS,
  INBOX_FACT_FIELDS,
  INBOX_PROJECTION_FIELDS,
  INBOX_PROJECTION_VERSION,
  INBOX_WINDOW_CAPS,
  classifyWorkState,
  isStashHidden,
  computeBucketStale,
  computeFold,
  digestProjection,
  emptyInboxTally,
  fnv1a32,
  fnv1a32Update,
  FNV1A32_OFFSET,
  isBelowFoldAt,
  isFoldExempt,
  isWorkingSetWindow,
  rollupParentIdOf,
  rideLeadPlacements,
  inWorkingSet,
  inboxEpoch,
  isHardBlocked,
  placeInboxRow,
  placeProjectableRow,
  projectInbox,
  selectWorkingSet,
  shouldShowInInbox,
  type InboxBucket,
  type InboxPlacementInput,
  type RollupRow,
  type WorkingSetRow,
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
  // string for exactly these triples. Change it only with a projection version
  // bump (v2: fold entered the digest).
  test("fixed test vector", () => {
    const entries: Array<[string, string, boolean]> = [
      ["conv_a", "working", false],
      ["conv_b", "needs_input", false],
      ["conv_c", "hidden", true],
    ];
    expect(digestProjection(entries)).toBe("5f7b16c8a03820a8");
  });

  test("empty set digests to sixteen zeros", () => {
    expect(digestProjection([])).toBe("0000000000000000");
  });

  test("order independent, bucket sensitive, id sensitive", () => {
    const a = digestProjection([["x", "working", false], ["y", "done", false]]);
    expect(digestProjection([["y", "done", false], ["x", "working", false]])).toBe(a);
    expect(digestProjection([["x", "done", false], ["y", "working", false]])).not.toBe(a);
    expect(digestProjection([["x", "working", false], ["z", "done", false]])).not.toBe(a);
    expect(a).toMatch(/^[0-9a-f]{16}$/);
  });

  // A fold flip with unchanged buckets MUST change the digest: with show old
  // off the headline count is the shown tally, so two replicas that agree on
  // every bucket but cut the fold differently are diverged (design C3).
  test("a fold flip with unchanged buckets changes the digest", () => {
    const base: Array<[string, string, boolean]> = [
      ["conv_a", "working", false],
      ["conv_b", "needs_input", false],
      ["conv_c", "hidden", true],
    ];
    for (let i = 0; i < base.length; i++) {
      const flipped = base.map(([id, b, f], j) => [id, b, j === i ? !f : f] as [string, string, boolean]);
      expect(digestProjection(flipped)).not.toBe(digestProjection(base));
    }
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
    // A killed row never files as a question, whatever asked: nobody can
    // answer a torn-down session's prompt or pending decide. Pinned keeps it
    // visible under Pinned (two-replica simulation, seed 86).
    expect(placeInboxRow(input({ killed: true, asking: true })).bucket).toBe("idle");
    expect(placeInboxRow(input({ killed: true, asking: true, pinned: true })).bucket).toBe("pinned");
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

// A live harness /loop asleep on a wakeup parks its session exactly like an
// armed inject trigger — the machine owns the next move (2026-08-31: these
// sessions filed under Needs Input with no visible wake).
describe("classifyWorkState armedLoopHome", () => {
  test("a settled session with an armed loop rests dormant", () => {
    expect(classifyWorkState(input({ armedLoopHome: true }))).toBe("dormant");
  });

  test("hard blocks outrank the loop park", () => {
    expect(classifyWorkState(input({ armedLoopHome: true, awaitingInput: true }))).toBe("needs_input");
    expect(classifyWorkState(input({ armedLoopHome: true, agentStatus: "permission_blocked" }))).toBe("needs_input");
  });

  test("an active turn outranks the loop park", () => {
    expect(classifyWorkState(input({ armedLoopHome: true, agentStatus: "working", isIdle: false }))).toBe("working");
  });
});

// ── The working set, fold and whole-projection call (design C4/C5) ──────────

const EPOCH = inboxEpoch(1_800_000_000_000);
const DAY = 24 * 60 * 60 * 1000;
const HOUR = 60 * 60 * 1000;

function row(id: string, overrides: Record<string, any> = {}): WorkingSetRow & Record<string, any> {
  return {
    _id: id,
    status: "active",
    updated_at: EPOCH - 2 * HOUR,
    message_count: 4,
    title: `Session ${id}`,
    ...overrides,
  };
}

describe("shouldShowInInbox (the lifted pure rule)", () => {
  test("drops subagents, orphans, blank completed rows, noise titles, killed unless pinned", () => {
    expect(shouldShowInInbox(row("a"))).toBe(true);
    expect(shouldShowInInbox(row("s", { is_subagent: true }))).toBe(false);
    expect(shouldShowInInbox(row("w", { is_workflow_sub: true }))).toBe(false);
    expect(shouldShowInInbox(row("o", { parent_conversation_id: "p", parent_message_uuid: undefined }))).toBe(false);
    expect(shouldShowInInbox(row("f", { parent_conversation_id: "p", parent_message_uuid: "m" }))).toBe(true);
    expect(shouldShowInInbox(row("b", { status: "completed", message_count: 0 }))).toBe(false);
    expect(shouldShowInInbox(row("n", { title: "[Using: claude]" }))).toBe(false);
    expect(shouldShowInInbox(row("wu", { title: "Warmup" }))).toBe(false);
    expect(shouldShowInInbox(row("k", { inbox_killed_at: EPOCH }))).toBe(false);
    expect(shouldShowInInbox(row("kp", { inbox_killed_at: EPOCH, inbox_pinned_at: EPOCH }))).toBe(true);
  });
});

describe("inWorkingSet", () => {
  test("window eligibility per the C4 table", () => {
    expect(inWorkingSet(row("recent"), EPOCH)).toEqual(["recent"]);
    expect(inWorkingSet(row("old", { updated_at: EPOCH - 31 * DAY }), EPOCH)).toEqual([]);
    expect(inWorkingSet(row("failed", { status: "failed" }), EPOCH)).toEqual([]);
    expect(inWorkingSet(row("pin", { inbox_pinned_at: EPOCH - HOUR }), EPOCH)).toEqual(["recent", "pinned"]);
    // A pin holds its seat past the recency window.
    expect(inWorkingSet(row("oldpin", { updated_at: EPOCH - 40 * DAY, inbox_pinned_at: EPOCH - 40 * DAY }), EPOCH)).toEqual(["pinned"]);
    expect(inWorkingSet(row("d", { inbox_dismissed_at: EPOCH - DAY }), EPOCH)).toEqual(["recent", "dismissed"]);
    expect(inWorkingSet(row("dold", { inbox_dismissed_at: EPOCH - 31 * DAY }), EPOCH)).toEqual(["recent"]);
    expect(inWorkingSet(row("st", { inbox_stashed_at: EPOCH - DAY }), EPOCH)).toEqual(["recent", "stashed"]);
    // Killed: out of the dismissed/stashed windows (per the C4 table); the pin
    // keeps it visible and its recency keeps its recent seat.
    expect(inWorkingSet(row("kd", { inbox_killed_at: EPOCH, inbox_dismissed_at: EPOCH - DAY, inbox_pinned_at: EPOCH - DAY }), EPOCH)).toEqual(["recent", "pinned"]);
    expect(inWorkingSet(row("kdo", { inbox_killed_at: EPOCH, inbox_dismissed_at: EPOCH - DAY, inbox_pinned_at: EPOCH - DAY, updated_at: EPOCH - 40 * DAY }), EPOCH)).toEqual(["pinned"]);
    expect(inWorkingSet(row("own", { owned_by_me: true }), EPOCH)).toEqual(["recent", "owned"]);
    // owned follows recent's status + recency rule.
    expect(inWorkingSet(row("ownold", { owned_by_me: true, updated_at: EPOCH - 31 * DAY }), EPOCH)).toEqual([]);
    // Nonmembers stay nonmembers whatever their stamps.
    expect(inWorkingSet(row("sub", { is_subagent: true, inbox_pinned_at: EPOCH }), EPOCH)).toEqual([]);
  });
});

describe("selectWorkingSet", () => {
  test("per-window top K by the pinned sort keys, overflow named in truncated", () => {
    const rows = Array.from({ length: INBOX_WINDOW_CAPS.recent + 1 }, (_, i) =>
      row(`r${i}`, { updated_at: EPOCH - HOUR - i * 1000 }));
    const { members, truncated } = selectWorkingSet(rows, EPOCH);
    expect(truncated).toEqual(["recent"]);
    expect(members.size).toBe(INBOX_WINDOW_CAPS.recent);
    expect(members.has("r0")).toBe(true); // newest survives
    expect(members.has(`r${INBOX_WINDOW_CAPS.recent}`)).toBe(false); // oldest dropped
  });

  test("pinned overflow drops the oldest pin, never a fresh one", () => {
    const rows = Array.from({ length: INBOX_WINDOW_CAPS.pinned + 1 }, (_, i) =>
      row(`p${i}`, { updated_at: EPOCH - 40 * DAY, inbox_pinned_at: EPOCH - HOUR - i * 1000 }));
    const { members, truncated } = selectWorkingSet(rows, EPOCH);
    expect(truncated).toEqual(["pinned"]);
    expect(members.has("p0")).toBe(true);
    expect(members.has(`p${INBOX_WINDOW_CAPS.pinned}`)).toBe(false);
  });

  test("a row eligible in several windows is one member carrying its eligibility windows", () => {
    const { members, truncated } = selectWorkingSet([row("a", { inbox_pinned_at: EPOCH - HOUR, owned_by_me: true })], EPOCH);
    expect(truncated).toEqual([]);
    expect(members.size).toBe(1);
    expect(members.get("a")!.windows).toEqual(["recent", "pinned", "owned"]);
  });

  test("every truncation flag fires at its cap", () => {
    const rows = [
      ...Array.from({ length: INBOX_WINDOW_CAPS.recent + 1 }, (_, i) => row(`r${i}`, { updated_at: EPOCH - HOUR - i * 1000 })),
      ...Array.from({ length: INBOX_WINDOW_CAPS.pinned + 1 }, (_, i) => row(`p${i}`, { updated_at: EPOCH - 40 * DAY, inbox_pinned_at: EPOCH - i * 1000 })),
      ...Array.from({ length: INBOX_WINDOW_CAPS.dismissed + 1 }, (_, i) => row(`d${i}`, { updated_at: EPOCH - 40 * DAY, inbox_dismissed_at: EPOCH - DAY - i * 1000 })),
      ...Array.from({ length: INBOX_WINDOW_CAPS.stashed + 1 }, (_, i) => row(`s${i}`, { updated_at: EPOCH - 40 * DAY, inbox_stashed_at: EPOCH - DAY - i * 1000 })),
      ...Array.from({ length: INBOX_WINDOW_CAPS.owned + 1 }, (_, i) => row(`o${i}`, { updated_at: EPOCH - 39 * DAY - i * 1000, owned_by_me: true })),
    ];
    // The 39d-old owned rows are outside the recency window (owned follows
    // recent's rule), so "owned" stays silent while the other four fire…
    expect(selectWorkingSet(rows, EPOCH).truncated).toEqual(["recent", "pinned", "dismissed", "stashed"]);
    // …and fires once its rows are recent-eligible.
    const fresh = rows.map((r) => (String(r._id).startsWith("o") ? { ...r, updated_at: EPOCH - 2 * HOUR } : r));
    expect(selectWorkingSet(fresh, EPOCH).truncated).toEqual(["recent", "pinned", "dismissed", "stashed", "owned"]);
  });
});

describe("computeFold", () => {
  test("12h gap cut over recent-only members; deliberate windows and queued work exempt", () => {
    const rows = [
      row("fresh", { updated_at: EPOCH - HOUR }),
      row("edge", { updated_at: EPOCH - 15 * HOUR }),
      row("old", { updated_at: EPOCH - 16 * HOUR }),
      row("old_pin", { updated_at: EPOCH - 17 * HOUR, inbox_pinned_at: EPOCH - HOUR }),
      row("old_owned", { updated_at: EPOCH - 18 * HOUR, owned_by_me: true }),
      row("old_pending", { updated_at: EPOCH - 19 * HOUR, has_pending_messages: true }),
      row("old_dismissed", { updated_at: EPOCH - 20 * HOUR, inbox_dismissed_at: EPOCH - HOUR }),
    ];
    const { members } = selectWorkingSet(rows, EPOCH);
    const { belowFold, cutoff } = computeFold(members);
    // The row AT the gap is the cut and never folds itself.
    expect(cutoff).toBe(EPOCH - 15 * HOUR);
    expect(belowFold.has("edge")).toBe(false);
    expect(belowFold.has("old")).toBe(true);
    expect(belowFold.has("old_pin")).toBe(false);
    expect(belowFold.has("old_owned")).toBe(false);
    expect(belowFold.has("old_pending")).toBe(false);
    expect(belowFold.has("old_dismissed")).toBe(false);
    expect(belowFold.has("fresh")).toBe(false);
  });

  test("no gap, no fold; deliberate rows cannot bridge a gap", () => {
    const noGap = selectWorkingSet([row("a"), row("b", { updated_at: EPOCH - 3 * HOUR })], EPOCH);
    expect(computeFold(noGap.members)).toEqual({ belowFold: new Set(), cutoff: 0 });
    // A pinned row sitting inside the gap must not hide it.
    const bridged = selectWorkingSet([
      row("fresh", { updated_at: EPOCH - HOUR }),
      row("bridge", { updated_at: EPOCH - 8 * HOUR, inbox_pinned_at: EPOCH - HOUR }),
      row("old", { updated_at: EPOCH - 16 * HOUR }),
    ], EPOCH);
    const { belowFold, cutoff } = computeFold(bridged.members);
    expect(cutoff).toBe(EPOCH - 16 * HOUR);
    expect(belowFold.has("old")).toBe(false); // at the cut, not under it
  });
});

describe("projectInbox", () => {
  const rows = () => [
    row("working", { agent_status: "working", is_idle: false, updated_at: EPOCH - HOUR }),
    row("needs", { is_idle: true, updated_at: EPOCH - 2 * HOUR }),
    row("ask", { is_idle: true, awaiting_input: true, updated_at: EPOCH - 2 * HOUR }),
    row("pin", { is_idle: true, inbox_pinned_at: EPOCH - HOUR, updated_at: EPOCH - 2 * HOUR }),
    row("anchor", { is_idle: true, anchor_id: "anchors_1", updated_at: EPOCH - 2 * HOUR }),
    // "edge" is the row AT the gap (the cut, never folded itself); "folded"
    // sits under it.
    row("edge", { is_idle: true, updated_at: EPOCH - 20 * HOUR }),
    row("folded", { is_idle: true, updated_at: EPOCH - 21 * HOUR }),
    row("sub", { is_subagent: true, agent_status: "working" }),
  ];

  test("membership, fold, placement, tallies and digest in one call", () => {
    const p = projectInbox(rows(), EPOCH, { asking: (id) => id === "ask" });
    expect(p.placements.get("working")).toMatchObject({ bucket: "working", below_fold: false });
    expect(p.placements.get("needs")).toMatchObject({ bucket: "needs_input", work_state: "needs_input" });
    expect(p.placements.get("ask")).toMatchObject({ bucket: "questions" });
    expect(p.placements.get("pin")).toMatchObject({ bucket: "pinned" });
    expect(p.placements.get("anchor")).toMatchObject({ bucket: "hidden" });
    expect(p.placements.get("folded")).toMatchObject({ bucket: "needs_input", below_fold: true });
    expect(p.placements.has("sub")).toBe(false);
    expect(p.placements.get("edge")).toMatchObject({ bucket: "needs_input", below_fold: false });
    // Hidden rows enter entries and the digest but never the tallies.
    expect(p.entries.find(([id]) => id === "anchor")).toEqual(["anchor", "hidden", false]);
    expect(p.tally.shown.hidden).toBe(0);
    expect(p.tally.shown.needs_input).toBe(2);
    expect(p.tally.folded.needs_input).toBe(1);
    expect(p.tally.shown.questions).toBe(1);
    expect(p.tally.shown.pinned).toBe(1);
    expect(p.tally.shown.working).toBe(1);
    expect(p.set_digest).toBe(digestProjection(p.entries));
  });

  test("a teammate rides its lead's bucket and fold; the tally counts it there", () => {
    const p = projectInbox(
      [
        ...rows(),
        // Under the cut on its own age, shown under a fresh lead.
        row("mate", { is_idle: true, updated_at: EPOCH - 21 * HOUR, spawned_by_conversation_id: "working", agent_team_name: "team" }),
        // Fresh on its own, folded with a lead under the cut.
        row("mate_of_folded", { is_idle: true, updated_at: EPOCH - HOUR, spawned_by_conversation_id: "folded", agent_team_name: "team" }),
      ],
      EPOCH,
    );
    expect(p.placements.get("mate")).toMatchObject({ bucket: "working", work_state: "needs_input", below_fold: false });
    expect(p.placements.get("mate_of_folded")).toMatchObject({ bucket: "needs_input", below_fold: true });
    expect(p.tally.shown.working).toBe(2);
    expect(p.tally.folded.needs_input).toBe(2);
    expect(p.set_digest).toBe(digestProjection(p.entries));
  });

  test("deterministic: same rows and epoch give identical output; showOld never changes it", () => {
    const a = projectInbox(rows(), EPOCH);
    const b = projectInbox([...rows()].reverse(), EPOCH);
    expect(b.set_digest).toBe(a.set_digest);
    expect(b.tally).toEqual(a.tally);
    expect(new Map(b.placements)).toEqual(new Map(a.placements));
  });
});

describe("placeProjectableRow — the park facts", () => {
  test("armed trigger home parks on the replicated last_turn_allows_park fact", () => {
    const base = row("t", { is_idle: true, armed_trigger_kind: "standing" });
    expect(placeProjectableRow({ ...base, last_turn_allows_park: true }, false, EPOCH).bucket).toBe("dormant");
    expect(placeProjectableRow({ ...base, last_turn_allows_park: false }, false, EPOCH).bucket).toBe("needs_input");
    // Absent fact: fall back to the machine-delivered preview rule.
    expect(placeProjectableRow({ ...base, last_message_preview: '<session-message from="x">hi</session-message>' }, false, EPOCH).bucket).toBe("dormant");
    expect(placeProjectableRow({ ...base, last_message_preview: "a human typed this" }, false, EPOCH).bucket).toBe("needs_input");
    expect(placeProjectableRow(base, false, EPOCH).bucket).toBe("dormant"); // no last user turn at all
  });

  test("armed loop home parks while fresh, un-parks when overdue", () => {
    const loop = (wakeupAt: number) => row("l", {
      is_idle: true,
      loop_state: { status: "armed", wakeup_at: wakeupAt, event_at: EPOCH - HOUR },
    });
    expect(placeProjectableRow(loop(EPOCH + HOUR), false, EPOCH).bucket).toBe("dormant");
    expect(placeProjectableRow(loop(EPOCH - HOUR), false, EPOCH).bucket).toBe("needs_input");
  });
});

describe("field ownership constants", () => {
  test("the fact and stamp alphabets are disjoint and pinned", () => {
    expect([...INBOX_FACT_FIELDS]).toEqual([
      "agent_status", "is_idle", "is_unresponsive", "awaiting_input", "is_connected",
      "tmux_session", "permission_mode", "agent_started_at", "open_tasks", "open_tasks_at",
      "message_count", "updated_at", "last_turn_allows_park",
      "agent_status_updated_at", "last_heartbeat", "last_role_is_user", "auq_open", "daemon_alive_until", "producing_until",
    ]);
    expect([...INBOX_PROJECTION_FIELDS]).toEqual([
      "bucket", "work_state", "asking", "below_fold", "bucket_stale_at", "stale_bucket",
    ]);
    for (const f of INBOX_PROJECTION_FIELDS) expect(INBOX_FACT_FIELDS).not.toContain(f);
  });

  test("the caps are the single source and the version is 3", () => {
    expect(INBOX_WINDOW_CAPS).toEqual({ recent: 200, pinned: 100, dismissed: 200, stashed: 200, owned: 200 });
    expect(INBOX_PROJECTION_VERSION).toBe(3);
  });
});

describe("isStashHidden — the stash mode flag", () => {
  test("true only while the stash stamp is set", () => {
    expect(isStashHidden({ inbox_stashed_at: 1, inbox_stash_hidden: true })).toBe(true);
    expect(isStashHidden({ inbox_stashed_at: 1, inbox_stash_hidden: false })).toBe(false);
    expect(isStashHidden({ inbox_stashed_at: 1 })).toBe(false);
    // A stale flag on an unstashed row is dead state, not a hide.
    expect(isStashHidden({ inbox_stashed_at: null, inbox_stash_hidden: true })).toBe(false);
    expect(isStashHidden({})).toBe(false);
  });
});

describe("rollupParentIdOf — the one child → parent rule", () => {
  test("a subagent or orphan rolls up to its parent; a plan handoff speaks for itself", () => {
    expect(rollupParentIdOf({ parent_conversation_id: "p", is_subagent: true, parent_message_uuid: "m" })).toBe("p");
    expect(rollupParentIdOf({ parent_conversation_id: "p" })).toBe("p"); // orphan: no parent message
    expect(rollupParentIdOf({ parent_conversation_id: "p", parent_message_uuid: "plan-handoff" })).toBeNull();
  });
  test("an agent-team teammate rolls up to its lead; a plain spawned session does not", () => {
    expect(rollupParentIdOf({ spawned_by_conversation_id: "lead", agent_team_name: "team" })).toBe("lead");
    expect(rollupParentIdOf({ spawned_by_conversation_id: "lead" })).toBeNull();
    expect(rollupParentIdOf({})).toBeNull();
  });
});

describe("rideLeadPlacements — a teammate rides its present lead", () => {
  const rowsById: Record<string, RollupRow> = {
    lead: {},
    mate: { spawned_by_conversation_id: "lead", agent_team_name: "team" },
    mate_of_mate: { spawned_by_conversation_id: "mate", agent_team_name: "team" },
    lead_absent: { spawned_by_conversation_id: "nobody", agent_team_name: "team" },
    handoff: { parent_conversation_id: "lead", parent_message_uuid: "plan-handoff" },
    a: { spawned_by_conversation_id: "b", agent_team_name: "team" },
    b: { spawned_by_conversation_id: "a", agent_team_name: "team" },
  };
  const placementsOf = (buckets: Record<string, InboxBucket>) =>
    new Map(Object.entries(buckets).map(([id, bucket]) => [id, { bucket, stamp: id }]));

  test("the bucket follows the lead through a chain; a plan handoff and a parentless teammate keep their own", () => {
    const p = placementsOf({ lead: "working", mate: "done", mate_of_mate: "needs_input", lead_absent: "needs_input", handoff: "done" });
    rideLeadPlacements(p, (id) => rowsById[id]);
    expect(p.get("mate")!.bucket).toBe("working");
    expect(p.get("mate_of_mate")!.bucket).toBe("working");
    expect(p.get("lead_absent")!.bucket).toBe("needs_input");
    expect(p.get("handoff")!.bucket).toBe("done");
    // Only the bucket rides unless the caller copies more.
    expect(p.get("mate")!.stamp).toBe("mate");
  });

  test("a pinned, stashed or dismissed teammate keeps its place and becomes the root its own riders take; a cycle rides nowhere", () => {
    const p = placementsOf({ lead: "working", mate: "stashed", mate_of_mate: "done", a: "done", b: "needs_input" });
    rideLeadPlacements(p, (id) => rowsById[id]);
    expect(p.get("mate")!.bucket).toBe("stashed");
    expect(p.get("mate_of_mate")!.bucket).toBe("stashed");
    expect(p.get("a")!.bucket).toBe("done");
    expect(p.get("b")!.bucket).toBe("needs_input");
    for (const own of ["pinned", "dismissed"] as const) {
      const q = placementsOf({ lead: "working", mate: own });
      rideLeadPlacements(q, (id) => rowsById[id]);
      expect(q.get("mate")!.bucket).toBe(own);
    }
  });

  test("copy carries more of the lead's stamp, read after the lead settled", () => {
    const p = placementsOf({ mate_of_mate: "done", mate: "done", lead: "working" });
    rideLeadPlacements(p, (id) => rowsById[id], (rider, lead) => { rider.stamp = lead.stamp; });
    expect(p.get("mate")!.stamp).toBe("lead");
    expect(p.get("mate_of_mate")!.stamp).toBe("lead");
  });

  test("input order never matters", () => {
    const ids = ["lead", "mate", "mate_of_mate", "lead_absent", "handoff"];
    const expectFrom = (order: string[]) => {
      const p = new Map(order.map((id) => [id, { bucket: (id === "lead" ? "working" : "done") as InboxBucket }]));
      rideLeadPlacements(p, (id) => rowsById[id]);
      return Object.fromEntries([...p].map(([id, v]) => [id, v.bucket]).sort());
    };
    expect(expectFrom([...ids].reverse())).toEqual(expectFrom(ids));
  });
});

describe("isBelowFoldAt — the per-row fold rule computeFold's loop reads", () => {
  const base: WorkingSetRow = { _id: "x", status: "active", updated_at: 100, message_count: 3 };
  test("no cut, exempt rows and queued work never fold; otherwise under the cut folds", () => {
    expect(isBelowFoldAt(base, 0)).toBe(false);
    expect(isBelowFoldAt(base, 200)).toBe(true);
    expect(isBelowFoldAt({ ...base, updated_at: 200 }, 200)).toBe(false);
    expect(isBelowFoldAt({ ...base, has_pending_messages: true }, 200)).toBe(false);
    for (const exempt of [{ inbox_pinned_at: 1 }, { inbox_dismissed_at: 1 }, { inbox_stashed_at: 1 }, { owned_by_me: true }]) {
      expect(isFoldExempt({ ...base, ...exempt })).toBe(true);
      expect(isBelowFoldAt({ ...base, ...exempt }, 200)).toBe(false);
    }
  });
});

describe("fnv1a32Update — the incremental form of the digest hash", () => {
  test("folding a string in pieces equals hashing it whole", () => {
    const whole = fnv1a32("abc:working:0");
    expect(fnv1a32Update(fnv1a32Update(FNV1A32_OFFSET, "abc:"), "working:0")).toBe(whole);
  });
  test("isWorkingSetWindow names exactly the five windows", () => {
    for (const w of ["recent", "pinned", "dismissed", "stashed", "owned"] as const) expect(isWorkingSetWindow(w)).toBe(true);
    for (const t of ["members", "member_rows", "foreign_scan"] as const) expect(isWorkingSetWindow(t)).toBe(false);
  });
});


// ── deriveLiveAt (ct-47609) ──────────────────────────────────────────────────
describe("deriveLiveAt: one idle rule at any instant", () => {
  const T0 = 1_800_000_000_000;
  const S = 1_000, MIN = 60 * S, H = 60 * MIN;
  // A tiny seeded generator so the property runs the same way every time.
  let seed = 12345;
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)];
  const maybe = <T,>(v: T): T | null => (rnd() < 0.3 ? null : v);
  const facts = (): LiveFactsRow => ({
    status: pick(["active", "active", "completed"]),
    updated_at: T0 - Math.floor(rnd() * 3 * H),
    message_count: pick([0, 3, 40]),
    has_pending_messages: rnd() < 0.2,
    inbox_dismissed_at: rnd() < 0.15 ? T0 - MIN : null,
    inbox_stashed_at: rnd() < 0.1 ? T0 - MIN : null,
    agent_status: maybe(pick(["working", "idle", "waiting", "dormant", "done", "stopped", "permission_blocked", "compacting"])),
    agent_status_updated_at: maybe(T0 - Math.floor(rnd() * 2 * H)),
    last_heartbeat: maybe(T0 - Math.floor(rnd() * 3 * MIN)),
    daemon_alive_until: maybe(T0 + Math.floor(rnd() * 10 * MIN) - 2 * MIN),
    producing_until: maybe(T0 + Math.floor(rnd() * 10 * MIN) - 2 * MIN),
    last_role_is_user: rnd() < 0.4,
    auq_open: rnd() < 0.2,
    open_tasks: rnd() < 0.3 ? [{}] : null,
    open_tasks_at: maybe(T0 - Math.floor(rnd() * 15 * MIN)),
    loop_state: null,
  });
  const live = (r: LiveFactsRow, t: number) => deriveLiveAt(r, t);

  test("re-running over the shipped (already coerced) live fields is idempotent", () => {
    for (let i = 0; i < 150; i++) {
      const r = facts();
      for (const t of [T0, T0 + 50 * S, T0 + 2 * MIN, T0 + 2 * H]) {
        const once = live(r, t);
        const twice = live({ ...r, agent_status: once.agent_status, awaiting_input: once.awaiting_input }, t);
        expect(twice).toEqual(once);
      }
    }
  });

  test("for fixed facts, is_idle never returns to false as time passes; an ask and a daemon never come back", () => {
    for (let i = 0; i < 150; i++) {
      const r = facts();
      let prev = live(r, T0 - H);
      for (let t = T0 - H + 5 * S; t <= T0 + 3 * H; t += 25 * S) {
        const cur = live(r, t);
        if (prev.is_idle) expect(cur.is_idle).toBe(true);
        if (!prev.awaiting_input) expect(cur.awaiting_input).toBe(false);
        if (!prev.daemon_alive) expect(cur.daemon_alive).toBe(false);
        prev = cur;
      }
    }
  });

  test("rowLiveDeadlines names every instant the derivation can change: it is constant between adjacent deadlines", () => {
    for (let i = 0; i < 150; i++) {
      const r = facts();
      const ds = [...new Set(rowLiveDeadlines(r).filter((d): d is number => d != null))].sort((a, b) => a - b);
      const points = [T0 - 4 * H, ...ds, T0 + 4 * H];
      for (let k = 0; k + 1 < points.length; k++) {
        const a = points[k], b = points[k + 1];
        if (b - a < 2) continue;
        expect(live(r, a)).toEqual(live(r, b - 1));
      }
    }
  });
});
