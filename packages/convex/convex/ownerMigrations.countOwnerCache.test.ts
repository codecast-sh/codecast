import { describe, expect, test } from "bun:test";
import { makeFakeDb } from "./testDb";
import { performCountOwnerCacheWithoutRows } from "./ownerMigrations";

// The pre-flag count: a team's conversations whose owner_user_id names a
// primary owner with no session_owners row behind it.
describe("countOwnerCacheWithoutRows", () => {
  test("counts a cached primary with no owner row, and only in that team", async () => {
    const db = makeFakeDb({
      conversations: [
        { _id: "conversations_ok", team_id: "teams_u", owner_user_id: "users_a", short_id: "jxok" },
        { _id: "conversations_stale", team_id: "teams_u", owner_user_id: "users_a", short_id: "jxstale" },
        { _id: "conversations_plain", team_id: "teams_u", short_id: "jxplain" },
        { _id: "conversations_other", team_id: "teams_x", owner_user_id: "users_a", short_id: "jxother" },
      ],
      session_owners: [{ _id: "so1", conversation_id: "conversations_ok", user_id: "users_a", added_by: "users_a", added_at: 1 }],
    });
    const res = await performCountOwnerCacheWithoutRows({ db }, { team_id: "teams_u" });
    expect(res).toMatchObject({ scanned: 3, with_owner_user_id: 2, stale: 1, examples: ["jxstale"], isDone: true });
  });

  // ownersModelOn covers a member's personal sessions too: the count walks
  // the team's rows, then each member's personal rows, page by page.
  test("covers the personal sessions of the team's members, and no one else's", async () => {
    const db = makeFakeDb({
      team_memberships: [
        { _id: "tm_a", user_id: "users_a", team_id: "teams_u" },
        { _id: "tm_b", user_id: "users_b", team_id: "teams_u" },
        { _id: "tm_c", user_id: "users_c", team_id: "teams_x" },
      ],
      conversations: [
        { _id: "conversations_team", team_id: "teams_u", owner_user_id: "users_a", short_id: "jxteam" },
        { _id: "conversations_a_personal", user_id: "users_a", owner_user_id: "users_a", short_id: "jxapers" },
        { _id: "conversations_a_team_x", team_id: "teams_x", user_id: "users_a", owner_user_id: "users_a", short_id: "jxax" },
        { _id: "conversations_b_personal", user_id: "users_b", owner_user_id: "users_b", short_id: "jxbpers" },
        { _id: "conversations_b_ok", user_id: "users_b", owner_user_id: "users_b", short_id: "jxbok" },
        { _id: "conversations_c_personal", user_id: "users_c", owner_user_id: "users_c", short_id: "jxcpers" },
      ],
      session_owners: [{ _id: "so1", conversation_id: "conversations_b_ok", user_id: "users_b", added_by: "users_b", added_at: 1 }],
    });
    const pages: any[] = [];
    let args: any = { team_id: "teams_u", numItems: 1 };
    for (let i = 0; i < 20; i++) {
      const res = await performCountOwnerCacheWithoutRows({ db }, args);
      pages.push(res);
      if (res.isDone) break;
      args = { team_id: "teams_u", numItems: 1, cursor: res.continueCursor, member: res.member ?? undefined };
    }
    expect(pages.at(-1).isDone).toBe(true);
    expect(pages.reduce((n, p) => n + p.stale, 0)).toBe(3);
    expect(pages.flatMap((p) => p.examples).sort()).toEqual(["jxapers", "jxbpers", "jxteam"]);
  });
});
