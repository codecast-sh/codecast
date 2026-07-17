import { describe, expect, test } from "bun:test";
import { collectHiddenSessionsLite } from "./conversations";
import { makeFakeDb } from "./testDb";

// The dismissed/stashed reconcile's whole-set contract: the client CLEAR pass
// un-hides any cached row missing from this set, so it must vouch for every
// session the caller can durably hide — their own rows (index scan) AND rows
// ASSIGNED to them (session_owners) that another account runs. Regression for
// "dismiss doesn't stick on a session assigned to me": owned foreign-run rows
// were absent, so every complete crawl resurrected their dismiss.
describe("collectHiddenSessionsLite", () => {
  const ME = "users_me";
  const OTHER = "users_other";
  const SINCE = 500;

  function fixtures() {
    return makeFakeDb({
      conversations: [
        // My own dismissed row — found by the index scan.
        { _id: "conversations_mine", user_id: ME, inbox_dismissed_at: 1000 },
        // Assigned to me, run by OTHER, dismissed in-window — must be appended.
        { _id: "conversations_assigned", user_id: OTHER, inbox_dismissed_at: 1200 },
        // Assigned to me but not hidden — stays out of the set.
        { _id: "conversations_active", user_id: OTHER },
        // Assigned to me, dismissed before the window — stays out.
        { _id: "conversations_stale", user_id: OTHER, inbox_dismissed_at: 100 },
      ],
      session_owners: [
        // Own row also in my owner set: must not be duplicated by the append.
        { _id: "so_0", conversation_id: "conversations_mine", user_id: ME, added_at: 1 },
        { _id: "so_1", conversation_id: "conversations_assigned", user_id: ME, added_at: 2 },
        { _id: "so_2", conversation_id: "conversations_active", user_id: ME, added_at: 3 },
        { _id: "so_3", conversation_id: "conversations_stale", user_id: ME, added_at: 4 },
      ],
    });
  }

  test("final page includes my own AND my assigned hidden rows, once each", async () => {
    const db = fixtures();
    const result = await collectHiddenSessionsLite(
      { db }, ME, { paginationOpts: { numItems: 1000, cursor: null }, since: SINCE },
      "by_user_dismissed", "inbox_dismissed_at",
    );
    expect(result.isDone).toBe(true);
    const ids = result.page.map((r: any) => r._id).sort();
    expect(ids).toEqual(["conversations_assigned", "conversations_mine"]);
    const assigned = result.page.find((r: any) => r._id === "conversations_assigned");
    expect(assigned.inbox_dismissed_at).toBe(1200);
  });

  test("stashed twin reads the stash field through the same append", async () => {
    const db = fixtures();
    db._tables.conversations[1].inbox_stashed_at = 1300;
    const result = await collectHiddenSessionsLite(
      { db }, ME, { paginationOpts: { numItems: 1000, cursor: null }, since: SINCE },
      "by_user_stashed", "inbox_stashed_at",
    );
    const assigned = result.page.find((r: any) => r._id === "conversations_assigned");
    expect(assigned?.inbox_stashed_at).toBe(1300);
  });
});
