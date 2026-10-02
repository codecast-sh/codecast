// The signal door (docs/architecture/the-line-end-to-end.md LE3, LE4, LE12),
// run through the real action, query and mutation under convex-test with the
// judge's model call stubbed at fetch: each attach path, the counters, and a
// cause in watch reopening.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { convexTest } from "convex-test";
import schema from "./schema";
import { api, internal } from "./_generated/api";
import { hashToken } from "./apiTokens";
import { attachJudgeRequest, normalizeSignal, parseAttachJudgeReply, type CauseCandidate } from "./signals";

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
    "./signals.ts": () => import("./signals"),
  });
  const userId = await t.run(async (ctx) => {
    const id = await ctx.db.insert("users", { name: "Finder" } as any);
    await ctx.db.insert("api_tokens", { user_id: id, token_hash: await hashToken(TOKEN), name: "cli", created_at: T0, last_used_at: T0 } as any);
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
    expect(a).toMatchObject({ status: "done", closed_at: shipAt });
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
