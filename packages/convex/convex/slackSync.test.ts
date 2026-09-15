import { describe, expect, test } from "bun:test";
import { getFunctionName } from "convex/server";
import { makeFakeDb } from "./testDb";
import {
  applyInboundDelete,
  applyInboundEdit,
  applyInboundMessage,
  applyInboundReaction,
  commitLink,
  ingestEvent,
  slackClientId,
  stampOutbound,
  updateLink,
} from "./slackSync";
import { sendMessage, toggleReaction } from "./chat";

const ALICE = "user-alice" as any;
const BOB = "user-bob" as any;
const TEAM = "team-main" as any;
const CHANNEL = "chat_channels_1" as any;
const OTHER_CHANNEL = "chat_channels_2" as any;
const INSTALL = "slack_installations_old" as any;
const LINK = "slack_channel_links_1" as any;
const WS = "T0UNION";
const SLACK_CH = "C0GENERAL";

function seed(over: Record<string, any[]> = {}) {
  return {
    users: [
      { _id: ALICE, name: "Alice", email: "alice@example.test", github_username: "alice" },
      { _id: BOB, name: "Bob", email: "bob@example.test", github_username: "bob" },
    ],
    teams: [{ _id: TEAM, name: "Union", invite_code: "U", created_at: 1, features: { chat: true } }],
    team_memberships: [
      { _id: "m-alice", user_id: ALICE, team_id: TEAM, role: "admin" },
      { _id: "m-bob", user_id: BOB, team_id: TEAM, role: "member" },
    ],
    chat_channels: [
      { _id: CHANNEL, team_id: TEAM, name: "general", created_by: ALICE, created_at: 1_000, updated_at: 1_000 },
      { _id: OTHER_CHANNEL, team_id: TEAM, name: "random", created_by: BOB, created_at: 1_000, updated_at: 1_000 },
    ],
    chat_messages: [],
    chat_reactions: [],
    chat_reads: [],
    chat_channel_members: [],
    rate_limits: [],
    notifications: [],
    push_outbox: [],
    entity_subscriptions: [],
    user_presence: [],
    anchors: [],
    anchor_channels: [],
    pending_messages: [],
    conversations: [],
    slack_installations: [{
      _id: INSTALL, workspace_id: WS, workspace_name: "Union", bot_user_id: "UBOT", bot_token: "xoxb-test", app_id: "A0CODECAST",
      team_id: TEAM, installed_by_user_id: ALICE, created_at: 1, updated_at: 1,
    }],
    slack_channel_links: [{
      _id: LINK, team_id: TEAM, installation_id: INSTALL, workspace_id: WS, slack_channel_id: SLACK_CH, slack_channel_name: "general",
      chat_channel_id: CHANNEL, direction: "both",
      options: { threads: true, reactions: true, edits: true, files: true, bot_messages: false, system_messages: false, agent_lines: true, match_people_by_email: true },
      since_ts: "1000.000000", created_by: ALICE, created_at: 1, updated_at: 1,
    }],
    slack_events: [],
    slack_sync_events: [],
    slack_users: [],
    ...over,
  };
}

function context(user: string | null, over: Record<string, any[]> = {}) {
  const db = makeFakeDb(seed(over));
  const scheduled: Array<{ delay: number; name: string; args: any }> = [];
  const ctx: any = {
    db,
    auth: { async getUserIdentity() { return user ? { subject: `${user}|session` } : null; } },
    async runQuery() { throw new Error("no runQuery in this test"); },
    async runMutation(_ref: unknown, _args: any) { return undefined; },
    scheduler: { async runAfter(delay: number, reference: unknown, args: any) { scheduled.push({ delay, name: getFunctionName(reference as any), args }); } },
    _scheduled: scheduled,
  };
  return ctx;
}
const call = (fn: any, ctx: any, args: any) => (fn as any)._handler(ctx, args);
const messages = (ctx: any) => ctx.db._tables.chat_messages as any[];
const scheduledNames = (ctx: any) => ctx._scheduled.map((s: any) => s.name);

