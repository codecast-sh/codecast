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
  "./syncOutbox.ts": () => import("./syncOutbox"),
    "./signals.ts": () => import("./signals"),
    "./notificationRouter.ts": () => import("./notificationRouter"),
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
    expect(quietNotes.some((c: any) => c.text.startsWith("Watch ended quiet: no new signal from"))).toBe(true);
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
