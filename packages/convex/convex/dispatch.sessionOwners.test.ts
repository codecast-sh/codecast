// The web's owners writes under the session_owners model (store
// sessionOwnersSlice applySessionOwners) ride this dispatch side effect into
// applyOwnersChange: a Save lands in one transaction, and a change the caller
// may not make refuses, so the client rolls its paint back.
import { expect, setDefaultTimeout, test } from "bun:test";
import { convexTest } from "convex-test";
import { anyApi } from "convex/server";
import schema from "./schema";
import { allModules } from "./testModules.testkit";

setDefaultTimeout(60_000);
const api = anyApi as any;

async function seed() {
  const t = convexTest(schema, allModules);
  const ids = await t.run(async (ctx) => {
    const ana = await ctx.db.insert("users", { name: "Ana", email: "ana@x.co" } as any);
    const cat = await ctx.db.insert("users", { name: "Cat", email: "cat@x.co" } as any);
    const dee = await ctx.db.insert("users", { name: "Dee", email: "dee@x.co" } as any);
    const team = await ctx.db.insert("teams", { name: "Acme", created_at: 1, features: { session_owners: true } } as any);
    for (const u of [ana, cat, dee]) await ctx.db.insert("team_memberships", { user_id: u, team_id: team, role: "member", joined_at: 1 } as any);
    const s = await ctx.db.insert("conversations", { user_id: ana, team_id: team, title: "Freeze case", status: "active", started_at: 1, updated_at: 1, message_count: 0, agent_type: "claude_code", session_id: "sess-1", short_id: "jxfreez", is_private: false, team_visibility: "full", auto_shared: true } as any);
    return { ana, cat, dee, s };
  });
  const as = (u: string) => t.withIdentity({ subject: `${u}|test` });
  const dispatch = (u: string, action: string, args: unknown[]) => as(u).mutation(api.dispatch.dispatch, { action, args });
  return { t, ...ids, as, dispatch };
}

test("a Save adds people in one change, and the owners read shows them", async () => {
  const { ana, cat, s, as, dispatch } = await seed();
  await dispatch(String(ana), "applySessionOwners", [String(s), { add: [String(cat)] }, { remove: [String(cat)] }]);
  const read = await as(String(ana)).query(api.sessionOwnership.listOwners, { session_id: String(s) });
  expect(read.session_owners).toBe(true);
  expect(read.people.map((p: any) => p.user_id)).toEqual([String(ana), String(cat)]);
});

test("Add me works for anyone who sees the session; editing others' owners refuses", async () => {
  const { ana, cat, dee, s, as, dispatch } = await seed();
  await dispatch(String(dee), "applySessionOwners", [String(s), { add: [String(dee)] }, null]);
  await expect(dispatch(String(cat), "applySessionOwners", [String(s), { remove: [String(ana)] }, null])).rejects.toThrow(/owners/);
  const read = await as(String(ana)).query(api.sessionOwnership.listOwners, { session_id: String(s) });
  expect(read.people.map((p: any) => p.user_id)).toEqual([String(ana), String(dee)]);
});

test("a restore row cannot plant an owner on another conversation", async () => {
  const { t, ana, dee, as, dispatch } = await seed();
  const { mine, victim } = await t.run(async (ctx) => {
    const team = (await ctx.db.query("teams").first())!._id;
    const base = { team_id: team, status: "active", started_at: 1, updated_at: 1, message_count: 0, agent_type: "claude_code", is_private: false, team_visibility: "full", auto_shared: true } as any;
    const mine = await ctx.db.insert("conversations", { ...base, user_id: dee, title: "Dee's own", session_id: "sess-dee", short_id: "jxdeeown" });
    const victim = await ctx.db.insert("conversations", { ...base, user_id: ana, title: "Ana's private", session_id: "sess-ana", short_id: "jxanapri", is_private: true, team_visibility: undefined, auto_shared: false });
    return { mine, victim };
  });
  const row = { user_id: String(dee), added_by: String(dee), added_at: 5, conversation_id: String(victim) };
  await dispatch(String(dee), "applySessionOwners", [String(mine), { restore: [row] }, null]).catch(() => null);
  const planted = await t.run((ctx) => ctx.db.query("session_owners").filter((q) => q.eq(q.field("conversation_id"), victim)).collect());
  expect(planted.map((r: any) => String(r.user_id))).not.toContain(String(dee));
  expect(await as(String(dee)).query(api.sessionOwnership.listOwners, { session_id: String(victim) })).toBeNull();
});

test("a change of the wrong shape is refused before it reaches the owners", async () => {
  const { ana, cat, s, dispatch } = await seed();
  await expect(dispatch(String(ana), "applySessionOwners", [String(s), { add: String(cat) }, null])).rejects.toThrow();
  await expect(dispatch(String(ana), "applySessionOwners", [String(s), { add: [String(cat)], surprise: true }, null])).rejects.toThrow();
});

test("acking a handoff stamps the viewer's owner row seen; an id the server cannot resolve is a no-op", async () => {
  const { t, ana, cat, s, dispatch } = await seed();
  await dispatch(String(ana), "applySessionOwners", [String(s), { add: [String(cat)] }, null]);
  await dispatch(String(cat), "clearAssignedPing", [String(s)]);
  const row = await t.run((ctx) => ctx.db.query("session_owners").filter((q) => q.eq(q.field("user_id"), cat)).first());
  expect(row?.seen_at).toBeGreaterThan(0);
  await dispatch(String(cat), "clearAssignedPing", ["optimistic-stub-1"]);
});
