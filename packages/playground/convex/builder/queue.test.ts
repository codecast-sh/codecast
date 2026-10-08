// The build queue's mutations under convex-test, with timers held so nothing
// scheduled runs by itself: each step (advance, finish, the watchdog, triage
// settling) is called explicitly and the room's view is read back.
import { afterAll, beforeAll, describe, expect, jest, test } from "bun:test";
import { convexTest } from "convex-test";
import { mintVisitor } from "../../src/lib/mint";
import schema from "../schema";
import { api, internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { APP_DAILY_BUDGET_USD, VISITOR_DAILY_BUDGET_USD } from "../lib/limits";
import { TALLY, dayKey } from "../tallies";
import type { Refusal } from "./rules";
import { TRIAGE_UNSURE } from "./triage";

beforeAll(() => jest.useFakeTimers());
afterAll(() => jest.useRealTimers());

const modules = {
  "../_generated/server.ts": () => import("../_generated/server"),
  "../apps.ts": () => import("../apps"),
  "../builds.ts": () => import("../builds"),
  "../tallies.ts": () => import("../tallies"),
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
  const register = (args: { secret: string; nonce: number }) => t.mutation(api.visitors.register, args);
  const A = await mintVisitor(register);
  const B = await mintVisitor(register);
  const app = await t.mutation(api.apps.create, { ...A, name: "Tea Tally" });
  const app_id = app.app_id as Id<"apps">;
  const room = async () => (await t.query(api.messages.list, { ...A, app_id, paginationOpts: { numItems: 50, cursor: null } })).page;
  const card = async (message_id: string) => (await room()).find((m) => m.id === message_id)!;
  const change = (who: typeof A, body: string) => t.mutation(api.messages.send, { ...who, app_id, mode: "change", body });
  const advance = () => t.mutation(internal.builder.queue.advance, { app_id });
  const files = async (n: number) => t.query(internal.versions.draft, { app_id, number: n });
  const finish = async (build_id: Id<"builds">, result: { ok: true; summary: string; name?: string; ideas?: string[]; files: { path: string; text: string }[] } | ({ ok: false } & Refusal)) =>
    t.mutation(internal.builder.queue.finish, { build_id, cost_usd: 0.05, narration: [{ at: 1, text: "Checked, going live" }], files_touched: [], result });
  const edited = async (n: number, find: string, replace: string) =>
    (await files(n)).map((f) => (f.path === "src/styles.css" ? { ...f, text: f.text.replace(find, replace) } : f));
  return { t, A, B, app_id, room, card, change, advance, files, finish, edited };
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

    await s.finish(c1.build!.id, {
      ok: true,
      summary: "Turns the background blue",
      ideas: ["Add a moon.", "add steam"],
      files: await s.edited(1, "#fff4d6;", "#2b59ff;"),
    });
    c1 = await s.card(first.message_id);
    expect([c1.build?.status, c1.build?.result_version, c1.build?.summary]).toEqual(["live", 2, "Turns the background blue"]);
    expect((await s.t.run((ctx) => ctx.db.get(s.app_id)))?.ideas).toEqual(["add a moon", "add steam"]);
    expect((await s.t.query(api.apps.get, { slug: (await s.t.run((ctx) => ctx.db.get(s.app_id)))!.slug }))?.live_version).toBe(2);

    await s.advance();
    c2 = await s.card(second.message_id);
    expect([c2.build?.status, c2.build?.base_version]).toEqual(["building", 2]);

    const timeline = await s.t.query(api.versions.list, { ...s.A, app_id: s.app_id });
    expect(timeline.map((v) => [v.number, v.kind, v.author?.id, v.parent_number])).toEqual([
      [1, "seed", s.A.visitor_id, null],
      [2, "build", s.B.visitor_id, 1],
    ]);
    expect(timeline[1].request_message_id).toBe(first.message_id);
  });

  test("an app made from a request starts on an unseen starter, so the maker's first build is v1", async () => {
    const s = await setup();
    const made = await s.t.mutation(api.apps.create, { ...s.A, prompt: "a frog choir" });
    const app_id = made.app_id as Id<"apps">;
    expect((await s.t.query(api.apps.get, { slug: made.slug }))?.live_version).toBe(0);
    expect(await s.t.query(api.versions.list, { ...s.A, app_id })).toEqual([]);
    expect(await s.t.query(api.versions.get, { ...s.A, app_id, number: 0 })).toBeNull();
    await expect(s.t.mutation(api.apps.fork, { ...s.A, app_id, number: 0, name: "Starter" })).rejects.toThrow(/does not exist/);

    await s.t.mutation(internal.builder.queue.advance, { app_id });
    const card = (await s.t.query(api.messages.list, { ...s.A, app_id, paginationOpts: { numItems: 5, cursor: null } })).page.find((m) => m.build)!;
    expect(card.build?.base_version).toBe(0);
    const starter = await s.t.query(internal.versions.draft, { app_id, number: 0 });
    await s.finish(card.build!.id, { ok: true, summary: "A frog choir", name: "Frog Choir", files: starter });
    expect((await s.t.query(api.apps.get, { slug: made.slug }))?.name).toBe("Frog Choir");
    const timeline = await s.t.query(api.versions.list, { ...s.A, app_id });
    expect(timeline.map((v) => [v.number, v.kind, v.parent_number])).toEqual([[1, "build", null]]);
    await expect(s.t.mutation(api.versions.restore, { ...s.A, app_id, number: 0, expected_live: 1 })).rejects.toThrow(/does not exist/);
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
    await s.finish(failed.id, { ok: false, kind: "unreachable", error: "Clay couldn't reach its model. Try again in a moment.", detail: "529" });
    const { build_id } = await s.t.mutation(api.builder.queue.retry, { ...s.B, build_id: failed.id });
    const again = await s.card(req.message_id);
    expect([again.build?.id, again.build?.status, again.kind]).toEqual([build_id, "queued", "request"]);
    expect((await s.room()).filter((m) => m.build).length).toBe(1);
    await expect(s.t.mutation(api.builder.queue.retry, { ...s.B, build_id: failed.id })).rejects.toThrow(/latest failed build/);
  });

  test("a decline says what kind it was and cannot be tried again with the same words", async () => {
    const s = await setup();
    const req = await s.change(s.A, "make the frog wobble");
    await s.advance();
    const { build } = await s.card(req.message_id);
    await s.finish(build!.id, { ok: false, kind: "declined", error: "It already wobbles.", detail: "declined: It already wobbles." });
    expect((await s.card(req.message_id)).build?.failure).toBe("declined");
    await expect(s.t.mutation(api.builder.queue.retry, { ...s.A, build_id: build!.id })).rejects.toThrow(/Edit the request/);
  });

  test("the watchdog fails a build whose run died, and a late report changes nothing", async () => {
    const s = await setup();
    const req = await s.change(s.A, "add a sound");
    await s.advance();
    const { build } = await s.card(req.message_id);
    await s.t.mutation(internal.builder.queue.expire, { build_id: build!.id, started_at: build!.started_at! });
    expect((await s.card(req.message_id)).build?.status).toBe("failed");
    await s.finish(build!.id, { ok: true, summary: "Adds a sound", files: await s.edited(1, "#fff4d6;", "#000;") });
    expect((await s.card(req.message_id)).build?.status).toBe("failed");
    expect((await s.t.query(api.versions.list, { ...s.A, app_id: s.app_id })).length).toBe(1);
  });

  test("an app over today's budget fails new builds without starting them", async () => {
    const s = await setup();
    await s.t.run((ctx) => ctx.db.insert("tallies", { key: TALLY.appSpend(s.app_id), day: dayKey(Date.now()), value: APP_DAILY_BUDGET_USD }));
    const req = await s.change(s.A, "add a leaderboard");
    await s.advance();
    const { build } = await s.card(req.message_id);
    expect([build?.status, build?.started_at]).toEqual(["failed", null]);
    expect(build?.error).toMatch(/This app has used today's building budget/);
  });

  test("an asker over their own budget fails without starting, whatever app they ask in", async () => {
    const s = await setup();
    await s.t.run((ctx) => ctx.db.insert("tallies", { key: TALLY.visitorSpend(s.B.visitor_id as Id<"visitors">), day: dayKey(Date.now()), value: VISITOR_DAILY_BUDGET_USD }));
    const theirs = await s.change(s.B, "add a leaderboard");
    await s.advance();
    expect((await s.card(theirs.message_id)).build?.error).toMatch(/a lot of changes today/);
    const mine = await s.change(s.A, "add a leaderboard");
    await s.advance();
    expect((await s.card(mine.message_id)).build?.status).toBe("building");
  });

  test("finishing charges the day overall, the app and the asker", async () => {
    const s = await setup();
    const req = await s.change(s.A, "make it blue");
    await s.advance();
    await s.finish((await s.card(req.message_id)).build!.id, { ok: false, kind: "stopped", error: "x", detail: "y" });
    const tallies = await s.t.run((ctx) => ctx.db.query("tallies").collect());
    expect(Object.fromEntries(tallies.map((r) => [r.key, r.value]))).toEqual({
      [TALLY.spend]: 0.05,
      [TALLY.appSpend(s.app_id)]: 0.05,
      [TALLY.visitorSpend(s.A.visitor_id as Id<"visitors">)]: 0.05,
    });
  });

  test("the card's narration lives apart from the stream", async () => {
    const s = await setup();
    const req = await s.change(s.A, "make it blue");
    await s.advance();
    const { build } = await s.card(req.message_id);
    await s.t.mutation(internal.builder.queue.narrate, { build_id: build!.id, narration: [{ at: 1, text: "Painting it blue" }], files_touched: [{ path: "src/styles.css", how: "wrote" }] });
    expect(await s.t.query(api.builds.progress, { ...s.B, build_id: build!.id })).toEqual({
      narration: [{ at: 1, text: "Painting it blue" }],
      files_touched: [{ path: "src/styles.css", how: "wrote" }],
    });
    expect(Object.keys((await s.card(req.message_id)).build!)).not.toContain("narration");
  });
});

