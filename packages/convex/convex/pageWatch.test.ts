// Sessions watching a page's state (trigger event page_state): a write wakes
// the triggers watching that page, narrowed to their collections, for owners
// who may read it; a session's own CLI write stamps the row and never wakes
// that session; the page shows an agent's row as the agent's.
import { describe, expect, test } from "bun:test";
import { convexTest } from "convex-test";
import schema from "./schema";
import { api, internal } from "./_generated/api";
import { allModules } from "./testModules.testkit";
import { parsePageDataDeclaration } from "@codecast/shared/contracts/pageData";
import { storedEventFilter } from "./agentTasks";

const SLUG = "watchslug1";

async function setup() {
  const t = convexTest(schema, allModules);
  const ids = await t.run(async (ctx) => {
    const owner = await ctx.db.insert("users", { name: "Pat" } as any);
    const stranger = await ctx.db.insert("users", { name: "Sam" } as any);
    const storage = await ctx.storage.store(new Blob(["<html></html>"], { type: "text/html" }));
    const artifact = await ctx.db.insert("artifacts", {
      slug: SLUG, user_id: owner, title: "Requests", storage_id: storage, size: 10, version: 1, created_at: 1, updated_at: 1, owner_key: "ownerkey",
    } as any);
    const conv = await ctx.db.insert("conversations", { user_id: owner, session_id: "sess-pat", title: "Request desk", status: "active", started_at: 1, updated_at: 1 } as any);
    return { owner, stranger, artifact, conv };
  });
  const parsed = parsePageDataDeclaration({ state: { requests: { write: "anyone" }, answers: { write: "editors" }, secret: { read: "owner" } } });
  if (!parsed.ok) throw new Error(parsed.error);
  await t.mutation(internal.pageData.replaceQueries, {
    slug: SLUG, owner: ids.owner, version: 1,
    set_json: JSON.stringify({ workspace: `user:${ids.owner}`, queries: [], state: parsed.state }),
  });
  const arm = (user: any, collections?: string[], originating?: any) =>
    t.run(async (ctx) => {
      const event_filter = await storedEventFilter(ctx as any, user, undefined, { event_type: "page_state", page_id: SLUG, ...(collections ? { collections } : {}) });
      return ctx.db.insert("agent_tasks", {
        user_id: user, title: "watch", prompt: "watch", schedule_type: "event", event_filter, status: "scheduled",
        mode: "apply", run_count: 0, retry_count: 0, created_at: 1, ...(originating ? { originating_conversation_id: originating } : {}),
      } as any);
    });
  const settle = async () => {
    await new Promise((r) => setTimeout(r, 5));
    await t.finishInProgressScheduledFunctions();
  };
  const events = (task: any) => t.run(async (ctx) => ((await ctx.db.get(task)) as any)?.pending_events ?? []);
  return { t, ...ids, arm, settle, events };
}

describe("watching a page's state", () => {
  test("a viewer's write reaches the watching session with what changed, coalesced", async () => {
    const { t, owner, conv, arm, settle, events } = await setup();
    const task = await arm(owner, undefined, conv);
    await t.mutation(api.pageState.write, { slug: SLUG, collection: "requests", op: "insert", value_json: JSON.stringify({ ask: "dark mode" }) });
    await t.mutation(api.pageState.write, { slug: SLUG, collection: "requests", op: "insert", value_json: JSON.stringify({ ask: "export" }) });
    await settle();
    const got = await events(task);
    expect(got).toHaveLength(2);
    expect(got[0]).toMatchObject({ event_type: "page_state", group_short_id: `${SLUG}/requests`, url: expect.stringContaining(SLUG) });
    expect(got[0].title).toContain("an anonymous viewer added");
    expect(got[0].title).toContain('"dark mode"');
    // Both writes ride one window: the run waits for the burst.
    const row: any = await t.run((ctx) => ctx.db.get(task));
    expect(row.run_at).toBeGreaterThan(Date.now());
  });

  test("a watch on some collections ignores the others", async () => {
    const { t, owner, arm, settle, events } = await setup();
    const task = await arm(owner, ["answers"]);
    await t.mutation(api.pageState.write, { slug: SLUG, collection: "requests", op: "insert", value_json: "1" });
    await settle();
    expect(await events(task)).toHaveLength(0);
    await t.mutation(api.pageState.write, { slug: SLUG, collection: "answers", op: "set", key: "a", value_json: "2", owner_key: "ownerkey" });
    await settle();
    expect(await events(task)).toHaveLength(1);
  });

  test("the session's own write is stamped as the agent's and does not wake it", async () => {
    const { t, owner, conv, arm, settle, events } = await setup();
    const task = await arm(owner, undefined, conv);
    const wrote = await t.mutation(internal.pageState.accountWrite, { user: owner, target: SLUG, collection: "answers", op: "set", key: "r1", value_json: JSON.stringify({ reply: "on it" }), session_id: "sess-pat" });
    expect(wrote).toEqual({ key: "r1" });
    await settle();
    expect(await events(task)).toHaveLength(0);
    const list: any = await t.query(api.pageState.list, { slug: SLUG, collection: "answers" });
    expect(list.rows[0].agent).toEqual({ session: String(conv).slice(0, 7), title: "Request desk" });
  });

  test("an unchanged write wakes nobody", async () => {
    const { t, owner, arm, settle, events } = await setup();
    const task = await arm(owner);
    const set = () => t.mutation(api.pageState.write, { slug: SLUG, collection: "answers", op: "set", key: "k", value_json: "1", owner_key: "ownerkey" });
    await set();
    await set();
    await settle();
    expect(await events(task)).toHaveLength(1);
  });

  test("a watch is refused for a collection the account cannot read, a missing one, or a page with no state", async () => {
    const { t, stranger, owner, arm } = await setup();
    await expect(arm(stranger, ["secret"])).rejects.toThrow("cannot read");
    await expect(arm(owner, ["nope"])).rejects.toThrow('no state collection "nope"');
    // A stranger may watch what the open link lets anyone read, and is never woken for the owner's collection.
    const task = await arm(stranger);
    await t.mutation(api.pageState.write, { slug: SLUG, collection: "secret", op: "set", key: "k", value_json: "1", owner_key: "ownerkey" });
    await new Promise((r) => setTimeout(r, 5));
    await t.finishInProgressScheduledFunctions();
    expect(((await t.run((ctx) => ctx.db.get(task))) as any).pending_events ?? []).toHaveLength(0);
  });

  test("a session reads and writes a page as its account would in the app", async () => {
    const { t, stranger } = await setup();
    const read: any = await t.query(internal.pageState.accountRead, { user: stranger, target: `https://codecast.sh/a/${SLUG}` });
    expect(read.collections.find((c: any) => c.id === "secret")).toMatchObject({ can_read: false, rows: [] });
    expect(await t.mutation(internal.pageState.accountWrite, { user: stranger, target: SLUG, collection: "answers", op: "set", key: "x", value_json: "1" })).toEqual({ error: expect.stringContaining("editors only") });
    expect(await t.mutation(internal.pageState.accountWrite, { user: stranger, target: SLUG, collection: "requests", op: "insert", value_json: "1" })).toHaveProperty("key");
  });
});
