// Bringing moments end to end under convex-test (learning-loop.md LL7 to
// LL10), with synthetic data only: events coalesce into moments at the ingest
// door, a repo publishes its extractor and judge, the host claims and hands a
// moment back, the judge runs inside the team's budget, a live judge's
// findings file and group into problems by what happened. The model and the
// embedding are stubbed at fetch.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { convexTest } from "convex-test";
import schema from "./schema";
import { api, internal } from "./_generated/api";
import { hashToken } from "./apiTokens";
import { allModules } from "./testModules.testkit";
import { FINDING_VECTOR_DIMENSIONS } from "./momentsSchema";

const TOKEN = "m".repeat(64);
const T0 = Date.now();

/** A unit vector along one axis, mixed a little with another: cosine between two is easy to set. */
function vec(axis: number, lean = 0, toward = (axis + 1) % FINDING_VECTOR_DIMENSIONS): number[] {
  const v = new Array(FINDING_VECTOR_DIMENSIONS).fill(0);
  v[axis] = Math.sqrt(1 - lean * lean);
  v[toward] = lean;
  return v;
}

function stubs() {
  const realFetch = globalThis.fetch;
  const keys = { a: process.env.ANTHROPIC_API_KEY, o: process.env.OPENAI_API_KEY };
  const state = { judge: '{"deviations": []}', vectors: [] as number[][], model: [] as any[], embeds: [] as string[] };
  return {
    state,
    install() {
      process.env.ANTHROPIC_API_KEY = "test-key";
      process.env.OPENAI_API_KEY = "test-key";
      globalThis.fetch = (async (url: unknown, init: { body: string }) => {
        const body = JSON.parse(init.body);
        if (String(url).includes("api.openai.com")) {
          state.embeds.push(body.input);
          return new Response(JSON.stringify({ data: [{ embedding: state.vectors.shift() ?? vec(0) }], usage: { total_tokens: 20 } }));
        }
        state.model.push(body);
        const isAttach = String(body.system ?? "").includes("list of causes");
        return new Response(JSON.stringify({ content: [{ type: "text", text: isAttach ? '{"answer":"none"}' : state.judge }], stop_reason: "end_turn", usage: { input_tokens: 900, output_tokens: 120 } }));
      }) as unknown as typeof fetch;
    },
    restore() {
      globalThis.fetch = realFetch;
      for (const [k, env] of [["a", "ANTHROPIC_API_KEY"], ["o", "OPENAI_API_KEY"]] as const) {
        if (keys[k] === undefined) delete process.env[env];
        else process.env[env] = keys[k];
      }
    },
  };
}

const JUDGE = {
  name: "comms",
  path: ".codecast/judges/comms.md",
  version: "a".repeat(40),
  moment: "conversation",
  model: "claude-haiku-5-5",
  max_tokens: 800,
  projects: ["Agent Quality"],
  mode: "live" as const,
  prompt: "Read the conversation and say where the agent broke what we expect.",
};

async function setup() {
  const t = convexTest(schema, allModules);
  const ids = await t.run(async (ctx) => {
    const user = await ctx.db.insert("users", { name: "Ana" } as any);
    await ctx.db.insert("api_tokens", { user_id: user, token_hash: await hashToken(TOKEN), name: "cli", created_at: T0, last_used_at: T0 } as any);
    const team = await ctx.db.insert("teams", { name: "Product", created_at: T0, invite_code: "x" } as any);
    await ctx.db.insert("team_memberships", { user_id: user, team_id: team, role: "admin", joined_at: T0 } as any);
    await ctx.db.insert("devices", { user_id: user, device_id: "host-1", label: "Host", platform: "darwin", last_seen: T0 } as any);
    const workspace = `team:${team}`;
    const project = await ctx.db.insert("projects", {
      user_id: user, team_id: team, workspace, short_id: "pr-1", title: "Agent Quality", status: "active", created_at: T0, updated_at: T0,
      line_profile: { finders: [{ id: "comms", source: "judge:comms", kind: ["prompt_miss"], fingerprint: "moment:<id>:<expectation>", opens_causes: true }], changed_at: T0 },
    } as any);
    await ctx.db.insert("project_expectations", {
      project_id: project, user_id: user, workspace, version: 3, prefix: "aq", next_n: 3, summary: "v3", how: "person", created_at: T0,
      items: [
        { id: "ex-aq-1", text: "Reply to a broker within one business day.", part: "Replies", status: "active", citations: [], added_in: 1, changed_in: 1 },
        { id: "ex-aq-2", text: "Never promise a call time nobody owns.", part: "Replies", status: "retired", citations: [], added_in: 1, changed_in: 2, retired_reason: "x" },
      ],
    } as any);
    const source = await ctx.db.insert("event_sources", { workspace, team_id: team, owner_user_id: user, project_id: project, short_id: "src-1", provider: "http", name: "app", promote: [], status: "active", created_at: T0, updated_at: T0 } as any);
    return { user, team, project, source, workspace };
  });
  const scope = { api_token: TOKEN, workspace: "team" as const, team_id: ids.team };
  const post = (items: any[]) => t.mutation(internal.ingest.applyBatch, { source_id: ids.source, items_json: JSON.stringify(items) });
  const due = () => t.run(async (ctx) => { for (const m of await ctx.db.query("moments").collect()) if (m.status === "waiting") await ctx.db.patch(m._id, { due_at: Date.now() - 1 }); });
  const claim = () => t.mutation(api.moments.claim, { api_token: TOKEN, device_id: "host-1" });
  const output = (subject: string, body = "Can we talk Tuesday?") => JSON.stringify({ refs: [{ label: "thread", id: subject, url: `https://app.example/t/${subject}` }], blocks: [{ type: "message", direction: "in", channel: "sms", at: T0 - 60_000, sender: "Dana", body }] });
  const complete = (moment: string, subject: string) => t.action(api.moments.complete, { api_token: TOKEN, device_id: "host-1", moment, extractor_version: "b".repeat(40), output: output(subject) });
  return { t, ids, scope, post, due, claim, complete };
}