describe("a live version that moves under a running build", () => {
  test("a restore during a build restarts it from the new live version instead of undoing it", async () => {
    const s = await setup();
    const v2 = await s.change(s.A, "make it blue");
    await s.advance();
    await s.finish((await s.card(v2.message_id)).build!.id, { ok: true, summary: "Blue", files: await s.edited(1, "#fff4d6;", "#2b59ff;") });
    const req = await s.change(s.B, "add a moon");
    await s.advance();
    const running = (await s.card(req.message_id)).build!;
    expect([running.status, running.base_version]).toEqual(["building", 2]);

    // Someone restores v1 (as v3) while Clay works from v2.
    await s.t.mutation(api.versions.restore, { ...s.A, app_id: s.app_id, number: 1, expected_live: 2 });
    await s.finish(running.id, { ok: true, summary: "Adds a moon", files: await s.edited(2, "#2b59ff;", "#123456;") });
    const restarted = (await s.card(req.message_id)).build!;
    expect([restarted.id, restarted.status, restarted.base_version]).toEqual([running.id, "queued", null]);
    expect((await s.t.query(api.builds.progress, { ...s.A, build_id: running.id }))?.narration[0].text).toMatch(/v3 went live while Clay worked/);
    expect((await s.t.query(api.versions.list, { ...s.A, app_id: s.app_id })).map((v) => v.number)).toEqual([1, 2, 3]);

    await s.advance();
    expect((await s.card(req.message_id)).build?.base_version).toBe(3);
    await s.finish(running.id, { ok: true, summary: "Adds a moon", files: await s.edited(3, "#fff4d6;", "#123456;") });
    const live = (await s.card(req.message_id)).build!;
    expect([live.status, live.result_version]).toEqual(["live", 4]);
    const tl = await s.t.query(api.versions.list, { ...s.A, app_id: s.app_id });
    expect(tl.map((v) => [v.number, v.kind, v.parent_number])).toEqual([[1, "seed", null], [2, "build", 1], [3, "restore", 2], [4, "build", 3]]);
  });

  test("a second move gives up with a reason rather than loop", async () => {
    const s = await setup();
    const v2 = await s.change(s.A, "make it blue");
    await s.advance();
    await s.finish((await s.card(v2.message_id)).build!.id, { ok: true, summary: "Blue", files: await s.edited(1, "#fff4d6;", "#2b59ff;") });
    const req = await s.change(s.B, "add a moon");
    for (const live of [2, 3]) {
      await s.advance();
      await s.t.mutation(api.versions.restore, { ...s.A, app_id: s.app_id, number: 1, expected_live: live });
      await s.finish((await s.card(req.message_id)).build!.id, { ok: true, summary: "Adds a moon", files: await s.edited(1, "#fff4d6;", "#123456;") });
    }
    const gave = (await s.card(req.message_id)).build!;
    expect([gave.status, gave.error]).toEqual(["failed", "The app kept changing while Clay worked. Try again."]);
    expect((await s.t.query(api.versions.list, { ...s.A, app_id: s.app_id })).length).toBe(4);
  });

  test("the first run's watchdog leaves a restarted build alone", async () => {
    const s = await setup();
    const req = await s.change(s.B, "add a moon");
    await s.advance();
    const first = (await s.card(req.message_id)).build!;
    // As finish does when the live version moved: back in line, then started again later.
    await s.t.run((ctx) => ctx.db.patch(first.id, { status: "queued", base_version: undefined, started_at: undefined, restarted: true }));
    jest.advanceTimersByTime(1_000);
    await s.advance();
    await s.t.mutation(internal.builder.queue.expire, { build_id: first.id, started_at: first.started_at! });
    expect((await s.card(req.message_id)).build?.status).toBe("building");
  });
});

