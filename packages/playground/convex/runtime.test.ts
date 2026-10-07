// The runtime data layer untrusted app code reaches (runtime.ts), under
// convex-test: the caps, which docs an app may touch, shared value
// conflicts, and copying an app's data into a fork.
import { afterAll, beforeAll, describe, expect, jest, test } from "bun:test";
import { convexTest } from "convex-test";
import { mintVisitor } from "../src/lib/mint";
import schema from "./schema";
import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { runtimeTokenForSecret } from "./lib/identity";
import { COPY_PAGE_DOCS, MAX_DATA_BYTES_PER_APP, MAX_DATA_DOCS_PER_APP, VISITOR_COPY_DAILY_BYTES } from "./lib/limits";
import { TALLY, dayKey } from "./tallies";

beforeAll(() => jest.useFakeTimers());
afterAll(() => jest.useRealTimers());

const modules = {
  "./_generated/server.ts": () => import("./_generated/server"),
  "./apps.ts": () => import("./apps"),
  "./builds.ts": () => import("./builds"),
  "./limits.ts": () => import("./limits"),
  "./messages.ts": () => import("./messages"),
  "./presence.ts": () => import("./presence"),
  "./runtime.ts": () => import("./runtime"),
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
  const app = async (name: string) => (await t.mutation(api.apps.create, { ...A, name })).app_id as Id<"apps">;
  const app_id = await app("Tea Tally");
  const rt = async (who: typeof A, id = app_id) => ({ visitor_id: who.visitor_id, app_id: id, token: await runtimeTokenForSecret(who.secret, id, 1) });
  const usage = (id = app_id) => t.run((ctx) => ctx.db.query("app_data_usage").withIndex("by_app", (q) => q.eq("app_id", id)).unique());
  const rows = (id: Id<"apps">) => t.run((ctx) => ctx.db.query("app_data").withIndex("by_app_collection_key", (q) => q.eq("app_id", id)).collect());
  return { t, A, B, app, app_id, rt, usage, rows };
}

describe("watching", () => {
  test("a watch token reads an app's data but writes nothing in the watcher's name", async () => {
    const s = await setup();
    await s.t.mutation(api.runtime.insert, { ...(await s.rt(s.A)), collection: "notes", value: { text: "hi" } });
    const watch = { visitor_id: s.B.visitor_id, app_id: s.app_id, token: await runtimeTokenForSecret(s.B.secret, s.app_id, 1, Date.now(), "watch") };
    expect((await s.t.query(api.runtime.list, { ...watch, collection: "notes" })).map((d) => d.text)).toEqual(["hi"]);
    await expect(s.t.mutation(api.runtime.insert, { ...watch, collection: "notes", value: { text: "x" } })).rejects.toThrow(/Looking only/);
    await expect(s.t.mutation(api.runtime.setShared, { ...watch, key: "k", value: 1 })).rejects.toThrow(/Looking only/);
    await expect(s.t.mutation(api.runtime.setState, { ...watch, state: { x: 1 } })).rejects.toThrow(/Looking only/);
  });
});

describe("caps", () => {
  test("an app holds at most MAX_DATA_DOCS_PER_APP docs", async () => {
    const s = await setup();
    await s.t.run((ctx) => ctx.db.insert("app_data_usage", { app_id: s.app_id, docs: MAX_DATA_DOCS_PER_APP, bytes: 0 }));
    await expect(s.t.mutation(api.runtime.insert, { ...(await s.rt(s.A)), collection: "notes", value: { a: 1 } })).rejects.toThrow(/the most it can/);
  });

  test("an update that grows the app past its bytes is refused; removing gives the room back", async () => {
    const s = await setup();
    const rt = await s.rt(s.A);
    const id = await s.t.mutation(api.runtime.insert, { ...rt, collection: "notes", value: { text: "hi" } });
    const before = (await s.usage())!;
    await s.t.run(async (ctx) => {
      const row = (await ctx.db.query("app_data_usage").withIndex("by_app", (q) => q.eq("app_id", s.app_id)).unique())!;
      await ctx.db.patch(row._id, { bytes: MAX_DATA_BYTES_PER_APP - 10 });
    });
    await expect(s.t.mutation(api.runtime.update, { ...rt, id, patch: { text: "x".repeat(200) } })).rejects.toThrow(/data is full/);
    await s.t.mutation(api.runtime.remove, { ...rt, id });
    expect(await s.usage()).toMatchObject({ docs: before.docs - 1, bytes: MAX_DATA_BYTES_PER_APP - 10 - before.bytes });
  });
});

