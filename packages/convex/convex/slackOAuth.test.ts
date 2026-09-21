import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { getFunctionName } from "convex/server";
import { makeFakeDb } from "./testDb";
import { completeSlackInstall, getInstallUrl, resolveInstallScope, signState, storeInstallation, storeUserToken } from "./slack";

const call = (fn: any, ctx: any, args: any) => fn._handler(ctx, args);
const envKeys = ["SLACK_CLIENT_ID", "SLACK_CLIENT_SECRET", "SITE_URL"] as const;
const savedEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
const originalFetch = globalThis.fetch;
let requests: Array<{ url: string; body: URLSearchParams }>;
let slackAnswer: any;
let fetchFailure = false;

function context() {
  const db = makeFakeDb({
    users: [{ _id: "alice", active_team_id: "team" }, { _id: "bob", active_team_id: "team" }],
    teams: [{ _id: "team" }, { _id: "other-team" }],
    team_memberships: [{ _id: "alice-member", user_id: "alice", team_id: "team", role: "admin" }, { _id: "bob-member", user_id: "bob", team_id: "team", role: "admin" }],
    anchors: [], slack_installations: [], slack_user_tokens: [],
  });
  const ctx: any = {
    db, user: "alice",
    auth: { async getUserIdentity() { return ctx.user ? { subject: `${ctx.user}|session` } : null; } },
    async runQuery(ref: any, args: any) {
      expect(getFunctionName(ref)).toBe("slack:resolveInstallScope");
      return call(resolveInstallScope, ctx, args);
    },
    async runMutation(ref: any, args: any) {
      const name = getFunctionName(ref);
      if (name === "slack:storeInstallation") return call(storeInstallation, ctx, args);
      if (name === "slack:storeUserToken") return call(storeUserToken, ctx, args);
      if (name === "slackSync:linkSignedInPerson") return null;
      throw new Error(`Unexpected mutation ${name}`);
    },
    scheduler: { async runAfter() {} },
  };
  return ctx;
}
async function start(ctx: any, scope_type = "team") {
  const res = await call(getInstallUrl, ctx, { scope_type, team_id: "team", return_to: "/settings/integrations", origin: "https://codecast.sh" });
  expect(res.ok).toBe(true);
  return new URL(res.url).searchParams.get("state")!;
}

beforeEach(() => {
  process.env.SLACK_CLIENT_ID = "test-client";
  process.env.SLACK_CLIENT_SECRET = "test-secret";
  process.env.SITE_URL = "https://codecast.sh";
  requests = [];
  fetchFailure = false;
  slackAnswer = { ok: true, access_token: "test-bot-token", bot_user_id: "bot", team: { id: "slack-team", name: "Test Workspace" }, app_id: "test-app", authed_user: { id: "slack-alice", access_token: "test-person-token", scope: "chat:write" } };
  globalThis.fetch = (async (input: any, init: any) => {
    requests.push({ url: String(input), body: new URLSearchParams(init.body) });
    if (fetchFailure) throw new Error("network unavailable");
    return Response.json(slackAnswer);
  }) as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = originalFetch;
  for (const key of envKeys) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
});

