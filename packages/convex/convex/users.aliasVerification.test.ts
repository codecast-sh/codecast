import { describe, expect, test } from "bun:test";
import { getFunctionName } from "convex/server";
import { makeFakeDb } from "./testDb";
import { addAlternateEmail } from "./users";
import { claimSlackPeopleByEmail, mapSlackPerson, upsertSlackUser } from "./slackSync";

const call = (fn: any, ctx: any, args: any) => fn._handler(ctx, args);
function fixture(over: Record<string, any[]> = {}) {
  const db = makeFakeDb({
    users: [{ _id: "member", email: "member@example.test", alternate_emails: ["victim@example.test"] }],
    teams: [{ _id: "team", features: { chat: true } }],
    team_memberships: [{ _id: "membership", user_id: "member", team_id: "team", role: "member" }],
    slack_installations: [{ _id: "install", workspace_id: "workspace", team_id: "team", installed_by_user_id: "member" }],
    slack_users: [{ _id: "person", workspace_id: "workspace", slack_user_id: "slack-victim", email: "victim@example.test", shadow_user_id: "shadow" }],
    chat_channels: [{ _id: "room", team_id: "team", dm_key: "team:shadow:someone" }],
    chat_channel_members: [{ _id: "room-member", channel_id: "room", user_id: "shadow" }],
    chat_messages: [{ _id: "private-message", channel_id: "room", user_id: "shadow", content: "fixture private message" }],
    ...over,
  });
  const scheduled: any[] = [];
  return {
    db,
    auth: { getUserIdentity: async () => ({ subject: "member|session" }) },
    runMutation: async () => {},
    scheduler: { runAfter: async (_delay: number, ref: any, args: any) => { scheduled.push({ name: getFunctionName(ref), args }); } },
    scheduled,
  };
}
function expectNoAuthorityWrites(ctx: ReturnType<typeof fixture>) {
  expect(ctx.scheduled.filter((s) => /slackSync/.test(s.name))).toEqual([]);
  expect(ctx.db._patched.filter((p: any) => ["person", "room", "room-member", "private-message"].includes(p._id))).toEqual([]);
  expect(ctx.db._deleted).toEqual([]);
}

