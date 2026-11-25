import { describe, expect, test } from "bun:test";
import { convexTest } from "convex-test";
import schema from "./schema";
import { api, internal } from "./_generated/api";
import { allModules } from "./testModules.testkit";
import { hashToken } from "./apiTokens";
import { PRESENCE_FRESH_MS } from "./presencePolicy";
import { redactSecrets } from "./redact";
import { CONVERSATION_ROW_TABLES } from "./lib/conversationRows";
import { REPLY_STREAM_LOAD_MAX_AGE_MS, REPLY_STREAM_MAX_CHARS } from "@codecast/shared/contracts";

const TOKEN = "owner-token";
const OTHER_TOKEN = "other-token";

async function seed(opts: { flag?: boolean; ownerLevel?: string; personal?: boolean } = {}) {
  const t = convexTest(schema, allModules);
  const ids = await t.run(async (ctx) => {
    const now = Date.now();
    const owner = await ctx.db.insert("users", { name: "Owner" });
    const other = await ctx.db.insert("users", { name: "Other" });
    const summaryMate = await ctx.db.insert("users", { name: "Summary teammate" });
    const fullMate = await ctx.db.insert("users", { name: "Full teammate" });
    for (const [user, token] of [[owner, TOKEN], [other, OTHER_TOKEN]] as const) {
      await ctx.db.insert("api_tokens", { user_id: user, token_hash: await hashToken(token), name: "cli", created_at: now, last_used_at: now });
    }
    const team = await ctx.db.insert("teams", {
      name: "T", created_at: now, invite_code: "t", ...(opts.flag ? { features: { reply_streaming: true } } : {}),
    } as any);
    await ctx.db.insert("team_memberships", { user_id: owner, team_id: team, role: "member", joined_at: now, ...(opts.ownerLevel ? { visibility: opts.ownerLevel } : {}) } as any);
    await ctx.db.insert("team_memberships", { user_id: fullMate, team_id: team, role: "member", joined_at: now } as any);
    await ctx.db.insert("team_memberships", { user_id: summaryMate, team_id: team, role: "member", joined_at: now } as any);
    const conversation = await ctx.db.insert("conversations", {
      user_id: owner, is_private: !!opts.personal, ...(opts.personal ? {} : { team_id: team }),
      agent_type: "claude_code", session_id: "s1", started_at: now, updated_at: now, message_count: 0, status: "active",
    } as any);
    return { owner, other, summaryMate, fullMate, team, conversation };
  });
  return { t, ...ids };
}

type Seeded = Awaited<ReturnType<typeof seed>>;

async function view(s: Seeded, lastSeen = Date.now()) {
  await s.t.run(async (ctx) => {
    await ctx.db.insert("user_presence", {
      user_id: s.owner, surface: "web", last_seen: lastSeen, last_input_at: lastSeen, focused: true, updated_at: lastSeen,
      viewing_conversation_id: s.conversation,
    });
  });
}

const push = (s: Seeded, over: Partial<{ message_id: string; seq: number; started_at: number; text: string; api_token: string }> = {}) =>
  s.t.mutation(api.replyStreams.push, {
    api_token: TOKEN, conversation_id: s.conversation, message_id: "m1", seq: 1, started_at: 1000, text: "Hello", ...over,
  });

const rows = (s: Seeded) => s.t.run((ctx) => ctx.db.query("reply_streams").collect());

