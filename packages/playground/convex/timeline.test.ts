// Restore, fork and what the timeline and room say about them, under
// convex-test with timers held: scheduled work (the fork's data copy) is
// called explicitly.
import { afterAll, beforeAll, describe, expect, jest, test } from "bun:test";
import { convexTest } from "convex-test";
import schema from "./schema";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";

beforeAll(() => jest.useFakeTimers());
afterAll(() => jest.useRealTimers());

const modules = {
  "./_generated/server.ts": () => import("./_generated/server"),
  "./apps.ts": () => import("./apps"),
  "./messages.ts": () => import("./messages"),
  "./presence.ts": () => import("./presence"),
  "./runtime.ts": () => import("./runtime"),
  "./versions.ts": () => import("./versions"),
  "./visitors.ts": () => import("./visitors"),
  "./builder/queue.ts": () => import("./builder/queue"),
  "./builder/run.ts": () => import("./builder/run"),
  "./builder/triage.ts": () => import("./builder/triage"),
};

async function setup() {
  const t = convexTest(schema, modules);
  const a = await t.mutation(api.visitors.register, {});
  const b = await t.mutation(api.visitors.register, {});
  const A = { visitor_id: a.visitor_id, secret: a.secret };
  const B = { visitor_id: b.visitor_id, secret: b.secret };
  const made = await t.mutation(api.apps.create, { ...A, name: "Tea Tally" });
  const app_id = made.app_id as Id<"apps">;
  const files = (id: Id<"apps">, n: number) => t.query(internal.versions.draft, { app_id: id, number: n });
  const timeline = (id = app_id) => t.query(api.versions.list, { ...A, app_id: id });
  const room = async (id = app_id) => (await t.query(api.messages.list, { ...A, app_id: id, paginationOpts: { numItems: 50, cursor: null } })).page;
  const view = (slug: string) => t.query(api.apps.get, { ...A, slug });

  // v2: a build's commit, so there is a past to go back to.
  const v1 = await files(app_id, 1);
  await t.mutation(internal.versions.append, {
    app_id,
    kind: "build",
    summary: "Turns the background blue",
    author_id: a.visitor_id as Id<"visitors">,
    files: v1.map((f) => (f.path === "src/styles.css" ? { ...f, text: `${f.text}\nbody { background: blue; }\n` } : f)),
  });
  return { t, a, b, A, B, app_id, slug: made.slug, files, timeline, room, view };
}

describe("restore", () => {
  test("appends a new live version with the old files and tells the room", async () => {
    const s = await setup();
    const { number } = await s.t.mutation(api.versions.restore, { ...s.B, app_id: s.app_id, number: 1 });
    expect(number).toBe(3);
    expect(await s.files(s.app_id, 3)).toEqual(await s.files(s.app_id, 1));

    const tl = await s.timeline();
    expect(tl.map((v) => [v.number, v.kind, v.parent_number])).toEqual([[1, "seed", null], [2, "build", 1], [3, "restore", 2]]);
    expect(tl[2].source).toEqual({ app_id: s.app_id, version: 1 });
    expect(tl[2].author?.id).toBe(s.b.visitor_id);
    expect(tl[2].summary).toBe(tl[0].summary);
    expect((await s.view(s.slug))?.live_version).toBe(3);

    const note = (await s.room()).find((m) => m.kind === "system")!;
    expect(note.note).toMatchObject({ type: "restore", from_version: 1, version: 3, by: { id: s.b.visitor_id } });
  });

  test("refuses the live version and versions that do not exist", async () => {
    const s = await setup();
    await expect(s.t.mutation(api.versions.restore, { ...s.A, app_id: s.app_id, number: 2 })).rejects.toThrow(/already live/);
    await expect(s.t.mutation(api.versions.restore, { ...s.A, app_id: s.app_id, number: 9 })).rejects.toThrow(/does not exist/);
    expect((await s.timeline()).length).toBe(2);
  });
});

