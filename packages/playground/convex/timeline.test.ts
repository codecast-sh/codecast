// Restore, fork and what the timeline and room say about them, under
// convex-test with timers held: scheduled work (the fork's data copy) is
// called explicitly.
import { afterAll, beforeAll, describe, expect, jest, test } from "bun:test";
import { convexTest } from "convex-test";
import { mintVisitor } from "../src/lib/mint";
import { LATEST_MESSAGES } from "./lib/limits";
import schema from "./schema";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";

beforeAll(() => jest.useFakeTimers());
afterAll(() => jest.useRealTimers());

const modules = {
  "./_generated/server.ts": () => import("./_generated/server"),
  "./apps.ts": () => import("./apps"),
  "./builds.ts": () => import("./builds"),
  "./tallies.ts": () => import("./tallies"),
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
  const register = (args: { secret: string; nonce: number }) => t.mutation(api.visitors.register, args);
  const A = await mintVisitor(register);
  const B = await mintVisitor(register);
  const made = await t.mutation(api.apps.create, { ...A, name: "Tea Tally" });
  const app_id = made.app_id as Id<"apps">;
  const files = (id: Id<"apps">, n: number) => t.query(internal.versions.draft, { app_id: id, number: n });
  const timeline = (id = app_id) => t.query(api.versions.list, { ...A, app_id: id });
  const room = async (id = app_id) => (await t.query(api.messages.list, { ...A, app_id: id, paginationOpts: { numItems: 50, cursor: null } })).page;
  const view = (slug: string) => t.query(api.apps.get, { slug });

  // v2: a build's commit, so there is a past to go back to.
  const v1 = await files(app_id, 1);
  await t.mutation(internal.versions.append, {
    app_id,
    kind: "build",
    summary: "Turns the background blue",
    author_id: A.visitor_id as Id<"visitors">,
    files: v1.map((f) => (f.path === "src/styles.css" ? { ...f, text: `${f.text}\nbody { background: blue; }\n` } : f)),
  });
  return { t, A, B, app_id, slug: made.slug, files, timeline, room, view };
}

describe("restore", () => {
  test("appends a new live version with the old files and tells the room", async () => {
    const s = await setup();
    const { number } = await s.t.mutation(api.versions.restore, { ...s.B, app_id: s.app_id, number: 1, expected_live: 2 });
    expect(number).toBe(3);
    expect(await s.files(s.app_id, 3)).toEqual(await s.files(s.app_id, 1));

    const tl = await s.timeline();
    expect(tl.map((v) => [v.number, v.kind, v.parent_number])).toEqual([[1, "seed", null], [2, "build", 1], [3, "restore", 2]]);
    expect(tl[2].source).toEqual({ app_id: s.app_id, version: 1 });
    expect(tl[2].author?.id).toBe(s.B.visitor_id);
    expect((await s.view(s.slug))?.live_version).toBe(3);

    const note = (await s.room()).find((m) => m.kind === "system")!;
    expect(note.note).toMatchObject({ type: "restore", from_version: 1, version: 3, by: { id: s.B.visitor_id } });
  });

  test("restoring what the live version was built on is an undo of it, said as one", async () => {
    const s = await setup();
    await s.t.mutation(api.versions.restore, { ...s.B, app_id: s.app_id, number: 1, expected_live: 2 });
    const undo = (await s.timeline())[2];
    expect(undo.undid).toBe(2);
    expect(undo.summary).toBe("Undid v2: Turns the background blue");
    expect((await s.room()).find((m) => m.kind === "system")!.note).toMatchObject({ type: "restore", undid: 2 });
  });

  test("restoring anything else brings it back, keeping its summary", async () => {
    const s = await setup();
    // Undo v2 (v3), then bring v2 back: a redo, not an undo of v3.
    await s.t.mutation(api.versions.restore, { ...s.B, app_id: s.app_id, number: 1, expected_live: 2 });
    await s.t.mutation(api.versions.restore, { ...s.A, app_id: s.app_id, number: 2, expected_live: 3 });
    const back = (await s.timeline())[3];
    expect(back.undid).toBeNull();
    expect(back.summary).toBe("Turns the background blue");
    expect((await s.room()).find((m) => m.note?.type === "restore" && m.note.version === 4)!.note).toMatchObject({ from_version: 2, undid: null });
  });

  test("refuses the live version and versions that do not exist", async () => {
    const s = await setup();
    await expect(s.t.mutation(api.versions.restore, { ...s.A, app_id: s.app_id, number: 2, expected_live: 2 })).rejects.toThrow(/already live/);
    await expect(s.t.mutation(api.versions.restore, { ...s.A, app_id: s.app_id, number: 9, expected_live: 2 })).rejects.toThrow(/does not exist/);
    expect((await s.timeline()).length).toBe(2);
  });

  test("refuses when something went live since it was chosen, so a double Undo restores once", async () => {
    const s = await setup();
    // Two people press Undo on v2 together: both chose against v2 being live.
    await s.t.mutation(api.versions.restore, { ...s.A, app_id: s.app_id, number: 1, expected_live: 2 });
    await expect(s.t.mutation(api.versions.restore, { ...s.B, app_id: s.app_id, number: 1, expected_live: 2 })).rejects.toThrow(/v3 is live now/);
    expect((await s.timeline()).map((v) => v.number)).toEqual([1, 2, 3]);
    expect((await s.room()).filter((m) => m.note?.type === "restore").length).toBe(1);
  });
});

