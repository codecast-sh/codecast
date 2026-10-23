// The scheduled scoring pass (problemScores.tick) end to end under
// convex-test, with the Batch API stubbed at fetch and synthetic data only:
// it sends the unscored problems as one batch, sends nothing while that batch
// is in flight, writes the scores when it ends and then places their labels in
// a family; six hours on, a problem with a finding newer than its score goes
// out again, and the daily cap limits how many go.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { convexTest } from "convex-test";
import schema from "./schema";
import { internal } from "./_generated/api";
import { allModules } from "./testModules.testkit";

const T0 = Date.now() - 60_000;
const FAMILIES = [{ key: "fam-a", name: "Family A", covers: "Everything here." }];

function batchApi() {
  const realFetch = globalThis.fetch;
  const prevKey = process.env.ANTHROPIC_API_KEY;
  const batches = new Map<string, { requests: Array<{ custom_id: string; params: any }>; ended: boolean }>();
  const answer = (r: { custom_id: string; params: any }) => {
    const text = r.custom_id.startsWith("assign-")
      ? JSON.stringify({ assignments: Array.from({ length: 10 }, (_, i) => ({ n: i + 1, key: "fam-a" })) })
      : JSON.stringify({ harm: 3, reach: 2, fixability: 4, score: 61, reason: "Clear cause.", root_cause: `cause of ${r.custom_id}` });
    return { custom_id: r.custom_id, result: { type: "succeeded", message: { content: [{ type: "text", text }], stop_reason: "end_turn", usage: { input_tokens: 1_000, output_tokens: 200 } } } };
  };
  return {
    batches,
    endAll() { for (const b of batches.values()) b.ended = true; },
    install() {
      batches.clear();
      process.env.ANTHROPIC_API_KEY = "test-key";
      globalThis.fetch = (async (url: unknown, init: any) => {
        const u = String(url);
        if (u === "https://api.anthropic.com/v1/messages/batches" && init?.method === "POST") {
          const id = `msgbatch_${batches.size + 1}`;
          batches.set(id, { requests: JSON.parse(init.body).requests, ended: false });
          return Response.json({ id, processing_status: "in_progress" });
        }
        const read = u.match(/\/v1\/messages\/batches\/([^/]+)$/);
        if (read) {
          const b = batches.get(read[1]!)!;
          return Response.json({ id: read[1], processing_status: b.ended ? "ended" : "in_progress", results_url: b.ended ? `https://results.test/${read[1]}` : null });
        }
        const results = u.match(/^https:\/\/results\.test\/(.+)$/);
        if (results) return new Response(batches.get(results[1]!)!.requests.map((r) => JSON.stringify(answer(r))).join("\n"));
        throw new Error(`unexpected fetch to ${u}`);
      }) as unknown as typeof fetch;
    },
    restore() {
      globalThis.fetch = realFetch;
      if (prevKey === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = prevKey;
    },
  };
}

async function setup(problems = 2) {
  const t = convexTest(schema, allModules);
  const ids = await t.run(async (ctx) => {
    const user = await ctx.db.insert("users", { name: "Ana" } as any);
    const ws = `user:${user}`;
    const project = await ctx.db.insert("projects", { user_id: user, workspace: ws, short_id: "pr-1", title: "Quality", status: "active", created_at: T0, updated_at: T0 } as any);
    const tasks = [];
    for (let i = 1; i <= problems; i++) {
      const short = `ct-${i}`;
      const task = await ctx.db.insert("tasks", {
        user_id: user, workspace: ws, short_id: short, title: `Problem ${short}`, status: "open", priority: "medium", blocks: [], source: "signal", project_id: project,
        cause: { signal_count: 1, first_seen: T0, last_seen: T0, fingerprints: [`k:${short}`] }, attempt_count: 0, retry_count: 0, max_retries: 3, created_at: T0 + i, updated_at: T0,
      } as any);
      tasks.push(task);
    }
    return { user, ws, project, tasks };
  });
  const finding = (n: number, task: any, at: number) => t.run((ctx) => ctx.db.insert("signals", {
    user_id: ids.user, workspace: ids.ws, short_id: `sg-${n}`, source: "judge:review", subject: "review", kind: "prompt_miss", fingerprint: `k:${n}`, title: `Finding ${n}`,
    detail_md: `What went wrong, ${n}.`, severity: 6, observed_at: at, created_at: at, task_id: task, project_id: ids.project, attach: "judge",
  } as any));
  for (const [i, task] of ids.tasks.entries()) await finding(i + 1, task, T0);
  await t.action(internal.problemScores.configure, { workspace: ids.ws, judge: "review", families: FAMILIES });
  const scored = () => t.run(async (ctx) => Promise.all(ids.tasks.map(async (id) => (await ctx.db.get(id))!)));
  const editState = (f: (s: any) => void) => t.run(async (ctx) => {
    const row = (await ctx.db.query("system_config").collect()).find((r) => r.key === `problem_scores:${ids.ws}:review`)!;
    const s = JSON.parse(row.value);
    f(s);
    await ctx.db.patch(row._id, { value: JSON.stringify(s) });
  });
  return { t, ids, finding, scored, editState };
}

describe("scheduled problem scoring", () => {
  const api = batchApi();
  beforeEach(() => api.install());
  afterEach(() => api.restore());

  test("sends the unscored problems once, writes the scores when the batch ends, places them in a family, and rescores a problem with a newer finding", async () => {
    const { t, ids, finding, scored, editState } = await setup();
    const tick = async () => (await t.action(internal.problemScores.tick, {}))[0] as any;

    expect(await t.action(internal.problemScores.tick, { dry: true })).toEqual([{ workspace: ids.ws, judge: "review", due: 2, would_send: 2, spent_today: 0 }]);
    expect(api.batches.size).toBe(0);

    expect(await tick()).toMatchObject({ due: 2, sent: 2, batch_id: "msgbatch_1" });
    expect(api.batches.get("msgbatch_1")!.requests.map((r) => r.custom_id).sort()).toEqual(ids.tasks.map(String).sort());
    expect(api.batches.get("msgbatch_1")!.requests[0]!.params.model).toBe("claude-sonnet-5-5");

    // In flight: nothing more is sent, so no problem is paid for twice.
    expect(await tick()).toMatchObject({ waiting: "msgbatch_1" });
    expect(api.batches.size).toBe(1);

    api.endAll();
    expect(await tick()).toMatchObject({ kind: "score", written: 2, failed: 0, next: "msgbatch_2" });
    let rows = await scored();
    expect(rows.map((r) => r.cause!.scored!.score)).toEqual([61, 61]);
    expect(rows.map((r) => [r.status, r.priority])).toEqual([["open", "medium"], ["open", "medium"]]);
    expect(rows[0]!.cause!.scored!.cluster_key).toBeUndefined();
    expect(api.batches.get("msgbatch_2")!.requests[0]!.params.model).toBe("claude-opus-5-5");
    expect(JSON.stringify(api.batches.get("msgbatch_2")!.requests[0]!.params)).toContain("Family A");

    api.endAll();
    expect(await tick()).toMatchObject({ kind: "assign", written: 2, placed_labels: 2, next: null });
    rows = await scored();
    expect(rows.map((r) => [r.cause!.scored!.cluster_key, r.cause!.scored!.cluster_name])).toEqual([["fam-a", "Family A"], ["fam-a", "Family A"]]);

    // Within six hours of the last send, nothing goes out, even with a new finding.
    await finding(9, ids.tasks[0], Date.now() + 1_000);
    expect(await tick()).toMatchObject({ next_send_at: expect.any(Number) });
    expect(api.batches.size).toBe(2);

    // Six hours on, only the problem with a finding newer than its score goes.
    await editState((s) => { s.last_submit_at -= 6 * 60 * 60_000 + 1; });
    expect(await tick()).toMatchObject({ due: 1, sent: 1, batch_id: "msgbatch_3" });
    expect(api.batches.get("msgbatch_3")!.requests.map((r) => r.custom_id)).toEqual([String(ids.tasks[0])]);
  });

  test("sends only as many problems as the daily cap still pays for", async () => {
    const { t, editState } = await setup(3);
    await editState((s) => { s.spend = [{ at: Date.now() - 60_000, usd: 1.995 }]; s.per_problem_usd = 0.002; });
    expect((await t.action(internal.problemScores.tick, {}))[0]).toMatchObject({ due: 3, sent: 2 });
    expect(api.batches.get("msgbatch_1")!.requests).toHaveLength(2);

    await editState((s) => { delete s.pending; s.last_submit_at = 0; s.spend = [{ at: Date.now(), usd: 2 }]; });
    expect((await t.action(internal.problemScores.tick, {}))[0]).toMatchObject({ due: 3, sent: 0, batch_id: null });
    expect(api.batches.size).toBe(1);
  });

  test("a score and a cluster written onto a team problem reach the team's sync log with the field in the cargo", async () => {
    const t = convexTest(schema, allModules);
    const { task, team } = await t.run(async (ctx) => {
      const user = await ctx.db.insert("users", { name: "Ana" } as any);
      const team = await ctx.db.insert("teams", { name: "P", created_at: T0, invite_code: "x" } as any);
      await ctx.db.insert("team_memberships", { user_id: user, team_id: team, role: "admin", joined_at: T0 } as any);
      const task = await ctx.db.insert("tasks", {
        user_id: user, team_id: team, workspace: `team:${team}`, short_id: "ct-1", title: "P", status: "open", priority: "medium", blocks: [], source: "signal",
        cause: { signal_count: 1, first_seen: T0, last_seen: T0, fingerprints: ["k:1"] }, attempt_count: 0, retry_count: 0, max_retries: 3, created_at: T0, updated_at: T0,
      } as any);
      return { task, team };
    });
    const settle = async () => { await new Promise((r) => setTimeout(r, 30)); await t.finishAllScheduledFunctions(() => {}); };
    const teamAction = async () => (await t.run((ctx) => ctx.db.query("sync_actions").collect())).find((a: any) => a.scope_key === `team:${team}` && a.entity_id === String(task)) as any;
    await settle();
    await t.mutation(internal.problemScores.record, { rows: [{ id: task, scored: { score: 50, harm: 1, reach: 1, fixability: 1, reason: "r", root_cause: "c", at: T0, version: "1" } }] });
    await settle();
    expect((await teamAction()).patch.cause.scored.score).toBe(50);
    await t.mutation(internal.problemScores.recordClusters, { rows: [{ id: task, key: "fam-a", name: "Family A" }] });
    await settle();
    expect((await teamAction()).patch.cause.scored).toMatchObject({ score: 50, cluster_key: "fam-a" });
  });
});
