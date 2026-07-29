import { describe, expect, test } from "bun:test";
import { applyPatches, classifyHideTransition } from "./dispatch";
import { makeFakeDb } from "./testDb";

// The conversation hide-transition hook in applyPatches is the ONE place the
// "dismiss = kill, stash = keep alive" contract is enforced — every dismiss
// path (chord, palette, card button, /sessions toggle) funnels its patch
// through it. These tests pin the decision matrix.
describe("classifyHideTransition", () => {
  test("a patch with neither hide flag is inert", () => {
    expect(classifyHideTransition({}, {}, false)).toBe("none");
    expect(classifyHideTransition({ title: "x" } as any, {}, true)).toBe("none");
  });

  test("undo (flags cleared to null/undefined) never reaps or kills", () => {
    expect(classifyHideTransition({ inbox_dismissed_at: undefined, inbox_stashed_at: undefined }, {}, false)).toBe("none");
  });

  test("hiding an EMPTY conversation reaps it — dismissed or stashed alike", () => {
    expect(classifyHideTransition({ inbox_dismissed_at: 111 }, {}, true)).toBe("reap");
    expect(classifyHideTransition({ inbox_stashed_at: 111 }, {}, true)).toBe("reap");
  });

  test("dismissing a conversation with real work kills the agent", () => {
    expect(classifyHideTransition({ inbox_dismissed_at: 111 }, {}, false)).toBe("kill");
  });

  test("stashing a conversation with real work does NOT kill — the whole point of stash", () => {
    expect(classifyHideTransition({ inbox_stashed_at: 111 }, {}, false)).toBe("none");
  });

  test("a re-asserted dismiss (already dismissed pre-patch) does not re-kill", () => {
    expect(classifyHideTransition({ inbox_dismissed_at: 222 }, { inbox_dismissed_at: 111 }, false)).toBe("none");
  });

  test("dismissing a previously-stashed session kills (stash is no shield once you dismiss)", () => {
    expect(classifyHideTransition({ inbox_dismissed_at: 222, inbox_stashed_at: null }, { inbox_dismissed_at: null }, false)).toBe("kill");
  });
});

// The conversations patch gate: the runner, the primary owner (owner_user_id
// cache), and a SECONDARY owner (session_owners row only) may all triage; a
// non-owner's patch is silently dropped. Regression for "dismiss doesn't stick
// on a session assigned to me": the gate consulted only the primary cache, so a
// secondary owner's dismiss never persisted and the reconcile resurrected it.
describe("applyPatches conversation owner gate", () => {
  const RUNNER = "users_runner";
  const PRIMARY = "users_primary";
  const SECONDARY = "users_secondary";
  const OUTSIDER = "users_outsider";
  const CONV = "conversations_1";

  function fixtures() {
    return makeFakeDb({
      conversations: [
        {
          _id: CONV,
          user_id: RUNNER,
          owner_user_id: PRIMARY,
          status: "active",
          message_count: 5,
        },
      ],
      session_owners: [
        { _id: "so_1", conversation_id: CONV, user_id: PRIMARY, added_by: RUNNER, added_at: 1 },
        { _id: "so_2", conversation_id: CONV, user_id: SECONDARY, added_by: RUNNER, added_at: 2 },
      ],
      messages: [],
      pending_messages: [],
    });
  }

  const stashPatch = { conversations: { [CONV]: { inbox_stashed_at: 111 } } };

  test("secondary owner's triage patch lands via the canonical owner set", async () => {
    const db = fixtures();
    await applyPatches({ db } as any, SECONDARY as any, stashPatch);
    expect(db._tables.conversations[0].inbox_stashed_at).toBe(111);
  });

  test("primary owner (cache) and runner still pass the fast checks", async () => {
    for (const user of [PRIMARY, RUNNER]) {
      const db = fixtures();
      await applyPatches({ db } as any, user as any, stashPatch);
      expect(db._tables.conversations[0].inbox_stashed_at).toBe(111);
    }
  });

  test("a non-owner's patch is dropped", async () => {
    const db = fixtures();
    await applyPatches({ db } as any, OUTSIDER as any, stashPatch);
    expect(db._tables.conversations[0].inbox_stashed_at).toBeUndefined();
  });
});

describe("applyPatches bucket coverage", () => {
  test("a legacy generic bucket patch advances the v2 complete-view head once", async () => {
    const userId = "users_owner";
    const db = makeFakeDb({
      inbox_buckets: [{ _id: "bucket_1", user_id: userId, name: "Before", updated_at: 1 }],
      local_view_heads: [],
    });
    await applyPatches({ db } as any, userId as any, {
      inbox_buckets: {
        bucket_1: { name: "After", color: "blue" },
      },
    });
    expect(db._tables.inbox_buckets[0].name).toBe("After");
    expect(db._tables.local_view_heads).toMatchObject([{
      principal_id: userId,
      contract_id: "buckets.principal/v2",
      view_key: "buckets:principal",
      revision: 1,
    }]);
  });

  test("a forbidden bucket patch neither writes nor advances coverage", async () => {
    const db = makeFakeDb({
      inbox_buckets: [{ _id: "bucket_1", user_id: "owner", name: "Before", updated_at: 1 }],
      local_view_heads: [],
    });
    await applyPatches({ db } as any, "stranger" as any, {
      inbox_buckets: { bucket_1: { name: "Stolen" } },
    });
    expect(db._tables.inbox_buckets[0].name).toBe("Before");
    expect(db._tables.local_view_heads).toEqual([]);
  });
});
