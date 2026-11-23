import { HOSTED_AGENT_TYPE } from "./assistant";
import { DORMANT_CLAIM_TTL_MS, PARKED_WAKE_TTL_MS } from "./agentStatus";
import { deriveLiveAt, rowLiveDeadlines, rowPinPredatesTurn, rowWakeInputs } from "./inboxProjection";
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
  rollupParentIdOf,
  isStackedAsk,
  rideLeadPlacements,
  inWorkingSet,
  inboxEpoch,
  isHardBlocked,
  placeInboxRow,
  placeProjectableRow,
  projectInbox,
  selectWorkingSet,
  shouldShowInInbox,
  isAssignedAwayFromViewer,
  isAssignedAwayFromOwnerSet,
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

// A resume, a clear or a manual /compact lands the pane at an idle prompt with
// no turn behind it. The status is honest — the agent really is quiet — but it
// is not a verdict, and before ct-49533 nothing said so: the hook reported
// nothing at all, and whatever the daemon later observed was read as the end of
// a turn that never happened.
describe("classifyWorkState — a session boundary carries no verdict", () => {
  const boundary = (partial = {}) => input({ agentStatus: "idle", sessionBoundary: true, ...partial });

  test("a resume does not spend the row's own declaration", () => {
    // The regression: the boundary status is present, so without the flag the
    // declaredStatus fallback is skipped and the row falls through to
    // needs_input — a delivered session re-filed as one waiting on its human.
    expect(classifyWorkState(boundary({ declaredStatus: "done" }))).toBe("done");
    expect(classifyWorkState(input({ agentStatus: "idle", declaredStatus: "done" }))).toBe("needs_input");
  });

  test("a current settle verdict survives a resume", () => {
    expect(classifyWorkState(boundary({ settleVerdict: "done" }))).toBe("done");
  });

  test("with nothing declared the ball is still the human's", () => {
    expect(classifyWorkState(boundary())).toBe("needs_input");
  });

  test("the flag reaches only the verdict, never a hard block or a live status", () => {
    expect(classifyWorkState(boundary({ awaitingInput: true }))).toBe("needs_input");
    expect(classifyWorkState(input({ agentStatus: "permission_blocked", sessionBoundary: true }))).toBe("needs_input");
    expect(classifyWorkState(input({ agentStatus: "stopped", sessionBoundary: true }))).toBe("needs_input");
    expect(classifyWorkState(input({ agentStatus: "working", isIdle: false, sessionBoundary: true }))).toBe("working");
  });

  test("a blank session is still idle, and a killed one still killed", () => {
    expect(classifyWorkState(boundary({ messageCount: 0 }))).toBe("idle");
    expect(classifyWorkState(boundary({ killed: true }))).toBe("idle");
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

// A process that exits AFTER the agent declared the work delivered owes nobody
// anything: every headless trigger run ends this way, and reading that exit as
// a death filed each clean run under Needs You.
describe("classifyWorkState — an exit after a declared done", () => {
  test("a stopped agent whose row says done files under done", () => {
    expect(classifyWorkState(input({ agentStatus: "stopped", declaredStatus: "done" }))).toBe("done");
    expect(isHardBlocked(input({ agentStatus: "stopped", declaredStatus: "done" }))).toBe(false);
  });

  test("a done row with an armed once trigger parks, same as a live done", () => {
    expect(classifyWorkState(input({ agentStatus: "stopped", declaredStatus: "done", armedOnceTriggerHome: true }))).toBe("dormant");
  });

  test("any other declaration still reads as a death", () => {
    for (const declaredStatus of [null, "working", "dormant", "blocked"]) {
      expect(classifyWorkState(input({ agentStatus: "stopped", declaredStatus }))).toBe("needs_input");
      expect(isHardBlocked(input({ agentStatus: "stopped", declaredStatus }))).toBe(true);
    }
  });

  test("queued work or a hanging message on a dead agent still needs a human", () => {
    expect(classifyWorkState(input({ agentStatus: "stopped", declaredStatus: "done", hasPending: true }))).toBe("needs_input");
    expect(classifyWorkState(input({ agentStatus: "stopped", declaredStatus: "done", isUnresponsive: true }))).toBe("needs_input");
    expect(isHardBlocked(input({ agentStatus: "stopped", declaredStatus: "done", hasPending: true }))).toBe(true);
  });

  test("the hard blocks above it still win", () => {
    expect(classifyWorkState(input({ agentStatus: "stopped", declaredStatus: "done", awaitingInput: true }))).toBe("needs_input");
    expect(classifyWorkState(input({ agentStatus: "stopped", declaredStatus: "done", pendingApiError: true }))).toBe("needs_input");
  });
});

// A trigger-run session exits after each run and is resumed on the next firing, so that exit is not a death.
describe("classifyWorkState — an exit with an armed wake", () => {
  test("a stopped agent with a standing trigger or loop into it files dormant", () => {
    for (const declaredStatus of [null, "working", "dormant"]) {
      for (const armed of [{ armedTriggerHome: true }, { armedLoopHome: true }]) {
        expect(classifyWorkState(input({ agentStatus: "stopped", declaredStatus, ...armed }))).toBe("dormant");
        expect(isHardBlocked(input({ agentStatus: "stopped", declaredStatus, ...armed }))).toBe(false);
      }
    }
  });

  test("a declared block, queued work or an unresponsive agent still needs a human", () => {
    expect(classifyWorkState(input({ agentStatus: "stopped", declaredStatus: "blocked", armedTriggerHome: true }))).toBe("needs_input");
    expect(classifyWorkState(input({ agentStatus: "stopped", declaredStatus: "dormant", armedTriggerHome: true, hasPending: true }))).toBe("needs_input");
    expect(classifyWorkState(input({ agentStatus: "stopped", declaredStatus: "dormant", armedTriggerHome: true, isUnresponsive: true }))).toBe("needs_input");
  });

  test("a once trigger is not a standing wake", () => {
    expect(classifyWorkState(input({ agentStatus: "stopped", declaredStatus: "dormant", armedOnceTriggerHome: true }))).toBe("needs_input");
  });
});

describe("placeInboxRow — bucket precedence", () => {
  test("dismissed outranks everything, stashed next", () => {
    expect(placeInboxRow(input({ dismissed: true, stashed: true, asking: true, pinned: true })).bucket).toBe("dismissed");
    expect(placeInboxRow(input({ stashed: true, asking: true, pinned: true })).bucket).toBe("stashed");
  });

  test("an anchor is hidden unless hard blocked or asking", () => {
    expect(placeInboxRow(input({ isAnchor: true })).bucket).toBe("hidden");
    expect(placeInboxRow(input({ isAnchor: true, pinned: true })).bucket).toBe("hidden");
    // A `cast decide` in a standing session's own thread is how a lead raises
    // a choice (org-staffing.md S28): it files as a question like any row.
    expect(placeInboxRow(input({ isAnchor: true, asking: true })).bucket).toBe("questions");
    expect(placeInboxRow(input({ isAnchor: true, pinned: true, asking: true })).bucket).toBe("questions");
    expect(placeInboxRow(input({ isAnchor: true, awaitingInput: true, asking: true })).bucket).toBe("questions");
    expect(placeInboxRow(input({ isAnchor: true, agentStatus: "permission_blocked" })).bucket).toBe("needs_input");
    expect(placeInboxRow(input({ isAnchor: true, pendingApiError: true })).bucket).toBe("needs_input");
    expect(placeInboxRow(input({ isAnchor: true, agentStatus: "stopped" })).bucket).toBe("needs_input");
    expect(placeInboxRow(input({ isAnchor: true, isUnresponsive: true })).bucket).toBe("needs_input");
    // A dead anchor with no content is not blocked on anyone.
    expect(placeInboxRow(input({ isAnchor: true, agentStatus: "stopped", messageCount: 0 })).bucket).toBe("hidden");
  });

  test("an anchor answering a turn a person started files like any session", () => {
    // The eval lead answered a person and pinned itself dormant: the reply is
    // theirs to read, so it leaves hidden and files by its work state.
    expect(placeInboxRow(input({ isAnchor: true, personTurn: true, agentStatus: "dormant" })).bucket).toBe("dormant");
    expect(placeInboxRow(input({ isAnchor: true, personTurn: true })).bucket).not.toBe("hidden");
    // Its own machine-driven turns stay hidden.
    expect(placeInboxRow(input({ isAnchor: true, personTurn: false, agentStatus: "dormant" })).bucket).toBe("hidden");
  });

  test("placement reads the turn origin off the row", () => {
    const base = { _id: "a", updated_at: 1, message_count: 5, is_idle: true, agent_status: "dormant", anchor_id: "an1" };
    expect(placeProjectableRow({ ...base, last_turn_origin: "person" }, false, 2).bucket).toBe("dormant");
    expect(placeProjectableRow({ ...base, last_turn_origin: "machine" }, false, 2).bucket).toBe("hidden");
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
      input({ dismissed: true }), input({ stashed: true }), input({ snoozed: true }), input({ isAnchor: true }), input({ asking: true }),
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

  test("a declared block counts while the turn is settled or the daemon is gone", () => {
    expect(isHardBlocked(input({ declaredStatus: "blocked" }))).toBe(true);
    expect(isHardBlocked(input({ declaredStatus: "blocked", agentStatus: "idle" }))).toBe(true);
    expect(isHardBlocked(input({ declaredStatus: "blocked", messageCount: 0 }))).toBe(false);
    // A live status that is not idle is fresher than the pin.
    expect(isHardBlocked(input({ declaredStatus: "blocked", agentStatus: "working" }))).toBe(false);
    expect(isHardBlocked(input({ declaredStatus: "blocked", agentStatus: "dormant" }))).toBe(false);
    expect(isHardBlocked(input({ declaredStatus: "done" }))).toBe(false);
  });

  test("an anchor that declares itself blocked surfaces out of hidden", () => {
    expect(placeInboxRow(input({ isAnchor: true, declaredStatus: "blocked" })).bucket).toBe("needs_input");
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
// sessions filed under Needs You with no visible wake).
describe("classifyWorkState armedLoopHome", () => {
  test("a settled session with an armed loop rests dormant", () => {
    expect(classifyWorkState(input({ armedLoopHome: true }))).toBe("dormant");
  });

  test("hard blocks outrank the loop park", () => {
    expect(classifyWorkState(input({ armedLoopHome: true, awaitingInput: true }))).toBe("needs_input");
    expect(classifyWorkState(input({ armedLoopHome: true, agentStatus: "permission_blocked" }))).toBe("needs_input");
    // The agent's declared block is one of them.
    expect(classifyWorkState(input({ armedLoopHome: true, agentStatus: "idle", declaredStatus: "blocked" }))).toBe("needs_input");
    expect(classifyWorkState(input({ armedTriggerHome: true, declaredStatus: "blocked" }))).toBe("needs_input");
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

describe("isAssignedAwayFromViewer", () => {
  const ME = "users_me";
  const THEM = "users_them";

  test("unowned rows stay with the runner", () => {
    expect(isAssignedAwayFromViewer({ owner_user_id: null }, ME)).toBe(false);
    expect(isAssignedAwayFromViewer({}, ME)).toBe(false);
  });

  test("a session I own is mine even when another account runs it", () => {
    expect(isAssignedAwayFromViewer({ owner_user_id: ME }, ME)).toBe(false);
    expect(isAssignedAwayFromViewer({ owner_user_id: THEM, owned_by_me: true }, ME)).toBe(false);
  });

  test("a session assigned to someone else leaves my inbox, even if I run it", () => {
    expect(isAssignedAwayFromViewer({ owner_user_id: THEM }, ME)).toBe(true);
    expect(isAssignedAwayFromViewer({ owner_user_id: THEM, owned_by_me: false }, ME)).toBe(true);
  });

  test("no viewer means do not hide", () => {
    expect(isAssignedAwayFromViewer({ owner_user_id: THEM }, null)).toBe(false);
  });

  test("the owner-set form answers the same question", () => {
    expect(isAssignedAwayFromOwnerSet([], ME)).toBe(false);
    expect(isAssignedAwayFromOwnerSet([ME], ME)).toBe(false);
    expect(isAssignedAwayFromOwnerSet([THEM, ME], ME)).toBe(false);
    expect(isAssignedAwayFromOwnerSet([THEM], ME)).toBe(true);
    expect(isAssignedAwayFromOwnerSet([THEM], null)).toBe(false);
    // Convex ids arrive as objects with toString, not as strings.
    expect(isAssignedAwayFromOwnerSet([{ toString: () => ME }], ME)).toBe(false);
  });
});

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
    // A filed row is not recent material: its own window decides its seat.
    expect(inWorkingSet(row("pin", { inbox_pinned_at: EPOCH - HOUR }), EPOCH)).toEqual(["pinned"]);
    // A pin holds its seat past the recency window.
    expect(inWorkingSet(row("oldpin", { updated_at: EPOCH - 40 * DAY, inbox_pinned_at: EPOCH - 40 * DAY }), EPOCH)).toEqual(["pinned"]);
    expect(inWorkingSet(row("d", { inbox_dismissed_at: EPOCH - DAY }), EPOCH)).toEqual(["dismissed"]);
    // A dismiss past its window falls off the shelf; fresh activity cannot
    // bring it back through the recent window.
    expect(inWorkingSet(row("dold", { inbox_dismissed_at: EPOCH - 31 * DAY }), EPOCH)).toEqual([]);
    expect(inWorkingSet(row("st", { inbox_stashed_at: EPOCH - DAY }), EPOCH)).toEqual(["stashed"]);
    expect(inWorkingSet(row("sn", { inbox_snoozed_until: EPOCH + DAY }), EPOCH)).toEqual(["snoozed"]);
    // Killed: out of the dismissed/stashed windows (per the C4 table); the pin
    // keeps it visible.
    expect(inWorkingSet(row("kd", { inbox_killed_at: EPOCH, inbox_dismissed_at: EPOCH - DAY, inbox_pinned_at: EPOCH - DAY }), EPOCH)).toEqual(["pinned"]);
    expect(inWorkingSet(row("kdo", { inbox_killed_at: EPOCH, inbox_dismissed_at: EPOCH - DAY, inbox_pinned_at: EPOCH - DAY, updated_at: EPOCH - 40 * DAY }), EPOCH)).toEqual(["pinned"]);
    expect(inWorkingSet(row("own", { owned_by_me: true }), EPOCH)).toEqual(["recent", "owned"]);
    // An owner seat holds on its own: assignment puts the session in that
    // person's inbox whatever state it is in, so neither the recency window nor
    // the status gate can age it out.
    expect(inWorkingSet(row("ownold", { owned_by_me: true, updated_at: EPOCH - 31 * DAY }), EPOCH)).toEqual(["owned"]);
    expect(inWorkingSet(row("ownfailed", { owned_by_me: true, status: "failed" }), EPOCH)).toEqual(["owned"]);
    // Still a nonmember when the row itself is not inbox material.
    expect(inWorkingSet(row("ownsub", { owned_by_me: true, is_subagent: true }), EPOCH)).toEqual([]);
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
    expect(members.get("a")!.windows).toEqual(["pinned", "owned"]);
  });

  test("filed rows with fresh activity never take a recent seat from a plain settled row", () => {
    // Two hundred stashed sessions whose agents kept heartbeating, all fresher
    // than one plain session that settled two days ago (the "Delta ideas"
    // case, 2026-09-23). The plain row keeps its recent seat; the stashed
    // rows sit in the stashed window only, and nothing is truncated.
    const rows = [
      row("plain", { updated_at: EPOCH - 2 * DAY }),
      ...Array.from({ length: INBOX_WINDOW_CAPS.recent }, (_, i) =>
        row(`s${i}`, { updated_at: EPOCH - HOUR - i * 1000, inbox_stashed_at: EPOCH - DAY - i * 1000 })),
    ];
    const { members, truncated } = selectWorkingSet(rows, EPOCH);
    expect(truncated).toEqual([]);
    expect(members.get("plain")!.windows).toEqual(["recent"]);
    expect(members.get("s0")!.windows).toEqual(["stashed"]);
    expect(members.size).toBe(INBOX_WINDOW_CAPS.recent + 1);
  });

  test("every truncation flag fires at its cap", () => {
    const rows = [
      ...Array.from({ length: INBOX_WINDOW_CAPS.recent + 1 }, (_, i) => row(`r${i}`, { updated_at: EPOCH - HOUR - i * 1000 })),
      ...Array.from({ length: INBOX_WINDOW_CAPS.pinned + 1 }, (_, i) => row(`p${i}`, { updated_at: EPOCH - 40 * DAY, inbox_pinned_at: EPOCH - i * 1000 })),
      ...Array.from({ length: INBOX_WINDOW_CAPS.dismissed + 1 }, (_, i) => row(`d${i}`, { updated_at: EPOCH - 40 * DAY, inbox_dismissed_at: EPOCH - DAY - i * 1000 })),
      ...Array.from({ length: INBOX_WINDOW_CAPS.stashed + 1 }, (_, i) => row(`s${i}`, { updated_at: EPOCH - 40 * DAY, inbox_stashed_at: EPOCH - DAY - i * 1000 })),
      ...Array.from({ length: INBOX_WINDOW_CAPS.owned + 1 }, (_, i) => row(`o${i}`, { updated_at: EPOCH - 39 * DAY - i * 1000, owned_by_me: true })),
    ];
    // An owner seat needs no recency, so all five fire — the 39d-old owned rows
    // are members on the owner row alone.
    expect(selectWorkingSet(rows, EPOCH).truncated).toEqual(["recent", "pinned", "dismissed", "stashed", "owned"]);
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
    // The cut is the first activity past the gap, and that row folds with
    // everything older: filing the oldest shown row must not surface it.
    expect(cutoff).toBe(EPOCH - 15 * HOUR);
    expect(belowFold.has("edge")).toBe(true);
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
    expect(belowFold.has("old")).toBe(true); // the first row past the gap folds
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
    expect(p.placements.get("edge")).toMatchObject({ bucket: "needs_input", below_fold: true });
    // Hidden rows enter entries and the digest but never the tallies.
    expect(p.entries.find(([id]) => id === "anchor")).toEqual(["anchor", "hidden", false]);
    expect(p.tally.shown.hidden).toBe(0);
    expect(p.tally.shown.needs_input).toBe(1);
    expect(p.tally.folded.needs_input).toBe(2);
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
    expect(p.tally.folded.needs_input).toBe(3);
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

  test("a hosted conversation's routine never parks it: each run's answer files like any turn", () => {
    for (const kind of ["standing", "once"] as const) {
      const hosted = row("h", { is_idle: true, armed_trigger_kind: kind, last_turn_allows_park: true, agent_type: HOSTED_AGENT_TYPE });
      expect(placeProjectableRow(hosted, false, EPOCH).bucket).not.toBe("dormant");
      expect(placeProjectableRow({ ...hosted, thread_state_status: "done" }, false, EPOCH).bucket).toBe("done");
    }
  });

  test("armed loop home parks while fresh, un-parks when overdue", () => {
    const loop = (wakeupAt: number) => row("l", {
      is_idle: true,
      loop_state: { status: "armed", wakeup_at: wakeupAt, event_at: EPOCH - HOUR },
    });
    expect(placeProjectableRow(loop(EPOCH + HOUR), false, EPOCH).bucket).toBe("dormant");
    expect(placeProjectableRow(loop(EPOCH - HOUR), false, EPOCH).bucket).toBe("needs_input");
  });

  // A declared dormant is a promise about a wake. The status only re-derives
  // when the wake lands (that IS the next turn), so a promise nothing can
  // verify had no expiry at all: a session parked on "another session's reply"
  // that never came sat in Dormant for days. Past DORMANT_CLAIM_TTL_MS of quiet
  // a bare claim files needs_input; a verifiable wake keeps the park.
  test("a bare dormant claim expires into needs_input; a verifiable wake keeps it parked", () => {
    const claim = (quietFor: number, extra: Record<string, any> = {}) =>
      row("d", { is_idle: true, agent_status: "dormant", updated_at: EPOCH - quietFor, ...extra });
    expect(placeProjectableRow(claim(HOUR), false, EPOCH).bucket).toBe("dormant");
    expect(placeProjectableRow(claim(DORMANT_CLAIM_TTL_MS), false, EPOCH).bucket).toBe("needs_input");
    expect(placeProjectableRow(claim(11 * HOUR), false, EPOCH).bucket).toBe("needs_input");
    // Any wake the system can stand behind outlives the claim window.
    expect(placeProjectableRow(claim(11 * HOUR, { armed_trigger_kind: "once" }), false, EPOCH).bucket).toBe("dormant");
    expect(placeProjectableRow(claim(11 * HOUR, { armed_trigger_kind: "standing" }), false, EPOCH).bucket).toBe("dormant");
    expect(placeProjectableRow(claim(11 * HOUR, { loop_state: { status: "armed", wakeup_at: EPOCH + HOUR, event_at: EPOCH - HOUR } }), false, EPOCH).bucket).toBe("dormant");
    // Open tasks vouch only while the daemon that reported them heartbeats.
    const openTasks = { open_tasks: [{ id: "t1" }], open_tasks_at: EPOCH - 60_000 };
    expect(placeProjectableRow(claim(11 * HOUR, { ...openTasks, last_heartbeat: EPOCH - 1_000 }), false, EPOCH).bucket).toBe("dormant");
    expect(placeProjectableRow(claim(11 * HOUR, openTasks), false, EPOCH).bucket).toBe("needs_input");
    // A worker still producing: its result will wake the parent. Once it stops, the claim is judged again.
    expect(placeProjectableRow(claim(11 * HOUR, { producing_until: EPOCH + 60_000 }), false, EPOCH).bucket).toBe("dormant");
    expect(placeProjectableRow(claim(11 * HOUR, { producing_until: EPOCH - 60_000 }), false, EPOCH).bucket).toBe("needs_input");
    // Stale open-task report: the daemon has not vouched recently, so it is no wake.
    expect(placeProjectableRow(claim(11 * HOUR, { open_tasks: [{ id: "t1" }], open_tasks_at: EPOCH - 11 * HOUR }), false, EPOCH).bucket).toBe("needs_input");
    // A verified `waiting` (open work) has its own trust rule and is untouched.
    expect(placeProjectableRow(claim(11 * HOUR, { agent_status: "waiting", open_tasks: [{ id: "t1" }], open_tasks_at: EPOCH - 60_000 }), false, EPOCH).bucket).toBe("dormant");
  });

  // A hosted turn's status is the engine's own settle, written as the turn
  // ends. A finished answer used to sit under Working on it for the 45
  // second idle grace, though the reply was on screen (pl-840 round 10).
  test("a hosted row that just settled done files as done, without the idle grace", () => {
    const hosted = (extra: Record<string, any>) => {
      const facts = row("h", {
        agent_type: "codecast", message_count: 4, updated_at: EPOCH - 2_000,
        agent_status_updated_at: EPOCH - 1_000, is_idle: false, ...extra,
      });
      return placeProjectableRow({ ...facts, ...deriveLiveAt(facts, EPOCH) }, false, EPOCH).work_state;
    };
    expect(hosted({ agent_status: "done" })).toBe("done");
    expect(hosted({ agent_status: "working" })).toBe("working");
    // A daemon session in the same instant still waits out the grace.
    expect(hosted({ agent_type: "claude_code", agent_status: "done" })).toBe("working");
  });

  // A lead that ended its turn while its subagents (a background workflow's
  // workers, a background Agent) still produce is parked on them: their result
  // is its next turn. It used to read as working for the whole run (jx73a5s).
  test("a settled lead with a producing subagent child is dormant, not working", () => {
    const lead = (extra: Record<string, any>) => {
      const facts = row("lead", {
        message_count: 40, updated_at: EPOCH - HOUR / 2, last_heartbeat: EPOCH - 10_000,
        agent_status_updated_at: EPOCH - HOUR / 2, producing_until: EPOCH + 60_000, ...extra,
      });
      return placeProjectableRow({ ...facts, ...deriveLiveAt(facts, EPOCH) }, false, EPOCH);
    };
    const tasks = { open_tasks: [{ id: "w1", kind: "workflow" }], open_tasks_at: EPOCH - 60_000 };
    expect(lead({ agent_status: "waiting", ...tasks }).work_state).toBe("dormant");
    expect(lead({ agent_status: "idle" }).work_state).toBe("dormant");
    expect(lead({ agent_status: "idle", producing_until: EPOCH - 60_000 }).work_state).toBe("needs_input");
    expect(lead({ agent_status: "working" }).work_state).toBe("working");
    // A declared block still reaches the human while the workers run.
    expect(lead({ agent_status: "idle", thread_state_status: "blocked" }).work_state).toBe("needs_input");
  });

  // A park the server can see (parked_wake_kind) is a verified wake: a live
  // workflow run the session spawned ("run", jx7eqd1) or an open blocker on
  // the task it holds ("blocker", jx7cn1s). Each keeps the daemon's dormant
  // past the claim window; when it dies the claim is judged again.
  test("a server-seen run or blocker keeps a dormant claim parked past the claim window", () => {
    const parked = (kind: string | null) => {
      const facts = row("p", {
        agent_status: "dormant", agent_status_updated_at: EPOCH - 3 * HOUR, updated_at: EPOCH - 3 * HOUR,
        last_heartbeat: EPOCH - 5_000, daemon_alive_until: EPOCH + 60_000, message_count: 30, parked_wake_kind: kind,
      });
      return placeProjectableRow({ ...facts, ...deriveLiveAt(facts, EPOCH) }, false, EPOCH).bucket;
    };
    expect(parked("run")).toBe("dormant");
    expect(parked("blocker")).toBe("dormant");
    expect(parked("none")).toBe("needs_input");
    expect(parked(null)).toBe("needs_input");
  });

  // The stamp can go stale (a run whose runner died stays "running", a PR
  // webhook never arrives), so it vouches only for PARKED_WAKE_TTL_MS of quiet.
  test("a wait stamp stops vouching after PARKED_WAKE_TTL_MS of quiet; a task blocker never does", () => {
    const quiet = (quietFor: number, extra: Record<string, any> = {}) =>
      row("p", { is_idle: true, agent_status: "dormant", updated_at: EPOCH - quietFor, parked_wake_kind: "wait", ...extra });
    expect(PARKED_WAKE_TTL_MS).toBe(72 * HOUR);
    expect(placeProjectableRow(quiet(71 * HOUR), false, EPOCH).bucket).toBe("dormant");
    expect(placeProjectableRow(quiet(73 * HOUR), false, EPOCH).bucket).toBe("needs_input");
    // A daemon-less pin carried only by the stamp expires with it.
    const pin = { agent_status: null, status: "completed", thread_state_status: "dormant" };
    expect(placeProjectableRow(quiet(71 * HOUR, pin), false, EPOCH).bucket).toBe("dormant");
    expect(placeProjectableRow(quiet(73 * HOUR, pin), false, EPOCH).bucket).toBe("needs_input");
    // jx7cn1s, quiet 4 days with its blocker task still open: the task graph
    // is recomputed on every write, so that stamp is exact and stays.
    expect(placeProjectableRow(quiet(96 * HOUR, { ...pin, parked_wake_kind: "blocker" }), false, EPOCH).bucket).toBe("dormant");
    // An armed trigger keeps its own rule: no TTL.
    expect(placeProjectableRow(quiet(73 * HOUR, { armed_trigger_kind: "standing" }), false, EPOCH).bucket).toBe("dormant");
  });

  test("the stamp's expiry is a shared deadline: the time flip lands on needs_input at updated_at + PARKED_WAKE_TTL_MS", () => {
    const placedAt = EPOCH - 70 * HOUR;
    const r = row("p", { is_idle: true, agent_status: "dormant", updated_at: placedAt, parked_wake_kind: "wait" });
    expect(rowLiveDeadlines(r as any)).toContain(placedAt + PARKED_WAKE_TTL_MS);
    const placeAt = (t: number) => placeProjectableRow(r, false, t);
    const stale = computeBucketStale({ deadlines: rowLiveDeadlines(r as any), placeAt, current: "dormant" }, EPOCH);
    expect(stale).toEqual({ bucket_stale_at: placedAt + PARKED_WAKE_TTL_MS, stale_bucket: "needs_input" });
  });

  // jx729tp: a lead with a standing trigger into it answered a person, then
  // pinned dormant. Its managed session is gone, so the only declaration left
  // is the pin, and the person spoke last, so the trigger is no structural
  // park. The armed trigger still wakes it, so the pin stands.
  test("a daemon-less pinned dormant parks while a verified wake stands", () => {
    const lead = (extra: Record<string, any> = {}) => {
      const facts = row("lead", {
        status: "completed", agent_status: null, updated_at: EPOCH - 5 * HOUR, message_count: 120,
        armed_trigger_kind: "standing", last_turn_origin: "person",
        last_message_preview: "yes, start a fix session", thread_state_status: "dormant", ...extra,
      });
      return placeProjectableRow({ ...facts, ...deriveLiveAt(facts, EPOCH) }, false, EPOCH).bucket;
    };
    expect(lead()).toBe("dormant");
    expect(lead({ updated_at: EPOCH - 100 * HOUR })).toBe("dormant");
    expect(lead({ armed_trigger_kind: "none" })).toBe("needs_input");
    // A declared block beats every park.
    expect(lead({ thread_state_status: "blocked" })).toBe("needs_input");
    // No pin: the structural park keeps the last-turn rule, and a person spoke last.
    expect(lead({ thread_state_status: null })).not.toBe("dormant");
    // Any verified wake carries the pin; a bare pin with no daemon has no one to wake it.
    // A run executes on the spawner's machine: with no daemon, nothing resumes it.
    expect(lead({ armed_trigger_kind: "none", parked_wake_kind: "run" })).toBe("needs_input");
    expect(lead({ armed_trigger_kind: "none", parked_wake_kind: "blocker" })).toBe("dormant");
    expect(lead({ armed_trigger_kind: "none", parked_wake_kind: "none" })).toBe("needs_input");
    // A hard block still wins over the pinned park.
    expect(lead({ pending_api_error: true })).toBe("needs_input");
  });

  // A pin written before the latest turn (a session message, a trigger
  // inject, a wait's wake) is not the agent's word on that turn, which may
  // have ended asking. Without a daemon status (hibernated, a boundary, an
  // aged-out managed row) nothing else carries a verdict, so the stale pin
  // must not park the row.
  test("a daemon-less pinned dormant older than the latest turn parks nothing", () => {
    const stale = {
      updated_at: EPOCH - 3 * HOUR, message_count: 40, is_idle: true, last_turn_origin: "machine", last_turn_allows_park: false,
      thread_state_status: "dormant", thread_state_at: EPOCH - 5 * HOUR, last_turn_at: EPOCH - 4 * HOUR,
    };
    const place = (extra: Record<string, any>) => placeProjectableRow(row("s", { ...stale, ...extra }), false, EPOCH).bucket;
    expect(place({ agent_status: "hibernated", parked_wake_kind: "blocker" })).toBe("needs_input");
    expect(place({ agent_status: "idle", agent_status_boundary: true, armed_trigger_kind: "standing" })).toBe("needs_input");
    expect(place({ agent_status: null, parked_wake_kind: "run" })).toBe("needs_input");
    // A pin written after the turn opened, or a row with no turn stamp (it
    // predates the field, as jx729tp's does), still parks.
    expect(place({ agent_status: null, parked_wake_kind: "blocker", thread_state_at: EPOCH - 4 * HOUR })).toBe("dormant");
    expect(place({ agent_status: null, parked_wake_kind: "blocker", last_turn_at: null })).toBe("dormant");
    expect(place({ agent_status: "hibernated", parked_wake_kind: "blocker", last_turn_at: undefined })).toBe("dormant");
  });

  test("a daemon-less pinned done older than the latest turn is not done", () => {
    const pin = (extra: Record<string, any>) => placeProjectableRow(row("d", {
      updated_at: EPOCH - 3 * HOUR, message_count: 40, is_idle: true, agent_status: null, last_turn_origin: "machine",
      thread_state_status: "done", thread_state_at: EPOCH - 5 * HOUR, ...extra,
    }), false, EPOCH).bucket;
    expect(pin({ last_turn_at: EPOCH - 4 * HOUR })).toBe("needs_input");
    expect(pin({ last_turn_at: EPOCH - 6 * HOUR })).toBe("done");
    expect(pin({})).toBe("done");
  });

  // rowArmedHomes never parks a hosted conversation on its routine, so its
  // trigger is no verified wake either: a pin there has no one to deliver it.
  test("a hosted conversation's armed trigger is no verified wake", () => {
    const pin = (agent_type: string) =>
      placeProjectableRow(row("h", {
        agent_status: null, status: "completed", is_idle: true, updated_at: EPOCH - 5 * HOUR, message_count: 10, agent_type,
        armed_trigger_kind: "standing", thread_state_status: "dormant",
      }), false, EPOCH).bucket;
    expect(pin(HOSTED_AGENT_TYPE)).toBe("needs_input");
    expect(pin("claude_code")).toBe("dormant");
  });

  // A process that exits while pinned dormant on a server-seen park files the
  // same way as when its managed row later ages out: dormant.
  test("a dead process pinned dormant on a live park files dormant, the same as an aged-out row", () => {
    const parked = (extra: Record<string, any>) =>
      placeProjectableRow(row("x", {
        updated_at: EPOCH - 3 * HOUR, message_count: 30, is_idle: true, thread_state_status: "dormant", parked_wake_kind: "blocker", ...extra,
      }), false, EPOCH).bucket;
    expect(parked({ agent_status: "stopped" })).toBe("dormant");
    expect(parked({ agent_status: null })).toBe("dormant");
    // Past a wait's TTL, a stale pin, queued work, unresponsive, or a declared block: a human must look.
    expect(parked({ agent_status: "stopped", parked_wake_kind: "wait", updated_at: EPOCH - 73 * HOUR })).toBe("needs_input");
    expect(parked({ agent_status: "stopped", thread_state_at: EPOCH - 5 * HOUR, last_turn_at: EPOCH - 4 * HOUR })).toBe("needs_input");
    expect(parked({ agent_status: "stopped", has_pending_messages: true })).not.toBe("dormant");
    expect(parked({ agent_status: "stopped", is_unresponsive: true })).toBe("needs_input");
    expect(parked({ agent_status: "stopped", thread_state_status: "blocked" })).toBe("needs_input");
    expect(parked({ agent_status: "stopped", parked_wake_kind: "none" })).toBe("needs_input");
    // A run needs its spawner's machine: it counts only while that daemon's heartbeat lives.
    expect(parked({ agent_status: "stopped", parked_wake_kind: "run" })).toBe("needs_input");
    expect(parked({ agent_status: null, parked_wake_kind: "run" })).toBe("needs_input");
    expect(parked({ agent_status: "dormant", parked_wake_kind: "run", last_heartbeat: EPOCH - 5_000, daemon_alive_until: EPOCH + 60_000 })).toBe("dormant");
  });

  // One rule for a run on every path: it counts only while the row's daemon
  // heartbeat lives. The daemon hibernates a dormant session after its idle
  // window; its heartbeat still beats, and so does the run.
  // A hung runner with a live pid is never resumed, and one that keeps dying
  // runs out of resumes: a run stamp also lives only PARKED_WAKE_TTL_MS.
  test("a run stamp stops vouching after PARKED_WAKE_TTL_MS of quiet, heartbeat or not", () => {
    const run = (quietFor: number) =>
      placeProjectableRow(row("r", {
        is_idle: true, agent_status: "dormant", updated_at: EPOCH - quietFor, message_count: 30, parked_wake_kind: "run",
        last_heartbeat: EPOCH - 5_000, daemon_alive_until: EPOCH + 60_000,
      }), false, EPOCH).bucket;
    expect(run(PARKED_WAKE_TTL_MS - HOUR)).toBe("dormant");
    expect(run(PARKED_WAKE_TTL_MS)).toBe("needs_input");
  });

  test("a run stamp counts while the daemon's heartbeat lives, whatever the status", () => {
    const run = (extra: Record<string, any>) =>
      placeProjectableRow(row("r", {
        is_idle: true, updated_at: EPOCH - 5 * HOUR, message_count: 30, thread_state_status: "dormant",
        thread_state_at: EPOCH - 5 * HOUR, last_turn_at: EPOCH - 5 * HOUR - 60_000, parked_wake_kind: "run", ...extra,
      }), false, EPOCH).bucket;
    const alive = { last_heartbeat: EPOCH - 5_000, daemon_alive_until: EPOCH + 60_000 };
    expect(run({ agent_status: "hibernated", ...alive })).toBe("dormant");
    expect(run({ agent_status: "dormant", ...alive })).toBe("dormant");
    // Heartbeat dead: a settled idle under a fresh dormant pin is no park on a run.
    expect(run({ agent_status: "idle", last_heartbeat: EPOCH - 5 * HOUR })).toBe("needs_input");
    expect(run({ agent_status: "hibernated", last_heartbeat: EPOCH - 5 * HOUR })).toBe("needs_input");
  });

  // A row with no last_turn_at (no turn since the stamp existed) falls back
  // to last_user_message_at with a minute of slack: a pre-deploy pin a later
  // turn never answered must not hide an asking session once a stamp lands.
  test("a legacy pin older than the newest user message by more than a minute parks nothing", () => {
    const legacy = (agent_status: string | null, kind: string) =>
      placeProjectableRow(row("l", {
        status: "active", message_count: 40, is_idle: true, updated_at: EPOCH - 20 * HOUR, agent_status, parked_wake_kind: kind,
        thread_state_status: "dormant", thread_state_at: EPOCH - 30 * HOUR, last_turn_origin: "machine", last_user_message_at: EPOCH - 20 * HOUR,
      }), false, EPOCH).bucket;
    for (const st of ["hibernated", "stopped", null]) for (const k of ["blocker", "wait"]) expect([st, k, legacy(st, k)]).toEqual([st, k, "needs_input"]);
    // jx729tp on prod: its pin's own `cast state` tool result lands 140ms
    // after the pin, and its standing trigger still parks it.
    const pinnedAt = EPOCH - 5 * HOUR;
    expect(placeProjectableRow(row("lead", {
      status: "completed", agent_status: null, is_idle: true, updated_at: pinnedAt + 140, message_count: 120,
      armed_trigger_kind: "standing", last_turn_origin: "person", last_turn_allows_park: false,
      thread_state_status: "dormant", thread_state_at: pinnedAt, last_user_message_at: pinnedAt + 140,
    }), false, EPOCH).bucket).toBe("dormant");
  });

  // jx729tp's shape: a standing trigger into a lead that answered a person and
  // pinned dormant. A trigger resumes a stopped session, so the dead arm reads
  // the same wake set as the daemon-less arm: no status, hibernated and
  // stopped all file the same, and the row does not flip when its managed row
  // ages out.
  test("a pinned dormant on a standing trigger files the same with no status, hibernated or stopped", () => {
    const lead = (agent_status: string | null, extra: Record<string, any> = {}) =>
      placeProjectableRow(row("lead", {
        status: "completed", agent_status, is_idle: true, updated_at: EPOCH - 5 * HOUR, message_count: 120,
        armed_trigger_kind: "standing", last_turn_origin: "person", last_turn_allows_park: false,
        last_message_preview: "yes, start a fix session", thread_state_status: "dormant", ...extra,
      }), false, EPOCH).bucket;
    for (const status of [null, "hibernated", "stopped"]) expect([status, lead(status)]).toEqual([status, "dormant"]);
    for (const status of [null, "hibernated", "stopped"]) expect([status, lead(status, { armed_trigger_kind: "none" })]).toEqual([status, "needs_input"]);
  });

  // A done pin answered an earlier turn when a later one opened since: a
  // process stopping after that unanswered turn is a death to read, not Done.
  test("a stopped process under a done pin older than the latest turn files needs_input", () => {
    const stopped = (extra: Record<string, any>) =>
      placeProjectableRow(row("e", {
        agent_status: "stopped", updated_at: EPOCH - HOUR, message_count: 30, is_idle: true,
        thread_state_status: "done", thread_state_at: EPOCH - 2 * HOUR, ...extra,
      }), false, EPOCH).bucket;
    expect(stopped({ last_turn_at: EPOCH - 3 * HOUR })).toBe("done");
    expect(stopped({ last_turn_at: EPOCH - HOUR })).toBe("needs_input");
  });

  // The daemon can overwrite a declared dormant or done with `working` when
  // it misreads a pane as busy, and the server decays a quiet `working` to
  // `idle` (jx76sve5q5m9 pinned done, then filed Needs You). A pin written in
  // or after the latest turn speaks over a settled idle, as if the daemon had
  // carried it.
  test("a fresh pin carries the verdict over a working the trust rule decayed to idle", () => {
    const settled = (extra: Record<string, any>) =>
      placeProjectableRow(row("i", {
        agent_status: "idle", raw_agent_status: "working", is_idle: true, updated_at: EPOCH - 3 * HOUR, message_count: 30,
        thread_state_at: EPOCH - 3 * HOUR, last_turn_at: EPOCH - 3 * HOUR - 60_000, ...extra,
      }), false, EPOCH).bucket;
    expect(settled({ thread_state_status: "done" })).toBe("done");
    expect(settled({ thread_state_status: "dormant", parked_wake_kind: "blocker" })).toBe("dormant");
    // A pin carried this way is still a dormant claim: with no wake it expires.
    expect(settled({ thread_state_status: "dormant" })).toBe("needs_input");
    expect(settled({ thread_state_status: "dormant", updated_at: EPOCH - HOUR, thread_state_at: EPOCH - HOUR, last_turn_at: EPOCH - HOUR })).toBe("dormant");
    // A pin older than the latest turn, or a row with no turn stamp: the settle's own verdict.
    expect(settled({ thread_state_status: "done", last_turn_at: EPOCH - 2 * HOUR })).toBe("needs_input");
    expect(settled({ thread_state_status: "done", last_turn_at: null })).toBe("needs_input");
    // A declared block still wins.
    expect(settled({ thread_state_status: "blocked" })).toBe("needs_input");
    // An idle the daemon reported itself always wins: it judges turns from the
    // transcript on its own clock, where the server can miss one (a session
    // move notice, a mid-turn auto-compaction).
    expect(settled({ raw_agent_status: "idle", thread_state_status: "done" })).toBe("needs_input");
    expect(settled({ raw_agent_status: "idle", thread_state_status: "dormant", parked_wake_kind: "blocker" })).toBe("needs_input");
  });

  // The round-5 probe: a session moved machines, the move notice opened a
  // turn the server did not count, the agent ended asking, and the daemon
  // reported idle. The old dormant pin must not speak over that idle.
  test("a daemon-reported idle after a move notice files needs_input under an older pin", () => {
    const wi = rowWakeInputs(
      { parked_wake_kind: "blocker", updated_at: EPOCH, last_turn_at: EPOCH - 600_000, thread_state_at: EPOCH - 300_000, thread_state_status: "dormant", agent_type: "claude_code", last_heartbeat: EPOCH } as any,
      { trusted: "idle", raw: "idle" },
      EPOCH + 3 * HOUR,
    );
    expect(classifyWorkState({ agentStatus: "idle", isIdle: true, awaitingInput: false, hasPending: false, isUnresponsive: false, messageCount: 10, declaredStatus: "dormant", ...wi })).toBe("needs_input");
  });

  // The turn's time is the machine's clock and the pin's the server's.
  // Strict, as the daemon compares: a turn seconds after the pin is one the
  // pin never answered (a `cast send` 3s after a done pin, a person's "yes"
  // 8s after a dormant pin).
  test("any turn after the pin predates it; a turn at or before it does not", () => {
    expect(rowPinPredatesTurn({ thread_state_at: EPOCH, last_turn_at: EPOCH })).toBe(false);
    expect(rowPinPredatesTurn({ thread_state_at: EPOCH, last_turn_at: EPOCH + 1 })).toBe(true);
    expect(rowPinPredatesTurn({ thread_state_at: EPOCH, last_turn_at: null })).toBe(false);
    const settled = (extra: Record<string, any>) =>
      placeProjectableRow(row("p", {
        agent_status: "idle", is_idle: true, updated_at: EPOCH - 30_000, message_count: 20, last_heartbeat: EPOCH - 1_000,
        thread_state_at: EPOCH - 60_000, ...extra,
      }), false, EPOCH).bucket;
    expect(settled({ thread_state_status: "done", last_turn_at: EPOCH - 57_000, last_turn_origin: "machine" })).toBe("needs_input");
    expect(settled({ thread_state_status: "dormant", last_turn_at: EPOCH - 52_000, last_turn_origin: "person" })).toBe("needs_input");
    expect(settled({ thread_state_status: "dormant", parked_wake_kind: "blocker", last_turn_at: EPOCH - 52_000, last_turn_origin: "person" })).toBe("needs_input");
  });

  test("a bare dormant claim still expires after DORMANT_CLAIM_TTL_MS", () => {
    const claim = (quietFor: number) =>
      row("d", { is_idle: true, agent_status: "dormant", updated_at: EPOCH - quietFor, parked_wake_kind: "none" });
    expect(placeProjectableRow(claim(DORMANT_CLAIM_TTL_MS - 60_000), false, EPOCH).bucket).toBe("dormant");
    expect(placeProjectableRow(claim(DORMANT_CLAIM_TTL_MS), false, EPOCH).bucket).toBe("needs_input");
  });

  test("the claim expiry is a shared deadline: the time flip lands on needs_input at updated_at + TTL", () => {
    const placedAt = EPOCH - HOUR;
    const r = row("d", { is_idle: true, agent_status: "dormant", updated_at: placedAt });
    const placeAt = (t: number) => placeProjectableRow(r, false, t);
    expect(placeAt(placedAt + 60_000).bucket).toBe("dormant");
    const stale = computeBucketStale(
      { deadlines: rowLiveDeadlines(r as any), placeAt, current: "dormant" },
      placedAt + 60_000,
    );
    expect(stale).toEqual({ bucket_stale_at: placedAt + DORMANT_CLAIM_TTL_MS, stale_bucket: "needs_input" });
  });
});

describe("field ownership constants", () => {
  test("the fact and stamp alphabets are disjoint and pinned", () => {
    expect([...INBOX_FACT_FIELDS]).toEqual([
      "agent_status", "is_idle", "is_unresponsive", "awaiting_input", "is_connected",
      "tmux_session", "claude_backend", "permission_mode", "agent_started_at", "open_tasks", "open_tasks_at",
      "message_count", "updated_at", "last_turn_allows_park",
      "agent_status_updated_at", "agent_status_boundary", "turn_completed_at", "hibernated_at", "last_heartbeat", "last_role_is_user", "auq_open", "daemon_alive_until", "producing_until",
      "child_asking", "child_asking_until", "child_live", "activity", "context_tokens", "last_model_call_at",
    ]);
    expect([...INBOX_PROJECTION_FIELDS]).toEqual([
      "bucket", "work_state", "asking", "below_fold", "bucket_stale_at", "stale_bucket",
    ]);
    for (const f of INBOX_PROJECTION_FIELDS) expect(INBOX_FACT_FIELDS).not.toContain(f);
  });

  test("the caps are the single source and the version is 29", () => {
    expect(INBOX_WINDOW_CAPS).toEqual({ recent: 200, pinned: 100, dismissed: 200, stashed: 200, snoozed: 200, owned: 200, adopted: 100 });
    expect(INBOX_PROJECTION_VERSION).toBe(29);
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
    expect(rollupParentIdOf({ spawned_by_conversation_id: "lead", agent_team_name: "team", agent_name: "team-lead" })).toBeNull();
    expect(rollupParentIdOf({ spawned_by_conversation_id: "lead" })).toBeNull();
    expect(rollupParentIdOf({})).toBeNull();
  });
});

describe("isStackedAsk — which pending decide lifts its session", () => {
  test("a blocking ask lifts; an advisory one lifts only from a named stack; a resolved one never", () => {
    expect(isStackedAsk({ status: "pending", blocking: true })).toBe(true);
    expect(isStackedAsk({ status: "pending", blocking: false })).toBe(false);
    expect(isStackedAsk({ status: "pending", blocking: false, stack_id: "ds1" })).toBe(true);
    expect(isStackedAsk({ status: "answered", blocking: true })).toBe(false);
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

  test("a hidden standing session with a live nested child files by its own state; idle, childless or role-less stays hidden", () => {
    const rows: Record<string, RollupRow> = {
      nested_lead: { standing_role_id: "r1", child_live: true },
      idle_lead: { standing_role_id: "r2", child_live: true },
      quiet_lead: { standing_role_id: "r3" },
      workspace_anchor: { child_live: true },
    };
    const p = new Map<string, { bucket: InboxBucket; work_state: string }>([
      ["nested_lead", { bucket: "hidden", work_state: "dormant" }],
      ["idle_lead", { bucket: "hidden", work_state: "idle" }],
      ["quiet_lead", { bucket: "hidden", work_state: "dormant" }],
      ["workspace_anchor", { bucket: "hidden", work_state: "dormant" }],
    ]);
    rideLeadPlacements(p, (id) => rows[id]);
    expect(p.get("nested_lead")!.bucket).toBe("dormant");
    expect(p.get("idle_lead")!.bucket).toBe("hidden");
    expect(p.get("quiet_lead")!.bucket).toBe("hidden");
    // A workspace anchor belongs to no role: its subagents never lift it.
    expect(p.get("workspace_anchor")!.bucket).toBe("hidden");
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