describe("moments", () => {
  const s = stubs();
  beforeEach(() => s.install());
  afterEach(() => s.restore());

  test("events coalesce per kind and subject, and only the publishing machine extracts them", async () => {
    const { t, ids, scope, post, due, claim } = await setup();
    await post([
      { type: "moment", kind: "conversation", subject: "t_1", at: T0 - 5_000, refs: { message: "m_1" } },
      { type: "moment", kind: "conversation", subject: "t_1", at: T0, refs: { message: "m_2" } },
      { type: "moment", kind: "conversation", subject: "t_2", at: T0 },
    ]);
    const rows = await t.run((ctx) => ctx.db.query("moments").collect());
    expect(rows.map((m) => [m.subject, m.events, m.status, m.storage, m.refs_json])).toEqual([
      ["t_1", 2, "waiting", "host", '{"message":"m_2"}'],
      ["t_2", 1, "waiting", "host", undefined],
    ]);
    expect(rows[0].due_at).toBeGreaterThan(Date.now() + 4 * 60_000);

    // Nothing is extracted until a repo publishes an extractor from a machine.
    await due();
    expect(await claim()).toEqual([]);
    const published = await t.mutation(api.moments.publish, { ...scope, source: "app", device_id: "host-1", root: "/repo", extractors: [{ kind: "conversation", path: ".codecast/moments/conversation.ts", version: "b".repeat(40), quiet_ms: 600_000, timeout_ms: 30_000 }], judges: [JUDGE] });
    expect(published).toMatchObject({ extractors: 1, judges: 1, storage: "host", problems: [] });
    await expect(t.mutation(api.moments.publish, { ...scope, source: "app", device_id: "someone-else", root: "/repo", extractors: [], judges: [] })).rejects.toThrow("signed in as you");

    const claims = await claim();
    expect(claims.map((c: any) => [c.moment, c.input.subject, c.input.events, c.input.refs, c.extractor.root])).toEqual([
      [rows[0].short_id, "t_1", 2, { message: "m_2" }, "/repo"],
      [rows[1].short_id, "t_2", 1, {}, "/repo"],
    ]);
    // A leased moment is not handed out twice; a new event opens the next moment.
    expect(await claim()).toEqual([]);
    await post([{ type: "moment", kind: "conversation", subject: "t_1", at: T0 + 1 }]);
    const t1 = (await t.run((ctx) => ctx.db.query("moments").collect())).filter((m) => m.subject === "t_1");
    expect(t1.map((m) => m.status)).toEqual(["extracting", "waiting"]);
    // The next event's quiet window is the published one.
    expect(t1[1].due_at).toBeGreaterThan(Date.now() + 9 * 60_000);
  }, 120_000);

  test("a judge waits on the budget, then reads the moment and files findings that group by what happened", async () => {
    const { t, ids, scope, post, due, claim, complete } = await setup();
    await t.mutation(api.moments.publish, { ...scope, source: "app", device_id: "host-1", root: "/repo", extractors: [{ kind: "conversation", path: ".codecast/moments/conversation.ts", version: "b".repeat(40), quiet_ms: 0, timeout_ms: 30_000 }], judges: [JUDGE] });
    await post(["t_1", "t_2", "t_3", "t_4"].map((subject) => ({ type: "moment", kind: "conversation", subject, at: T0 })));
    await due();
    const [c1, c2, c3, c4] = await t.mutation(api.moments.claim, { api_token: TOKEN, device_id: "host-1", limit: 10 });

    // No budget: the moment is kept (on the host) and the judge is skipped, counted.
    const first = await complete(c1.moment, "t_1");
    expect(first).toMatchObject({ status: "ready", storage: "host", judged: [{ judge: "comms", status: "skipped", findings: 0 }] });
    expect(s.state.model).toHaveLength(0);
    const off = await t.mutation(api.modelCalls.budgetForCli, scope);
    expect(off).toMatchObject({ cap_usd: 0, refused: 1 });
    const row = await t.run(async (ctx) => (await ctx.db.query("moments").collect())[0]);
    expect(row).toMatchObject({ status: "ready", blocks: 1, extractor_version: "b".repeat(40) });
    expect(row.body_key).toBeUndefined();

    await t.mutation(api.modelCalls.budgetForCli, { ...scope, set_usd: 5 });

    // The judge reads the clock, the active expectations at their version and the moment, and finds one break.
    s.state.judge = '{"deviations": [{"expectation": "ex-aq-1", "severity": 7, "what_happened": "The agent left the broker waiting two days for a reply.", "quote": "Can we talk Tuesday?", "markers": ["late reply"]}, {"expectation": "ex-aq-2", "what_happened": "retired line"}]}';
    s.state.vectors.push(vec(10));
    const second = await complete(c2.moment, "t_2");
    expect(second.judged).toMatchObject([{ judge: "comms", status: "ok", findings: 1, filed: 1 }]);
    const req = s.state.model[0];
    expect(req.model).toBe("claude-haiku-5-5");
    expect(req.max_tokens).toBe(800);
    expect(req.system.startsWith(JUDGE.prompt)).toBe(true);
    expect(req.messages[0].content).toContain('<expectations project="Agent Quality" version="3">');
    expect(req.messages[0].content).toContain("ex-aq-1: Reply to a broker within one business day.");
    expect(req.messages[0].content).not.toContain("Never promise a call time");
    expect(req.messages[0].content).toContain("[2026-");

    const signals = await t.run((ctx) => ctx.db.query("signals").collect());
    expect(signals).toHaveLength(1);
    expect(signals[0]).toMatchObject({ source: "judge:comms", subject: "ex-aq-1", judge: "comms", judge_version: JUDGE.version, severity: 7, moment: c2.moment, attach: "new", evidence_url: "https://app.example/t/t_2", project_id: ids.project, workspace: ids.workspace });
    const run = await t.run(async (ctx) => (await ctx.db.query("judge_runs").collect()).find((r) => r.status === "ok")!);
    expect(run).toMatchObject({ judge: "comms", mode: "live", findings: 1, uncited: 1, expectations: [{ project_id: ids.project, version: 3 }] });
    expect(run.signal_ids).toEqual([signals[0]._id]);

    // A finding that says the same thing in other words joins that problem without a question.
    s.state.judge = '{"deviations": [{"expectation": "ex-aq-1", "severity": 6, "what_happened": "Broker waited two days before the agent answered.", "quote": "x", "markers": []}]}';
    s.state.vectors.push(vec(10, 0.2));
    await complete(c3.moment, "t_3");
    // A finding about something else opens its own.
    s.state.vectors.push(vec(500));
    s.state.judge = '{"deviations": [{"expectation": "ex-aq-1", "severity": 3, "what_happened": "The agent replied to the wrong broker.", "quote": "x", "markers": []}]}';
    await complete(c4.moment, "t_4");
    const all = await t.run((ctx) => ctx.db.query("signals").collect());
    expect(all.map((sg) => sg.attach)).toEqual(["new", "similar", "new"]);
    expect(all[1].task_id).toBe(all[0].task_id);
    expect(all[2].task_id).not.toBe(all[0].task_id);
    expect(await t.run((ctx) => ctx.db.query("signal_vectors").collect())).toHaveLength(3);

    const budget = await t.mutation(api.modelCalls.budgetForCli, scope);
    expect(budget.spent_usd).toBeGreaterThan(0);
    expect(budget.held_usd).toBe(0);
    expect(budget.by_purpose.judge).toBeGreaterThan(budget.by_purpose.grouping);
    expect(budget.by_purpose.grouping).toBeGreaterThan(0);

    const shown = await t.query(api.moments.showForCli, { ...scope, moment: c2.moment });
    expect(shown.runs[0]).toMatchObject({ judge: "comms", status: "ok", filed: 1, findings: [{ expectation: "ex-aq-1", severity: 7 }] });
  }, 120_000);

  test("a shadow judge keeps its findings on its run and files nothing; a bad moment fails without a retry", async () => {
    const { t, scope, post, due, claim, complete } = await setup();
    await t.mutation(api.moments.publish, { ...scope, source: "app", device_id: "host-1", root: "/repo", extractors: [{ kind: "conversation", path: ".codecast/moments/conversation.ts", version: "b".repeat(40), quiet_ms: 0, timeout_ms: 30_000 }], judges: [{ ...JUDGE, mode: "shadow" }] });
    await t.mutation(api.modelCalls.budgetForCli, { ...scope, set_usd: 5 });
    await post([{ type: "moment", kind: "conversation", subject: "t_1", at: T0 }, { type: "moment", kind: "conversation", subject: "t_2", at: T0 }]);
    await due();
    const [c1, c2] = await claim();
    s.state.judge = '{"deviations": [{"expectation": "ex-aq-1", "severity": 5, "what_happened": "Late.", "quote": "x", "markers": []}]}';
    expect((await complete(c1.moment, "t_1")).judged).toMatchObject([{ status: "ok", findings: 1, filed: 0 }]);
    expect(await t.run((ctx) => ctx.db.query("signals").collect())).toHaveLength(0);

    const bad = await t.action(api.moments.complete, { api_token: TOKEN, device_id: "host-1", moment: c2.moment, extractor_version: "b".repeat(40), output: '{"blocks": [{"type": "photo"}]}' });
    expect(bad).toMatchObject({ status: "failed", error: expect.stringContaining("unknown type") });
  }, 120_000);

  test("codecast storage is the source's setting when the moment is read, and never falls back to the host", async () => {
    const { t, ids, scope, post, due, claim, complete } = await setup();
    const prev = { a: process.env.REPLAYS_R2_ACCESS_KEY_ID, e: process.env.R2_ENDPOINT };
    delete process.env.REPLAYS_R2_ACCESS_KEY_ID;
    try {
      await t.mutation(api.moments.publish, { ...scope, source: "app", device_id: "host-1", root: "/repo", extractors: [{ kind: "conversation", path: ".codecast/moments/conversation.ts", version: "b".repeat(40), quiet_ms: 0, timeout_ms: 30_000 }], judges: [] });
      await post([{ type: "moment", kind: "conversation", subject: "t_1", at: T0 }]);
      await t.mutation(api.ingest.updateSource, { ...scope, source: "app", config: { moment_storage: "codecast" } });
      await due();
      const [c] = await claim();
      expect(c.storage).toBe("codecast");
      // Without storage configured the moment waits for it rather than being kept anywhere else.
      expect(await complete(c.moment, "t_1")).toMatchObject({ status: "waiting", error: "storage is not configured" });
      const row = await t.run(async (ctx) => (await ctx.db.query("moments").collect())[0]);
      expect(row).toMatchObject({ status: "waiting", storage: "codecast" });
      expect(row.body_key).toBeUndefined();
      // Naming one setting keeps the others.
      const source = await t.run((ctx) => ctx.db.get(ids.source));
      expect(source?.config).toEqual({ moment_storage: "codecast" });
    } finally {
      if (prev.a !== undefined) process.env.REPLAYS_R2_ACCESS_KEY_ID = prev.a;
      if (prev.e !== undefined) process.env.R2_ENDPOINT = prev.e;
    }
  }, 120_000);

  test("a graph's call node runs on the budget and answers with its JSON and cost", async () => {
    const { t, scope } = await setup();
    const call = { ...scope, model: "claude-haiku-5-5", max_tokens: 100, prompt: "Is 2 even?", output: "json" as const };
    expect(await t.action(api.modelCalls.callForCli, call)).toMatchObject({ ok: false, reason: "budget" });
    await t.mutation(api.modelCalls.budgetForCli, { ...scope, set_usd: 1 });
    s.state.judge = '{"even": true}';
    const r = await t.action(api.modelCalls.callForCli, call);
    expect(r).toMatchObject({ ok: true, json: { even: true }, model: "claude-haiku-5-5" });
    expect(r.cost_usd).toBeGreaterThan(0);
    const budget = await t.mutation(api.modelCalls.budgetForCli, scope);
    expect(budget.by_purpose.call).toBeCloseTo(r.cost_usd, 8);
    expect(budget.refused).toBe(1);
  }, 120_000);
});
