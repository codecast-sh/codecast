// `cast typed`'s read over the per-send log: the token's person's sends since
// a time, oldest first, paged, as time + session short id + typed length, with
// decision answers marked by kind and no text anywhere in the answer.
import { expect, test } from "bun:test";
import { convexTest } from "convex-test";
import schema from "./schema";
import { api } from "./_generated/api";
import { allModules } from "./testModules.testkit";
import { hashToken } from "./apiTokens";

const TOKEN = "typed-test-token";

async function seed() {
  const t = convexTest(schema, allModules);
  await t.run(async (ctx) => {
    const me = await ctx.db.insert("users", { name: "Me" } as any);
    const other = await ctx.db.insert("users", { name: "Other" } as any);
    await ctx.db.insert("api_tokens", { user_id: me, token_hash: await hashToken(TOKEN), name: "cli", created_at: 1, last_used_at: 1 } as any);
    const conv = (short_id: string, project_path: string) =>
      ctx.db.insert("conversations", {
        user_id: me, short_id, project_path, agent_type: "claude_code",
        session_id: short_id, started_at: 1, updated_at: 1, message_count: 0, status: "active",
      } as any);
    const work = await conv("jx7work", "/Users/me/src/app");
    const testRun = await conv("jx7test", "/private/tmp/codecast-test-cwd-abc/repo");
    const send = async (user: any, c: any, timestamp: number, text: string, extra: Record<string, unknown> = {}) => {
      const message = await ctx.db.insert("messages", { conversation_id: c, role: "user", content: text, timestamp } as any);
      await ctx.db.insert("user_sends", { user_id: user, conversation_id: c, message_id: message, timestamp, words: 1, text, clipped: false, ...extra } as any);
    };
    await send(me, work, 1000, "too early");
    await send(me, work, 2000, "fix the build");
    await send(other, work, 2500, "someone else's prompt");
    await send(me, work, 3000, "see <pasted_content id=\"1\">a long log</pasted_content> above");
    await send(me, work, 4000, "Ship it", { decision: { question: "Which way?", picked: true } });
    await send(me, work, 5000, "Hold until Thursday", { decision: { question: "Ship now?", picked: false } });
    await send(me, testRun, 6000, "a test suite's prompt");
    // The log cut this paste at its cap, closing tag and all.
    await send(me, work, 7000, "why does it fail? <pasted_content id=\"2\">" + "x".repeat(7950), { clipped: true });
  });
  return t;
}

test("the person's sends since a time, oldest first, without text", async () => {
  const t = await seed();
  const page = await t.query(api.userSends.typedSince, { api_token: TOKEN, since: 2000 });
  page.messages = page.messages.filter((m) => m.at < 7000);
  expect(page).toEqual({
    messages: [
      { at: 2000, session: "jx7work", chars: "fix the build".length, kind: "message" },
      { at: 3000, session: "jx7work", chars: "see  above".length, kind: "message" },
      { at: 4000, session: "jx7work", chars: "Ship it".length, kind: "decision_picked" },
      { at: 5000, session: "jx7work", chars: "Hold until Thursday".length, kind: "decision_written" },
    ],
    next: null,
  });
  expect(JSON.stringify(page)).not.toContain("fix the build");
});

test("a paste the log cut at its cap counts only the words around it", async () => {
  const t = await seed();
  const page = await t.query(api.userSends.typedSince, { api_token: TOKEN, since: 7000 });
  expect(page.messages).toEqual([{ at: 7000, session: "jx7work", chars: "why does it fail?".length, kind: "message" }]);
});

test("pages walk the window with the cursor each page returns", async () => {
  const t = await seed();
  const first = await t.query(api.userSends.typedSince, { api_token: TOKEN, since: 2000, limit: 2 });
  expect(first.messages.map((m) => m.at)).toEqual([2000, 3000]);
  expect(first.next).toBe(3000);
  const second = await t.query(api.userSends.typedSince, { api_token: TOKEN, since: 2000, after: first.next!, limit: 2 });
  expect(second.messages.map((m) => m.at)).toEqual([4000, 5000]);
  const last = await t.query(api.userSends.typedSince, { api_token: TOKEN, since: 2000, after: second.next!, limit: 2 });
  // The test-run session's row at 6000 is read and dropped.
  expect(last.messages.map((m) => m.at)).toEqual([7000]);
  expect(last.next).toBe(7000);
  const end = await t.query(api.userSends.typedSince, { api_token: TOKEN, since: 2000, after: last.next!, limit: 2 });
  expect(end).toEqual({ messages: [], next: null });
});

test("a bad token is refused", async () => {
  const t = await seed();
  await expect(t.query(api.userSends.typedSince, { api_token: "nope", since: 0 })).rejects.toThrow(/Unauthorized/);
});