describe("alternate addresses do not prove Slack identity", () => {
  test("adding a contact address does not schedule a Slack claim or touch private rooms", async () => {
    const ctx = fixture({ users: [{ _id: "member", email: "member@example.test" }] });
    expect(await call(addAlternateEmail, ctx, { email: " Victim@example.test " })).toMatchObject({ added: true, email: "victim@example.test" });
    expect((await ctx.db.get("member")).alternate_emails).toEqual(["victim@example.test"]);
    expectNoAuthorityWrites(ctx);
  });

  test("a queued claim from a legacy unverified alias causes no identity or room writes", async () => {
    const ctx = fixture();
    expect(await call(claimSlackPeopleByEmail, ctx, { user_id: "member", email: "victim@example.test" })).toEqual({ claimed: 0 });
    expectNoAuthorityWrites(ctx);
  });

  test("a raw primary email and a spoofed self-map cannot claim another person", async () => {
    const ctx = fixture({ users: [{ _id: "member", email: "victim@example.test" }] });
    expect(await call(claimSlackPeopleByEmail, ctx, { user_id: "member", email: "victim@example.test" })).toEqual({ claimed: 0 });
    await expect(call(mapSlackPerson, ctx, { team_id: "team", slack_user_id: "slack-victim", codecast_user_id: "member" })).rejects.toThrow(/Sign in with Slack or verify/);
    expectNoAuthorityWrites(ctx);
  });

  test("profile refresh ignores unverified aliases", async () => {
    const ctx = fixture({ slack_users: [] });
    const row = await call(upsertSlackUser, ctx, { workspace_id: "workspace", slack_user_id: "slack-victim", team_id: "team", profile: { profile: { email: "victim@example.test" } } });
    expect(row.codecast_user_id).toBeUndefined();
    expectNoAuthorityWrites(ctx);
  });

  test("one verified primary owner can claim and schedule retargeting", async () => {
    const ctx = fixture({ users: [{ _id: "member", email: "victim@example.test", emailVerificationTime: 1 }] });
    expect(await call(claimSlackPeopleByEmail, ctx, { user_id: "member", email: "victim@example.test" })).toEqual({ claimed: 1 });
    expect((await ctx.db.get("person")).codecast_user_id).toBe("member");
    expect(ctx.scheduled.find((s) => s.name === "slackSync:retargetPersonRooms")?.args).toEqual({ team_id: "team", from_user_id: "shadow", to_user_id: "member" });
  });

  test("a legacy auth-account mailbox receipt remains sufficient proof", async () => {
    const ctx = fixture({ users: [{ _id: "member", email: "victim@example.test" }], authAccounts: [{ _id: "auth-account", userId: "member", provider: "password", emailVerified: "victim@example.test" }] });
    expect(await call(claimSlackPeopleByEmail, ctx, { user_id: "member", email: "victim@example.test" })).toEqual({ claimed: 1 });
  });

  test("provider presence without a mailbox receipt is not proof", async () => {
    const ctx = fixture({ users: [{ _id: "member", email: "victim@example.test" }], authAccounts: [{ _id: "auth-account", userId: "member", provider: "github", providerAccountId: "123" }] });
    expect(await call(claimSlackPeopleByEmail, ctx, { user_id: "member", email: "victim@example.test" })).toEqual({ claimed: 0 });
    expectNoAuthorityWrites(ctx);
  });

  test("ambiguous verified owners never pick the first match", async () => {
    const ctx = fixture({ users: [
      { _id: "member", email: "victim@example.test", emailVerificationTime: 1 },
      { _id: "duplicate", email: "victim@example.test", emailVerificationTime: 2 },
    ] });
    expect(await call(claimSlackPeopleByEmail, ctx, { user_id: "member", email: "victim@example.test" })).toEqual({ claimed: 0 });
    expectNoAuthorityWrites(ctx);
  });

  test("verified email permits a member to claim their own Slack person", async () => {
    const ctx = fixture({ users: [{ _id: "member", email: "victim@example.test", emailVerificationTime: 1 }] });
    await call(mapSlackPerson, ctx, { team_id: "team", slack_user_id: "slack-victim", codecast_user_id: "member" });
    expect((await ctx.db.get("person")).codecast_user_id).toBe("member");
  });

  test("a stored Slack OAuth identity permits the exact subject without an email match", async () => {
    const ctx = fixture({ slack_user_tokens: [{ _id: "token", installation_id: "install", workspace_id: "workspace", user_id: "member", slack_user_id: "slack-victim" }] });
    await call(mapSlackPerson, ctx, { team_id: "team", slack_user_id: "slack-victim", codecast_user_id: "member" });
    expect((await ctx.db.get("person")).codecast_user_id).toBe("member");
  });

  test.each([
    { workspace_id: "other-workspace", slack_user_id: "slack-victim" },
    { workspace_id: "workspace", slack_user_id: "other-person" },
  ])("OAuth proof for a different workspace or subject is rejected", async (token) => {
    const ctx = fixture({ slack_user_tokens: [{ _id: "token", installation_id: "install", user_id: "member", ...token }] });
    await expect(call(mapSlackPerson, ctx, { team_id: "team", slack_user_id: "slack-victim", codecast_user_id: "member" })).rejects.toThrow(/Sign in with Slack or verify/);
    expectNoAuthorityWrites(ctx);
  });

  test("a claim leaves existing manual mappings and DMs untouched", async () => {
    const ctx = fixture({ users: [{ _id: "member", email: "victim@example.test", emailVerificationTime: 1 }], slack_users: [{ _id: "person", workspace_id: "workspace", slack_user_id: "slack-victim", email: "victim@example.test", codecast_user_id: "manual-owner", mapped_by: "manual" }] });
    expect(await call(claimSlackPeopleByEmail, ctx, { user_id: "member", email: "victim@example.test" })).toEqual({ claimed: 0 });
    expectNoAuthorityWrites(ctx);
  });
});
