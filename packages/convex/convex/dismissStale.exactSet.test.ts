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
const old = Date.now() - 60 * DAY;

async function seed(t: ReturnType<typeof convexTest>) {
  return await t.run(async (ctx) => {
    const owner = await ctx.db.insert("users", { name: "Ann", email: "ann@x.dev" } as any);
    const other = await ctx.db.insert("users", { name: "Bo", email: "bo@x.dev" } as any);
    const conv = (user: any, n: number, extra: object = {}) =>
      ctx.db.insert("conversations", {
        user_id: user, agent_type: "claude_code", session_id: crypto.randomUUID(),
        started_at: old - n, updated_at: old - n, message_count: 1, is_private: true, status: "completed", ...extra,
      } as any);
    return {
      owner,
      // a, b: the two the prompt counted.
      a: await conv(owner, 1),
      b: await conv(owner, 2),
      // open: just as old, but on screen, so the list left it out.
      open: await conv(owner, 3),
      // In the list all the same: someone else's row, and one pinned since.
      foreign: await conv(other, 4),
      pinned: await conv(owner, 5, { inbox_pinned_at: old }),
      // Dismissed long ago by something else.
      earlier: await conv(owner, 6, { inbox_dismissed_at: old }),
    };
  });
}

async function stamps(t: ReturnType<typeof convexTest>, ids: Record<string, any>) {
  return await t.run(async (ctx) => {
    const out: Record<string, number | undefined> = {};
    for (const [k, id] of Object.entries(ids)) if (k !== "owner") out[k] = ((await ctx.db.get(id)) as any)?.inbox_dismissed_at;
    return out;
  });
}

describe("dismissStaleInboxSessions", () => {
  test("dismisses exactly the sessions the prompt counted, and nothing else", async () => {
    vi.useFakeTimers();
    const t = convexTest(schema, allModules);
    const ids = await seed(t);
    const as = t.withIdentity({ subject: `${ids.owner}|session` });
    const at = Date.now();

    await as.mutation(api.conversations.dismissStaleInboxSessions, { ids: [ids.a, ids.b, ids.foreign, ids.pinned], at });
    await t.finishAllScheduledFunctions(vi.runAllTimers);

    expect(await stamps(t, ids)).toEqual({ a: at, b: at, open: undefined, foreign: undefined, pinned: undefined, earlier: old });
    vi.useRealTimers();
  });
});

