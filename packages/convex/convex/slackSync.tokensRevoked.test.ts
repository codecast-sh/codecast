// tokens_revoked names whose token died: a person's (drop their stored token,
// leave the team's mirrors running) or the bot's (pause the mirrors). Moved out
// of slackSync.test.ts to keep that file under its line pin; the fixture is the
// slice of its seed these cases read.
import { describe, expect, test } from "bun:test";
import { makeFakeDb } from "./testDb";
import { ingestEvent } from "./slackSync";

const ALICE = "user-alice" as any;
const BOB = "user-bob" as any;
const TEAM = "team-main" as any;
const CHANNEL = "chat_channels_1" as any;
const INSTALL = "slack_installations_old" as any;
const LINK = "slack_channel_links_1" as any;
const WS = "T0UNION";

function context(_user: null, over: Record<string, any[]> = {}) {
  const db = makeFakeDb({
    users: [{ _id: ALICE, name: "Alice" }, { _id: BOB, name: "Bob" }],
    teams: [{ _id: TEAM, name: "Union", invite_code: "U", created_at: 1, features: { chat: true } }],
    team_memberships: [
      { _id: "m-alice", user_id: ALICE, team_id: TEAM, role: "admin" },
      { _id: "m-bob", user_id: BOB, team_id: TEAM, role: "member" },
    ],
    chat_channels: [{ _id: CHANNEL, team_id: TEAM, name: "general", created_by: ALICE, created_at: 1_000, updated_at: 1_000 }],
    slack_installations: [{
      _id: INSTALL, workspace_id: WS, workspace_name: "Union", bot_user_id: "UBOT", bot_token: "xoxb-test", app_id: "A0CODECAST",
      team_id: TEAM, installed_by_user_id: ALICE, created_at: 1, updated_at: 1,
    }],
    slack_channel_links: [{
      _id: LINK, team_id: TEAM, installation_id: INSTALL, workspace_id: WS, slack_channel_id: "C0GENERAL", slack_channel_name: "general",
      chat_channel_id: CHANNEL, direction: "both",
      options: { threads: true, reactions: true, edits: true, files: true, bot_messages: false, system_messages: false, agent_lines: true, match_people_by_email: true },
      since_ts: "1000.000000", created_by: ALICE, created_at: 1, updated_at: 1,
    }],
    slack_events: [],
    slack_sync_events: [],
    slack_users: [],
    slack_user_tokens: [],
    anchors: [],
    anchor_channels: [],
    ...over,
  });
  return {
    db,
    auth: { async getUserIdentity() { return null; } },
    async runQuery() { throw new Error("no runQuery in this test"); },
    async runMutation() { return undefined; },
    scheduler: { async runAfter() {} },
  } as any;
}
const call = (fn: any, ctx: any, args: any) => (fn as any)._handler(ctx, args);

describe("tokens_revoked", () => {
  const tokenRow = (id: string, user: any, slackUser: string) => ({ _id: id, installation_id: INSTALL, workspace_id: WS, user_id: user, slack_user_id: slackUser, token: "xoxp-" + id, created_at: 1, updated_at: 1 });
  test("one person revoking their own token drops only their stored token; the team's mirrors keep running", async () => {
    const ctx = context(null, { slack_user_tokens: [tokenRow("tok-alice", ALICE, "UALICE"), tokenRow("tok-bob", BOB, "UBOB")] });
    const out = await call(ingestEvent, ctx, { event_id: "Ev12", workspace: WS, event: { type: "tokens_revoked", tokens: { oauth: ["UALICE"], bot: [] } } });
    expect(out).toEqual({ status: "tokens_revoked" });
    expect((await ctx.db.get(LINK)).paused).toBeUndefined();
    expect(ctx.db._tables.slack_installations.length).toBe(1);
    expect(ctx.db._tables.slack_user_tokens.map((t: any) => t._id)).toEqual(["tok-bob"]);
  });
  test("the bot's token revoked pauses the mirrors and keeps the installation", async () => {
    const ctx = context(null);
    await call(ingestEvent, ctx, { event_id: "Ev13", workspace: WS, event: { type: "tokens_revoked", tokens: { oauth: [], bot: ["UBOT"] } } });
    expect((await ctx.db.get(LINK)).paused).toBe(true);
    expect(ctx.db._tables.slack_installations.length).toBe(1);
  });
  test("an uninstall drops every stored personal token with the installation", async () => {
    const ctx = context(null, { slack_user_tokens: [tokenRow("tok-alice", ALICE, "UALICE")] });
    await call(ingestEvent, ctx, { event_id: "Ev14", workspace: WS, event: { type: "app_uninstalled" } });
    expect(ctx.db._tables.slack_user_tokens).toEqual([]);
    expect(ctx.db._tables.slack_installations.length).toBe(0);
  });
});
