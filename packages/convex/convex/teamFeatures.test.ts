import { describe, expect, test } from "bun:test";
import { makeFakeDb } from "./testDb";
import { gatedSnippetAvailability, setTeamFeature, teamHasFeature } from "./teamFeatures";
import { createChannel, listChannels, searchMessages, sendMessage } from "./chat";
import { snippetAvailableForTeams, teamFeatureEnabled } from "@codecast/shared/contracts";

const ALICE = "user-alice" as any;
const BOB = "user-bob" as any;
const ON = "team-on" as any;
const OFF = "team-off" as any;
const CH_ON = "chat_channels_on" as any;
const CH_OFF = "chat_channels_off" as any;

function ctxFor(user: string | null) {
  const db = makeFakeDb({
    users: [
      { _id: ALICE, name: "Alice", email: "a@example.test", github_username: "alice" },
      { _id: BOB, name: "Bob", email: "b@example.test", github_username: "bob" },
    ],
    teams: [
      { _id: ON, name: "On", invite_code: "ON", created_at: 1, features: { chat: true } },
      { _id: OFF, name: "Off", invite_code: "OFF", created_at: 1 },
    ],
    team_memberships: [
      { _id: "m-a-on", user_id: ALICE, team_id: ON, role: "admin" },
      { _id: "m-a-off", user_id: ALICE, team_id: OFF, role: "member" },
      { _id: "m-b-off", user_id: BOB, team_id: OFF, role: "admin" },
    ],
    chat_channels: [
      { _id: CH_ON, team_id: ON, name: "general", created_by: ALICE, created_at: 1, updated_at: 1 },
      { _id: CH_OFF, team_id: OFF, name: "general", created_by: BOB, created_at: 1, updated_at: 1 },
    ],
    chat_messages: [], chat_reactions: [], chat_reads: [], chat_channel_members: [],
    rate_limits: [], notifications: [], push_outbox: [], entity_subscriptions: [],
    user_presence: [], anchors: [], anchor_channels: [], pending_messages: [], conversations: [],
  });
  return {
    db,
    auth: { async getUserIdentity() { return user ? { subject: `${user}|session` } : null; } },
    async runMutation() { return undefined; },
    scheduler: { async runAfter() {} },
  } as any;
}
const call = (fn: any, ctx: any, args: any) => (fn as any)._handler(ctx, args);

describe("the shared rule", () => {
  test("absent flag, absent bag, absent team all read as off", () => {
    expect(teamFeatureEnabled(undefined, "chat")).toBe(false);
    expect(teamFeatureEnabled({}, "chat")).toBe(false);
    expect(teamFeatureEnabled({ features: {} }, "chat")).toBe(false);
    expect(teamFeatureEnabled({ features: { chat: false } }, "chat")).toBe(false);
    expect(teamFeatureEnabled({ features: { chat: true } }, "chat")).toBe(true);
    // One feature never implies another.
    expect(teamFeatureEnabled({ features: { chat: true } }, "calls")).toBe(false);
  });

  test("a gated snippet is available when ANY team has the feature; ungated always", () => {
    const teams = [{ features: {} }, { features: { calls: true } }];
    expect(snippetAvailableForTeams("calls", teams)).toBe(true);
    expect(snippetAvailableForTeams("chat", teams)).toBe(false);
    expect(snippetAvailableForTeams("memory", [])).toBe(true);
  });
});

describe("the server guard", () => {
  test("teamHasFeature reads the row; a missing team is off", async () => {
    const ctx = ctxFor(ALICE);
    expect(await teamHasFeature(ctx, ON, "chat")).toBe(true);
    expect(await teamHasFeature(ctx, OFF, "chat")).toBe(false);
    expect(await teamHasFeature(ctx, "team-nope" as any, "chat")).toBe(false);
    expect(await teamHasFeature(ctx, undefined, "chat")).toBe(false);
  });

  test("chat refuses an off team for reads and writes, and answers the on team", async () => {
    const ctx = ctxFor(ALICE);
    const on = await call(listChannels, ctx, { team_id: ON });
    expect(on.channels.map((c: any) => c._id)).toEqual([CH_ON]);
    // Reads degrade to empty (the query contract), writes fail loudly.
    expect((await call(listChannels, ctx, { team_id: OFF })).channels).toEqual([]);
    expect((await call(searchMessages, ctx, { team_id: OFF, q: "hi" })).results).toEqual([]);
    await expect(call(createChannel, ctx, { team_id: OFF, name: "new" })).rejects.toThrow(/not enabled for this team/);
    await expect(call(sendMessage, ctx, { channel_id: CH_OFF, content: "hi" })).rejects.toThrow();
    const sent = await call(sendMessage, ctx, { channel_id: CH_ON, content: "hi" });
    expect(sent.message_id ?? sent).toBeTruthy();
  });
});

describe("snippet availability for the heartbeat", () => {
  test("names each gated slug with whether any of the user's teams has it on", async () => {
    expect(await gatedSnippetAvailability(ctxFor(ALICE), ALICE)).toEqual({ chat: true, calls: false });
    expect(await gatedSnippetAvailability(ctxFor(BOB), BOB)).toEqual({ chat: false, calls: false });
  });
});

describe("setTeamFeature", () => {
  test("an admin flips a flag; a member is refused; other flags survive", async () => {
    const ctx = ctxFor(ALICE);
    await expect(call(setTeamFeature, ctx, { team_id: OFF, feature: "chat", enabled: true })).rejects.toThrow(/admins/);
    const res = await call(setTeamFeature, ctx, { team_id: ON, feature: "calls", enabled: true });
    expect(res.features).toEqual({ chat: true, calls: true });
    const off = await call(setTeamFeature, ctx, { team_id: ON, feature: "chat", enabled: false });
    expect(off.features).toEqual({ chat: false, calls: true });
    expect(await teamHasFeature(ctx, ON, "chat")).toBe(false);
  });
});
