import { describe, expect, test } from "bun:test";
import { resolveConversationForViewer } from "./conversations";
import { makeFakeDb } from "./testDb";

// Regression for "conversation Not Found" on /conversation/<short-id>: entity
// pills fall back to the 7-char short id in their href until webGet resolves,
// and `cast link` mints short-id URLs outright — but resolveConversation only
// tried full ids, session UUIDs, and tombstones, so every short-id link died
// on NotFoundView (2026-08-02, clicking a teammate-session pill in chat).
describe("resolveConversationForViewer", () => {
  const ME = "users_me" as any;
  const SAMVIT = "users_samvit";
  const TEAM = "teams_1";

  const TEAMMATE_CONV_ID = "jx7666xkcfbmvq69jv7a3g1kb18bn73m";

  function fixtures(extraConversations: any[] = []) {
    return makeFakeDb({
      conversations: [
        {
          _id: TEAMMATE_CONV_ID,
          short_id: "jx7666x",
          user_id: SAMVIT,
          team_id: TEAM,
          is_private: false,
        },
        ...extraConversations,
      ],
      team_memberships: [
        { _id: "tm_me", user_id: ME, team_id: TEAM },
        { _id: "tm_samvit", user_id: SAMVIT, team_id: TEAM },
      ],
    });
  }

  test("teammate's short id resolves to the full id with team access", async () => {
    const db = fixtures();
    const result = await resolveConversationForViewer({ db }, "jx7666x", ME);
    expect(result).toEqual({ access_level: "team", conversation_id: TEAMMATE_CONV_ID });
  });

  test("full Convex id still resolves (normalizeId path unchanged)", async () => {
    const db = fixtures();
    const result = await resolveConversationForViewer({ db }, TEAMMATE_CONV_ID, ME);
    expect(result).toEqual({ access_level: "team", conversation_id: TEAMMATE_CONV_ID });
  });

  test("unknown short id stays not_found", async () => {
    const db = fixtures();
    const result = await resolveConversationForViewer({ db }, "jxzzzzz", ME);
    expect(result.access_level).toBe("not_found");
  });

  test("short-id collision: an inaccessible newer row can't shadow an accessible one", async () => {
    // Newest-first candidate order puts the private stranger's row first; the
    // access-ranked resolver must skip it and return the team-visible row.
    const db = fixtures([
      {
        _id: "jx7666xzzzzzzzzzzzzzzzzzzzzzzzzz",
        short_id: "jx7666x",
        user_id: "users_stranger",
        is_private: true,
      },
    ]);
    const result = await resolveConversationForViewer({ db }, "jx7666x", ME);
    expect(result).toEqual({ access_level: "team", conversation_id: TEAMMATE_CONV_ID });
  });

  test("guest (no auth) on a non-shared short id gets denied, not a crash or not_found", async () => {
    const db = fixtures();
    const result = await resolveConversationForViewer({ db }, "jx7666x", null);
    expect(result).toEqual({ access_level: "denied", conversation_id: null });
  });

  test("guest resolves a short id when the conversation has a share token", async () => {
    const db = fixtures();
    db._tables.conversations[0].share_token = "tok_1";
    const result = await resolveConversationForViewer({ db }, "jx7666x", null);
    expect(result).toEqual({ access_level: "shared", conversation_id: TEAMMATE_CONV_ID });
  });
});