describe("fork", () => {
  test("makes a new app from any version, with a copy of the data, linked both ways", async () => {
    const s = await setup();
    await s.t.run(async (ctx) => {
      const by = s.a.visitor_id as Id<"visitors">;
      await ctx.db.insert("app_data", { app_id: s.app_id, collection: "cups", value: { n: 3 }, size: 7, rev: 1, created_by: by, updated_by: by, updated_at: 1 });
      await ctx.db.insert("app_data_usage", { app_id: s.app_id, docs: 1, bytes: 7 });
    });

    const fork = await s.t.mutation(api.apps.fork, { ...s.B, app_id: s.app_id, number: 1, name: "  Tea Tally, Bo's take " });
    await s.t.mutation(internal.runtime.copyData, { from_app_id: s.app_id, to_app_id: fork.app_id, cursor: null });

    const forked = (await s.view(fork.slug))!;
    expect([forked.name, forked.live_version, forked.forked_from]).toEqual(["Tea Tally, Bo's take", 1, { app_id: s.app_id, slug: s.slug, name: "Tea Tally", version: 1 }]);
    expect(await s.files(fork.app_id, 1)).toEqual(await s.files(s.app_id, 1));
    const [v1] = await s.timeline(fork.app_id);
    expect([v1.kind, v1.author?.id, v1.source]).toEqual(["fork", s.b.visitor_id, { app_id: s.app_id, version: 1 }]);

    const data = await s.t.run((ctx) => ctx.db.query("app_data").collect());
    expect(data.filter((d) => d.app_id === fork.app_id).map((d) => d.value)).toEqual([{ n: 3 }]);

    const note = (await s.room()).find((m) => m.kind === "system")!;
    expect(note.note).toMatchObject({ type: "fork", version: 1, by: { id: s.b.visitor_id }, fork: { slug: fork.slug, name: "Tea Tally, Bo's take" } });
    expect(await s.room(fork.app_id)).toEqual([]);
    expect((await s.timeline()).map((v) => v.fork_count)).toEqual([1, 0]);
  });

  test("needs a name and a real version", async () => {
    const s = await setup();
    await expect(s.t.mutation(api.apps.fork, { ...s.A, app_id: s.app_id, number: 1, name: "   " })).rejects.toThrow(/name/);
    await expect(s.t.mutation(api.apps.fork, { ...s.A, app_id: s.app_id, number: 7, name: "x" })).rejects.toThrow(/does not exist/);
  });

  test("starts with the source's change ideas", async () => {
    const s = await setup();
    await s.t.run((ctx) => ctx.db.patch(s.app_id, { ideas: ["add milk", "count biscuits"] }));
    const fork = await s.t.mutation(api.apps.fork, { ...s.A, app_id: s.app_id, number: 2, name: "Biscuit Tally" });
    expect((await s.view(fork.slug))?.ideas).toEqual(["add milk", "count biscuits"]);
  });
});

describe("the room hears about runtime errors", () => {
  test("once per version, whoever saw it", async () => {
    const s = await setup();
    const first = await s.t.mutation(api.messages.reportError, { ...s.A, app_id: s.app_id, version: 2, message: "  x is\n not defined " });
    const again = await s.t.mutation(api.messages.reportError, { ...s.B, app_id: s.app_id, version: 2, message: "y" });
    await s.t.mutation(api.messages.reportError, { ...s.B, app_id: s.app_id, version: 1, message: "z" });
    expect([first.fresh, again.fresh, again.message_id]).toEqual([true, false, first.message_id]);
    const notes = (await s.room()).filter((m) => m.kind === "system").map((m) => m.note);
    expect(notes).toEqual([{ type: "error", version: 1, message: "z" }, { type: "error", version: 2, message: "x is not defined" }]);
    await expect(s.t.mutation(api.messages.reportError, { ...s.A, app_id: s.app_id, version: 5, message: "w" })).rejects.toThrow(/does not exist/);
  });
});

describe("the app view", () => {
  test("says when changes cannot build", async () => {
    const s = await setup();
    expect((await s.view(s.slug))?.builds_paused).toBeNull();
    process.env.PLAYGROUND_BUILDS_OFF = "1";
    try {
      expect((await s.view(s.slug))?.builds_paused).toMatch(/paused/);
    } finally {
      delete process.env.PLAYGROUND_BUILDS_OFF;
    }
  });
});
