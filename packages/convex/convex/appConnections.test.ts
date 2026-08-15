// listConnections answers "is this app connected in MY workspace, and by whom".
// What earns tests here is the boundary work, not the join:
//
//   Membership gates the team lens. The user row keeps pointing at a team after
//   membership lapses (routing ≠ visibility), so a stale pointer must not keep
//   showing a former member who connected what.
//
//   Absence stays honest. No installer row → `by: null`, never a made-up name.
//   No revoke path (Slack) → no disconnect_id, so the UI cannot render a dead
//   Disconnect. Same for role: deleteInstallation rejects non-admins, so only
//   an admin is handed disconnect_id. Unauthenticated → empty list, not a
//   throw, because the query is a subscription that outlives a session
//   expiring.

import { describe, expect, test } from "bun:test";
import { makeFakeDb } from "./testDb";
import { hashToken } from "./apiTokens";
import { listConnections } from "./appConnections";
import { APP_IDS } from "@codecast/shared/contracts";

const OWNER = "u_owner";
const MATE = "u_mate";
const TEAM = "team_1";
const TOKEN = "cast_test_token";

function auth(userId: string | null) {
  return {
    async getUserIdentity() {
      return userId ? { subject: `${userId}|session` } : null;
    },
  };
}

function ctx(userId: string | null, tables: Record<string, any[]>) {
  return { auth: auth(userId), db: makeFakeDb(tables) } as any;
}

function tables(extra: Record<string, any[]> = {}): Record<string, any[]> {
  return {
    users: [
      { _id: OWNER, name: "Ash", email: "ash@example.com", team_id: TEAM },
      { _id: MATE, name: "Sam", email: "sam@example.com", team_id: TEAM },
    ],
    // Schema-complete rows (role + joined_at are required fields): OWNER is the
    // team admin, MATE a plain member — the split the disconnect_id gate tests.
    team_memberships: [
      { _id: "tm_1", user_id: OWNER, team_id: TEAM, role: "admin", joined_at: 1 },
      { _id: "tm_2", user_id: MATE, team_id: TEAM, role: "member", joined_at: 2 },
    ],
    slack_installations: [],
    github_app_installations: [],
    api_tokens: [],
    ...extra,
  };
}

const run = (c: any, args: Record<string, any> = {}) =>
  (listConnections as any)._handler(c, args);

const byId = (result: { apps: any[] }) =>
  Object.fromEntries(result.apps.map((a) => [a.id, a]));

const slackRow = (over: Record<string, any> = {}) => ({
  _id: "si_1",
  workspace_id: "T123",
  workspace_name: "acme",
  bot_user_id: "B1",
  bot_token: "xoxb-secret",
  team_id: TEAM,
  installed_by_user_id: MATE,
  created_at: 111,
  updated_at: 111,
  ...over,
});

const githubRow = (over: Record<string, any> = {}) => ({
  _id: "ghi_1",
  team_id: TEAM,
  installation_id: 42,
  account_login: "acme-org",
  account_type: "Organization",
  account_id: 7,
  repository_selection: "selected",
  installed_by_user_id: OWNER,
  created_at: 222,
  updated_at: 222,
  ...over,
});

