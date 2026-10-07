// What the home page reads (apps.gallery, activity.recent) and how a version
// gets its gallery picture (stills.ts), under convex-test.
import { afterAll, beforeAll, describe, expect, jest, test } from "bun:test";
import { convexTest } from "convex-test";
import { mintVisitor } from "../src/lib/mint";
import schema from "./schema";
import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { STILL_AUTHOR_FIRST_MS, STILL_MAX_BYTES } from "./lib/limits";

beforeAll(() => jest.useFakeTimers());
afterAll(() => jest.useRealTimers());

const modules = {
  "./_generated/server.ts": () => import("./_generated/server"),
  "./activity.ts": () => import("./activity"),
  "./apps.ts": () => import("./apps"),
  "./builds.ts": () => import("./builds"),
  "./limits.ts": () => import("./limits"),
  "./messages.ts": () => import("./messages"),
  "./presence.ts": () => import("./presence"),
  "./stills.ts": () => import("./stills"),
  "./tallies.ts": () => import("./tallies"),
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
  const make = async (name: string) => (await t.mutation(api.apps.create, { ...A, name })).app_id as Id<"apps">;
  const enter = (who: typeof A, app_id: Id<"apps">) => t.mutation(api.presence.heartbeat, { ...who, app_id, viewing_version: null });
  const gallery = async () => (await t.query(api.apps.gallery, { ...A })).apps;
  const image = (bytes: number, type = "image/webp") => t.run((ctx) => ctx.storage.store(new Blob([new Uint8Array(bytes)], { type })));
  return { t, A, B, make, enter, gallery, image };
}

describe("the gallery", () => {
  test("puts apps with people in them first, busiest first, then the most recent", async () => {
    const s = await setup();
    await s.make("Quiet");
    jest.advanceTimersByTime(1_000);
    const one = await s.make("One here");
    jest.advanceTimersByTime(1_000);
    await s.make("Newest");
    jest.advanceTimersByTime(1_000);
    const two = await s.make("Two here");
    await s.t.run((ctx) => ctx.db.patch(two, { last_activity_at: 0 }));
    await s.enter(s.A, one);
    await s.enter(s.A, two);
    await s.enter(s.B, two);
    expect((await s.gallery()).map((c) => [c.name, c.here_count])).toEqual([["Two here", 2], ["One here", 1], ["Newest", 0], ["Quiet", 0]]);
  });

  test("leaves out an app Clay has not made yet, even with its maker in it", async () => {
    const s = await setup();
    const made = await s.t.mutation(api.apps.create, { ...s.A, prompt: "a frog choir" });
    await s.enter(s.A, made.app_id as Id<"apps">);
    expect(await s.gallery()).toEqual([]);
  });

  test("says what made the live version instead of its number", async () => {
    const s = await setup();
    await s.make("Tea Tally");
    const [card] = await s.gallery();
    expect(card.latest?.said).toBe("started it");
    expect(card.still_url).toBeNull();
  });
});

describe("right now", () => {
  test("one row per person per app, their latest change, and never the unseen starter", async () => {
    const s = await setup();
    const app = await s.make("Tea Tally");
    const made = await s.t.mutation(api.apps.create, { ...s.B, prompt: "a frog choir" });
    for (const summary of ["Turns it blue", "Adds a moon"]) {
      jest.advanceTimersByTime(1_000);
      await s.t.run(async (ctx) => {
        const a = (await ctx.db.get(app))!;
        await ctx.db.insert("versions", {
          app_id: app, number: a.version_count + 1, parent_number: a.live_version, kind: "build", summary, author_id: s.A.visitor_id as Id<"visitors">,
          file_count: 0, bytes: 0, files_hash: "x", created_at: Date.now(),
        });
        await ctx.db.patch(app, { version_count: a.version_count + 1, live_version: a.version_count + 1 });
      });
    }
    const feed = await s.t.query(api.activity.recent, { ...s.A });
    expect(feed.map((e) => [e.app_name, e.said, e.live])).toEqual([["Tea Tally", "adds a moon", true]]);
    expect(feed.some((e) => e.slug === made.slug)).toBe(false);
  });
});

describe("stills", () => {
  // convex-test keeps no content type on stored files, so a picture is set
  // straight on the row here; the checks on what is uploaded are the rest.
  test("the author pictures a version first; anyone may once it has been live a while", async () => {
    const s = await setup();
    const app_id = await s.make("Tea Tally");
    const ask = (who: typeof s.A) => s.t.mutation(api.stills.uploadUrl, { ...who, app_id, number: 1 });
    expect(await ask(s.A)).toBeTruthy();
    expect(await ask(s.B)).toBeNull();
    jest.advanceTimersByTime(STILL_AUTHOR_FIRST_MS);
    expect(await ask(s.B)).toBeTruthy();
  });

  test("the first picture stays, and the gallery shows it", async () => {
    const s = await setup();
    const app_id = await s.make("Tea Tally");
    const first = await s.image(1_000);
    await s.t.run(async (ctx) => {
      const v = (await ctx.db.query("versions").withIndex("by_app_number", (q) => q.eq("app_id", app_id).eq("number", 1)).unique())!;
      await ctx.db.patch(v._id, { still: first });
    });
    expect(await s.t.mutation(api.stills.uploadUrl, { ...s.A, app_id, number: 1 })).toBeNull();
    const late = await s.image(1_000);
    expect(await s.t.mutation(api.stills.attach, { ...s.A, app_id, number: 1, storage_id: late })).toBe(false);
    expect(await s.t.run((ctx) => ctx.db.system.get(late))).toBeNull();
    expect((await s.gallery())[0].still_url).toBeTruthy();
  });

  test("anything not a small image is thrown away, not kept", async () => {
    const s = await setup();
    const app_id = await s.make("Tea Tally");
    for (const file of [await s.image(STILL_MAX_BYTES + 1), await s.image(100, "text/html")]) {
      expect(await s.t.mutation(api.stills.attach, { ...s.A, app_id, number: 1, storage_id: file })).toBe(false);
      expect(await s.t.run((ctx) => ctx.db.system.get(file))).toBeNull();
    }
  });
});
