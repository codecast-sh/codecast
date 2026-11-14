// A team may connect several Slack workspaces. Connecting a second one keeps
// the first and its mirrors; connecting a workspace back after its install row
// went reattaches the mirrors and tokens that still name it.
import { describe, expect, test } from "bun:test";
import { storeInstallation } from "./slack";
import { listSlackPeople } from "./slackSync";
import { ALICE, TEAM, INSTALL, LINK, WS, context, call } from "./slackSync.testkit";

const install = (workspace_id: string, workspace_name: string) => ({
  workspace_id, workspace_name, bot_user_id: "UBOT2", bot_token: "xoxb-new", team_id: String(TEAM), installed_by: String(ALICE),
});

describe("several Slack workspaces per team", () => {
  test("connecting a second workspace keeps the first and its mirrors", async () => {
    const ctx = context(ALICE, {
      slack_users: [
        { _id: "su-1", workspace_id: WS, slack_user_id: "UCAM", name: "Cam", fetched_at: 1 },
        { _id: "su-2", workspace_id: "T0CODECAST", slack_user_id: "UASH", name: "Ashot", fetched_at: 1 },
      ],
    });
    const res = await call(storeInstallation, ctx, install("T0CODECAST", "Codecast"));
    expect(res.ok).toBe(true);
    const rows = ctx.db._tables.slack_installations.map((i: any) => i.workspace_id).sort();
    expect(rows).toEqual(["T0CODECAST", WS]);
    expect((await ctx.db.get(LINK)).installation_id).toBe(INSTALL);
    // The member panel names people from every connected workspace.
    const people = await call(listSlackPeople, ctx, { team_id: TEAM });
    expect(people.people.map((p: any) => p.name).sort()).toEqual(["Ashot", "Cam"]);
  });

  test("connecting a workspace back reattaches its orphaned mirrors and tokens", async () => {
    const ctx = context(ALICE, {
      slack_installations: [],
      slack_user_tokens: [{
        _id: "tok-1", installation_id: INSTALL, workspace_id: WS, user_id: ALICE, slack_user_id: "UALICE", token: "xoxp-a", created_at: 1, updated_at: 1,
      }],
    });
    await ctx.db.patch(LINK, { paused: true, last_error: "The Slack app was removed from the workspace" });
    const res = await call(storeInstallation, ctx, install(WS, "Union"));
    const link = await ctx.db.get(LINK);
    expect(link.installation_id).toBe(res.id);
    expect(link.paused).toBe(false);
    expect(link.last_error).toBeUndefined();
    expect((await ctx.db.get("tok-1")).installation_id).toBe(res.id);
  });

  test("a link paused by hand stays paused when its workspace comes back", async () => {
    const ctx = context(ALICE, { slack_installations: [] });
    await ctx.db.patch(LINK, { paused: true });
    const res = await call(storeInstallation, ctx, install(WS, "Union"));
    const link = await ctx.db.get(LINK);
    expect(link.installation_id).toBe(res.id);
    expect(link.paused).toBe(true);
  });
});