describe("push", () => {
  test("flag off answers off and writes nothing", async () => {
    const s = await seed();
    await view(s);
    expect(await push(s)).toEqual({ state: "off" });
    expect(await rows(s)).toHaveLength(0);
  });

  test("nobody viewing answers unwatched and writes nothing", async () => {
    const s = await seed({ flag: true });
    expect(await push(s)).toEqual({ state: "unwatched" });
    expect(await rows(s)).toHaveLength(0);
  });

  test("a presence row older than the freshness bound is not a viewer", async () => {
    const s = await seed({ flag: true });
    await view(s, Date.now() - PRESENCE_FRESH_MS - 1);
    expect(await push(s)).toEqual({ state: "unwatched" });
    expect(await rows(s)).toHaveLength(0);
  });

  test("a fresh viewer: writes, advances, ignores late pushes, and moves to a newer message", async () => {
    const s = await seed({ flag: true });
    await view(s);
    expect(await push(s, { seq: 1, text: "Hello" })).toEqual({ state: "written" });
    expect((await rows(s))[0]).toMatchObject({ message_id: "m1", seq: 1, text: "Hello", started_at: 1000, user_id: s.owner });

    expect(await push(s, { seq: 2, text: "Hello world" })).toEqual({ state: "written" });
    expect((await rows(s))[0]).toMatchObject({ seq: 2, text: "Hello world" });

    expect(await push(s, { seq: 1, text: "stale" })).toEqual({ state: "written" });
    expect(await push(s, { seq: 2, text: "dup" })).toEqual({ state: "written" });
    expect((await rows(s))[0]).toMatchObject({ seq: 2, text: "Hello world" });

    expect(await push(s, { message_id: "m2", seq: 1, started_at: 2000, text: "Next" })).toEqual({ state: "written" });
    expect((await rows(s))[0]).toMatchObject({ message_id: "m2", seq: 1, started_at: 2000, text: "Next" });

    expect(await push(s, { message_id: "m0", seq: 9, started_at: 1500, text: "older message" })).toEqual({ state: "written" });
    const all = await rows(s);
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({ message_id: "m2", text: "Next" });
  });

  test("text past the cap is cut to it", async () => {
    const s = await seed({ flag: true });
    await view(s);
    await push(s, { text: "x".repeat(REPLY_STREAM_MAX_CHARS + 50) });
    expect((await rows(s))[0].text).toHaveLength(REPLY_STREAM_MAX_CHARS);
  });

  test("a secret in the text is redacted as a message's would be", async () => {
    const s = await seed({ flag: true });
    await view(s);
    // Built at runtime: push protection rejects credential-shaped literals.
    const secret = "DEPLOY" + "_TOKEN=" + "a1b2c3d4e5f6g7h8";
    await push(s, { text: `Run it with ${secret} set.` });
    const text = (await rows(s))[0].text;
    expect(text).not.toContain("a1b2c3d4e5f6g7h8");
    expect(text).toBe(redactSecrets(`Run it with ${secret} set.`));
  });

  test("a key block still being written is held back until it closes and redacts whole", async () => {
    const s = await seed({ flag: true });
    await view(s);
    // Built at runtime: push protection rejects credential-shaped literals.
    const begin = "-----BEGIN " + "PRIVATE KEY-----";
    const end = "-----END " + "PRIVATE KEY-----";
    await push(s, { seq: 1, text: `Here is the key:\n${begin}\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASC\n` });
    expect((await rows(s))[0].text).toBe("Here is the key:\n");
    const whole = `Here is the key:\n${begin}\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASC\n${end}\nDone.`;
    await push(s, { seq: 2, text: whole });
    const text = (await rows(s))[0].text;
    expect(text).toBe(redactSecrets(whole));
    expect(text).not.toContain("MIIEvQIBADANBgkqhkiG9w0BAQEFAASC");
    expect(text).toContain("Done.");
  });

  test("a row nobody has written to for the load age no longer orders pushes", async () => {
    const s = await seed({ flag: true });
    await view(s);
    await push(s, { message_id: "m1", started_at: 5000, text: "From the first machine" });
    const [row] = await rows(s);
    await s.t.run((ctx) => ctx.db.patch(row._id, { updated_at: Date.now() - REPLY_STREAM_LOAD_MAX_AGE_MS - 1 }));
    // A machine whose clock runs behind takes the session over.
    await push(s, { message_id: "m2", seq: 1, started_at: 4000, text: "From the second" });
    expect((await rows(s))[0]).toMatchObject({ message_id: "m2", started_at: 4000, text: "From the second" });
  });

  test("deleting the conversation's rows takes the stream with them", () => {
    expect(CONVERSATION_ROW_TABLES).toContainEqual(["reply_streams", "by_conversation"]);
  });

  test("another user's token throws", async () => {
    const s = await seed({ flag: true });
    await view(s);
    await expect(push(s, { api_token: OTHER_TOKEN })).rejects.toThrow(/Unauthorized/);
    expect(await rows(s)).toHaveLength(0);
  });

  test("a personal conversation is on when any of the owner's teams has the flag", async () => {
    const s = await seed({ flag: true, personal: true });
    await view(s);
    expect(await push(s)).toEqual({ state: "written" });
    const off = await seed({ personal: true });
    await view(off);
    expect(await push(off)).toEqual({ state: "off" });
  });
});

describe("get", () => {
  test("the owner and a Full teammate read the row; strangers and Summary teammates get null", async () => {
    const s = await seed({ flag: true, ownerLevel: "full" });
    await view(s);
    await push(s, { text: "Hello" });
    const read = (user: any) => s.t.withIdentity({ subject: user }).query(api.replyStreams.get, { conversation_id: s.conversation });

    const row = await read(s.owner);
    expect(row).toMatchObject({ conversation_id: s.conversation, message_id: "m1", text: "Hello", seq: 1, started_at: 1000 });
    expect(row).not.toHaveProperty("user_id");
    expect(await read(s.fullMate)).toMatchObject({ text: "Hello" });
    expect(await read(s.other)).toBeNull();
    expect(await s.t.query(api.replyStreams.get, { conversation_id: s.conversation })).toBeNull();
  });

  test("a teammate the owner shares only a Summary with gets null, as listMessagesTail refuses them", async () => {
    const s = await seed({ flag: true, ownerLevel: "summary" });
    await view(s);
    await push(s);
    const as = s.t.withIdentity({ subject: s.summaryMate });
    expect(await as.query(api.conversations.listMessagesTail, { conversation_id: s.conversation, after_timestamp: 0 })).toBeNull();
    expect(await as.query(api.replyStreams.get, { conversation_id: s.conversation })).toBeNull();
  });

  test("a row older than the load age, or no row, reads as null", async () => {
    const s = await seed({ flag: true });
    const read = () => s.t.withIdentity({ subject: s.owner }).query(api.replyStreams.get, { conversation_id: s.conversation });
    expect(await read()).toBeNull();
    await view(s);
    await push(s);
    await s.t.run(async (ctx) => {
      const r = (await ctx.db.query("reply_streams").first())!;
      await ctx.db.patch(r._id, { updated_at: Date.now() - REPLY_STREAM_LOAD_MAX_AGE_MS - 1 });
    });
    expect(await read()).toBeNull();
  });
});

describe("prune", () => {
  test("deletes rows untouched for an hour and keeps fresh ones", async () => {
    const s = await seed();
    await s.t.run(async (ctx) => {
      const base = { conversation_id: s.conversation, user_id: s.owner, message_id: "m", text: "t", seq: 1, started_at: 1 };
      await ctx.db.insert("reply_streams", { ...base, message_id: "old", updated_at: Date.now() - 61 * 60_000 });
      await ctx.db.insert("reply_streams", { ...base, message_id: "fresh", updated_at: Date.now() - 5 * 60_000 });
    });
    expect(await s.t.mutation(internal.replyStreams.prune, {})).toEqual({ deleted: 1 });
    expect((await rows(s)).map((r) => r.message_id)).toEqual(["fresh"]);
  });
});
