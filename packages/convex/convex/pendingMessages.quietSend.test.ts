import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { convexTest } from "convex-test";
import schema from "./schema";
import { api } from "./_generated/api";
import { hashToken } from "./apiTokens";
import { allModules } from "./testModules.testkit";

setDefaultTimeout(60_000);

// A quiet send (flows.md FL4): a flow run hands its subject session work out
// of sight. A hidden stash and a snooze stay, the way a trigger's wake leaves them;
// a killed or dismissed session still revives, and a send with no sender
// session (a person) is never quiet.

const TOKEN = "quiet-send-test-token";

async function setup(recipient: Record<string, unknown>) {
  const t = convexTest(schema, allModules);
  const ids = await t.run(async (ctx) => {
    const now = Date.now();
    const user = await ctx.db.insert("users", { emailVerificationTime: 1, name: "Riley" } as any);
    await ctx.db.insert("api_tokens", { user_id: user, token_hash: await hashToken(TOKEN), name: "cli", created_at: now, last_used_at: now } as any);
    await ctx.db.insert("conversations", { user_id: user, agent_type: "claude_code", started_at: now, short_id: "jx7send" } as any);
    const conv = await ctx.db.insert("conversations", { user_id: user, agent_type: "claude_code", started_at: now, short_id: "jx7recv", ...recipient } as any);
    return { conv };
  });
  const send = (extra: Record<string, unknown>) =>
    t.mutation(api.pendingMessages.sendSessionMessage, { to: "jx7recv", body: "Check failed; fix it", api_token: TOKEN, ...extra } as any);
  const row = () => t.run(async (ctx) => (await ctx.db.get(ids.conv)) as any);
  return { send, row };
}

describe("a quiet send from a session", () => {
  test("leaves a hidden stash hidden and still revives a killed session", async () => {
    const { send, row } = await setup({ inbox_stashed_at: 100, inbox_stash_hidden: true, inbox_killed_at: 200, inbox_dismissed_at: 150 });
    await send({ from: "jx7send", quiet: true });
    const conv = await row();
    expect(conv.inbox_stashed_at).toBe(100);
    expect(conv.inbox_killed_at).toBeUndefined();
    expect(conv.inbox_dismissed_at).toBeUndefined();
    expect(conv.has_pending_messages).toBe(true);
  });

  test("leaves a snooze in place; an ordinary session send clears it", async () => {
    const until = Date.now() + 3_600_000;
    const quiet = await setup({ inbox_snoozed_until: until });
    await quiet.send({ from: "jx7send", quiet: true });
    expect((await quiet.row()).inbox_snoozed_until).toBe(until);
    const loud = await setup({ inbox_snoozed_until: until });
    await loud.send({ from: "jx7send" });
    expect((await loud.row()).inbox_snoozed_until).toBeUndefined();
  });

  test("clears a plain stash, as any wake does", async () => {
    const { send, row } = await setup({ inbox_stashed_at: 100 });
    await send({ from: "jx7send", quiet: true });
    expect((await row()).inbox_stashed_at).toBeUndefined();
  });

  test("an ordinary session send keeps a hidden stash too: no person sent it (isMachineWake)", async () => {
    const { send, row } = await setup({ inbox_stashed_at: 100, inbox_stash_hidden: true });
    await send({ from: "jx7send" });
    expect((await row()).inbox_stashed_at).toBe(100);
  });

  test("an ordinary session send clears a plain stash", async () => {
    const { send, row } = await setup({ inbox_stashed_at: 100 });
    await send({ from: "jx7send" });
    expect((await row()).inbox_stashed_at).toBeUndefined();
  });

  test("quiet means nothing without a sender session", async () => {
    const { send, row } = await setup({ inbox_stashed_at: 100, inbox_stash_hidden: true });
    await send({ quiet: true });
    expect((await row()).inbox_stashed_at).toBeUndefined();
  });
});
