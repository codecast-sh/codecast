// Agent reviews end to end under convex-test (agentReviews.ts), with synthetic
// data only: a bulk start opens moments as of now, judging one queues its
// agent judge's review instead of calling a model, a machine leases it with
// both turns built from the kept body, renews and hands it back, and its
// findings file as signals under the judge. R2 and the model are stubbed at fetch.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { convexTest } from "convex-test";
import { gunzipSync, gzipSync, strFromU8, strToU8 } from "fflate";
import schema from "./schema";
import { api, internal } from "./_generated/api";
import { hashToken } from "./apiTokens";
import { allModules } from "./testModules.testkit";
import { AGENT_FINDINGS_TURN } from "@codecast/shared/contracts/agentJudges";

const TOKEN = "r".repeat(64);
const T0 = Date.now();
const R2 = { R2_ENDPOINT: "https://acct.r2.test", REPLAYS_R2_ACCESS_KEY_ID: "k", REPLAYS_R2_SECRET_ACCESS_KEY: "s" } as const;

const REVIEWER = {
  name: "review",
  path: ".codecast/judges/review.md",
  version: "c".repeat(40),
  moment: "conversation",
  model: "claude-opus-5-5",
  max_tokens: 2000,
  projects: ["Agent Quality"],
  mode: "live" as const,
  prompt: "Review {{SUBJECT}} ({{WHO}}) as of {{NOW}}.\n<c>\n{{MOMENT}}\n</c>",
  agent: { tools: ["Bash", "Read"], cwd: "app", max_turns: 50, timeout_ms: 20 * 60_000, claude_md: "Be plain." },
};

function stubs() {
  const realFetch = globalThis.fetch;
  const prev = Object.fromEntries(Object.keys(R2).map((k) => [k, process.env[k]]));
  const objects = new Map<string, Uint8Array>();
  return {
    objects,
    install() {
      Object.assign(process.env, R2);
      globalThis.fetch = (async (url: unknown, init: any) => {
        const u = String(url);
        if (u.startsWith(R2.R2_ENDPOINT)) {
          const key = decodeURIComponent(new URL(u).pathname.split("/").slice(2).join("/"));
          const method = init?.method ?? "GET";
          if (method === "PUT") { objects.set(key, new Uint8Array(init.body)); return new Response(null, { status: 200 }); }
          if (method === "HEAD") return new Response(null, { status: objects.has(key) ? 200 : 404 });
          const body = objects.get(key);
          return body ? new Response(body as any, { status: 200 }) : new Response(null, { status: 404 });
        }
        // No budget is set: nothing here may reach a model.
        throw new Error(`unexpected fetch to ${u}`);
      }) as unknown as typeof fetch;
    },
    restore() {
      globalThis.fetch = realFetch;
      for (const [k, val] of Object.entries(prev)) {
        if (val === undefined) delete process.env[k];
        else process.env[k] = val;
      }
    },
  };
}

async function setup() {
  const t = convexTest(schema, allModules);
  const ids = await t.run(async (ctx) => {
    const user = await ctx.db.insert("users", { name: "Ana" } as any);
    await ctx.db.insert("api_tokens", { user_id: user, token_hash: await hashToken(TOKEN), name: "cli", created_at: T0, last_used_at: T0 } as any);
    const team = await ctx.db.insert("teams", { name: "Product", created_at: T0, invite_code: "x" } as any);
    await ctx.db.insert("team_memberships", { user_id: user, team_id: team, role: "admin", joined_at: T0 } as any);
    for (const d of ["host-1", "host-2"]) await ctx.db.insert("devices", { user_id: user, device_id: d, label: d, platform: "darwin", last_seen: T0 } as any);
    const workspace = `team:${team}`;
    const project = await ctx.db.insert("projects", { user_id: user, team_id: team, workspace, short_id: "pr-1", title: "Agent Quality", status: "active", created_at: T0, updated_at: T0 } as any);
    const source = await ctx.db.insert("event_sources", { workspace, team_id: team, owner_user_id: user, project_id: project, short_id: "src-1", provider: "http", name: "app", promote: [], status: "active", config: { moment_storage: "codecast" }, created_at: T0, updated_at: T0 } as any);
    return { user, team, project, source, workspace };
  });
  const scope = { api_token: TOKEN, workspace: "team" as const, team_id: ids.team };
  await t.mutation(api.moments.publish, { ...scope, source: "app", device_id: "host-1", root: "/repo", extractors: [{ kind: "conversation", path: ".codecast/moments/conversation.ts", version: "b".repeat(40), quiet_ms: 5 * 60_000, timeout_ms: 30_000 }], judges: [REVIEWER] });
  const output = (subject: string) => JSON.stringify({ refs: [{ label: "contact", id: subject, table: "contacts", url: `https://app.example/c/${subject}` }], who: "Dana Reyes", blocks: [{ type: "message", direction: "in", channel: "email", at: T0 - 60_000, body: "Can we talk Tuesday?" }], review: `PAGE FOR ${subject}\n## Now\nIt is now Tuesday.` });
  const extract = async () => {
    const claims = await t.mutation(api.moments.claim, { api_token: TOKEN, device_id: "host-1", limit: 20 });
    return Promise.all(claims.map((c: any) => t.action(api.moments.complete, { api_token: TOKEN, device_id: "host-1", moment: c.moment, extractor_version: "b".repeat(40), output: output(c.input.subject) })));
  };
  return { t, ids, scope, extract };
}

