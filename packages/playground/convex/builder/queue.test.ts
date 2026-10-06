// The build queue's mutations under convex-test, with timers held so nothing
// scheduled runs by itself: each step (advance, finish, the watchdog, triage
// settling) is called explicitly and the room's view is read back.
import { afterAll, beforeAll, describe, expect, jest, test } from "bun:test";
import { convexTest } from "convex-test";
import schema from "../schema";
import { api, internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { APP_DAILY_BUDGET_USD } from "../lib/limits";
import { dayKey } from "./rules";

beforeAll(() => jest.useFakeTimers());
afterAll(() => jest.useRealTimers());

const modules = {
  "../_generated/server.ts": () => import("../_generated/server"),
  "../apps.ts": () => import("../apps"),
  "../messages.ts": () => import("../messages"),
  "../presence.ts": () => import("../presence"),
  "../versions.ts": () => import("../versions"),
  "../visitors.ts": () => import("../visitors"),
  "../builder/queue.ts": () => import("./queue"),
  "../builder/run.ts": () => import("./run"),
  "../builder/triage.ts": () => import("./triage"),
};

async function setup() {
  const t = convexTest(schema, modules);
  const a = await t.mutation(api.visitors.register, {});
  const b = await t.mutation(api.visitors.register, {});
  const A = { visitor_id: a.visitor_id, secret: a.secret };
  const B = { visitor_id: b.visitor_id, secret: b.secret };
  const app = await t.mutation(api.apps.create, { ...A, name: "Tea Tally" });
  const app_id = app.app_id as Id<"apps">;
  const room = async () => (await t.query(api.messages.list, { ...A, app_id, paginationOpts: { numItems: 50, cursor: null } })).page;
  const card = async (message_id: string) => (await room()).find((m) => m.id === message_id)!;
  const change = (who: typeof A, body: string) => t.mutation(api.messages.send, { ...who, app_id, mode: "change", body });
  const advance = () => t.mutation(internal.builder.queue.advance, { app_id });
  const files = async (n: number) => t.query(internal.versions.draft, { app_id, number: n });
  const finish = async (build_id: Id<"builds">, result: { ok: true; summary: string; files: { path: string; text: string }[] } | { ok: false; error: string; detail: string }) =>
    t.mutation(internal.builder.queue.finish, { build_id, cost_usd: 0.05, narration: [{ at: 1, text: "Checked, going live" }], files_touched: [], result });
  const edited = async (n: number, find: string, replace: string) =>
    (await files(n)).map((f) => (f.path === "src/styles.css" ? { ...f, text: f.text.replace(find, replace) } : f));
  return { t, a, b, A, B, app_id, room, card, change, advance, files, finish, edited };
}

describe("the build queue", () => {
  test("requests build one at a time, first in first out, each from the live version when it starts", async () => {
    const s = await setup();
    const first = await s.change(s.B, "make the background blue");
    const second = await s.change(s.A, "add a reset button");
    expect(first.kind).toBe("request");

    let c1 = await s.card(first.message_id);
    let c2 = await s.card(second.message_id);
    expect([c1.build?.status, c1.build?.queue_position, c2.build?.queue_position]).toEqual(["queued", 1, 2]);

    await s.advance();
    await s.advance();
    c1 = await s.card(first.message_id);
    c2 = await s.card(second.message_id);
    expect([c1.build?.status, c1.build?.base_version]).toEqual(["building", 1]);
    expect([c2.build?.status, c2.build?.queue_position]).toEqual(["queued", 1]);

    await s.finish(c1.build!.id, { ok: true, summary: "Turns the background blue", files: await s.edited(1, "#fff4d6;", "#2b59ff;") });
    c1 = await s.card(first.message_id);
    expect([c1.build?.status, c1.build?.result_version, c1.build?.summary]).toEqual(["live", 2, "Turns the background blue"]);
    expect((await s.t.query(api.apps.get, { ...s.A, slug: (await s.t.run((ctx) => ctx.db.get(s.app_id)))!.slug }))?.live_version).toBe(2);

    await s.advance();
    c2 = await s.card(second.message_id);
    expect([c2.build?.status, c2.build?.base_version]).toEqual(["building", 2]);

    const timeline = await s.t.query(api.versions.list, { ...s.A, app_id: s.app_id });
    expect(timeline.map((v) => [v.number, v.kind, v.author?.id, v.parent_number])).toEqual([
      [1, "seed", s.a.visitor_id, null],
      [2, "build", s.b.visitor_id, 1],
    ]);
    expect(timeline[1].request_message_id).toBe(first.message_id);
  });

  test("a draft the version writer refuses fails the build with the reason behind Details", async () => {
    const s = await setup();
    const req = await s.change(s.A, "break it");
    await s.advance();
    const { build } = await s.card(req.message_id);
    await s.finish(build!.id, { ok: true, summary: "Breaks it", files: [{ path: "src/App.jsx", text: "export default 1;" }] });
    const after = (await s.card(req.message_id)).build!;
    expect(after.status).toBe("failed");
    expect(after.error).toBe("The code Clay wrote didn't run.");
    expect(after.error_detail).toContain("index.html is missing");
  });

  test("Try again re-queues the same request in place, only from its latest failed build", async () => {
    const s = await setup();
    const req = await s.change(s.A, "add confetti");
    await s.advance();
    const failed = (await s.card(req.message_id)).build!;
    await s.finish(failed.id, { ok: false, error: "Clay couldn't reach its model. Try again in a moment.", detail: "529" });
    const { build_id } = await s.t.mutation(api.builder.queue.retry, { ...s.B, build_id: failed.id });
    const again = await s.card(req.message_id);
    expect([again.build?.id, again.build?.status, again.kind]).toEqual([build_id, "queued", "request"]);
    expect((await s.room()).filter((m) => m.build).length).toBe(1);
    await expect(s.t.mutation(api.builder.queue.retry, { ...s.B, build_id: failed.id })).rejects.toThrow(/latest failed build/);
  });

  test("the watchdog fails a build whose run died, and a late report changes nothing", async () => {
    const s = await setup();
    const req = await s.change(s.A, "add a sound");
    await s.advance();
    const { build } = await s.card(req.message_id);
    await s.t.mutation(internal.builder.queue.expire, { build_id: build!.id });
    expect((await s.card(req.message_id)).build?.status).toBe("failed");
    await s.finish(build!.id, { ok: true, summary: "Adds a sound", files: await s.edited(1, "#fff4d6;", "#000;") });
    expect((await s.card(req.message_id)).build?.status).toBe("failed");
    expect((await s.t.query(api.versions.list, { ...s.A, app_id: s.app_id })).length).toBe(1);
  });

  test("an app over today's budget fails new builds without starting them", async () => {
    const s = await setup();
    await s.t.run((ctx) => ctx.db.patch(s.app_id, { budget: { day: dayKey(Date.now()), spent_usd: APP_DAILY_BUDGET_USD } }));
    const req = await s.change(s.A, "add a leaderboard");
    await s.advance();
    const { build } = await s.card(req.message_id);
    expect([build?.status, build?.started_at]).toEqual(["failed", null]);
    expect(build?.error).toMatch(/This app has used today's building budget/);
  });

  test("finishing charges the app and the global day", async () => {
    const s = await setup();
    const req = await s.change(s.A, "make it blue");
    await s.advance();
    await s.finish((await s.card(req.message_id)).build!.id, { ok: false, error: "x", detail: "y" });
    const [app, spend] = await s.t.run(async (ctx) => [await ctx.db.get(s.app_id), await ctx.db.query("spend").collect()] as const);
    expect(app?.budget).toEqual({ day: dayKey(Date.now()), spent_usd: 0.05 });
    expect(spend.map((r) => r.usd)).toEqual([0.05]);
  });
});

describe("triage and the first build", () => {
  test("an Auto message waits on triage; a change becomes its own queued card, chat just settles", async () => {
    const s = await setup();
    const ask = await s.t.mutation(api.messages.send, { ...s.A, app_id: s.app_id, mode: "auto", body: "can it play a sound?" });
    const hi = await s.t.mutation(api.messages.send, { ...s.B, app_id: s.app_id, mode: "auto", body: "morning all" });
    expect((await s.card(ask.message_id)).triage_pending).toBe(true);

    await s.t.mutation(internal.builder.triage.settle, { message_id: ask.message_id, kind: "change" });
    await s.t.mutation(internal.builder.triage.settle, { message_id: hi.message_id, kind: "chat" });
    const asked = await s.card(ask.message_id);
    const said = await s.card(hi.message_id);
    expect([asked.kind, asked.triage_pending, asked.build?.status]).toEqual(["request", false, "queued"]);
    expect([said.kind, said.triage_pending, said.build]).toEqual(["chat", false, null]);

    // Settling twice (a retried action) queues nothing more.
    await s.t.mutation(internal.builder.triage.settle, { message_id: ask.message_id, kind: "change" });
    expect((await s.room()).filter((m) => m.build).length).toBe(1);
  });

  test("making an app from a prompt queues its first build on the prompt", async () => {
    const t = convexTest(schema, modules);
    const a = await t.mutation(api.visitors.register, {});
    const created = await t.mutation(api.apps.create, { visitor_id: a.visitor_id, secret: a.secret, prompt: "a frog choir" });
    const page = await t.query(api.messages.list, {
      visitor_id: a.visitor_id,
      secret: a.secret,
      app_id: created.app_id as Id<"apps">,
      paginationOpts: { numItems: 10, cursor: null },
    });
    expect(page.page.map((m) => [m.id, m.kind, m.body, m.build?.status])).toEqual([[created.request_message_id, "request", "a frog choir", "queued"]]);
  });
});