describe("listConnections", () => {
  test("unauthenticated returns an empty list, not a throw", async () => {
    const result = await run(ctx(null, tables()));
    expect(result).toEqual({ apps: [] });
  });

  test("covers every catalog app, in catalog order", async () => {
    const result = await run(ctx(OWNER, tables()));
    expect(result.apps.map((a: any) => a.id)).toEqual([...APP_IDS]);
  });

  test("nothing connected: every app not_connected — no coming_soon cards remain", async () => {
    const apps = byId(await run(ctx(OWNER, tables())));
    expect(apps.slack).toEqual({ id: "slack", status: "not_connected" });
    expect(apps.github).toEqual({ id: "github", status: "not_connected" });
    // Gmail went live with the Google connector (ct-43290) — updated
    // deliberately when its connectKind flipped to oauth-popup.
    // Every catalog app is a live connector now: gmail via googleOAuth,
    // linear/notion via the generic oauthConnectors table.
    for (const id of ["gmail", "linear", "notion"]) {
      expect(apps[id]).toEqual({ id, status: "not_connected" });
    }
  });

  test("a linear connection reports team scope, the workspace, who, and a disconnect id", async () => {
    const apps = byId(
      await run(
        ctx(
          OWNER,
          tables({
            app_installations: [
              {
                _id: "ai_1",
                provider: "linear",
                team_id: TEAM,
                connected_by: OWNER,
                account_label: "Acme Eng",
                access_token_enc: "enc",
                granted_scopes: ["read"],
                created_at: 1700000000000,
                updated_at: 1700000000000,
              },
            ],
          }),
        ),
      ),
    );
    expect(apps.linear).toMatchObject({
      status: "connected",
      scope: "team",
      by_me: true,
      detail: "Acme Eng",
      disconnect_id: "ai_1",
    });
  });

  test("a PENDING linear row (redirect landed, not yet confirmed) reads as not connected", async () => {
    const apps = byId(
      await run(
        ctx(
          OWNER,
          tables({
            app_installations: [
              { _id: "ai_p", provider: "linear", team_id: TEAM, connected_by: OWNER, access_token_enc: "enc",
                granted_scopes: [], pending_confirm_hash: "h", pending_expires_at: 9e15, created_at: 1, updated_at: 1 },
            ],
          }),
        ),
      ),
    );
    expect(apps.linear).toEqual({ id: "linear", status: "not_connected" });
  });

  test("a google install reports personal scope, the email, and a disconnect id", async () => {
    const apps = byId(
      await run(
        ctx(
          OWNER,
          tables({
            google_installations: [
              {
                _id: "gi_1",
                scope_user_id: OWNER,
                email: "ashot@example.com",
                created_at: 1700000000000,
              },
            ],
          }),
        ),
      ),
    );
    expect(apps.gmail).toMatchObject({
      status: "connected",
      scope: "personal",
      by_me: true,
      detail: "ashot@example.com",
      disconnect_id: "gi_1",
    });
  });

  test("team slack install reports who, when, scope — and no disconnect_id", async () => {
    const apps = byId(
      await run(ctx(OWNER, tables({ slack_installations: [slackRow()] }))),
    );
    expect(apps.slack).toEqual({
      id: "slack",
      status: "connected",
      scope: "team",
      by: "Sam",
      by_me: false,
      at: 111,
      detail: "acme",
      disconnect_id: undefined,
    });
  });

  test("by_me is true for the installer themself", async () => {
    const apps = byId(
      await run(ctx(MATE, tables({ slack_installations: [slackRow()] }))),
    );
    expect(apps.slack.by_me).toBe(true);
  });

  test("personal slack install reports personal scope when no team install exists", async () => {
    const row = slackRow({
      team_id: undefined,
      scope_user_id: OWNER,
      installed_by_user_id: OWNER,
    });
    const apps = byId(await run(ctx(OWNER, tables({ slack_installations: [row] }))));
    expect(apps.slack.status).toBe("connected");
    expect(apps.slack.scope).toBe("personal");
    expect(apps.slack.by_me).toBe(true);
  });

  test("a stale team pointer without a membership row hides the team's installs", async () => {
    const t = tables({
      slack_installations: [slackRow()],
      github_app_installations: [githubRow()],
    });
    // OWNER's user row still points at TEAM, but the membership row is gone.
    t.team_memberships = t.team_memberships.filter((m) => m.user_id !== OWNER);
    const apps = byId(await run(ctx(OWNER, t)));
    expect(apps.slack).toEqual({ id: "slack", status: "not_connected" });
    expect(apps.github).toEqual({ id: "github", status: "not_connected" });
  });

  test("github install hands the revoke path's id to a team admin", async () => {
    const apps = byId(
      await run(ctx(OWNER, tables({ github_app_installations: [githubRow()] }))),
    );
    expect(apps.github).toEqual({
      id: "github",
      status: "connected",
      scope: "team",
      by: "Ash",
      by_me: true,
      at: 222,
      detail: "acme-org",
      disconnect_id: "ghi_1",
    });
  });

  test("a plain member sees the connection but gets no disconnect_id", async () => {
    // deleteInstallation would reject them (requireTeamAdmin), so handing out
    // the id would render a Disconnect button that can only fail.
    const apps = byId(
      await run(ctx(MATE, tables({ github_app_installations: [githubRow()] }))),
    );
    expect(apps.github.status).toBe("connected");
    expect(apps.github.by).toBe("Ash");
    expect(apps.github.by_me).toBe(false);
    expect(apps.github.disconnect_id).toBeUndefined();
  });

  test("active_team_id outranks the home team — same resolution the connect flow uses", async () => {
    // OWNER's home team is TEAM but they are LOOKING at team_2. The card must
    // answer for team_2: its install connected, TEAM's install invisible.
    const t = tables({
      github_app_installations: [
        githubRow(), // TEAM's install — the wrong workspace here
        githubRow({ _id: "ghi_2", team_id: "team_2", account_login: "other-org" }),
      ],
    });
    t.users.find((u) => u._id === OWNER)!.active_team_id = "team_2";
    t.team_memberships.push({
      _id: "tm_3",
      user_id: OWNER,
      team_id: "team_2",
      role: "member",
      joined_at: 3,
    });
    const apps = byId(await run(ctx(OWNER, t)));
    expect(apps.github.status).toBe("connected");
    expect(apps.github.detail).toBe("other-org");
    expect(apps.github.disconnect_id).toBeUndefined(); // member there, not admin
  });

  test("a stale active_team_id does not fall back to the home team", async () => {
    // Membership in the active team lapsed. The pointer only counts with a live
    // membership behind it, and the resolver does not then reach for team_id —
    // showing the home team's installs while the user is looking at another
    // workspace would answer a question they did not ask.
    const t = tables({ github_app_installations: [githubRow()] });
    t.users.find((u) => u._id === OWNER)!.active_team_id = "team_2";
    const apps = byId(await run(ctx(OWNER, t)));
    expect(apps.github).toEqual({ id: "github", status: "not_connected" });
  });

  test("a vanished installer account reads as by: null, still connected", async () => {
    const row = slackRow({ installed_by_user_id: "u_gone" });
    const apps = byId(await run(ctx(OWNER, tables({ slack_installations: [row] }))));
    expect(apps.slack.status).toBe("connected");
    expect(apps.slack.by).toBe(null);
    expect(apps.slack.by_me).toBe(false);
  });

  test("an installer with no name falls back to email", async () => {
    const t = tables({ slack_installations: [slackRow()] });
    const mate = t.users.find((u) => u._id === MATE)!;
    delete mate.name;
    const apps = byId(await run(ctx(OWNER, t)));
    expect(apps.slack.by).toBe("sam@example.com");
  });

  test("api_token auth reaches the same answer as a web session", async () => {
    const t = tables({
      slack_installations: [slackRow()],
      api_tokens: [{ _id: "tok_1", user_id: OWNER, token_hash: await hashToken(TOKEN) }],
    });
    const apps = byId(await run(ctx(null, t), { api_token: TOKEN }));
    expect(apps.slack.status).toBe("connected");
  });
});