describe("fork", () => {
  test("makes a new app from any version, with a copy of the data, linked both ways", async () => {
    const s = await setup();
    await s.t.run(async (ctx) => {
      const by = s.A.visitor_id as Id<"visitors">;
      await ctx.db.insert("app_data", { app_id: s.app_id, collection: "cups", value: { n: 3 }, size: 7, rev: 1, created_by: by, updated_by: by, updated_at: 1 });
      await ctx.db.insert("app_data_usage", { app_id: s.app_id, docs: 1, bytes: 7 });
    });

    // A small app's data copies inside the fork itself: there the moment it exists.
    const fork = await s.t.mutation(api.apps.fork, { ...s.B, app_id: s.app_id, number: 1, name: "  Tea Tally, Bo's take " });

    const forked = (await s.view(fork.slug))!;
    expect([forked.name, forked.live_version, forked.forked_from]).toEqual(["Tea Tally, Bo's take", 1, { app_id: s.app_id, slug: s.slug, name: "Tea Tally", version: 1 }]);
    expect(await s.files(fork.app_id, 1)).toEqual(await s.files(s.app_id, 1));
    const [v1] = await s.timeline(fork.app_id);
    expect([v1.kind, v1.author?.id, v1.source]).toEqual(["fork", s.B.visitor_id, { app_id: s.app_id, version: 1 }]);

    const data = await s.t.run((ctx) => ctx.db.query("app_data").collect());
    expect(data.filter((d) => d.app_id === fork.app_id).map((d) => d.value)).toEqual([{ n: 3 }]);

    const note = (await s.room()).find((m) => m.kind === "system")!;
    expect(note.note).toMatchObject({ type: "fork", version: 1, by: { id: s.B.visitor_id }, fork: { slug: fork.slug, name: "Tea Tally, Bo's take" } });
    expect(await s.room(fork.app_id)).toEqual([]);
    const [source1, source2] = await s.timeline();
    expect([source1.forks.map((f) => [f.slug, f.name, f.by?.id]), source2.forks]).toEqual([[[fork.slug, "Tea Tally, Bo's take", s.B.visitor_id]], []]);
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

describe("the app page", () => {
  test("says when changes cannot build", async () => {
    const s = await setup();
    const paused = () => s.t.query(api.apps.buildsPaused, { ...s.A, app_id: s.app_id });
    expect(await paused()).toBeNull();
    process.env.PLAYGROUND_BUILDS_OFF = "1";
    try {
      expect(await paused()).toMatch(/paused/);
    } finally {
      delete process.env.PLAYGROUND_BUILDS_OFF;
    }
  });

  test("follows the newest messages and every change still on its way while the room is closed", async () => {
    const s = await setup();
    const asked = await s.t.mutation(api.messages.send, { ...s.A, app_id: s.app_id, body: "make it green", mode: "change" });
    for (let i = 0; i < LATEST_MESSAGES + 2; i++) await s.t.mutation(api.messages.send, { ...s.B, app_id: s.app_id, body: `hi ${i}`, mode: "chat" });
    const latest = await s.t.query(api.messages.latest, { ...s.A, app_id: s.app_id });
    expect(latest.map((m) => m.body)).toEqual([...Array.from({ length: LATEST_MESSAGES }, (_, i) => `hi ${LATEST_MESSAGES + 1 - i}`), "make it green"]);
    expect(latest.at(-1)?.id).toBe(asked.message_id);
    expect(latest.at(-1)?.build?.status).toBe("queued");
  });

  test("reads the app without knowing who is asking", async () => {
    const s = await setup();
    expect((await s.view(s.slug))?.live_version).toBe(2);
  });
});
