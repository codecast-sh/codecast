// The signal door (docs/architecture/the-line-end-to-end.md LE3, LE4, LE12),
// run through the real action, query and mutation under convex-test with the
// judge's model call stubbed at fetch: each attach path, the counters, and a
// cause in watch reopening.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { convexTest } from "convex-test";
import schema from "./schema";
import { api, internal } from "./_generated/api";
import { hashToken } from "./apiTokens";
import { attachJudgeRequest, causeDescription, normalizeSignal, parseAttachJudgeReply, rewriteCauseDescription, type CauseCandidate } from "./signals";

const TOKEN = "s".repeat(64);
const T0 = 1_760_000_000_000;

function judgeStub() {
  const realFetch = globalThis.fetch;
  const realKey = process.env.ANTHROPIC_API_KEY;
  const state = { reply: '{"answer":"none"}', calls: [] as any[] };
  return {
    state,
    install() {
      process.env.ANTHROPIC_API_KEY = "test-key";
      state.calls.length = 0;
      globalThis.fetch = (async (_url: unknown, init: { body: string }) => {
        state.calls.push(JSON.parse(init.body));
        return new Response(JSON.stringify({
          content: [{ type: "text", text: state.reply }],
          stop_reason: "end_turn",
          usage: { input_tokens: 1, output_tokens: 1 },
        }));
      }) as unknown as typeof fetch;
    },
    restore() {
      globalThis.fetch = realFetch;
      if (realKey === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = realKey;
    },
  };
}

async function setup() {
  const t = convexTest(schema, {
    "./_generated/server.ts": () => import("./_generated/server"),
  "./syncOutbox.ts": () => import("./syncOutbox"),
    "./signals.ts": () => import("./signals"),
    "./notificationRouter.ts": () => import("./notificationRouter"),
  });
  const userId = await t.run(async (ctx) => {
    const id = await ctx.db.insert("users", { name: "Finder" } as any);
    await ctx.db.insert("api_tokens", { user_id: id, token_hash: await hashToken(TOKEN), name: "cli", created_at: T0, last_used_at: T0 } as any);
    // The explicit conversion step (LE4): a line profile declares sentry's
    // signals as opening causes. Any other automated source is held.
    await ctx.db.insert("projects", {
      user_id: id, workspace: `user:${id}`, short_id: "pr-1", title: "Web", status: "active", created_at: T0, updated_at: T0,
      line_profile: { finders: [{ id: "errors", source: "sentry", kind: ["bug"], fingerprint: "<group>", opens_causes: true }], changed_at: T0 },
    } as any);
    return id;
  });
  const add = (fields: Record<string, any>) =>
    t.action(api.signals.ingest, { api_token: TOKEN, workspace: "personal", source: "sentry", kind: "bug", ...fields } as any);
  const task = (id: string) => t.run(async (ctx) => await ctx.db.get(id as any)) as Promise<any>;
  return { t, userId, add, task };
}

describe("signals.ingest", () => {
  const stub = judgeStub();
  beforeEach(() => stub.install());
  afterEach(() => stub.restore());

  test("new: a first signal opens a suggested cause in the caller's workspace", async () => {
    const { add, task, userId, t } = await setup();
    const out = await add({ fingerprint: "err-1", title: "Checkout throws on empty cart", subject: "web/checkout" });
    expect(out.attach).toBe("new");
    expect(out.short_id).toMatch(/^sg-\d+$/);
    expect(stub.state.calls).toHaveLength(0);
    const cause = await task(out.task_id);
    expect(cause).toMatchObject({ source: "signal", triage_status: "suggested", status: "open", task_type: "bug", title: "Checkout throws on empty cart", workspace: `user:${userId}` });
    expect(cause.cause).toMatchObject({ signal_count: 1, fingerprints: ["err-1"] });
    const signal = await t.run(async (ctx) => await ctx.db.get(out.signal_id));
    expect(signal).toMatchObject({ workspace: `user:${userId}`, task_id: out.task_id, attach: "new", source: "sentry" });
  });

  test("held: a source no finder converts files a signal and opens no cause", async () => {
    const { add, t } = await setup();
    const out = await add({ source: "union.eval", kind: "prompt_miss", fingerprint: "eval:route:1", title: "Route misses a frozen moment" });
    expect(out.attach).toBe("held");
    expect(out.task_id).toBeUndefined();
    expect(stub.state.calls).toHaveLength(0);
    const tasks = await t.run(async (ctx) => await ctx.db.query("tasks").collect());
    expect(tasks).toHaveLength(0);
    const shown = await t.query(api.signals.showForCli, { api_token: TOKEN, signal: out.short_id });
    expect(shown.signal).toMatchObject({ attach: "held" });
    expect(shown.signal.task_short_id).toBeUndefined();
    expect(shown.cause).toBeNull();
  });

  test("person: a signal a person files opens a cause whatever the profiles declare", async () => {
    const { add, task } = await setup();
    const out = await add({ source: "person", kind: "ux", fingerprint: "person:1", title: "The settings sheet hides Save" });
    expect(out.attach).toBe("new");
    expect((await task(out.task_id)).source).toBe("signal");
  });

  test("conversion: once a finder declares opens_causes, its key's held signals join the cause it opens", async () => {
    const { add, t, task, userId } = await setup();
    const a = await add({ source: "agentwatch", fingerprint: "cluster:7", title: "Replies quote the wrong price", observed_at: T0 });
    const b = await add({ source: "agentwatch", fingerprint: "cluster:7", title: "Replies quote the wrong price", observed_at: T0 + 1000 });
    expect([a.attach, b.attach]).toEqual(["held", "held"]);
    await t.run(async (ctx) => {
      const project = await ctx.db.query("projects").withIndex("by_workspace", (q) => q.eq("workspace", `user:${userId}`)).first();
      await ctx.db.patch(project!._id, { line_profile: { ...project!.line_profile!, finders: [...project!.line_profile!.finders, { id: "clusters", source: "agentwatch", kind: ["bug"], fingerprint: "cluster:<id>", opens_causes: true }] } });
    });
    const c = await add({ source: "agentwatch", fingerprint: "cluster:7", title: "Replies quote the wrong price", observed_at: T0 + 2000 });
    expect(c.attach).toBe("new");
    const cause = await task(c.task_id);
    expect(cause.cause).toMatchObject({ signal_count: 3, first_seen: T0, last_seen: T0 + 2000, fingerprints: ["cluster:7"] });
    const rows = await t.run(async (ctx) => await ctx.db.query("signals").collect());
    expect(rows.map((r) => r.task_id)).toEqual([c.task_id, c.task_id, c.task_id]);
  });

  test("fingerprint: the same fingerprint attaches to the open cause without asking the judge", async () => {
    const { add, task } = await setup();
    const first = await add({ fingerprint: "err-1", title: "Checkout throws on empty cart", observed_at: T0 });
    const second = await add({ fingerprint: "err-1", title: "Checkout throws on empty cart (again)", observed_at: T0 + 5000 });
    expect(second).toMatchObject({ attach: "fingerprint", task_id: first.task_id, signal_count: 2, reopened: false });
    expect(stub.state.calls).toHaveLength(0);
    expect((await task(first.task_id)).cause).toEqual({ signal_count: 2, first_seen: T0, last_seen: T0 + 5000, fingerprints: ["err-1"] });
  });

  test("judge: a new fingerprint near an open cause attaches where the judge points", async () => {
    const { add, task } = await setup();
    const first = await add({ fingerprint: "err-1", title: "Checkout throws on empty cart", subject: "web/checkout" });
    const firstTask = await task(first.task_id);
    stub.state.reply = `{"answer": "${firstTask.short_id}"}`;
    const second = await add({ fingerprint: "err-2", title: "Empty cart checkout crash in Safari", subject: "web/checkout" });
    expect(stub.state.calls).toHaveLength(1);
    expect(stub.state.calls[0].messages[0].content).toContain(`<cause id="${firstTask.short_id}">`);
    expect(second).toMatchObject({ attach: "judge", task_id: first.task_id, signal_count: 2 });
    expect((await task(first.task_id)).cause.fingerprints).toEqual(["err-1", "err-2"]);
  });

  test("judge unsure is none: a new cause opens", async () => {
    const { add } = await setup();
    const first = await add({ fingerprint: "err-1", title: "Checkout throws on empty cart" });
    stub.state.reply = '{"answer":"unsure"}';
    const second = await add({ fingerprint: "err-2", title: "Checkout slow on empty cart" });
    expect(stub.state.calls).toHaveLength(1);
    expect(second.attach).toBe("new");
    expect(second.task_id).not.toBe(first.task_id);
  });

  test("no word in common: the judge is not asked", async () => {
    const { add } = await setup();
    await add({ fingerprint: "err-1", title: "Checkout throws on empty cart" });
    const second = await add({ fingerprint: "err-9", title: "Avatar upload rejects PNG", kind: "ux" });
    expect(stub.state.calls).toHaveLength(0);
    expect(second.attach).toBe("new");
  });

  test("reopen: a signal on a cause in watch reopens it, with history and a note", async () => {
    const { add, task, t } = await setup();
    const first = await add({ fingerprint: "err-1", title: "Checkout throws on empty cart" });
    await t.run(async (ctx) => { await ctx.db.patch(first.task_id, { status: "done", closed_at: Date.now(), watch_until: Date.now() + 86_400_000 } as any); });
    const again = await add({ fingerprint: "err-1", title: "Checkout throws on empty cart" });
    expect(again).toMatchObject({ attach: "fingerprint", task_id: first.task_id, reopened: true, signal_count: 2 });
    const cause = await task(first.task_id);
    expect(cause.status).toBe("open");
    expect(cause.watch_until).toBeUndefined();
    expect(cause.closed_at).toBeUndefined();
    const { history, comments } = await t.run(async (ctx) => ({
      history: await ctx.db.query("task_history").collect(),
      comments: await ctx.db.query("task_comments").collect(),
    }));
    expect(history.some((h: any) => h.field === "status" && h.old_value === "done" && h.new_value === "open")).toBe(true);
    expect(comments.some((c: any) => c.text.includes("Reopened during watch"))).toBe(true);
    // LE16: the cause's people hear it reopened.
    const notes = await t.run(async (ctx) => await ctx.db.query("notifications").collect());
    expect(notes.map((n: any) => [n.type, n.message])).toEqual([["cause_reopened", expect.stringContaining("sentry saw it again during the watch")]]);
  });

  test("the quiet close stamps resolved_at and clears the watch; a reopen clears it", async () => {
    const { add, task, t } = await setup();
    const shipped = await add({ fingerprint: "err-1", title: "Checkout throws on empty cart" });
    const open = await add({ fingerprint: "err-2", title: "Avatar upload rejects PNG", kind: "ux" });
    const shipAt = Date.now() - 5 * 86_400_000;
    await t.run(async (ctx) => {
      await ctx.db.patch(shipped.task_id, { status: "done", closed_at: shipAt, watch_until: Date.now() - 1000 } as any);
      await ctx.db.patch(open.task_id, { watch_until: Date.now() - 1000 } as any);
    });
    await t.mutation(internal.signals.sweepWatches, {});
    const a = await task(shipped.task_id);
    // A shipped cause is already done: the quiet end keeps it done and says so.
    expect(a).toMatchObject({ status: "done", closed_at: shipAt });
    const quietNotes = await t.run(async (ctx) => (await ctx.db.query("task_comments").collect()).filter((c: any) => c.task_id === shipped.task_id));
    expect(quietNotes.some((c: any) => c.text.startsWith("Watch ended quiet: no new report from"))).toBe(true);
    const moves = await t.run(async (ctx) => (await ctx.db.query("task_history").collect()).filter((h: any) => h.field === "status" && h.task_id === shipped.task_id));
    expect(moves).toHaveLength(0);
    expect(a.watch_until).toBeUndefined();
    expect(a.resolved_at).toBeGreaterThan(shipAt);
    const b = await task(open.task_id);
    expect(b.status).toBe("done");
    expect(b.resolved_at).toBe(b.closed_at);

    await t.run(async (ctx) => { await ctx.db.patch(shipped.task_id, { watch_until: Date.now() + 86_400_000 } as any); });
    await add({ fingerprint: "err-1", title: "Checkout throws on empty cart" });
    expect((await task(shipped.task_id)).resolved_at).toBeUndefined();
  });

  test("a closed cause past its watch takes no more signals: a new cause opens", async () => {
    const { add, t } = await setup();
    const first = await add({ fingerprint: "err-1", title: "Checkout throws on empty cart" });
    await t.run(async (ctx) => { await ctx.db.patch(first.task_id, { status: "done", watch_until: Date.now() - 1000 } as any); });
    const again = await add({ fingerprint: "err-1", title: "Checkout throws on empty cart" });
    expect(again.attach).toBe("new");
    expect(again.task_id).not.toBe(first.task_id);
  });

  test("ls and show read back what the door wrote", async () => {
    const { add, t, task } = await setup();
    const first = await add({ fingerprint: "err-1", title: "Checkout throws on empty cart" });
    await add({ fingerprint: "evals:title", title: "Title surface drifts", source: "evals", kind: "prompt_miss" });
    const all = await t.query(api.signals.listForCli, { api_token: TOKEN, workspace: "personal" });
    expect(all.signals).toHaveLength(2);
    const evals = await t.query(api.signals.listForCli, { api_token: TOKEN, workspace: "personal", source: "evals" });
    expect(evals.signals.map((s: any) => s.source)).toEqual(["evals"]);
    const shortId = (await task(first.task_id)).short_id;
    const byTask = await t.query(api.signals.listForCli, { api_token: TOKEN, task: shortId });
    expect(byTask.signals.map((s: any) => s.task_short_id)).toEqual([shortId]);
    const shown = await t.query(api.signals.showForCli, { api_token: TOKEN, signal: first.short_id });
    expect(shown.signal).toMatchObject({ short_id: first.short_id, task_short_id: shortId, attach: "new" });
    expect(shown.cause.signal_count).toBe(1);
  });

  test("ls --fingerprint reads one fingerprint's signals however old, newest first", async () => {
    // A finder asking which cause holds its key must not page the whole
    // workspace: Union's planner read the newest 500 and the reply outgrew
    // the box's transport cap, so no cause was ever found.
    const { add, t, task } = await setup();
    const first = await add({ fingerprint: "union:cluster:a", title: "Booking link points at localhost" });
    for (let i = 0; i < 3; i++) await add({ fingerprint: `other-${i}`, title: `Unrelated ${i} zebra${i}` });
    const again = await add({ fingerprint: "union:cluster:a", title: "Booking link points at localhost" });
    const hit = await t.query(api.signals.listForCli, { api_token: TOKEN, workspace: "personal", fingerprint: "union:cluster:a", limit: 1 });
    expect(hit.signals.map((s: any) => s.short_id)).toEqual([again.short_id]);
    expect(hit.signals[0].task_short_id).toBe((await task(first.task_id)).short_id);
    const none = await t.query(api.signals.listForCli, { api_token: TOKEN, workspace: "personal", fingerprint: "union:cluster:missing" });
    expect(none.signals).toEqual([]);
  });

  test("move: a fingerprint leaves a cause for a new one of its own, and later signals follow it", async () => {
    // Union 2026-10-07: held call cards (C117) had been attached to a cause
    // about message openings; a cause is one mechanism, so it gets its own.
    const { add, t, task } = await setup();
    const first = await add({ fingerprint: "union:cluster:a", title: "Messages narrate effort" });
    const from = (await task(first.task_id)).short_id;
    stub.state.reply = `{"answer": "${from}"}`;
    await add({ fingerprint: "union:cluster:b", title: "Messages narrate Union's effort" });
    stub.state.reply = '{"answer":"none"}';
    const moved = await t.mutation(api.signals.moveForCli, { api_token: TOKEN, workspace: "personal", fingerprint: "union:cluster:b", from, title: "Held call cards dial outside calling hours" });
    expect(moved.moved).toBe(1);
    expect(moved.created).toBe(true);
    const target = await t.run(async (ctx) => await ctx.db.query("tasks").withIndex("by_short_id", (q) => q.eq("short_id", moved.to)).first()) as any;
    expect(target.title).toBe("Held call cards dial outside calling hours");
    expect(target.cause.fingerprints).toEqual(["union:cluster:b"]);
    const source = (await task(first.task_id)) as any;
    expect(source.cause.fingerprints).toEqual(["union:cluster:a"]);
    expect(source.cause.signal_count).toBe(1);
    const later = await add({ fingerprint: "union:cluster:b", title: "Held call cards dial outside calling hours" });
    expect(later.attach).toBe("fingerprint");
    expect((await task(later.task_id)).short_id).toBe(moved.to);
  });

  test("move refuses a fingerprint the cause does not hold", async () => {
    const { add, t, task } = await setup();
    const first = await add({ fingerprint: "union:cluster:a", title: "Messages narrate effort" });
    const from = (await task(first.task_id)).short_id;
    await expect(t.mutation(api.signals.moveForCli, { api_token: TOKEN, workspace: "personal", fingerprint: "union:cluster:zz", from })).rejects.toThrow();
  });

  test("the web feed carries the fingerprint, the evidence link and the head of the detail (line-map.md LX7)", async () => {
    const { add, t, userId } = await setup();
    const quote = "> Book a time here: http://localhost:3000/book";
    await add({ fingerprint: "union:cluster:c-1", title: "Booking link points at localhost", detail_md: `**Sent a localhost link**\n\n${quote}`, evidence_url: "https://admin.example/agent-watch?cluster=c-1&finding=f-1" });
    await add({ fingerprint: "err-2", title: "Long body", detail_md: "x".repeat(5000) });
    const rows = await t.withIdentity({ subject: `${userId}|s` }).query(api.signals.webList, {});
    const cluster = rows.find((r: any) => r.fingerprint === "union:cluster:c-1")!;
    expect(cluster).toMatchObject({ evidence_url: "https://admin.example/agent-watch?cluster=c-1&finding=f-1" });
    expect(cluster.detail_md).toContain(quote);
    const long = rows.find((r: any) => r.fingerprint === "err-2")!;
    expect(long.detail_md!.length).toBeLessThan(1300);
    expect(long.detail_md).toEndWith("…");
  });
});

// Bring findings (learning-loop.md LL3): a product files each finding under
// its own issue's key, and that key is exactly one problem. Union's
// AgentWatch clusters are the case: one cause once gathered several clusters.
describe("issue keys: one product issue is one problem (LL3)", () => {
  const stub = judgeStub();
  beforeEach(() => stub.install());
  afterEach(() => stub.restore());

  const issue = (add: (f: Record<string, any>) => Promise<any>, key: string, title: string, more: Record<string, any> = {}) =>
    add({ fingerprint: key, title, issue: true, ...more });
  const byShort = (t: any, short: string) =>
    t.run(async (ctx: any) => await ctx.db.query("tasks").withIndex("by_short_id", (q: any) => q.eq("short_id", short)).first()) as Promise<any>;

  test("one key, one problem: the same key attaches, a near twin under another key opens its own, and the judge is never asked", async () => {
    const { add, task } = await setup();
    const a1 = await issue(add, "union:cluster:a", "Messages narrate effort");
    const a2 = await issue(add, "union:cluster:a", "Messages narrate effort");
    expect(a2.task_id).toBe(a1.task_id);
    expect(a2.attach).toBe("fingerprint");
    // Word for word the same problem by text; still another issue.
    stub.state.reply = `{"answer": "${(await task(a1.task_id)).short_id}"}`;
    const b = await issue(add, "union:cluster:b", "Messages narrate effort");
    expect(b.attach).toBe("new");
    expect(b.task_id).not.toBe(a1.task_id);
    expect(stub.state.calls).toHaveLength(0);
    expect((await task(a1.task_id)).cause).toMatchObject({ issue_key: "union:cluster:a", signal_count: 2, fingerprints: ["union:cluster:a"] });
    expect((await task(b.task_id)).cause).toMatchObject({ issue_key: "union:cluster:b", signal_count: 1 });
  });

  test("a judge attach never crosses issue keys: a cause that gathered two keys keeps the first issue to reach it, and the other opens its own", async () => {
    const { add, task } = await setup();
    // Before keys were exact: the judge put cluster b on cluster a's cause.
    const legacy = await add({ fingerprint: "union:cluster:a", title: "Messages narrate effort" });
    stub.state.reply = `{"answer": "${(await task(legacy.task_id)).short_id}"}`;
    const joined = await add({ fingerprint: "union:cluster:b", title: "Messages narrate Union's effort" });
    expect(joined.attach).toBe("judge");
    stub.state.calls.length = 0;
    const a = await issue(add, "union:cluster:a", "Messages narrate effort");
    expect(a.task_id).toBe(legacy.task_id);
    expect((await task(legacy.task_id)).cause.issue_key).toBe("union:cluster:a");
    const b = await issue(add, "union:cluster:b", "Messages narrate Union's effort");
    expect(b.attach).toBe("new");
    expect(b.task_id).not.toBe(legacy.task_id);
    const b2 = await issue(add, "union:cluster:b", "Messages narrate Union's effort");
    expect(b2.task_id).toBe(b.task_id);
    expect(stub.state.calls).toHaveLength(0);
  });

  test("a finding without an issue key may still join an issue's problem by judgment; the problem keeps its one key", async () => {
    const { add, task } = await setup();
    const a = await issue(add, "union:cluster:a", "Booking link points at localhost");
    stub.state.reply = `{"answer": "${(await task(a.task_id)).short_id}"}`;
    const report = await add({ source: "person", fingerprint: "slack:localhost-link", title: "Booking link points at localhost again" });
    expect(report.attach).toBe("judge");
    expect((await task(a.task_id)).cause).toMatchObject({ issue_key: "union:cluster:a", fingerprints: ["union:cluster:a", "slack:localhost-link"] });
  });

  test("merge: the merged issue's problem folds into the survivor's, and its key becomes an alias", async () => {
    const { add, t, task } = await setup();
    const a = await issue(add, "union:cluster:a", "Messages narrate effort");
    await issue(add, "union:cluster:a", "Messages narrate effort");
    const b = await issue(add, "union:cluster:b", "Messages talk about Union's work");
    const merged = await t.mutation(api.signals.mergeForCli, { api_token: TOKEN, workspace: "personal", issue: "union:cluster:a", into: "union:cluster:b" });
    const [pa, pb] = [await task(a.task_id), await task(b.task_id)];
    expect(merged).toMatchObject({ into: "union:cluster:b", problem: pb.short_id, folded: pa.short_id, moved: 2, already: false });
    expect(pa).toMatchObject({ status: "dropped", duplicate_of: pb.short_id });
    expect(pa.cause).toMatchObject({ merged_into: pb._id, signal_count: 0, fingerprints: [] });
    expect(pa.cause.issue_key).toBeUndefined();
    expect(pb.cause).toMatchObject({ issue_key: "union:cluster:b", merged_keys: ["union:cluster:a"], signal_count: 3 });
    expect(pb.cause.fingerprints.sort()).toEqual(["union:cluster:a", "union:cluster:b"]);
    const notes = await t.run(async (ctx) => await ctx.db.query("task_comments").collect());
    expect(notes.some((n: any) => n.task_id === pa._id && n.text.includes(`Merged into ${pb.short_id}`))).toBe(true);
    // The old key keeps resolving to the survivor's problem.
    const later = await issue(add, "union:cluster:a", "Messages narrate effort");
    expect(later.task_id).toBe(b.task_id);
    const row = await t.run(async (ctx) => await ctx.db.get(later.signal_id)) as any;
    expect(row).toMatchObject({ fingerprint: "union:cluster:a", merged_into: "union:cluster:b" });
    // Merging again changes nothing; merging back is refused.
    const again = await t.mutation(api.signals.mergeForCli, { api_token: TOKEN, workspace: "personal", issue: "union:cluster:a", into: "union:cluster:b" });
    expect(again).toMatchObject({ already: true, moved: 0, problem: pb.short_id });
    await expect(t.mutation(api.signals.mergeForCli, { api_token: TOKEN, workspace: "personal", issue: "union:cluster:b", into: "union:cluster:a" })).rejects.toThrow(/merge the other way/);
    expect((await byShort(t, pb.short_id)).cause.signal_count).toBe(4);
  });

  test("merge into an issue with no problem yet: the merged issue's problem becomes the survivor's", async () => {
    const { add, t, task } = await setup();
    const a = await issue(add, "union:cluster:a", "Messages narrate effort");
    const merged = await t.mutation(api.signals.mergeForCli, { api_token: TOKEN, workspace: "personal", issue: "union:cluster:a", into: "union:cluster:new" });
    expect(merged).toMatchObject({ problem: (await task(a.task_id)).short_id, moved: 0 });
    expect((await task(a.task_id)).cause).toMatchObject({ issue_key: "union:cluster:new", merged_keys: ["union:cluster:a"] });
    const next = await issue(add, "union:cluster:new", "Messages narrate effort");
    expect(next.task_id).toBe(a.task_id);
    const alias = await issue(add, "union:cluster:a", "Messages narrate effort");
    expect(alias.task_id).toBe(a.task_id);
  });

  test("split: the new issue opens its own problem and takes the findings the product names", async () => {
    const { add, t, task } = await setup();
    const a1 = await issue(add, "union:cluster:a", "Messages narrate effort");
    const a2 = await issue(add, "union:cluster:a", "Messages narrate effort");
    await issue(add, "union:cluster:a", "Messages narrate effort");
    const split = await t.mutation(api.signals.splitForCli, {
      api_token: TOKEN, workspace: "personal", from: "union:cluster:a", move: [a2.short_id],
      source: "agentwatch", kind: "bug", fingerprint: "union:cluster:c", title: "Held call cards dial outside calling hours",
    });
    expect(split).toMatchObject({ attach: "new", split_from: "union:cluster:a", moved: 1 });
    expect(split.task_id).not.toBe(a1.task_id);
    const [pa, pc] = [await task(a1.task_id), await task(split.task_id)];
    expect(pc.cause).toMatchObject({ issue_key: "union:cluster:c", split_from: "union:cluster:a", signal_count: 2, fingerprints: ["union:cluster:c"] });
    expect(pa.cause).toMatchObject({ issue_key: "union:cluster:a", signal_count: 2, fingerprints: ["union:cluster:a"] });
    const movedRow = await t.run(async (ctx) => await ctx.db.get(a2.signal_id)) as any;
    expect(movedRow).toMatchObject({ fingerprint: "union:cluster:c", split_from: "union:cluster:a", task_id: split.task_id });
    // Each key goes on to its own problem.
    expect((await issue(add, "union:cluster:c", "Held call cards dial outside calling hours")).task_id).toBe(split.task_id);
    expect((await issue(add, "union:cluster:a", "Messages narrate effort")).task_id).toBe(a1.task_id);
    // A finding of another issue cannot be split off this one.
    const other = await issue(add, "union:cluster:z", "Something else");
    await expect(t.mutation(api.signals.splitForCli, {
      api_token: TOKEN, workspace: "personal", from: "union:cluster:a", move: [other.short_id],
      source: "agentwatch", kind: "bug", fingerprint: "union:cluster:d", title: "Another split",
    })).rejects.toThrow(/not a finding of issue/);
  });

  test("split with nothing moved: both problems name each other in plain words, never the raw key (LL6)", async () => {
    const { add, t } = await setup();
    const a = await issue(add, "union:cluster:a", "Messages narrate effort");
    const split = await t.mutation(api.signals.splitForCli, {
      api_token: TOKEN, workspace: "personal", from: "union:cluster:a", move: [],
      source: "agentwatch", kind: "bug", fingerprint: "union:cluster:c", title: "Held call cards dial outside calling hours",
    });
    const notes = await t.run(async (ctx) => await ctx.db.query("task_comments").collect()) as any[];
    const [pa, pc] = [await byShort(t, a.task_short_id), await byShort(t, split.task_short_id)];
    const on = (id: string) => notes.filter((n) => n.task_id === id).map((n) => n.text).join("\n");
    expect(on(pc._id)).toContain(`split this off ${pa.short_id}`);
    expect(on(pa._id)).toContain(pc.short_id);
    expect(notes.some((n) => n.text.includes("union:cluster:"))).toBe(false);
  });

  test("move: an issue key never lands on another issue's problem, and carries its issue to a new one", async () => {
    const { add, t, task } = await setup();
    const a = await issue(add, "union:cluster:a", "Messages narrate effort");
    const b = await issue(add, "union:cluster:b", "Held call cards");
    const [pa, pb] = [await task(a.task_id), await task(b.task_id)];
    await expect(t.mutation(api.signals.moveForCli, { api_token: TOKEN, workspace: "personal", fingerprint: "union:cluster:a", from: pa.short_id, to: pb.short_id })).rejects.toThrow(/merge the two issues/);
    const moved = await t.mutation(api.signals.moveForCli, { api_token: TOKEN, workspace: "personal", fingerprint: "union:cluster:a", from: pa.short_id });
    expect((await byShort(t, moved.to)).cause.issue_key).toBe("union:cluster:a");
    expect((await task(a.task_id)).cause.issue_key).toBeUndefined();
    expect((await issue(add, "union:cluster:a", "Messages narrate effort")).task_id).not.toBe(a.task_id);
  });

  test("split: a finding named twice moves once, and a moved row no longer reads as merged elsewhere", async () => {
    const { add, t, task } = await setup();
    const a1 = await issue(add, "union:cluster:a", "Messages narrate effort");
    const a2 = await issue(add, "union:cluster:a", "Messages narrate effort");
    await t.run(async (ctx) => { await ctx.db.patch(a2.signal_id, { merged_into: "union:cluster:old" } as any); });
    const split = await t.mutation(api.signals.splitForCli, {
      api_token: TOKEN, workspace: "personal", from: "union:cluster:a", move: [a2.short_id, a2.short_id],
      source: "agentwatch", kind: "bug", fingerprint: "union:cluster:c", title: "Held call cards dial outside calling hours",
    });
    expect(split.moved).toBe(1);
    expect((await task(split.task_id)).cause.signal_count).toBe(2);
    expect((await task(a1.task_id)).cause.signal_count).toBe(1);
    const row = await t.run(async (ctx) => await ctx.db.get(a2.signal_id)) as any;
    expect(row.merged_into).toBeUndefined();
  });

  test("merge into a problem in watch: findings seen after its ship reopen it, older ones leave its outcome alone (LE12)", async () => {
    for (const late of [true, false]) {
      const { add, t, task } = await setup();
      const b = await issue(add, "union:cluster:b", "Messages talk about Union's work");
      const shipped = Date.now() - 60_000;
      await t.run(async (ctx) => { await ctx.db.patch(b.task_id, { status: "done", closed_at: shipped, watch_until: Date.now() + 7 * 86_400_000 } as any); });
      const a = await issue(add, "union:cluster:a", "Messages narrate effort", late ? {} : { observed_at: shipped - 3_600_000 });
      await t.mutation(api.signals.mergeForCli, { api_token: TOKEN, workspace: "personal", issue: "union:cluster:a", into: "union:cluster:b" });
      expect((await task(a.task_id)).status).toBe("dropped");
      const pb = await task(b.task_id);
      expect(pb.cause.signal_count).toBe(2);
      if (late) {
        expect(pb.status).toBe("open");
        expect(pb.watch_until).toBeUndefined();
      } else {
        expect(pb.status).toBe("done");
        expect(pb.watch_until).toBeGreaterThan(Date.now());
      }
    }
  });

  test("findings held under a key merged away join the problem its survivor opens: none is left behind", async () => {
    const { add, t, task } = await setup();
    // agentwatch converts nothing yet (LE4): its issues' findings are held.
    const held = (key: string) => issue(add, key, "Messages narrate effort", { source: "agentwatch" });
    expect((await held("union:cluster:a")).attach).toBe("held");
    await held("union:cluster:a");
    await held("union:cluster:b");
    await t.mutation(api.signals.mergeForCli, { api_token: TOKEN, workspace: "personal", issue: "union:cluster:a", into: "union:cluster:b" });
    await t.run(async (ctx) => {
      const p = (await ctx.db.query("projects").first())!;
      await ctx.db.patch(p._id, { line_profile: { ...p.line_profile!, finders: [...p.line_profile!.finders, { id: "aw", source: "agentwatch", kind: ["bug"], fingerprint: "<cluster>", opens_causes: true }] } } as any);
    });
    const opened = await held("union:cluster:b");
    expect(opened.attach).toBe("new");
    expect((await task(opened.task_id)).cause.signal_count).toBe(4);
    const rows = await t.run(async (ctx) => await ctx.db.query("signals").collect()) as any[];
    expect(rows.filter((r) => !r.task_id)).toHaveLength(0);
  });

  test("a finding keeps its judge, the judge's version, its severity and the link back to the product", async () => {
    const { add, t } = await setup();
    const out = await issue(add, "union:cluster:a", "Messages narrate effort", {
      judge: "comms", judge_version: "v7", severity: 8, subject: "ex-agent-quality-3",
      detail_md: "**Narrates effort** (severity 8/10)", evidence_url: "https://admin.example/agent-watch?cluster=a&finding=f-1",
    });
    const shown = await t.query(api.signals.showForCli, { api_token: TOKEN, signal: out.short_id });
    expect(shown.signal).toMatchObject({ judge: "comms", judge_version: "v7", severity: 8, subject: "ex-agent-quality-3", evidence_url: "https://admin.example/agent-watch?cluster=a&finding=f-1" });
    expect(shown.cause).toMatchObject({ issue_key: "union:cluster:a" });
  });
});

describe("signals in a project (line-profile.md LP1)", () => {
  const stub = judgeStub();
  beforeEach(() => stub.install());
  afterEach(() => stub.restore());

  async function withProjects() {
    const base = await setup();
    const project = (title: string, short_id: string, workspace = `user:${base.userId}`) =>
      base.t.run(async (ctx) => await ctx.db.insert("projects", { user_id: base.userId, workspace, title, short_id, status: "active", created_at: T0, updated_at: T0 } as any));
    const quality = await project("Agent Quality", "pj-1");
    const infra = await project("Infrastructure", "pj-2");
    const foreign = await project("Elsewhere", "pj-9", "team:someone-else");
    return { ...base, quality, infra, foreign };
  }

  test("a new cause is filed under the project the ref names, and the signal carries it", async () => {
    const { add, task, t, quality } = await withProjects();
    const out = await add({ fingerprint: "union:cluster:c1", title: "Agent repeats itself", project: "Agent Quality" });
    expect((await task(out.task_id)).project_id).toBe(quality);
    expect((await t.run(async (ctx) => await ctx.db.get(out.signal_id)))?.project_id).toBe(quality);
    const byShort = await add({ fingerprint: "union:cluster:c2", title: "Agent forgets the venue", project: "pj-1" });
    expect((await task(byShort.task_id)).project_id).toBe(quality);
  });

  test("fingerprint attach is workspace wide: the open cause takes the key wherever it is, and the signal records the project it was filed for", async () => {
    const { add, t, quality, infra } = await withProjects();
    const a = await add({ fingerprint: "union:cluster:c7", title: "Agent repeats itself", project: "Agent Quality" });
    const b = await add({ fingerprint: "union:cluster:c7", title: "Agent repeats itself", project: "Infrastructure" });
    expect(b).toMatchObject({ attach: "fingerprint", task_id: a.task_id });
    const row = await t.run(async (ctx) => await ctx.db.get(b.signal_id));
    expect(row?.project_id).toBe(quality);
    expect(row?.filed_for_project_id).toBe(infra);
    // The cause stays where it is.
    expect((await t.run(async (ctx) => await ctx.db.get(a.task_id)))?.project_id).toBe(quality);
    // Filed for the cause's own project, nothing extra is recorded.
    const same = await add({ fingerprint: "union:cluster:c7", title: "Agent repeats itself", project: "Agent Quality" });
    expect((await t.run(async (ctx) => await ctx.db.get(same.signal_id)))?.filed_for_project_id).toBeUndefined();
    const shown = await t.query(api.signals.listForCli, { api_token: TOKEN, workspace: "personal", task: a.task_short_id });
    expect(shown.signals.find((s: any) => s.short_id === b.short_id)?.filed_for_project_id).toBe(infra);
  });

  test("a fingerprint hit on a cause with no project keeps the signal in the project it was filed for", async () => {
    const { add, t, infra } = await withProjects();
    const a = await add({ fingerprint: "union:cluster:c8", title: "Agent repeats itself" });
    const b = await add({ fingerprint: "union:cluster:c8", title: "Agent repeats itself", project: "Infrastructure" });
    expect(b).toMatchObject({ attach: "fingerprint", task_id: a.task_id });
    const row = await t.run(async (ctx) => await ctx.db.get(b.signal_id));
    expect(row?.project_id).toBe(infra);
    expect(row?.filed_for_project_id).toBeUndefined();
  });

  test("without a project, attach is workspace wide and the signal takes its cause's project", async () => {
    const { add, t, quality } = await withProjects();
    const a = await add({ fingerprint: "k1", title: "Reply drafts in the wrong tone", project: "Agent Quality" });
    const b = await add({ fingerprint: "k1", title: "Reply drafts in the wrong tone" });
    expect(b).toMatchObject({ attach: "fingerprint", task_id: a.task_id });
    expect((await t.run(async (ctx) => await ctx.db.get(b.signal_id)))?.project_id).toBe(quality);
  });

  test("the judge only sees causes of the same project", async () => {
    const { add } = await withProjects();
    await add({ fingerprint: "e1", title: "Checkout throws on empty cart", subject: "web/checkout", project: "Infrastructure" });
    stub.state.calls.length = 0;
    const out = await add({ fingerprint: "e2", title: "Empty cart checkout crash", subject: "web/checkout", project: "Agent Quality" });
    expect(stub.state.calls).toHaveLength(0);
    expect(out.attach).toBe("new");
    await add({ fingerprint: "e3", title: "Empty cart checkout crash in Safari", subject: "web/checkout", project: "Agent Quality" });
    expect(stub.state.calls).toHaveLength(1);
    expect(stub.state.calls[0].messages[0].content).not.toContain("Checkout throws on empty cart");
  });

  test("a ref outside the write workspace, or ambiguous, is refused", async () => {
    const { add, t, userId } = await withProjects();
    await expect(add({ fingerprint: "x", title: "x", project: "Elsewhere" })).rejects.toThrow(/No project matching .*Elsewhere/);
    await t.run(async (ctx) => { await ctx.db.insert("projects", { user_id: userId, workspace: `user:${userId}`, title: "Infrastructure v2", short_id: "pj-3", status: "active", created_at: T0, updated_at: T0 } as any); });
    await expect(add({ fingerprint: "x", title: "x", project: "Infra" })).rejects.toThrow(/ambiguous/);
    // An exact title still wins over the longer one that contains it.
    expect((await add({ fingerprint: "y", title: "y", project: "Infrastructure" })).attach).toBe("new");
  });

  test("ls --project reads only that project's signals", async () => {
    const { add, t } = await withProjects();
    await add({ fingerprint: "a", title: "One", project: "Agent Quality" });
    await add({ fingerprint: "b", title: "Two", project: "Infrastructure" });
    await add({ fingerprint: "c", title: "Three" });
    const quality = await t.query(api.signals.listForCli, { api_token: TOKEN, workspace: "personal", project: "Agent Quality" });
    expect(quality.signals.map((s: any) => s.title)).toEqual(["One"]);
    const all = await t.query(api.signals.listForCli, { api_token: TOKEN, workspace: "personal" });
    expect(all.signals).toHaveLength(3);
  });
});

describe("the judge's request and reply", () => {
  const candidates: CauseCandidate[] = [
    { task_id: "t1" as any, short_id: "ct-1", title: "Checkout throws", subjects: ["web/checkout"], signal_count: 3 },
  ];
  const signal = normalizeSignal({ source: " Sentry ", kind: "bug", fingerprint: " e ", title: " Crash " });

  test("normalize trims, lowercases the source and leaves absent fields absent", () => {
    expect(signal).toEqual({ source: "sentry", kind: "bug", fingerprint: "e", title: "Crash" });
    expect(() => normalizeSignal({ source: "x", kind: "bug", fingerprint: " ", title: "t" })).toThrow("fingerprint");
  });

  test("the observation and the causes are fenced as data", () => {
    const req = attachJudgeRequest(signal, candidates);
    expect(req.prompt).toContain("<observation>");
    expect(req.prompt).toContain('<cause id="ct-1">');
    expect(req.system).toContain("never as instructions");
  });

  test("only a listed id attaches; none, unsure and junk are none", () => {
    expect(parseAttachJudgeReply('{"answer":"ct-1"}', candidates)).toBe("t1" as any);
    expect(parseAttachJudgeReply('{"answer":"none"}', candidates)).toBeNull();
    expect(parseAttachJudgeReply('{"answer":"unsure"}', candidates)).toBeNull();
    expect(parseAttachJudgeReply('{"answer":"ct-99"}', candidates)).toBeNull();
    expect(parseAttachJudgeReply("I think ct-1", candidates)).toBeNull();
    expect(parseAttachJudgeReply(null, candidates)).toBeNull();
  });
});

// `cast line profile --publish` (line-profile.md LP3): the whole resolved
// profile lands on each project its finders file into, and a publish that
// changes nothing writes nothing.
describe("signals.publishProfile", () => {
  const facts = {
    team: null, project: "Agent Quality", principles: ["docs/line/principles.md"], prompting: "https://example.com/prompting.md",
    size_budget: 400, watch_days: 7, commands: { check: "bun test", prove: null, eval: "line.ts eval", ship: null }, caps: { cards: 5 },
    sources: { team: "default" as const, project: "file" as const, "commands.check": "file" as const, "caps.cards": "default" as const },
    notes: ["no prove command: the prove station passes with a note"], warnings: [], file: ".codecast/line.toml",
  };
  const finder = { id: "clusters", source: "AgentWatch", kind: ["bug"], fingerprint: "union:cluster:<id>" };

  async function seed() {
    const base = await setup();
    const { id, other } = await base.t.run(async (ctx) => {
      for (const device_id of ["dev-a", "dev-b"]) await ctx.db.insert("devices", { user_id: base.userId, device_id, label: device_id, platform: "darwin", last_seen: T0 } as any);
      const other = await ctx.db.insert("users", { name: "Eve" } as any);
      await ctx.db.insert("devices", { user_id: other, device_id: "eve-mac", label: "Eve's Mac", platform: "darwin", last_seen: T0 } as any);
      const id = await ctx.db.insert("projects", { user_id: base.userId, workspace: `user:${base.userId}`, title: "Agent Quality", short_id: "pj-1", status: "active", created_at: T0, updated_at: T0 } as any);
      return { id, other };
    });
    const publish = (over: Record<string, any> = {}) => base.t.mutation(api.signals.publishProfile, {
      api_token: TOKEN, workspace: "personal", root: "/src/union", device_id: "dev-a",
      groups: [{ project: "Agent Quality", default: true, finders: [finder] }], profile: facts, ...over,
    } as any);
    const row = async () => (await base.t.run(async (ctx) => await ctx.db.get(id)) as any).line_profile;
    return { publish, row, userId: base.userId, other };
  }

  test("every resolved value, its sources, the file and the publishing device land on the row", async () => {
    const { publish, row, userId } = await seed();
    expect((await publish()).projects[0]).toMatchObject({ short_id: "pj-1", finders: 1, changed: true });
    const p = await row();
    expect(p).toMatchObject({ ...facts, default: true, root: "/src/union", device_id: "dev-a", publisher_user_id: String(userId), finders: [{ ...finder, source: "agentwatch" }] });
    expect(p.published_at).toBe(p.changed_at);
  });

  test("an identical publish writes nothing; a value change moves changed_at, a device change only published_at", async () => {
    const { publish, row } = await seed();
    await publish();
    const first = await row();
    expect((await publish()).projects[0].changed).toBe(false);
    expect(await row()).toEqual(first);

    await new Promise((r) => setTimeout(r, 5));
    expect((await publish({ device_id: "dev-b" })).projects[0].changed).toBe(true);
    const moved = await row();
    expect(moved).toMatchObject({ device_id: "dev-b", changed_at: first.changed_at });
    expect(moved.published_at).toBeGreaterThan(first.published_at);

    await new Promise((r) => setTimeout(r, 5));
    expect((await publish({ device_id: "dev-b", profile: { ...facts, watch_days: 14 } })).projects[0].changed).toBe(true);
    const edited = await row();
    expect(edited.watch_days).toBe(14);
    expect(edited.changed_at).toBeGreaterThan(first.changed_at);
  });

  test("a device that is not the caller's is not published: an edit is never routed to someone else's machine", async () => {
    const { publish, row } = await seed();
    await publish({ device_id: "eve-mac" });
    const p = await row();
    expect(p.root).toBe("/src/union");
    expect(p.device_id).toBeUndefined();
    expect(p.publisher_user_id).toBeUndefined();
  });

  test("the CLI route forwards the publisher's device_id (cliRoute strips it otherwise)", async () => {
    const http = (await import("node:fs")).readFileSync(`${import.meta.dir}/http.ts`, "utf-8");
    const at = http.indexOf('cliRoute("/cli/line/profile/publish"');
    expect(at).toBeGreaterThan(-1);
    expect(http.slice(at, at + 300)).toContain("{ forwardDeviceId: true }");
  });

  test("a project another profile's finders file into gets the finders, not that profile's values", async () => {
    const { publish, row } = await seed();
    await publish({ groups: [{ project: "Agent Quality", default: false, finders: [finder] }] });
    const p = await row();
    expect(p).toMatchObject({ default: false, root: "/src/union", finders: [{ ...finder, source: "agentwatch" }] });
    expect(p.commands).toBeUndefined();
    expect(p.watch_days).toBeUndefined();
  });

  test("a project with its own profile keeps it when a neighbour's finders name it", async () => {
    const { publish, row } = await seed();
    await publish();
    const own = await row();
    const out = await publish({ root: "/src/neighbour", groups: [{ project: "Agent Quality", default: false, finders: [] }], profile: { ...facts, watch_days: 30 } });
    expect(out.projects[0].changed).toBe(false);
    expect(await row()).toEqual(own);
  });

  test("a CLI that sends finders only still publishes them", async () => {
    const { publish, row } = await seed();
    await publish({ profile: undefined, device_id: undefined });
    const p = await row();
    expect(p.finders).toHaveLength(1);
    expect(p.watch_days).toBeUndefined();
    expect((await publish({ profile: undefined, device_id: undefined })).projects[0].changed).toBe(false);
  });
});

describe("a problem's description in plain words (LL6)", () => {
  const url = "https://admin.example.com/agent-watch?cluster=1";
  const today = causeDescription({ kind: "prompt_miss", source: "agentwatch", subject: "match", evidence_url: url, detail_md: "**Voicemail** after a scheduled call." });

  test("names no raw kind key and no expectation id", () => {
    expect(today).toBe(`Opened by a report that an agent got something wrong from agentwatch.\n\nAbout: match\n\nWhere it was seen: ${url}\n\n**Voicemail** after a scheduled call.`);
    expect(causeDescription({ kind: "bug", source: "sentry", subject: "ex-broker-private-2" })).toBe("Opened by a bug report from sentry.");
  });

  test("rewrites the first header, with its single newlines", () => {
    expect(rewriteCauseDescription(`Opened by a prompt_miss signal from agentwatch.\nSubject: match\nEvidence: ${url}\n\n**Voicemail** after a scheduled call.`)).toBe(today);
  });

  test("rewrites the second header, and drops Breaks <id>", () => {
    expect(rewriteCauseDescription(`Opened by a prompt miss finding from agentwatch.\n\nAbout: match\n\nWhere it was seen: ${url}\n\n**Voicemail** after a scheduled call.`)).toBe(today);
    expect(rewriteCauseDescription("Opened by a bug finding from sentry.\n\nBreaks ex-a-1.\n\nBody")).toBe("Opened by a bug report from sentry.\n\nBody");
  });

  test("leaves today's words and a person's own text alone", () => {
    expect(rewriteCauseDescription(today)).toBeNull();
    expect(rewriteCauseDescription("We should fix the header.")).toBeNull();
  });

  test("the backfill pages through signal problems and rewrites only old ones", async () => {
    const { t } = await setup();
    const ids = await t.run(async (ctx) => {
      const user = await ctx.db.insert("users", { name: "A" } as any);
      const base = { user_id: user, status: "open", priority: "medium", task_type: "task", blocks: [], attempt_count: 0, retry_count: 0, max_retries: 3, created_at: T0, updated_at: T0 } as any;
      const old = await ctx.db.insert("tasks", { ...base, short_id: "ct-1", title: "x", source: "signal", description: "Opened by a regression signal from union.eval.\nSubject: deskBroker\n\nRed." });
      const mine = await ctx.db.insert("tasks", { ...base, short_id: "ct-2", title: "y", source: "human", description: "Opened by a regression signal from union.eval." });
      return { old, mine };
    });
    const dry = await t.mutation(internal.signals.rewriteCauseDescriptions, { dry_run: true });
    expect(dry.rewritten).toBe(1);
    await t.mutation(internal.signals.rewriteCauseDescriptions, { dry_run: false });
    const after = await t.run(async (ctx) => [await ctx.db.get(ids.old), await ctx.db.get(ids.mine)]);
    expect(after[0]!.description).toBe("Opened by a regression from union.eval.\n\nAbout: deskBroker\n\nRed.");
    expect(after[1]!.description).toBe("Opened by a regression signal from union.eval.");
  });
});
