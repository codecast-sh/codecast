// "Dismiss all N" acts on exactly the N sessions the prompt counted and showed.
// The server must take that set from the client, not re-derive it by age: an
// age sweep also dismisses the session the person has open and any old row the
// local store does not hold, so the number on the button stops matching what
// is acted on (ct-98161).
import { describe, expect, setDefaultTimeout, test, vi } from "bun:test";
import { convexTest } from "convex-test";
import schema from "./schema";
import { api } from "./_generated/api";
import { allModules } from "./testModules.testkit";

setDefaultTimeout(120_000);

const DAY = 24 * 60 * 60 * 1000;

describe("dismissStaleInboxSessions", () => {
  test("dismisses exactly the sessions the prompt counted, and nothing else", async () => {
    vi.useFakeTimers();
    const t = convexTest(schema, allModules);
    const old = Date.now() - 60 * DAY;
    const ids = await t.run(async (ctx) => {
      const owner = await ctx.db.insert("users", { name: "Ann", email: "ann@x.dev" } as any);
      const conv = (n: number) =>
        ctx.db.insert("conversations", {
          user_id: owner, agent_type: "claude_code", session_id: crypto.randomUUID(),
          started_at: old - n, updated_at: old - n, message_count: 1, is_private: true, status: "completed",
        } as any);
      // a, b: the two the prompt counted ("Dismiss all 2").
      // open: just as old, but it is the session on screen, so the list left it out.
      return { owner, a: await conv(1), b: await conv(2), open: await conv(3) };
    });
    const as = t.withIdentity({ subject: `${ids.owner}|session` });

    await as.mutation(api.conversations.dismissStaleInboxSessions, { ids: [ids.a, ids.b] } as any);
    await t.finishAllScheduledFunctions(vi.runAllTimers);

    const rows = await t.run(async (ctx) => ({
      a: await ctx.db.get(ids.a), b: await ctx.db.get(ids.b), open: await ctx.db.get(ids.open),
    }));
    expect(rows.a?.inbox_dismissed_at).toBeNumber();
    expect(rows.b?.inbox_dismissed_at).toBeNumber();
    expect(rows.open?.inbox_dismissed_at).toBeUndefined();
    vi.useRealTimers();
  });
  test("Undo restores exactly that sweep's rows, not one dismissed by something else", async () => {
    const t = convexTest(schema, allModules);
    const old = Date.now() - 60 * DAY;
    const ids = await t.run(async (ctx) => {
      const owner = await ctx.db.insert("users", { name: "Ann", email: "ann@x.dev" } as any);
      const conv = (n: number, extra: object = {}) =>
        ctx.db.insert("conversations", {
          user_id: owner, agent_type: "claude_code", session_id: crypto.randomUUID(),
          started_at: old - n, updated_at: old - n, message_count: 1, is_private: true, status: "completed", ...extra,
        } as any);
      return { owner, a: await conv(1), earlier: await conv(2, { inbox_dismissed_at: old }) };
    });
    const as = t.withIdentity({ subject: `${ids.owner}|session` });
    const at = Date.now();
    await as.mutation(api.conversations.dismissStaleInboxSessions, { ids: [ids.a, ids.earlier], at });
    await as.mutation(api.conversations.restoreStaleInboxSessions, { ids: [ids.a, ids.earlier], at });
    const rows = await t.run(async (ctx) => ({ a: await ctx.db.get(ids.a), earlier: await ctx.db.get(ids.earlier) }));
    expect(rows.a?.inbox_dismissed_at).toBeUndefined();
    expect(rows.earlier?.inbox_dismissed_at).toBe(old);
  });
});