describe("ingestEvent", () => {
  test("routes a channel message to a job and dedupes on event id", async () => {
    const ctx = context(null);
    const event = { type: "message", channel: SLACK_CH, user: "U1", text: "hi", ts: "1700.000100", channel_type: "channel" };
    const first = await call(ingestEvent, ctx, { event_id: "Ev1", workspace: WS, event });
    expect(first.status).toBe("queued");
    expect(scheduledNames(ctx)).toEqual(["slackSync:processEvent"]);
    const again = await call(ingestEvent, ctx, { event_id: "Ev1", workspace: WS, event });
    expect(again.status).toBe("duplicate");
    expect(ctx.db._tables.slack_sync_events.length).toBe(1);
  });
  test("an unmirrored channel is left for the anchor path and NOT recorded", async () => {
    const ctx = context(null);
    const res = await call(ingestEvent, ctx, { event_id: "Ev2", workspace: WS, event: { type: "app_mention", channel: "C0OTHER", text: "<@UBOT> hi", ts: "1" } });
    expect(res.status).toBe("no_link");
    expect(ctx.db._tables.slack_events.length).toBe(0);
  });
  test("our own bot's echo is dropped at the door", async () => {
    const ctx = context(null);
    const res = await call(ingestEvent, ctx, { event_id: "Ev3", workspace: WS, event: { type: "message", channel: SLACK_CH, user: "UBOT", text: "echo", ts: "2" } });
    expect(res.status).toBe("own_bot");
    expect(ctx.db._tables.slack_sync_events.length).toBe(0);
    const viaApp = await call(ingestEvent, ctx, { event_id: "Ev4", workspace: WS, event: { type: "message", subtype: "bot_message", channel: SLACK_CH, bot_id: "B1", bot_profile: { app_id: "A0CODECAST" }, text: "echo", ts: "3" } });
    expect(viaApp.status).toBe("own_bot");
  });
  test("another workspace's channel id never reaches this link", async () => {
    const ctx = context(null);
    const res = await call(ingestEvent, ctx, { event_id: "Ev5", workspace: "T0OTHER", event: { type: "message", channel: SLACK_CH, user: "U1", text: "x", ts: "4" } });
    expect(res.status).toBe("no_link");
  });
  test("a paused link skips, a mention in a mirrored channel is handled by the mirror", async () => {
    const ctx = context(null);
    const mention = await call(ingestEvent, ctx, { event_id: "Ev6", workspace: WS, event: { type: "app_mention", channel: SLACK_CH, user: "U1", text: "<@UBOT>", ts: "5" } });
    expect(mention.status).toBe("handled_by_mirror");
    await ctx.db.patch(LINK, { paused: true });
    const paused = await call(ingestEvent, ctx, { event_id: "Ev7", workspace: WS, event: { type: "message", channel: SLACK_CH, user: "U1", text: "x", ts: "6" } });
    expect(paused.status).toBe("skipped");
  });
  test("channel lifecycle events patch the link", async () => {
    const ctx = context(null);
    await call(ingestEvent, ctx, { event_id: "Ev8", workspace: WS, event: { type: "channel_rename", channel: { id: SLACK_CH, name: "general-2" } } });
    expect((await ctx.db.get(LINK)).slack_channel_name).toBe("general-2");
    await call(ingestEvent, ctx, { event_id: "Ev9", workspace: WS, event: { type: "channel_archive", channel: SLACK_CH } });
    expect((await ctx.db.get(LINK)).paused).toBe(true);
    await call(ingestEvent, ctx, { event_id: "Ev10", workspace: WS, event: { type: "channel_unarchive", channel: SLACK_CH } });
    expect((await ctx.db.get(LINK)).paused).toBe(false);
  });
  test("app uninstall pauses links and drops the installation", async () => {
    const ctx = context(null);
    await call(ingestEvent, ctx, { event_id: "Ev11", workspace: WS, event: { type: "app_uninstalled" } });
    expect((await ctx.db.get(LINK)).paused).toBe(true);
    expect(ctx.db._tables.slack_installations.length).toBe(0);
  });
});