describe("triage and the first build", () => {
  test("an Auto message waits on triage; a change becomes its own queued card, chat just settles", async () => {
    const s = await setup();
    const ask = await s.t.mutation(api.messages.send, { ...s.A, app_id: s.app_id, mode: "auto", body: "can it play a sound?" });
    const hi = await s.t.mutation(api.messages.send, { ...s.B, app_id: s.app_id, mode: "auto", body: "morning all" });
    expect((await s.card(ask.message_id)).triage_pending).toBe(true);

    await s.t.mutation(internal.builder.triage.settle, { message_id: ask.message_id, kind: "change", cost_usd: 0 });
    await s.t.mutation(internal.builder.triage.settle, { message_id: hi.message_id, kind: "chat", cost_usd: 0 });
    const asked = await s.card(ask.message_id);
    const said = await s.card(hi.message_id);
    expect([asked.kind, asked.triage_pending, asked.build?.status]).toEqual(["request", false, "queued"]);
    expect([said.kind, said.triage_pending, said.build]).toEqual(["chat", false, null]);

    // Settling twice (a retried action) queues nothing more.
    await s.t.mutation(internal.builder.triage.settle, { message_id: ask.message_id, kind: "change", cost_usd: 0 });
    expect((await s.room()).filter((m) => m.build).length).toBe(1);
  });

  test("a triage that can't decide, or a change that can't be queued, stays chat with Clay saying why", async () => {
    const s = await setup();
    const unsure = await s.t.mutation(api.messages.send, { ...s.A, app_id: s.app_id, mode: "auto", body: "hmm the frog" });
    await s.t.mutation(internal.builder.triage.settle, { message_id: unsure.message_id, kind: "unsure", cost_usd: 0 });
    const clay = () => s.room().then((ms) => ms.filter((m) => !m.author && m.kind === "chat").map((m) => m.body));
    expect((await s.card(unsure.message_id)).triage_pending).toBe(false);
    expect(await clay()).toEqual([TRIAGE_UNSURE]);

    // Past the build rate, a change triage heard stays chat with a reply.
    const asks = [];
    for (let i = 0; i < 9; i++) asks.push(await s.t.mutation(api.messages.send, { ...s.B, app_id: s.app_id, mode: "auto", body: `make it ${i}` }));
    for (const a of asks) await s.t.mutation(internal.builder.triage.settle, { message_id: a.message_id, kind: "change", cost_usd: 0 });
    const last = await s.card(asks[8].message_id);
    expect([last.kind, last.build]).toEqual(["chat", null]);
    expect((await clay())[0]).toMatch(/^That's a lot of changes in a few minutes\. Ask again in \d+ min/);
  });

  test("making an app from a prompt queues its first build on the prompt", async () => {
    const t = convexTest(schema, modules);
    const a = await mintVisitor((args) => t.mutation(api.visitors.register, args));
    const created = await t.mutation(api.apps.create, { visitor_id: a.visitor_id, secret: a.secret, prompt: "a frog choir" });
    const page = await t.query(api.messages.list, {
      visitor_id: a.visitor_id,
      secret: a.secret,
      app_id: created.app_id as Id<"apps">,
      paginationOpts: { numItems: 10, cursor: null },
    });
    expect(page.page.map((m): unknown[] => [m.id, m.kind, m.body, m.build?.status])).toEqual([[created.request_message_id, "request", "a frog choir", "queued"]]);
  });
});