describe("which docs an app may touch", () => {
  test("not another app's doc, and not a shared value by its id", async () => {
    const s = await setup();
    const other = await s.app("Elsewhere");
    const theirs = await s.t.mutation(api.runtime.insert, { ...(await s.rt(s.A, other)), collection: "notes", value: { a: 1 } });
    const rt = await s.rt(s.A);
    await s.t.mutation(api.runtime.setShared, { ...rt, key: "score", value: 1 });
    const shared = (await s.rows(s.app_id)).find((r) => r.collection === "~shared")!._id;
    for (const id of [theirs, shared]) {
      await expect(s.t.mutation(api.runtime.update, { ...rt, id, patch: { a: 2 } })).rejects.toThrow(/does not exist anymore/);
      await expect(s.t.mutation(api.runtime.remove, { ...rt, id })).rejects.toThrow(/does not exist anymore/);
    }
    expect((await s.rows(other))[0].value).toEqual({ a: 1 });
  });

  test("a token for another app opens nothing here", async () => {
    const s = await setup();
    const other = await s.app("Elsewhere");
    await expect(s.t.query(api.runtime.list, { ...(await s.rt(s.A, other)), app_id: s.app_id, collection: "notes" })).rejects.toThrow(/not connected/);
  });
});

describe("shared values", () => {
  test("a write against a stale rev answers with what is there now", async () => {
    const s = await setup();
    const [a, b] = [await s.rt(s.A), await s.rt(s.B)];
    expect(await s.t.mutation(api.runtime.setShared, { ...a, key: "score", value: 5, base_rev: 0 })).toEqual({ ok: true, rev: 1 });
    expect(await s.t.mutation(api.runtime.setShared, { ...b, key: "score", value: 9, base_rev: 0 })).toEqual({ ok: false, value: 5, rev: 1 });
    expect(await s.t.mutation(api.runtime.setShared, { ...b, key: "score", value: 6, base_rev: 1 })).toEqual({ ok: true, rev: 2 });
    expect(await s.t.query(api.runtime.shared, { ...a, key: "score" })).toMatchObject({ value: 6, rev: 2, by: { id: s.B.visitor_id } });
  });

  test("keys are 1 to 64 characters", async () => {
    const s = await setup();
    const rt = await s.rt(s.A);
    for (const key of ["", "k".repeat(65)]) {
      await expect(s.t.mutation(api.runtime.setShared, { ...rt, key, value: 1 })).rejects.toThrow(/1 to 64/);
    }
  });
});

describe("scoped reads and bulk removes", () => {
  test("where narrows a read to matching docs, so old rounds never crowd out the newest 400", async () => {
    const s = await setup();
    const rt = await s.rt(s.A);
    for (const [round, text] of [[1, "a"], [2, "b"], [2, "c"], [1, "d"]] as const) {
      await s.t.mutation(api.runtime.insert, { ...rt, collection: "strokes", value: { round, text } });
    }
    const read = (where?: unknown) => s.t.query(api.runtime.list, { ...rt, collection: "strokes", ...(where ? { where } : {}) });
    expect((await read({ round: 2 })).map((d) => d.text)).toEqual(["b", "c"]);
    expect((await read()).map((d) => d.text)).toEqual(["a", "b", "c", "d"]);
    await expect(read({ "a.b": 1 })).rejects.toThrow(/not a field name/);
  });

  test("removeWhere clears matching docs in pages and gives the room back", async () => {
    const s = await setup();
    const rt = await s.rt(s.A);
    for (let i = 0; i < 5; i++) await s.t.mutation(api.runtime.insert, { ...rt, collection: "items", value: { done: i % 2 === 0, i } });
    expect(await s.t.mutation(api.runtime.removeWhere, { ...rt, collection: "items", where: { done: true } })).toEqual({ removed: 3, more: false });
    expect((await s.t.query(api.runtime.list, { ...rt, collection: "items" })).map((d) => d.i)).toEqual([1, 3]);
    expect(await s.usage()).toMatchObject({ docs: 2 });
    expect(await s.t.mutation(api.runtime.removeWhere, { ...rt, collection: "items", where: {} })).toEqual({ removed: 2, more: false });
  });
});