describe("applyInboundMessage", () => {
  const base = {
    link_id: LINK, ts: "1700.000100", content: "hello from slack", attachments: [], live: true,
    external_author: { name: "Dana", handle: "dana", avatar_url: "https://a/b.png" },
  };
  test("inserts through the chat path with provenance, the bridge identity, and no outbound echo", async () => {
    const ctx = context(null);
    const res = await call(applyInboundMessage, ctx, base);
    expect(res.status).toBe("posted");
    const row = messages(ctx)[0];
    expect(row.client_id).toBe(slackClientId(WS, SLACK_CH, "1700.000100"));
    expect(row.external.direction).toBe("inbound");
    expect(row.external_author.name).toBe("Dana");
    const bridge = await ctx.db.get(row.user_id);
    expect(bridge.is_bot).toBe(true);
    expect(bridge.bot_kind).toBe("slack");
    expect((await ctx.db.get(INSTALL)).bridge_user_id).toBe(row.user_id);
    // The bridge is a team member so the roster knows its face.
    expect(ctx.db._tables.team_memberships.some((m: any) => m.user_id === row.user_id)).toBe(true);
    expect(scheduledNames(ctx)).not.toContain("slackSync:pushMessage");
    expect((await ctx.db.get(LINK)).inbound_count).toBe(1);
  });
  test("a mapped teammate is the author and the line still wears the Slack mark", async () => {
    const ctx = context(null);
    await call(applyInboundMessage, ctx, { ...base, author_user_id: BOB, external_author: undefined });
    const row = messages(ctx)[0];
    expect(row.user_id).toBe(BOB);
    expect(row.external_author).toBeUndefined();
    expect(row.external.provider).toBe("slack");
  });
  test("the same Slack ts twice is one row", async () => {
    const ctx = context(null);
    await call(applyInboundMessage, ctx, base);
    const dup = await call(applyInboundMessage, ctx, base);
    expect(dup.status).toBe("duplicate");
    expect(messages(ctx).length).toBe(1);
  });
  test("a reply threads under a root that came from Slack", async () => {
    const ctx = context(null);
    await call(applyInboundMessage, ctx, base);
    const reply = await call(applyInboundMessage, ctx, { ...base, ts: "1700.000200", thread_ts: "1700.000100", content: "reply" });
    const rows = messages(ctx);
    expect(rows[1].thread_root_id).toBe(rows[0]._id);
    expect(reply.status).toBe("posted");
  });
  test("a reply threads under a root WE posted, found by the stamped ts", async () => {
    const ctx = context(ALICE);
    await call(sendMessage, ctx, { channel_id: CHANNEL, content: "from codecast", client_id: "web-1" });
    const ours = messages(ctx)[0];
    expect(scheduledNames(ctx)).toContain("slackSync:pushMessage");
    await call(stampOutbound, ctx, { message_id: ours._id, link_id: LINK, ts: "1700.000300", permalink: "https://slack/p" });
    expect((await ctx.db.get(ours._id)).external.direction).toBe("outbound");
    await call(applyInboundMessage, { ...ctx, auth: context(null).auth }, { ...base, ts: "1700.000400", thread_ts: "1700.000300", content: "slack reply" });
    const reply = messages(ctx).find((m: any) => m.content === "slack reply");
    expect(reply.thread_root_id).toBe(ours._id);
  });
  test("backfilled lines keep their Slack time and bump on a collision", async () => {
    const ctx = context(null);
    await call(applyInboundMessage, ctx, { ...base, live: false, created_at: 5_000 });
    await call(applyInboundMessage, ctx, { ...base, ts: "1700.000101", live: false, created_at: 5_000 });
    const [a, b] = messages(ctx);
    expect(a.created_at).toBe(5_000);
    expect(b.created_at).toBe(5_001);
  });
});