describe("Slack OAuth installation integration", () => {
  test("initiates, validates state, exchanges and stores both tokens for the signed-in initiator", async () => {
    const ctx = context();
    const state = await start(ctx);
    const res = await call(completeSlackInstall, ctx, { code: "slack-code", state });
    expect(res).toEqual({ ok: true, scope_type: "team", team_id: "team", return_to: "/settings/integrations" });
    expect(requests).toHaveLength(1);
    expect(requests[0].url).toBe("https://slack.com/api/oauth.v2.access");
    expect(requests[0].body.get("redirect_uri")).toBe("https://codecast.sh/slack/connect");
    expect(requests[0].body.get("code")).toBe("slack-code");
    expect(ctx.db._tables.slack_installations).toHaveLength(1);
    expect(ctx.db._tables.slack_installations[0].installed_by_user_id).toBe("alice");
    expect(ctx.db._tables.slack_user_tokens[0].user_id).toBe("alice");
  });

  test.each(["signed-out", "wrong-user", "lost-admin", "expired", "tampered"])("rejects %s before contacting Slack or writing tokens", async (kind) => {
    const ctx = context();
    let state = await start(ctx);
    if (kind === "signed-out") ctx.user = null;
    if (kind === "wrong-user") ctx.user = "bob";
    if (kind === "lost-admin") await ctx.db.patch("alice-member", { role: "member" });
    if (kind === "expired") state = await signState({ user_id: "alice", scope_type: "team", team_id: "team", ts: Date.now() - 601_000 });
    if (kind === "tampered") state += "0";
    const res = await call(completeSlackInstall, ctx, { code: "slack-code", state });
    expect(res.ok).toBe(false);
    expect(res.error).toBe(kind === "wrong-user" ? "wrong_user" : ["expired", "tampered"].includes(kind) ? "bad_state" : "not_admin");
    expect(requests).toHaveLength(0);
    expect(ctx.db._tables.slack_installations).toHaveLength(0);
    expect(ctx.db._tables.slack_user_tokens).toHaveLength(0);
  });

  test.each(["invalid_code", "code_already_used", "network"])("does not store an installation on %s", async (error) => {
    const ctx = context();
    const state = await start(ctx);
    slackAnswer = { ok: false, error };
    fetchFailure = error === "network";
    const res = await call(completeSlackInstall, ctx, { code: "slack-code", state });
    expect(res.error).toBe(fetchFailure ? "exchange_failed" : error);
    expect(ctx.db._tables.slack_installations).toHaveLength(0);
    expect(ctx.db._tables.slack_user_tokens).toHaveLength(0);
  });

  test("cannot take a Slack workspace already owned by another Codecast team", async () => {
    const ctx = context();
    await ctx.db.insert("slack_installations", { workspace_id: "slack-team", team_id: "other-team", bot_token: "original" });
    const res = await call(completeSlackInstall, ctx, { code: "slack-code", state: await start(ctx) });
    expect(res.error).toBe("workspace_taken");
    expect(ctx.db._tables.slack_installations[0].bot_token).toBe("original");
    expect(ctx.db._tables.slack_user_tokens).toHaveLength(0);
  });

  test("reconnecting the same workspace refreshes one installation", async () => {
    const ctx = context();
    await call(completeSlackInstall, ctx, { code: "first", state: await start(ctx) });
    slackAnswer.access_token = "new-bot-token";
    await call(completeSlackInstall, ctx, { code: "second", state: await start(ctx) });
    expect(ctx.db._tables.slack_installations).toHaveLength(1);
    expect(ctx.db._tables.slack_user_tokens).toHaveLength(1);
    expect(ctx.db._tables.slack_installations[0].bot_token).toBe("new-bot-token");
  });

  test("a personal anchor install remains scoped to its owner", async () => {
    const ctx = context();
    await ctx.db.insert("anchors", { scope_user_id: "alice", host_user_id: "alice", status: "active" });
    const res = await call(completeSlackInstall, ctx, { code: "personal-code", state: await start(ctx, "user") });
    expect(res.ok).toBe(true);
    expect(ctx.db._tables.slack_installations[0].scope_user_id).toBe("alice");
    expect(ctx.db._tables.slack_installations[0].team_id).toBeUndefined();
  });

  test("a team member can connect their own account without replacing the bot", async () => {
    const ctx = context();
    await call(completeSlackInstall, ctx, { code: "team-code", state: await start(ctx) });
    await ctx.db.patch("alice-member", { role: "member" });
    const state = await start(ctx, "self");
    slackAnswer.access_token = "must-not-replace-bot";
    slackAnswer.authed_user.access_token = "new-person-token";
    const res = await call(completeSlackInstall, ctx, { code: "personal-code", state });
    expect(res.ok).toBe(true);
    expect(ctx.db._tables.slack_installations[0].bot_token).toBe("test-bot-token");
    expect(ctx.db._tables.slack_user_tokens[0].token).toBe("new-person-token");
  });

  test("a self connection without granted user permissions cannot report success", async () => {
    const ctx = context();
    await call(completeSlackInstall, ctx, { code: "team-code", state: await start(ctx) });
    const state = await start(ctx, "self");
    delete slackAnswer.authed_user;
    const res = await call(completeSlackInstall, ctx, { code: "personal-code", state });
    expect(res.error).toBe("no_user_token");
    expect(ctx.db._tables.slack_user_tokens[0].token).toBe("test-person-token");
  });

  test("a member's own connection cannot substitute a different Slack workspace", async () => {
    const ctx = context();
    await call(completeSlackInstall, ctx, { code: "team-code", state: await start(ctx) });
    const state = await start(ctx, "self");
    slackAnswer.team.id = "other-slack";
    slackAnswer.authed_user.access_token = "wrong-person-token";
    const res = await call(completeSlackInstall, ctx, { code: "personal-code", state });
    expect(res.error).toBe("wrong_workspace");
    expect(ctx.db._tables.slack_user_tokens[0].token).toBe("test-person-token");
  });
});
