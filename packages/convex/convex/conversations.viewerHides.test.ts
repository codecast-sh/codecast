import { describe, expect, test } from "bun:test";
import { cliSetSessionVisibility, scanInboxConversations } from "./conversations";
import { dispatch } from "./dispatch";
import { makeFakeDb } from "./testDb";

// A stash or dismiss on a teammate's session (the team board) cannot live on the
// row: its stamps are the owner's and the patch gate drops them from anyone
// else. Before inbox_hides the store only forgot its copy and the team fold fed
// the row straight back on the next push ("I dismissed it and it popped back
// up", jx75map). The viewer's gesture now has its own row, the team scan skips
// it, and restore deletes it.
describe("a viewer's hide of a teammate's session", () => {
  const ME = "users_me";
  const MATE = "users_mate";
  const NOW = Date.now();
  const TEAM = "teams_1";
  const CONV = "conversations_mate";

  function fixtures(hides: any[] = []) {
    return makeFakeDb({
      users: [
        { _id: ME, name: "Me", email: "me@example.com", team_id: TEAM },
        { _id: MATE, name: "Mate", email: "mate@example.com", team_id: TEAM },
      ],
      teams: [{ _id: TEAM, name: "Team" }],
      team_memberships: [
        { _id: "tm_me", team_id: TEAM, user_id: ME },
        { _id: "tm_mate", team_id: TEAM, user_id: MATE },
      ],
      conversations: [
        { _id: CONV, short_id: "conversations_mate".slice(0, 7), user_id: MATE, status: "completed", updated_at: NOW, message_count: 5, team_id: TEAM, is_private: false, title: "Mate's work" },
        { _id: "conversations_mine", user_id: ME, status: "active", updated_at: NOW, message_count: 5, team_id: TEAM, is_private: false, title: "Mine" },
      ],
      session_owners: [],
      inbox_hides: hides,
      managed_sessions: [],
      messages: [],
    });
  }

  const auth = (user: string) => ({ getUserIdentity: async () => ({ subject: `${user}|session` }) });
  const teamIds = async (db: any) => {
    const scan = await scanInboxConversations({ db }, ME as any, NOW, { includeLiveness: false, teamScope: TEAM as any });
    return scan.conversations.map((c: any) => c._id.toString()).sort();
  };

  test("the team board folds the teammate's row until I hide it", async () => {
    expect(await teamIds(fixtures())).toEqual(["conversations_mine", CONV].sort());
    const hidden = fixtures([{ _id: "ih_1", user_id: ME, conversation_id: CONV, kind: "dismiss", at: NOW }]);
    expect(await teamIds(hidden)).toEqual(["conversations_mine"]);
  });

  test("the web kill gesture records a hide for a viewer, nothing for the runner", async () => {
    const db = fixtures();
    await (dispatch as any)._handler({ auth: auth(ME), db }, { action: "killSession", args: [CONV] });
    expect(db._tables.inbox_hides).toHaveLength(1);
    expect(db._tables.inbox_hides[0]).toMatchObject({ user_id: ME, conversation_id: CONV, kind: "dismiss" });
    // The runner's own kill rides the row's stamps; no viewer row.
    const own = fixtures();
    await (dispatch as any)._handler({ auth: auth(MATE), db: own }, { action: "killSession", args: [CONV] });
    expect(own._tables.inbox_hides).toHaveLength(0);
    // The runner's stamps stay clean: a viewer's hide never touches the row.
    expect(db._tables.conversations[0].inbox_dismissed_at).toBeUndefined();
  });

  test("stash, bulk kill and restore keep one row per viewer and session", async () => {
    const db = fixtures();
    await (dispatch as any)._handler({ auth: auth(ME), db }, { action: "stashSession", args: [CONV, { hidden: true }] });
    await (dispatch as any)._handler({ auth: auth(ME), db }, { action: "killSessions", args: [[CONV]] });
    expect(db._tables.inbox_hides).toHaveLength(1);
    expect(db._tables.inbox_hides[0].kind).toBe("dismiss");
    await (dispatch as any)._handler({ auth: auth(ME), db }, { action: "restoreSession", args: [CONV] });
    expect(db._tables.inbox_hides).toHaveLength(0);
  });

  test("cast stash / cast restore fall back to a viewer hide for a session I can see but do not own", async () => {
    const db = fixtures();
    const ctx = { auth: auth(ME), db };
    const hid = await (cliSetSessionVisibility as any)._handler(ctx, { session: CONV, action: "dismiss" });
    expect(hid).toMatchObject({ ok: true, outcome: "viewer_hide" });
    expect(db._tables.inbox_hides).toHaveLength(1);
    expect(await teamIds(db)).toEqual(["conversations_mine"]);
    const back = await (cliSetSessionVisibility as any)._handler(ctx, { session: CONV, action: "undismiss" });
    expect(back).toMatchObject({ ok: true, outcome: "viewer_hide", was_hidden: true });
    expect(db._tables.inbox_hides).toHaveLength(0);
  });

  test("a stranger to the team gets the old error, not a hide row", async () => {
    const db = fixtures();
    await expect((cliSetSessionVisibility as any)._handler({ auth: auth("users_stranger"), db }, { session: CONV, action: "dismiss" }))
      .rejects.toThrow(/No session found/);
    expect(db._tables.inbox_hides).toHaveLength(0);
  });
});