describe("edits, deletes, reactions from Slack", () => {
  const base = { link_id: LINK, ts: "1700.000100", content: "v1", attachments: [], live: true, external_author: { name: "Dana" } };
  test("an edit patches an inbound row and refuses our own outbound row", async () => {
    const ctx = context(ALICE);
    await call(applyInboundMessage, ctx, base);
    const edit = await call(applyInboundEdit, ctx, { link_id: LINK, ts: "1700.000100", content: "v2" });
    expect(edit.status).toBe("edited");
    expect(messages(ctx)[0].content).toBe("v2");
    expect(messages(ctx)[0].edited_at).toBeTruthy();
    await call(sendMessage, ctx, { channel_id: CHANNEL, content: "ours", client_id: "web-2" });
    const ours = messages(ctx)[1];
    await call(stampOutbound, ctx, { message_id: ours._id, link_id: LINK, ts: "1700.000900" });
    const echo = await call(applyInboundEdit, ctx, { link_id: LINK, ts: "1700.000900", content: "ours (edited in slack)" });
    expect(echo.status).toBe("not_inbound");
    expect((await ctx.db.get(ours._id)).content).toBe("ours");
  });
  test("a delete tombstones an inbound row and only detaches an outbound one", async () => {
    const ctx = context(ALICE);
    await call(applyInboundMessage, ctx, base);
    await call(applyInboundReaction, ctx, { link_id: LINK, ts: "1700.000100", emoji: "👍", add: true });
    const del = await call(applyInboundDelete, ctx, { link_id: LINK, ts: "1700.000100" });
    expect(del.status).toBe("deleted");
    expect(messages(ctx)[0].deleted_at).toBeTruthy();
    expect(ctx.db._tables.chat_reactions.length).toBe(0);
    await call(sendMessage, ctx, { channel_id: CHANNEL, content: "ours", client_id: "web-3" });
    const ours = messages(ctx)[1];
    await call(stampOutbound, ctx, { message_id: ours._id, link_id: LINK, ts: "1700.000900" });
    const detach = await call(applyInboundDelete, ctx, { link_id: LINK, ts: "1700.000900" });
    expect(detach.status).toBe("detached");
    const after = await ctx.db.get(ours._id);
    expect(after.deleted_at).toBeUndefined();
    expect(after.external).toBeUndefined();
  });
  test("reactions land under the mapped teammate or the bridge, and toggle", async () => {
    const ctx = context(null);
    await call(applyInboundMessage, ctx, base);
    const r1 = await call(applyInboundReaction, ctx, { link_id: LINK, ts: "1700.000100", emoji: "🎉", add: true, user_id: BOB });
    expect(r1.status).toBe("applied");
    expect(ctx.db._tables.chat_reactions[0].user_id).toBe(BOB);
    const r2 = await call(applyInboundReaction, ctx, { link_id: LINK, ts: "1700.000100", emoji: "🎉", add: true });
    expect(r2.status).toBe("applied");
    expect(ctx.db._tables.chat_reactions.length).toBe(2);
    const r3 = await call(applyInboundReaction, ctx, { link_id: LINK, ts: "1700.000100", emoji: "🎉", add: false, user_id: BOB });
    expect(r3.status).toBe("applied");
    expect(ctx.db._tables.chat_reactions.length).toBe(1);
    const bad = await call(applyInboundReaction, ctx, { link_id: LINK, ts: "1700.000100", emoji: "not-emoji", add: true });
    expect(bad.status).toBe("bad_emoji");
  });
});

