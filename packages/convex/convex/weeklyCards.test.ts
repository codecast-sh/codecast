// The weekly card end to end: staff build last week's card from their own
// sessions (subagents and other people's sessions left out), publish it
// through publicShare's "card" kind, a stranger reads only what was turned on,
// options lock while it is public, and unpublishing closes the link.
// Everyone else is refused at every door.
import { expect, setDefaultTimeout, test } from "bun:test";
import { convexTest } from "convex-test";
import { anyApi } from "convex/server";
import schema from "./schema";
import { allModules } from "./testModules.testkit";
import { weekBounds } from "@codecast/shared/contracts/weeklyCard";

setDefaultTimeout(60_000);
const api = anyApi as any;
const H = 3_600_000;
const TOKEN = "11111111-2222-4333-8444-555555555555";

async function seed() {
  const t = convexTest(schema, allModules);
  const last = weekBounds(Date.now(), "UTC", "last");
  const ids = await t.run(async (ctx) => {
    const ana = await ctx.db.insert("users", { name: "Ana", staff: true, timezone: "UTC" } as any);
    const ben = await ctx.db.insert("users", { name: "Ben" } as any);
    await ctx.db.insert("devices", { user_id: ana, device_id: "mac1", label: "ana-mbp.local", platform: "darwin", last_seen: Date.now() } as any);
    const conv = (user: any, at: number, extra: Record<string, unknown> = {}) =>
      ctx.db.insert("conversations", {
        user_id: user, agent_type: "claude_code", session_id: `s${Math.random()}`, title: "Secret billing work",
        started_at: at, updated_at: at + H, message_count: 4, is_private: false, status: "completed",
        project_path: "/Users/ana/src/billing", owner_device_id: "mac1", ...extra,
      } as any);
    await conv(ana, last.days[0] + 9 * H);
    await conv(ana, last.days[2] + 9 * H, { agent_type: "codex" });
    await conv(ana, last.days[2] + 9 * H, { is_subagent: true });
    await conv(ben, last.days[1] + 9 * H);
    return { ana: String(ana), ben: String(ben) };
  });
  return { t, ids, as: (u: string) => t.withIdentity({ subject: `${u}|test` }), key: last.key };
}

test("staff build, publish, and unpublish a card; the public view carries no private text", async () => {
  const { t, ids, as, key } = await seed();
  const id = await as(ids.ana).action(api.weeklyCards.generate, { which: "last", tz: "UTC" });
  const [card] = await as(ids.ana).query(api.weeklyCards.listMine, {});
  expect(card._id).toBe(id);
  expect(card.week_key).toBe(key);
  expect(card.stats).toMatchObject({ sessions: 2, active_days: 2, agent_hours: 2, machines: { count: 1, kinds: [{ kind: "mac", count: 1 }] } });
  expect(card.stats.projects).toEqual([{ name: "billing", sessions: 2 }]);

  await as(ids.ana).mutation(api.dispatch.dispatch, { action: "setObjectShareLink", args: ["card", id, TOKEN] });
  const shared = await t.query(api.publicShare.getSharedCard, { share_token: TOKEN });
  expect(shared.user.name).toBe("Ana");
  expect(shared.stats.projects).toEqual([]);
  const text = JSON.stringify(shared);
  for (const leak of ["Secret billing", "billing", "ana-mbp", "/Users"]) expect(text).not.toContain(leak);

  // Options are locked while the card is public.
  await expect(as(ids.ana).mutation(api.dispatch.dispatch, { action: "setWeeklyCardOptions", args: [id, { show_projects: true }] })).rejects.toThrow();

  await as(ids.ana).mutation(api.dispatch.dispatch, { action: "setObjectShareLink", args: ["card", id, null] });
  expect(await t.query(api.publicShare.getSharedCard, { share_token: TOKEN })).toBeNull();

  await as(ids.ana).mutation(api.dispatch.dispatch, { action: "setWeeklyCardOptions", args: [id, { show_projects: true }] });
  await as(ids.ana).mutation(api.dispatch.dispatch, { action: "setObjectShareLink", args: ["card", id, TOKEN] });
  expect((await t.query(api.publicShare.getSharedCard, { share_token: TOKEN })).stats.projects).toEqual([{ name: "billing", sessions: 2 }]);
});

test("the card is closed to everyone but staff, and to anyone but its owner", async () => {
  const { as, ids } = await seed();
  expect(await as(ids.ben).action(api.weeklyCards.generate, { which: "last" })).toBeNull();
  expect(await as(ids.ben).query(api.weeklyCards.listMine, {})).toEqual([]);
  await expect(as(ids.ben).mutation(api.dispatch.dispatch, { action: "setWeeklyCardEnabled", args: [true] })).rejects.toThrow();
  const id = await as(ids.ana).action(api.weeklyCards.generate, { which: "last" });
  await expect(as(ids.ben).mutation(api.dispatch.dispatch, { action: "setObjectShareLink", args: ["card", id, TOKEN] })).rejects.toThrow();
});

test("the Monday sweep builds once for people who opted in and leaves a quiet bell row", async () => {
  const { t, as, ids, key } = await seed();
  await as(ids.ana).mutation(api.dispatch.dispatch, { action: "setWeeklyCardEnabled", args: [true] });
  await t.action((anyApi as any).weeklyCards.mondaySweep, {});
  await t.action((anyApi as any).weeklyCards.mondaySweep, {});
  const { cards, notes } = await t.run(async (ctx) => ({
    cards: await ctx.db.query("weekly_cards").collect(),
    notes: (await ctx.db.query("notifications").collect()).filter((n: any) => n.type === "weekly_card"),
  }));
  expect(cards.map((c: any) => c.week_key)).toEqual([key]);
  expect(notes).toHaveLength(1);
  expect(notes[0]).toMatchObject({ entity_type: "weekly_card", entity_id: key });
});
