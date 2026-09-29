import { describe, expect, test } from "bun:test";
import { resolveCommitSessions } from "./blame";
import { makeFakeDb } from "./testDb";

// A commit's Codecast-Session trailer is the surest attribution blame has: it
// outranks the commits table, stored hashes and subject matching, but only for
// a viewer who may see the session it names.

const SHA = "a".repeat(40);
const TRAILED = "t".repeat(32);
const GUESSED = "g".repeat(32);
const HIDDEN = "h".repeat(32);

function ctx() {
  return {
    db: makeFakeDb({
      users: [{ _id: "me", name: "Me" }, { _id: "other", name: "Other" }],
      conversations: [
        { _id: TRAILED, user_id: "me", title: "Trailed", short_id: "jx7trai" },
        { _id: GUESSED, user_id: "me", title: "Guessed" },
        { _id: HIDDEN, user_id: "other", title: "Someone else's", is_private: true },
      ],
      commits: [{ _id: "c", sha: SHA, conversation_id: GUESSED }],
      file_changes: [],
      session_owners: [],
      team_memberships: [],
      share_redemptions: [],
    }),
  };
}

describe("resolveCommitSessions and the trailer", () => {
  test("the trailer's session beats the commits table", async () => {
    const out = await resolveCommitSessions(ctx(), "me" as any, [{ sha: SHA, session: TRAILED }]);
    expect(out[SHA]).toMatchObject({ conversation_id: TRAILED, title: "Trailed", via: "trailer" });
  });

  test("without a trailer the commits table still answers", async () => {
    const out = await resolveCommitSessions(ctx(), "me" as any, [{ sha: SHA }]);
    expect(out[SHA]).toMatchObject({ conversation_id: GUESSED, via: "commit" });
  });

  test("a trailer naming a session the viewer cannot see grants nothing and falls through", async () => {
    const out = await resolveCommitSessions(ctx(), "me" as any, [{ sha: SHA, session: HIDDEN }]);
    expect(out[SHA]).toMatchObject({ conversation_id: GUESSED, via: "commit" });
  });

  test("a malformed trailer id is ignored", async () => {
    const out = await resolveCommitSessions(ctx(), "me" as any, [{ sha: SHA, session: "not-an-id" }]);
    expect(out[SHA].via).toBe("commit");
  });
});
