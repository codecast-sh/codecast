import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { computeSessionsLiveness, _resetChildAuqProbeCacheForTests } from "./conversations";
import { ME, H, NOW, EPOCH, conv, db, countingCtx } from "./conversations.projection.testkit";

// The liveness overlay's reads under the owners model (team feature
// session_owners), beside the flag-off budget in conversations.projection.test.ts.

let nowSpy: ReturnType<typeof spyOn>;
beforeEach(() => { nowSpy = spyOn(Date, "now").mockReturnValue(NOW); _resetChildAuqProbeCacheForTests(); });
afterEach(() => { nowSpy.mockRestore(); });

describe("overlay read budget under the owners model", () => {
  test("the overlay reads the subagent range once, serving the fast-field and the nested windows alike", async () => {
    const team = "teams_union";
    const tables = {
      teams: [{ _id: team, name: "Union", features: { session_owners: true } }],
      team_memberships: [{ _id: "tm_1", user_id: ME, team_id: team, role: "member", joined_at: 1, visibility: "full" }],
      conversations: [
        conv("own", { team_id: team }),
        conv("sub", { team_id: team, is_subagent: true, parent_conversation_id: "conversations_own", parent_released_at: EPOCH - H }),
        conv("co_owned", { team_id: team, owner_user_id: "users_mate" }),
      ],
    };
    const { ctx, ops } = countingCtx(db(tables));
    const { liveness } = await computeSessionsLiveness(ctx, ME as any);
    expect(liveness["conversations_sub"]).toBeDefined();
    // recent x2, the subagent range ONCE, pinned, adopted, dismissed x2,
    // stashed x2, snoozed x2, and the escalation window.
    expect(ops.filter((o) => o === "conversations.by_user_plain_updated").length).toBe(3);
    expect(ops.filter((o) => o === "conversations.by_wait_up_person").length).toBe(1);
    // A row carries no owner list: no session's owner rows are read, only the
    // viewer's own (the by_user window).
    expect(ops.filter((o) => o === "session_owners.by_conversation").length).toBe(0);
  });
});