describe("outbound hooks in chat", () => {
  test("a typed line queues a push; a local-only line does not; a reaction removal waits for the last holder", async () => {
    const ctx = context(ALICE);
    await call(sendMessage, ctx, { channel_id: CHANNEL, content: "to slack", client_id: "w1" });
    await call(sendMessage, ctx, { channel_id: CHANNEL, content: "stay home", client_id: "w2", sync_local_only: true });
    expect(scheduledNames(ctx).filter((n: string) => n === "slackSync:pushMessage").length).toBe(1);
    expect(messages(ctx)[1].sync_local_only).toBe(true);
    const target = messages(ctx)[0];
    await call(stampOutbound, ctx, { message_id: target._id, link_id: LINK, ts: "1700.000500" });
    await call(toggleReaction, ctx, { message_id: target._id, emoji: "👍" });
    const bob = { ...ctx, auth: context(BOB).auth };
    await call(toggleReaction, bob, { message_id: target._id, emoji: "👍" });
    const adds = ctx._scheduled.filter((s: any) => s.name === "slackSync:pushReaction");
    expect(adds.length).toBe(2);
    await call(toggleReaction, ctx, { message_id: target._id, emoji: "👍" }); // Alice lets go, Bob still holds
    expect(ctx._scheduled.filter((s: any) => s.name === "slackSync:pushReaction" && s.args.add === false).length).toBe(0);
    await call(toggleReaction, bob, { message_id: target._id, emoji: "👍" }); // last holder
    expect(ctx._scheduled.filter((s: any) => s.name === "slackSync:pushReaction" && s.args.add === false).length).toBe(1);
  });
  test("a channel without a link queues nothing", async () => {
    const ctx = context(ALICE);
    await call(sendMessage, ctx, { channel_id: OTHER_CHANNEL, content: "plain", client_id: "w3" });
    expect(scheduledNames(ctx)).not.toContain("slackSync:pushMessage");
  });
  test("stampOutbound keeps the first stamp", async () => {
    const ctx = context(ALICE);
    await call(sendMessage, ctx, { channel_id: CHANNEL, content: "x", client_id: "w4" });
    const m = messages(ctx)[0];
    await call(stampOutbound, ctx, { message_id: m._id, link_id: LINK, ts: "1" });
    await call(stampOutbound, ctx, { message_id: m._id, link_id: LINK, ts: "2" });
    expect((await ctx.db.get(m._id)).external.ts).toBe("1");
  });
});

describe("link management", () => {
  test("commitLink refuses a second mirror on either side, and a manager-only write", async () => {
    const ctx = context(ALICE);
    await expect(call(commitLink, ctx, { chat_channel_id: CHANNEL, slack_channel_id: "C0NEW", since_ts: "1" })).rejects.toThrow(/already mirrors/);
    await expect(call(commitLink, ctx, { chat_channel_id: OTHER_CHANNEL, slack_channel_id: SLACK_CH, since_ts: "1" })).rejects.toThrow(/already mirrors/);
    const bob = context(BOB);
    // Bob created #random, so he may link it; he may not touch #general's link.
    await expect(call(updateLink, bob, { link_id: LINK, paused: true })).rejects.toThrow();
    const ok = await call(commitLink, bob, { chat_channel_id: OTHER_CHANNEL, slack_channel_id: "C0RANDOM", slack_channel_name: "random", since_ts: "1" });
    expect(ok.link_id).toBeTruthy();
    const notice = bob.db._tables.chat_messages.find((m: any) => m.channel_id === OTHER_CHANNEL);
    expect(notice.sync_local_only).toBe(true);
    expect(notice.external_author.name).toBe("Slack");
  });
  test("a link whose installation is gone is replaced, not a blocker", async () => {
    const ctx = context(ALICE, { slack_installations: [] });
    await ctx.db.insert("slack_installations", { workspace_id: "T0NEW", workspace_name: "New", bot_user_id: "UB2", bot_token: "x", team_id: TEAM, installed_by_user_id: ALICE, created_at: 1, updated_at: 1 });
    const ok = await call(commitLink, ctx, { chat_channel_id: CHANNEL, slack_channel_id: "C0X", since_ts: "1" });
    expect(ok.link_id).toBeTruthy();
    expect(ctx.db._tables.slack_channel_links.length).toBe(1);
  });
  test("updateLink merges options and clears the error on resume", async () => {
    const ctx = context(ALICE);
    await ctx.db.patch(LINK, { paused: true, last_error: "boom", last_error_at: 5 });
    await call(updateLink, ctx, { link_id: LINK, options: { threads: false }, paused: false, direction: "slack_to_codecast" });
    const link = await ctx.db.get(LINK);
    expect(link.options.threads).toBe(false);
    expect(link.options.reactions).toBe(true);
    expect(link.paused).toBe(false);
    expect(link.last_error).toBeUndefined();
    expect(link.direction).toBe("slack_to_codecast");
  });
});