describe("the web's markSessionsDismissed dispatch", () => {
  test("stamps only the listed rows the caller owns and has not pinned, whatever patches ride along", async () => {
    vi.useFakeTimers();
    const t = convexTest(schema, allModules);
    const ids = await seed(t);
    const as = t.withIdentity({ subject: `${ids.owner}|session` });
    const at = Date.now();
    const list = [ids.a, ids.b, ids.foreign, ids.pinned];
    // The draft's patches name every listed row; the side effect is the write.
    const patches = { conversations: Object.fromEntries(list.map((id) => [id, { inbox_dismissed_at: at }])) };

    await as.mutation(api.dispatch.dispatch, { action: "markSessionsDismissed", args: [list], patches, result: at });
    await t.finishAllScheduledFunctions(vi.runAllTimers);

    expect(await stamps(t, ids)).toEqual({ a: at, b: at, open: undefined, foreign: undefined, pinned: undefined, earlier: old });
    vi.useRealTimers();
  });

  test("a sweep of several hundred is one call, and every row lands", async () => {
    vi.useFakeTimers();
    const t = convexTest(schema, allModules);
    const { owner, many } = await t.run(async (ctx) => {
      const owner = await ctx.db.insert("users", { name: "Ann", email: "ann@x.dev" } as any);
      const many = [];
      for (let n = 0; n < 350; n++) {
        many.push(await ctx.db.insert("conversations", {
          user_id: owner, agent_type: "claude_code", session_id: `s-${n}`,
          started_at: old - n, updated_at: old - n, message_count: 1, is_private: true, status: "completed",
        } as any));
      }
      return { owner, many };
    });
    const at = Date.now();
    await t.withIdentity({ subject: `${owner}|session` }).mutation(api.dispatch.dispatch, { action: "markSessionsDismissed", args: [many], result: at });
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    const left = await t.run(async (ctx) => {
      let n = 0;
      for (const id of many) if (((await ctx.db.get(id)) as any)?.inbox_dismissed_at !== at) n++;
      return n;
    });
    expect(left).toBe(0);
    vi.useRealTimers();
  });

  test("rows the caller owns but did not start are stamped, and a teammate's is hidden for the caller until Undo", async () => {
    vi.useFakeTimers();
    const t = convexTest(schema, allModules);
    const ids = await t.run(async (ctx) => {
      const me = await ctx.db.insert("users", { name: "Ann", email: "ann@x.dev" } as any);
      const mate = await ctx.db.insert("users", { name: "Bo", email: "bo@x.dev" } as any);
      const team = await ctx.db.insert("teams", { name: "Team", created_at: old } as any);
      for (const u of [me, mate]) {
        await ctx.db.insert("team_memberships", { user_id: u, team_id: team, role: "member", joined_at: old, visibility: "full" } as any);
      }
      const conv = (extra: object) =>
        ctx.db.insert("conversations", {
          user_id: mate, agent_type: "claude_code", session_id: crypto.randomUUID(),
          started_at: old, updated_at: old, message_count: 1, is_private: true, status: "completed", ...extra,
        } as any);
      // Bo started all three. I am the primary owner of one, a secondary owner
      // of the next, and the third is Bo's, shared with the team.
      const primary = await conv({ owner_user_id: me });
      const secondary = await conv({});
      await ctx.db.insert("session_owners", { conversation_id: secondary, user_id: me, added_by: mate, added_at: old } as any);
      const teammate = await conv({ is_private: false, team_id: team, team_visibility: "full" });
      return { me, primary, secondary, teammate };
    });
    const as = t.withIdentity({ subject: `${ids.me}|session` });
    const hides = () =>
      t.run(async (ctx) => (await ctx.db.query("inbox_hides").collect()).map((h: any) => [h.conversation_id, h.kind]));
    const at = Date.now();
    const list = [ids.primary, ids.secondary, ids.teammate];

    await as.mutation(api.dispatch.dispatch, { action: "markSessionsDismissed", args: [list], result: at });
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    expect(await stamps(t, { primary: ids.primary, secondary: ids.secondary, teammate: ids.teammate })).toEqual({ primary: at, secondary: at, teammate: undefined });
    expect(await hides()).toEqual([[ids.teammate, "dismiss"]]);

    // The web's undo: one restoreSessions dispatch whose patches clear the stamps.
    const undo = { conversations: Object.fromEntries(list.map((id) => [id, { inbox_dismissed_at: null }])) };
    await as.mutation(api.dispatch.dispatch, { action: "restoreSessions", args: [list], patches: undo });
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    expect(await stamps(t, { primary: ids.primary, secondary: ids.secondary, teammate: ids.teammate })).toEqual({ primary: undefined, secondary: undefined, teammate: undefined });
    expect(await hides()).toEqual([]);
    vi.useRealTimers();
  });

  test("the undo the web sends back clears exactly the sweep's rows and changes no other", async () => {
    vi.useFakeTimers();
    const t = convexTest(schema, allModules);
    const ids = await seed(t);
    const as = t.withIdentity({ subject: `${ids.owner}|session` });
    const at = Date.now();
    await as.mutation(api.dispatch.dispatch, { action: "markSessionsDismissed", args: [[ids.a, ids.b]], result: at });
    await t.finishAllScheduledFunctions(vi.runAllTimers);

    // The patches web lib/__tests__/dismissStale.guard.test.ts shows the undo sending.
    const undo = { conversations: { [ids.a]: { inbox_dismissed_at: null }, [ids.b]: { inbox_dismissed_at: null } } };
    await as.mutation(api.dispatch.dispatch, { action: "restoreSessions", args: [[ids.a, ids.b]], patches: undo });
    await t.finishAllScheduledFunctions(vi.runAllTimers);

    expect(await stamps(t, ids)).toEqual({ a: undefined, b: undefined, open: undefined, foreign: undefined, pinned: undefined, earlier: old });
    vi.useRealTimers();
  });
});