describe("private values", () => {
  test("useMine is each person's own: same key, separate values, and no doc id reaches it", async () => {
    const s = await setup();
    const [a, b] = [await s.rt(s.A), await s.rt(s.B)];
    await s.t.mutation(api.runtime.setShared, { ...a, key: "word", mine: true, value: "otter" });
    await s.t.mutation(api.runtime.setShared, { ...b, key: "word", mine: true, value: "heron" });
    expect(await s.t.query(api.runtime.shared, { ...a, key: "word", mine: true })).toMatchObject({ value: "otter" });
    expect(await s.t.query(api.runtime.shared, { ...b, key: "word", mine: true })).toMatchObject({ value: "heron" });
    expect(await s.t.query(api.runtime.shared, { ...a, key: "word" })).toBeNull();
    const [row] = (await s.rows(s.app_id)).filter((r) => r.collection === "~mine");
    await expect(s.t.mutation(api.runtime.remove, { ...b, id: row._id })).rejects.toThrow(/does not exist/);
  });
});

describe("a fork's copy of the data", () => {
  /** Fill the source with `docs` notes and one shared score, all by A. */
  async function filled(s: Awaited<ReturnType<typeof setup>>, docs: number) {
    const rt = await s.rt(s.A);
    await s.t.run(async (ctx) => {
      const by = s.A.visitor_id;
      for (let i = 0; i < docs; i++) {
        await ctx.db.insert("app_data", { app_id: s.app_id, collection: "notes", value: { i }, size: 8, rev: 1, created_by: by, updated_by: by, updated_at: 1 });
      }
      await ctx.db.insert("app_data", { app_id: s.app_id, collection: "~shared", key: "score", value: 7, size: 1, rev: 3, created_by: by, updated_by: by, updated_at: 1 });
      await ctx.db.insert("app_data_usage", { app_id: s.app_id, docs: docs + 1, bytes: docs * 8 + 1 });
    });
    return rt;
  }

  test("a big copy runs in pages after the fork opens: a value the fork set first wins, and later source rows stay behind", async () => {
    const s = await setup();
    await filled(s, COPY_PAGE_DOCS + 20);
    const fork = (await s.t.mutation(api.apps.fork, { ...s.B, app_id: s.app_id, number: 1, name: "Take two" })).app_id;
    const forkRt = await s.rt(s.B, fork);
    // The fork is open at once; someone there sets the score before the copy reaches it.
    await s.t.mutation(api.runtime.setShared, { ...forkRt, key: "score", value: 100 });
    // The source keeps going after the fork.
    jest.advanceTimersByTime(1_000);
    await s.t.mutation(api.runtime.insert, { ...(await s.rt(s.A)), collection: "notes", value: { late: true } });
    await s.t.finishAllScheduledFunctions(jest.runAllTimers);

    const rows = await s.rows(fork);
    const shared = rows.filter((r) => r.collection === "~shared");
    expect(shared.map((r) => [r.key, r.value])).toEqual([["score", 100]]);
    expect(await s.t.query(api.runtime.shared, { ...forkRt, key: "score" })).toMatchObject({ value: 100 });
    const notes = rows.filter((r) => r.collection === "notes").map((r) => r.value);
    expect(notes).toHaveLength(COPY_PAGE_DOCS + 20);
    expect(notes).not.toContainEqual({ late: true });
    expect(await s.usage(fork)).toMatchObject({ docs: COPY_PAGE_DOCS + 21 });
  });

  test("a forker past today's copying gets an empty fork and its room says why", async () => {
    const s = await setup();
    await filled(s, 3);
    await s.t.run((ctx) => ctx.db.insert("tallies", { key: TALLY.visitorCopied(s.B.visitor_id), day: dayKey(Date.now()), value: VISITOR_COPY_DAILY_BYTES }));
    const fork = (await s.t.mutation(api.apps.fork, { ...s.B, app_id: s.app_id, number: 1, name: "Take two" })).app_id;
    expect(await s.rows(fork)).toEqual([]);
    const room = await s.t.query(api.messages.list, { ...s.B, app_id: fork, paginationOpts: { numItems: 5, cursor: null } });
    expect(room.page.map((m) => m.note)).toEqual([{ type: "data", outcome: "skipped" }]);
  });

  test("the bytes a fork copies count toward the forker's day", async () => {
    const s = await setup();
    await filled(s, 3);
    await s.t.mutation(api.apps.fork, { ...s.B, app_id: s.app_id, number: 1, name: "Take two" });
    const copied = await s.t.run((ctx) => ctx.db.query("tallies").collect());
    expect(Object.fromEntries(copied.map((r) => [r.key, r.value]))).toMatchObject({ [TALLY.copied]: 25, [TALLY.visitorCopied(s.B.visitor_id)]: 25 });
  });
});