const FINDINGS = JSON.stringify({ findings: [
  { what: "A promised introduction was never followed up. Dana was told on Monday someone would write.", evidence: [{ quote: "Can we talk Tuesday?", message: "m_1", run: "r_1" }], hurt: "Dana waited", severity: 7, layer: "both", cause: "The follow-up job skips threads with no match.", cause_checked: true },
  { what: "A reply went out in the wrong language. Dana writes in Spanish.", evidence: [], hurt: "Dana", severity: 5, layer: "conversation", cause: "", cause_checked: false },
] });
/** A settled review files in a scheduled action: let it start, then wait for it. */
const filing = async (t: { finishInProgressScheduledFunctions: () => Promise<void> }) => {
  await new Promise((done) => setTimeout(done, 20));
  await t.finishInProgressScheduledFunctions();
};
const transcriptGz = (review: string) => btoa(String.fromCharCode(...gzipSync(strToU8(JSON.stringify({ review, moment: "mo-1", judge: "review", model: "m", turns: [[{ kind: "text", text: "Looked." }]] })))));

describe("agent reviews", () => {
  const s = stubs();
  beforeEach(() => s.install());
  afterEach(() => s.restore());

  test("a bulk start queues one review per subject, which a machine leases with both turns, and files what it found", async () => {
    const { t, ids, scope, extract } = await setup();
    const started = await t.mutation(api.agentReviews.startForCli, { ...scope, source: "app", kind: "conversation", subjects: ["c_1", "c_2", "c_1"], batch: "b1" });
    expect(started).toMatchObject({ subjects: 2, opened: 2 });
    // Due at once: a bulk start waits out no quiet window.
    const judged = await extract();
    expect(judged.map((j: any) => j.judged)).toEqual([[{ judge: "review", status: "queued", findings: 0, filed: 0, reason: expect.stringMatching(/^rv-\d+$/), cost_usd: 0 }], [expect.objectContaining({ status: "queued" })]]);
    expect(await t.run((ctx) => ctx.db.query("judge_runs").collect())).toEqual([]);

    // Another machine of the same person may lease them; both turns come built from the kept body.
    const claimed = await t.action(api.agentReviews.claimForCli, { api_token: TOKEN, device_id: "host-2", slots: 5 });
    expect(claimed.map((c) => c.subject).sort()).toEqual(["c_1", "c_2"]);
    const a = claimed.find((c) => c.subject === "c_1")!;
    expect(a).toMatchObject({ subject: "c_1", source: "app", judge: { name: "review", model: "claude-opus-5-5", root: "/repo", agent: REVIEWER.agent } });
    expect(a.turns[0]).toMatch(/^Review c_1 \(Dana Reyes\) as of \d{4}-\d\d-\d\d \d\d:\d\d UTC\.\n<c>\nPAGE FOR c_1\n## Now\nIt is now Tuesday\.\n<\/c>$/);
    expect(a.turns[1]).toBe(AGENT_FINDINGS_TURN);
    expect(await t.action(api.agentReviews.claimForCli, { api_token: TOKEN, device_id: "host-2", slots: 5 })).toEqual([]);

    // Only the machine running it hands it back.
    await expect(t.action(api.agentReviews.doneForCli, { api_token: TOKEN, device_id: "host-1", review: a.review, ok: true, findings_text: FINDINGS })).rejects.toThrow("not running on this machine");
    const done = await t.action(api.agentReviews.doneForCli, { api_token: TOKEN, device_id: "host-2", review: a.review, ok: true, findings_text: FINDINGS, transcript_gz: transcriptGz(a.review), account: "p1", took_ms: 300_000, turns: 30, usage: { input: 10, output: 20, cache_read: 30, cache_write: 40 }, notional_usd: 2.5 });
    expect(done).toEqual({ review: a.review, status: "done", findings: 2 });
    // A hand back sent again (its request timed out while the first was still filing) files nothing twice.
    expect(await t.action(api.agentReviews.doneForCli, { api_token: TOKEN, device_id: "host-2", review: a.review, ok: true, findings_text: FINDINGS }).catch((e: Error) => e.message)).toContain("not running on this machine");
    await filing(t);
    const signals = await t.run((ctx) => ctx.db.query("signals").collect());
    expect(signals.map((x) => [x.source, x.subject, x.kind, x.severity, x.judge, x.moment])).toEqual([["judge:review", "review", "prompt_miss", 7, "review", a.moment], ["judge:review", "review", "prompt_miss", 5, "review", a.moment]]);
    expect(signals[0]!.project_id).toBe(ids.project);
    expect(signals[0]!.evidence_url).toBe("https://app.example/c/c_1");
    const [run] = await t.run((ctx) => ctx.db.query("judge_runs").collect());
    expect(run).toMatchObject({ status: "ok", findings: 2, backend: "subscription", cost_usd: 0, expectations: [] });
    expect(JSON.parse(run!.findings_json!)[0]).toMatchObject({ expectation: "review", what_happened: expect.stringContaining("introduction"), quote: "Can we talk Tuesday?", cause_checked: true });
    const row = await t.run(async (ctx) => (await ctx.db.query("agent_reviews").collect()).find((r) => r.short_id === a.review)!);
    expect(row).toMatchObject({ status: "done", batch: "b1", account: "p1", took_ms: 300_000, notional_usd: 2.5, findings: 2, filed: 2, run_id: run!._id });
    // The transcript sits beside the moment's body, and reads back whole.
    expect(row.transcript_key).toStartWith(`moments-30d/${ids.source}/reviews/${a.review}-`);
    expect(JSON.parse(strFromU8(gunzipSync(s.objects.get(row.transcript_key!)!))).turns[0][0].text).toBe("Looked.");
    const shown = await t.action(api.agentReviews.transcriptForCli, { ...scope, review: a.moment });
    expect(shown.transcript?.review).toBe(a.review);

    const status = await t.query(api.agentReviews.statusForCli, { ...scope, source: "app", batch: "b1" });
    expect(status.counts).toEqual({ queued: 0, running: 1, done: 1, failed: 0, cancelled: 0 });
    expect(status.averages).toMatchObject({ of: 1, took_ms: 300_000, notional_usd: 2.5, findings: 2 });
  }, 120_000);

  test("a session cut off by a limit queues again without spending a try; one that keeps failing fails, and a lapsed lease goes back", async () => {
    const { t, scope, extract } = await setup();
    await t.mutation(api.agentReviews.startForCli, { ...scope, source: "app", kind: "conversation", subjects: ["c_1"] });
    await extract();
    const lease = async () => (await t.action(api.agentReviews.claimForCli, { api_token: TOKEN, device_id: "host-1", slots: 1 }))[0];
    const back = (review: string, o: Record<string, unknown>) => t.action(api.agentReviews.doneForCli, { api_token: TOKEN, device_id: "host-1", review, ok: false, ...o });
    const r = await lease();
    expect(await back(r.review, { error: "usage limit reached", retry: true })).toMatchObject({ status: "queued" });
    expect((await t.run(async (ctx) => (await ctx.db.query("agent_reviews").collect())[0]!)).attempts).toBe(0);
    for (const n of [1, 2]) expect(await back((await lease()).review, { error: `crash ${n}` })).toMatchObject({ status: "queued" });
    expect(await back((await lease()).review, { error: "crash 3" })).toMatchObject({ status: "failed", error: "crash 3" });
    expect(await t.run((ctx) => ctx.db.query("judge_runs").collect())).toMatchObject([{ status: "failed", reason: "crash 3" }]);

    // Retry gives it fresh tries; a lease nobody renews goes back to the queue at the next claim.
    expect(await t.mutation(api.agentReviews.retryForCli, { ...scope, source: "app" })).toMatchObject({ queued: 1 });
    const again = await lease();
    expect(await t.mutation(api.agentReviews.renewForCli, { api_token: TOKEN, device_id: "host-1", reviews: [again.review, "rv-999"] })).toEqual({ lost: ["rv-999"] });
    await t.run(async (ctx) => { const row = (await ctx.db.query("agent_reviews").collect())[0]!; await ctx.db.patch(row._id, { lease_until: Date.now() - 1 }); });
    expect((await lease()).review).toBe(again.review);
    expect(await t.mutation(api.agentReviews.renewForCli, { api_token: TOKEN, device_id: "host-2", reviews: [again.review] })).toEqual({ lost: [again.review] });
  }, 120_000);

  test("a review of a moment read again replaces what the earlier one filed; cancel stops what waits", async () => {
    const { t, scope, extract } = await setup();
    await t.mutation(api.agentReviews.startForCli, { ...scope, source: "app", kind: "conversation", subjects: ["c_1"] });
    await extract();
    const first = (await t.action(api.agentReviews.claimForCli, { api_token: TOKEN, device_id: "host-1", slots: 1 }))[0];
    await t.action(api.agentReviews.doneForCli, { api_token: TOKEN, device_id: "host-1", review: first.review, ok: true, findings_text: FINDINGS });
    await filing(t);
    await t.mutation(internal.agentReviews.enqueue, { moment_id: (await t.run(async (ctx) => (await ctx.db.query("moments").collect())[0]!._id)), judge_id: (await t.run(async (ctx) => (await ctx.db.query("judges").collect())[0]!._id)) });
    const second = (await t.action(api.agentReviews.claimForCli, { api_token: TOKEN, device_id: "host-1", slots: 1 }))[0];
    const one = JSON.stringify({ findings: [JSON.parse(FINDINGS).findings[0]] });
    expect(await t.action(api.agentReviews.doneForCli, { api_token: TOKEN, device_id: "host-1", review: second.review, ok: true, findings_text: one })).toMatchObject({ status: "done", findings: 1 });
    await filing(t);
    const signals = await t.run((ctx) => ctx.db.query("signals").collect());
    // The same words on the same moment are the same finding; the one not found again leaves.
    expect(signals.filter((x) => !x.retired)).toHaveLength(1);
    expect(signals.find((x) => x.retired)?.retired?.reason).toBe(`replaced by ${second.review}, a newer review of the same moment`);

    await t.mutation(api.agentReviews.startForCli, { ...scope, source: "app", kind: "conversation", subjects: ["c_2", "c_3"], batch: "b2" });
    await extract();
    expect(await t.mutation(api.agentReviews.cancelForCli, { ...scope, source: "app", batch: "b2" })).toEqual({ cancelled: 2, left: false });
    expect(await t.action(api.agentReviews.claimForCli, { api_token: TOKEN, device_id: "host-1", slots: 5 })).toEqual([]);
  }, 120_000);

  test("findings held while no profile let the judge open problems are filed again once one does, each opening its problem", async () => {
    const { t, ids, scope, extract } = await setup();
    await t.mutation(api.agentReviews.startForCli, { ...scope, source: "app", kind: "conversation", subjects: ["c_1"] });
    await extract();
    const r = (await t.action(api.agentReviews.claimForCli, { api_token: TOKEN, device_id: "host-1", slots: 1 }))[0];
    await t.action(api.agentReviews.doneForCli, { api_token: TOKEN, device_id: "host-1", review: r.review, ok: true, findings_text: FINDINGS });
    await filing(t);
    expect((await t.run((ctx) => ctx.db.query("signals").collect())).map((x) => [x.attach, x.task_id])).toEqual([["held", undefined], ["held", undefined]]);
    await t.run((ctx) => ctx.db.patch(ids.project, { line_profile: { finders: [{ id: "review", source: "judge:review", kind: ["prompt_miss", "bug"], fingerprint: "agent:<contact>", opens_causes: true }], changed_at: T0 } } as any));
    const out = await t.action(internal.agentReviews.refileHeld, { workspace: ids.workspace, judge: "review" });
    expect(out).toMatchObject({ refiled: 2, left: false });
    expect(out.tasks).toHaveLength(2);
    const rows = await t.run((ctx) => ctx.db.query("signals").collect());
    expect(rows.filter((x) => x.retired).map((x) => x.retired!.reason)).toEqual(["filed again once judge:review could open problems", "filed again once judge:review could open problems"]);
    const live = rows.filter((x) => !x.retired);
    expect(live.map((x) => x.attach)).toEqual(["new", "new"]);
    const [run] = await t.run((ctx) => ctx.db.query("judge_runs").collect());
    expect([...run!.signal_ids!].sort()).toEqual(live.map((x) => x._id).sort());
  }, 120_000);

  test("an agent judge is refused on a source that keeps its moments on the host, and a bulk start needs one", async () => {
    const { t, scope } = await setup();
    await t.mutation(api.ingest.updateSource, { ...scope, source: "app", config: { moment_storage: "host" } });
    const r = await t.mutation(api.moments.publish, { ...scope, source: "app", device_id: "host-1", root: "/repo", extractors: [{ kind: "conversation", path: ".codecast/moments/conversation.ts", version: "b".repeat(40), quiet_ms: 0, timeout_ms: 30_000 }], judges: [REVIEWER] });
    expect(r.problems).toEqual([expect.stringContaining("an agent judge reads moments kept in codecast")]);
    await t.mutation(api.moments.publish, { ...scope, source: "app", device_id: "host-1", root: "/repo", extractors: [{ kind: "conversation", path: ".codecast/moments/conversation.ts", version: "b".repeat(40), quiet_ms: 0, timeout_ms: 30_000 }], judges: [] });
    await expect(t.mutation(api.agentReviews.startForCli, { ...scope, source: "app", kind: "conversation", subjects: ["c_1"] })).rejects.toThrow("no agent judge");
  }, 120_000);
});
