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

  test("events coalesce by their own times, so a replay of history keeps apart what happened apart", async () => {
    const { t, post } = await setup();
    const hour = 3_600_000;
    // A day of one conversation sent in one batch, newest first: three moments
    // hours apart, the middle one a burst of two inside the quiet window.
    await post([
      { type: "moment", kind: "conversation", subject: "t_1", at: T0 - 1 * hour, refs: { as_of: "c" } },
      { type: "moment", kind: "conversation", subject: "t_1", at: T0 - 5 * hour, refs: { as_of: "b2" } },
      { type: "moment", kind: "conversation", subject: "t_1", at: T0 - 5 * hour - 120_000, refs: { as_of: "b1" } },
      { type: "moment", kind: "conversation", subject: "t_1", at: T0 - 9 * hour, refs: { as_of: "a" } },
    ]);
    const rows = (await t.run((ctx) => ctx.db.query("moments").collect())).sort((a, b) => a.event_at - b.event_at);
    expect(rows.map((m) => [m.events, m.event_at, m.refs_json])).toEqual([
      [1, T0 - 9 * hour, '{"as_of":"a"}'],
      [2, T0 - 5 * hour, '{"as_of":"b2"}'],
      [1, T0 - 1 * hour, '{"as_of":"c"}'],
    ]);
    // A later event inside the newest moment's window joins it, as live events do.
    await post([{ type: "moment", kind: "conversation", subject: "t_1", at: T0 - 1 * hour + 60_000, refs: { as_of: "c2" } }]);
    const newest = (await t.run((ctx) => ctx.db.query("moments").collect())).find((m) => m.first_event_at === T0 - 1 * hour)!;
    expect([newest.events, newest.refs_json]).toEqual([2, '{"as_of":"c2"}']);
  }, 120_000);

  test("a moment read as of its own time is judged at that time", async () => {
    const { t, scope, post, due, claim } = await setup();
    await t.mutation(api.moments.publish, { ...scope, source: "app", device_id: "host-1", root: "/repo", extractors: [{ kind: "conversation", path: ".codecast/moments/conversation.ts", version: "b".repeat(40), quiet_ms: 0, timeout_ms: 30_000 }], judges: [{ ...JUDGE, mode: "shadow" as const }] });
    await t.mutation(api.modelCalls.budgetForCli, { ...scope, set_usd: 5 });
    const then = T0 - 12 * 86_400_000;
    await post([{ type: "moment", kind: "conversation", subject: "t_1", at: then, refs: { as_of: new Date(then).toISOString() } }]);
    await due();
    const [c] = await claim();
    // The extractor read the conversation as of the event and says so in its at.
    const output = JSON.stringify({ at: then + 2_000, refs: [{ label: "thread", id: "t_1" }], blocks: [{ type: "message", direction: "in", channel: "sms", at: then - 60_000, sender: "Dana", body: "Can we talk Tuesday?" }] });
    await t.action(api.moments.complete, { api_token: TOKEN, device_id: "host-1", moment: c.moment, extractor_version: "b".repeat(40), output });
    const prompt: string = s.state.model[0].messages[0].content;
    expect(prompt).toContain(`Now: ${new Date(then + 2_000).toISOString()}.`);
    expect(prompt).not.toContain("12 days");
    const row = await t.run(async (ctx) => (await ctx.db.query("moments").collect())[0]);
    expect(row.gap_ms).toBe(2_000);
    s.state.model.length = 0;
  }, 120_000);

  test("a moment puts only what is new since the last judged moment under judgment, and the judge sees which entries those are", async () => {
    const { t, scope, post, due, claim } = await setup();
    await t.mutation(api.moments.publish, { ...scope, source: "app", device_id: "host-1", root: "/repo", extractors: [{ kind: "conversation", path: ".codecast/moments/conversation.ts", version: "b".repeat(40), quiet_ms: 300_000, timeout_ms: 30_000 }], judges: [{ ...JUDGE, mode: "shadow" as const }] });
    await t.mutation(api.modelCalls.budgetForCli, { ...scope, set_usd: 5 });
    const day = 86_400_000;
    const msg = (at: number, body: string) => ({ type: "message", direction: "out", channel: "email", at, sender: "Riley", body });
    await post([{ type: "moment", kind: "conversation", subject: "t_1", at: T0 - 2 * day }]);
    await due();
    const [first] = await claim();
    // The first moment of a subject reaches back only its quiet window before its first event.
    expect(first.input.window).toEqual({ from: T0 - 2 * day - 300_000, to: T0 - 2 * day });
    await t.action(api.moments.complete, { api_token: TOKEN, device_id: "host-1", moment: first.moment, extractor_version: "b".repeat(40), output: JSON.stringify({ refs: [], blocks: [msg(T0 - 30 * day, "An old pitch."), msg(T0 - 2 * day, "Monday's note.")] }) });
    await post([{ type: "moment", kind: "conversation", subject: "t_1", at: T0 }]);
    await due();
    const [second] = await claim();
    expect(second.input.window).toEqual({ from: T0 - 2 * day + 1, to: T0 });
    s.state.model.length = 0;
    await t.action(api.moments.complete, { api_token: TOKEN, device_id: "host-1", moment: second.moment, extractor_version: "b".repeat(40), output: JSON.stringify({ refs: [], blocks: [msg(T0 - 30 * day, "An old pitch."), msg(T0 - 2 * day, "Monday's note."), msg(T0 - 60_000, "Today's reply.")] }) });
    const prompt = JSON.stringify(s.state.model[0].messages);
    expect(prompt).toContain(`Under judgment: what happened from ${new Date(T0 - 2 * day + 1).toISOString().replace(/\.\d{3}Z$/, "Z")}`);
    expect(prompt).toMatch(/\[history\] out from Riley, email:\\n  Monday's note/);
    expect(prompt).toMatch(/\[NEW, under judgment\] out from Riley, email:\\n  Today's reply/);
    expect(JSON.stringify(s.state.model[0].system)).toContain("never report it");
    s.state.model.length = 0;
  }, 120_000);

  test("a moment judged again retires what the judge filed from it before and no longer finds, and an emptied problem closes", async () => {
    const { t, ids, scope, post, due, claim, complete } = await setup();
    await t.mutation(api.moments.publish, { ...scope, source: "app", device_id: "host-1", root: "/repo", extractors: [{ kind: "conversation", path: ".codecast/moments/conversation.ts", version: "b".repeat(40), quiet_ms: 0, timeout_ms: 30_000 }], judges: [JUDGE] });
    await t.mutation(api.modelCalls.budgetForCli, { ...scope, set_usd: 5 });
    await post([{ type: "moment", kind: "conversation", subject: "t_1", at: T0 }]);
    await due();
    const [c] = await claim();
    s.state.judge = '{"deviations": [{"expectation": "ex-aq-1", "severity": 7, "what_happened": "A broker waited two days for a reply.", "quote": "Can we talk Tuesday?", "markers": []}]}';
    s.state.vectors.push(vec(12));
    expect((await complete(c.moment, "t_1")).judged).toMatchObject([{ findings: 1, filed: 1 }]);
    const [finding] = await t.run((ctx) => ctx.db.query("signals").collect());
    expect(finding.task_id).toBeDefined();
    const m = await t.run(async (ctx) => (await ctx.db.query("moments").collect())[0]);

    // The run that filed it stands behind it.
    expect(finding.held_by).toEqual([m.short_id]);
    // Found again by the same version, unchanged: not filed again, but held (the run stands behind it).
    expect(await t.mutation(internal.judgeRetire.refound, { workspace: ids.workspace, judge: "comms", judge_version: finding.judge_version!, rows: [{ key: finding.fingerprint, title: finding.title }] })).toEqual({ live: [finding.fingerprint], updated: [], held: [finding._id] });
    const settle = (moment: { _id: any; short_id: string }, o: { held?: any[]; keep?: string[]; shown?: string[] }) =>
      t.mutation(internal.judgeRetire.settleRun, { moment_id: moment._id, moment: moment.short_id, judge: "comms", judge_version: "c".repeat(40), held: o.held ?? [], keep: o.keep ?? [], shown: o.shown ?? ["ex-aq-1"], before: Date.now() + 1, actor: ids.user });

    // A finding the new run finds again stays.
    expect((await settle(m, { keep: [finding.fingerprint] })).retired).toBe(0);
    // A run that was not shown the finding's expectation did not look for it, so it stays.
    expect((await settle(m, { shown: ["ex-aq-9"] })).retired).toBe(0);
    // A run that left the line out as not yet in force when the moment happened (judges.briefAt) let it go as history, on a problem a run is working.
    {
      const hist = await t.run(async (ctx) => {
        const { _id, _creationTime, ...row } = finding as any;
        const task = await ctx.db.get(finding.task_id!);
        const { _id: tid, _creationTime: tc, ...trow } = task as any;
        const busy = await ctx.db.insert("tasks", { ...trow, short_id: "ct-hist", status: "in_review", cause: { ...trow.cause, fingerprints: ["k:hist"] } });
        return await ctx.db.insert("signals", { ...row, short_id: "sg-hist", fingerprint: "k:hist", task_id: busy, held_by: [m.short_id] });
      });
      const run = (await t.run(async (ctx) => (await ctx.db.query("judge_runs").collect())[0]!));
      await t.run(async (ctx) => ctx.db.patch(run._id, { signal_ids: [...(run.signal_ids ?? []), hist] }));
      const r = await t.mutation(internal.judgeRetire.settleRun, { moment_id: m._id, moment: m.short_id, judge: "comms", judge_version: "c".repeat(40), held: [finding._id], keep: [finding.fingerprint], shown: [], later: ["ex-aq-1"], before: Date.now() + 1, actor: ids.user });
      expect(r.retired).toBe(1);
      const h = (await t.run((ctx) => ctx.db.get(hist)))!;
      expect(h.retired!.reason).toStartWith("from before its line was in force:");
      expect(h.task_id).toBeUndefined();
      await t.run(async (ctx) => ctx.db.patch(run._id, { signal_ids: run.signal_ids }));
    }
    // The same message shows in a second moment, whose newest run files it too.
    const m2 = await t.run(async (ctx) => {
      const run = (await ctx.db.query("judge_runs").collect())[0]!;
      const { _id, _creationTime, ...rest } = m as any;
      const id = await ctx.db.insert("moments", { ...rest, short_id: "mo-999", subject: "t_2" });
      const { _id: r, _creationTime: rc, ...runRest } = run as any;
      await ctx.db.insert("judge_runs", { ...runRest, moment_id: id, moment_short_id: "mo-999", signal_ids: [finding._id], at: Date.now() - 10 });
      return (await ctx.db.get(id))!;
    });
    await settle(m2, { held: [finding._id] });
    expect((await t.run((ctx) => ctx.db.get(finding._id)))!.held_by).toEqual([m.short_id, "mo-999"]);
    // The first moment lets it go: the second still files it, so it stays on its problem.
    expect((await settle(m, {})).retired).toBe(0);
    expect((await t.run((ctx) => ctx.db.get(finding._id)))!).toMatchObject({ held_by: ["mo-999"], task_id: finding.task_id });
    // The last moment lets it go: it leaves its problem, which closes.
    const gone = await settle(m2, {});
    expect(gone).toMatchObject({ retired: 1, problems: 1, closed: [expect.stringMatching(/^ct-/)] });
    const after = await t.run(async (ctx) => ({ signal: await ctx.db.get(finding._id), task: await ctx.db.get(finding.task_id!) }));
    expect(after.signal!.task_id).toBeUndefined();
    expect(after.signal!.retired).toMatchObject({ task_id: finding.task_id, judge_version: "c".repeat(40) });
    expect(after.task!.status).toBe("dropped");
    expect(after.task!.cause!.signal_count).toBe(0);
    // A retired key whose problem closed no longer counts as filed, so a later finding of the same words files again.
    const back = await t.mutation(internal.judgeRetire.refound, { workspace: ids.workspace, judge: "comms", judge_version: "c".repeat(40), rows: [{ key: finding.fingerprint, title: "x" }] });
    expect(back).toEqual({ live: [], updated: [], held: [] });
    s.state.model.length = 0;
  }, 120_000);

  test("a miss by the same judge on the same reading is a resample: a finding leaves only after 2 of 3 reads miss it, or at once when what it read changed", async () => {
    const { t, ids, scope, post, due, claim, complete } = await setup();
    await t.mutation(api.moments.publish, { ...scope, source: "app", device_id: "host-1", root: "/repo", extractors: [{ kind: "conversation", path: ".codecast/moments/conversation.ts", version: "b".repeat(40), quiet_ms: 0, timeout_ms: 30_000 }], judges: [JUDGE] });
    await t.mutation(api.modelCalls.budgetForCli, { ...scope, set_usd: 5 });
    await post([{ type: "moment", kind: "conversation", subject: "t_1", at: T0 }]);
    await due();
    const [c] = await claim();
    s.state.judge = '{"deviations": [{"expectation": "ex-aq-1", "severity": 7, "what_happened": "A broker waited two days for a reply.", "quote": "Can we talk Tuesday?", "markers": []}]}';
    s.state.vectors.push(vec(12));
    await complete(c.moment, "t_1");
    const [finding] = await t.run((ctx) => ctx.db.query("signals").collect());
    const m = await t.run(async (ctx) => (await ctx.db.query("moments").collect())[0]!);
    const [filing] = await t.run((ctx) => ctx.db.query("judge_runs").collect());
    // The run recorded what it read.
    const read = { ...filing!.inputs! };
    expect([typeof read.messages, typeof read.facts]).toEqual(["string", "string"]);
    const settle = (o: { inputs?: { messages: string; facts: string }; fresh?: string[] } = {}) =>
      t.mutation(internal.judgeRetire.settleRun, { moment_id: m._id, moment: m.short_id, judge: "comms", judge_version: finding.judge_version!, held: [], keep: [], shown: ["ex-aq-1"], inputs: o.inputs ?? read, ...(o.fresh ? { fresh: o.fresh } : {}), before: Date.now() + 1, actor: ids.user });
    const missed = () => t.run(async (ctx) => { const { _id, _creationTime, signal_ids, ...rest } = filing as any; await ctx.db.insert("judge_runs", { ...rest, findings: 0, at: Date.now() }); });
    const restore = () => t.run((ctx) => ctx.db.patch(finding._id, { retired: undefined, task_id: finding.task_id, held_by: [m.short_id] }));

    // One miss of the same version on the same messages, facts changed or not: a resample, the finding stays held.
    expect((await settle({ inputs: { ...read, facts: "other" } })).retired).toBe(0);
    expect((await t.run((ctx) => ctx.db.get(finding._id)))!).toMatchObject({ held_by: [m.short_id], task_id: finding.task_id });
    // That miss recorded, a second one makes 2 of the last 3: it leaves, saying so.
    await missed();
    expect((await settle()).retired).toBe(1);
    expect((await t.run((ctx) => ctx.db.get(finding._id)))!.retired!.reason).toContain("did not find it in 2 of its last 3 reads");

    // A re-read of other messages is the judge's answer on what it reads now: one miss lets it go.
    await t.run(async (ctx) => { for (const r of await ctx.db.query("judge_runs").collect()) if (r._id !== filing!._id) await ctx.db.delete(r._id); });
    await restore();
    expect((await settle({ inputs: { ...read, messages: "other" } })).retired).toBe(1);
    // So is a re-read scoped to the finding's line (`--lines`): its facts changed.
    await restore();
    expect((await settle({ fresh: ["ex-aq-1"] })).retired).toBe(1);
    expect((await t.run((ctx) => ctx.db.get(finding._id)))!.retired!.reason).toEndWith("which did not find it");
    s.state.model.length = 0;
  }, 120_000);

  test("a finding only a resample made waits: it files once 2 of the last 3 reads of the same messages make it, or at once when its line is the re-read's scope", async () => {
    const { t, scope, post, due, claim, complete } = await setup();
    await t.mutation(api.moments.publish, { ...scope, source: "app", device_id: "host-1", root: "/repo", extractors: [{ kind: "conversation", path: ".codecast/moments/conversation.ts", version: "b".repeat(40), quiet_ms: 0, timeout_ms: 30_000 }], judges: [JUDGE] });
    await t.mutation(api.modelCalls.budgetForCli, { ...scope, set_usd: 5 });
    await post([{ type: "moment", kind: "conversation", subject: "t_1", at: T0 }]);
    await due();
    const [c] = await claim();
    await t.run(async (ctx) => { const doc = (await ctx.db.query("project_expectations").collect())[0]!; await ctx.db.patch(doc._id, { items: doc.items.map((e: any) => (e.id === "ex-aq-2" ? { ...e, status: "active", retired_reason: undefined } : e)) }); });
    const says = (line: string) => `{"deviations": [{"expectation": "${line}", "severity": 7, "what_happened": "A broker waited two days for a reply.", "quote": "Can we talk Tuesday?", "markers": []}]}`;
    const reread = async (reply: string, lines?: string[]) => {
      await t.mutation(api.moments.retryForCli, { ...scope, moments: [c.moment], again: true, ...(lines ? { lines } : {}) });
      await due();
      const [again] = await claim();
      s.state.judge = reply;
      s.state.vectors.push(vec(12));
      return (await complete(again.moment, "t_1")).judged;
    };
    const live = async () => (await t.run((ctx) => ctx.db.query("signals").collect())).filter((x) => !x.retired).map((x) => x.subject).sort();
    // The first read is the judge's answer: it files.
    s.state.judge = says("ex-aq-1");
    s.state.vectors.push(vec(12));
    expect((await complete(c.moment, "t_1")).judged).toMatchObject([{ findings: 1, filed: 1 }]);
    // The same judge reads the same messages and files the same quote under another line: one sample. Nothing files, nothing leaves.
    expect(await reread(says("ex-aq-2"))).toMatchObject([{ findings: 1, filed: 0 }]);
    expect(await live()).toEqual(["ex-aq-1"]);
    // A second read makes it too: 2 of the last 3 found the new line and missed the old one, so they change places.
    expect(await reread(says("ex-aq-2"))).toMatchObject([{ findings: 1, filed: 1 }]);
    expect(await live()).toEqual(["ex-aq-2"]);
    // One read finds the retired line again: one find in three, so it is not revived.
    expect(await reread(says("ex-aq-1"))).toMatchObject([{ findings: 1, filed: 0 }]);
    expect(await live()).toEqual(["ex-aq-2"]);
    // A re-read scoped to that line (its facts changed) is the judge's first answer on them: it comes back at once.
    expect(await reread(says("ex-aq-1"), ["ex-aq-1"])).toMatchObject([{ findings: 1, filed: 1 }]);
    expect(await live()).toEqual(["ex-aq-1", "ex-aq-2"]);
    s.state.vectors.length = 0;
    s.state.model.length = 0;
  }, 120_000);

  test("a re-read scoped to some lines files and lets go only under them", async () => {
    const { t, scope, post, due, claim, complete } = await setup();
    await t.mutation(api.moments.publish, { ...scope, source: "app", device_id: "host-1", root: "/repo", extractors: [{ kind: "conversation", path: ".codecast/moments/conversation.ts", version: "b".repeat(40), quiet_ms: 0, timeout_ms: 30_000 }], judges: [JUDGE] });
    await t.mutation(api.modelCalls.budgetForCli, { ...scope, set_usd: 5 });
    await post([{ type: "moment", kind: "conversation", subject: "t_1", at: T0 }]);
    await due();
    const [c] = await claim();
    s.state.judge = '{"deviations": [{"expectation": "ex-aq-1", "severity": 7, "what_happened": "A broker waited two days for a reply.", "quote": "Can we talk Tuesday?", "markers": []}]}';
    s.state.vectors.push(vec(12));
    await complete(c.moment, "t_1");
    const [finding] = await t.run((ctx) => ctx.db.query("signals").collect());
    // Read again scoped to another line: the judge's miss of ex-aq-1 moves nothing.
    expect(await t.mutation(api.moments.retryForCli, { ...scope, moments: [c.moment], again: true, lines: ["ex-aq-9"] })).toEqual([{ moment: c.moment, status: "waiting", retried: true }]);
    await due();
    const [again] = await claim();
    s.state.judge = '{"deviations": []}';
    await complete(again.moment, "t_1");
    const after = (await t.run((ctx) => ctx.db.get(finding._id)))!;
    expect(after.retired).toBeUndefined();
    const runs = await t.run((ctx) => ctx.db.query("judge_runs").collect());
    expect(runs.at(-1)!.lines).toEqual(["ex-aq-9"]);
    // The scope was one reading's: the moment reads whole again.
    expect((await t.run(async (ctx) => (await ctx.db.query("moments").collect())[0]!)).rejudge_lines).toBeUndefined();
    s.state.model.length = 0;
  }, 120_000);

  test("moments ls counts the live findings an older extractor or judge made, and names their moments", async () => {
    const { t, scope, post, due, claim, complete } = await setup();
    const publish = (extractor: string, judge: string) => t.mutation(api.moments.publish, { ...scope, source: "app", device_id: "host-1", root: "/repo", extractors: [{ kind: "conversation", path: ".codecast/moments/conversation.ts", version: extractor, quiet_ms: 0, timeout_ms: 30_000 }], judges: [{ ...JUDGE, version: judge }] });
    await publish("b".repeat(40), "a".repeat(40));
    await t.mutation(api.modelCalls.budgetForCli, { ...scope, set_usd: 5 });
    await post([{ type: "moment", kind: "conversation", subject: "t_1", at: T0 }]);
    await due();
    const [c] = await claim();
    s.state.judge = '{"deviations": [{"expectation": "ex-aq-1", "severity": 7, "what_happened": "A broker waited two days for a reply.", "quote": "Can we talk Tuesday?", "markers": []}]}';
    s.state.vectors.push(vec(12));
    await complete(c.moment, "t_1");
    const freshness = async () => (await t.query(api.moments.listForCli, { ...scope, source: "app" })).findings;
    expect(await freshness()).toEqual([{ source: "app", live: 1, stale: 0, stale_judge: 0, stale_extractor: 0, stale_moments: [] }]);

    await publish("e".repeat(40), "a".repeat(40));
    expect(await freshness()).toEqual([{ source: "app", live: 1, stale: 1, stale_judge: 0, stale_extractor: 1, stale_moments: [c.moment] }]);
    await publish("e".repeat(40), "c".repeat(40));
    expect(await freshness()).toEqual([{ source: "app", live: 1, stale: 1, stale_judge: 1, stale_extractor: 1, stale_moments: [c.moment] }]);
    // A case against the judge, made from the finding, is the judge's defect and not counted as a finding.
    await t.run(async (ctx) => {
      const [f] = await ctx.db.query("signals").collect();
      const { _id, _creationTime, ...row } = f;
      await ctx.db.insert("signals", { ...row, short_id: "sg-case", fingerprint: "case:x", case_of: _id, task_id: undefined } as any);
    });
    expect((await freshness())[0]).toMatchObject({ live: 1, stale: 1 });
    // A retired finding is off the board and off the count.
    await t.run(async (ctx) => { for (const sg of await ctx.db.query("signals").collect()) await ctx.db.patch(sg._id, { retired: { at: T0, reason: "x" } }); });
    expect(await freshness()).toEqual([{ source: "app", live: 0, stale: 0, stale_judge: 0, stale_extractor: 0, stale_moments: [] }]);
    s.state.model.length = 0;
  }, 120_000);

  test("a newer version of a judge that finds a finding again gives it its words, keeps its problem, and brings back one it retired blind", async () => {
    const { t, ids, scope, post, due, claim, complete } = await setup();
    const publish = (version: string) => t.mutation(api.moments.publish, { ...scope, source: "app", device_id: "host-1", root: "/repo", extractors: [{ kind: "conversation", path: ".codecast/moments/conversation.ts", version: "b".repeat(40), quiet_ms: 0, timeout_ms: 30_000 }], judges: [{ ...JUDGE, version }] });
    await publish("a".repeat(40));
    await t.mutation(api.modelCalls.budgetForCli, { ...scope, set_usd: 5 });
    await post([{ type: "moment", kind: "conversation", subject: "t_1", at: T0 }]);
    await due();
    const [c1] = await claim();
    s.state.judge = '{"deviations": [{"expectation": "ex-aq-1", "severity": 7, "what_happened": "Dana waited two days for the broker. She asked on Monday.", "quote": "Can we talk Tuesday?", "markers": []}]}';
    s.state.vectors.push(vec(12));
    await complete(c1.moment, "t_1");
    const [old] = await t.run((ctx) => ctx.db.query("signals").collect());
    expect(old.title).toBe("Dana waited two days for the broker.");

    // The new version reads the conversation's next moment and finds the same words, written miss first.
    await publish("c".repeat(40));
    await post([{ type: "moment", kind: "conversation", subject: "t_1", at: T0 + 1000 }]);
    await due();
    const [c2] = await claim();
    s.state.judge = '{"deviations": [{"expectation": "ex-aq-1", "severity": 5, "what_happened": "The broker left a contact waiting past a business day. Dana asked on Monday.", "quote": "Can we talk Tuesday?", "markers": []}]}';
    s.state.vectors.push(vec(30));
    s.state.embeds.length = 0;
    expect((await complete(c2.moment, "t_1")).judged).toMatchObject([{ findings: 1, filed: 1 }]);
    const rows = await t.run((ctx) => ctx.db.query("signals").collect());
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ _id: old._id, task_id: old.task_id, title: "The broker left a contact waiting past a business day.", severity: 5, judge_version: "c".repeat(40) });
    // Its problem was titled by the old words and takes the new ones; grouping reads the new words.
    expect((await t.run((ctx) => ctx.db.get(old.task_id!)))!.title).toBe("The broker left a contact waiting past a business day.");
    expect(s.state.embeds).toEqual(["The broker left a contact waiting past a business day. Dana asked on Monday."]);
    const vectors = await t.run((ctx) => ctx.db.query("signal_vectors").collect());
    expect(vectors.map((v) => [v.signal_id, v.embedding.indexOf(1)])).toEqual([[old._id, 30]]);

    // Another judge's copy of the same words keeps its writer's.
    const other = await t.mutation(internal.judgeRetire.refound, { workspace: ids.workspace, judge: "match", judge_version: "d".repeat(40), rows: [{ key: old.fingerprint, title: "Other words." }] });
    expect(other).toEqual({ live: [old.fingerprint], updated: [], held: [] });

    // Retired by a run of this judge, while a sibling finding keeps the problem open: found again, it comes back.
    await t.run(async (ctx) => {
      const task = (await ctx.db.get(old.task_id!))!;
      await ctx.db.insert("signals", { user_id: ids.user, workspace: ids.workspace, team_id: ids.team, short_id: "sg-99", source: "judge:comms", kind: "prompt_miss", fingerprint: "evidence:x:ex-aq-1:00000000", title: "Sibling.", subject: "ex-aq-1", observed_at: T0, created_at: T0, task_id: task._id, attach: "similar", judge: "comms" } as any);
      await ctx.db.patch(old._id, { task_id: undefined, retired: { at: T0, reason: `judged again by comms ${"e".repeat(8)}, which did not find it`, task_id: task._id } });
    });
    const revived = await t.mutation(internal.judgeRetire.refound, { workspace: ids.workspace, judge: "comms", judge_version: "f".repeat(40), rows: [{ key: old.fingerprint, title: "Back." }] });
    expect(revived).toMatchObject({ live: [old.fingerprint], updated: [{ signal_id: old._id, revived: true }] });
    const after = await t.run(async (ctx) => ({ row: await ctx.db.get(old._id), task: await ctx.db.get(old.task_id!) }));
    expect(after.row).toMatchObject({ task_id: old.task_id, title: "Back.", judge_version: "f".repeat(40) });
    expect(after.row!.retired).toBeUndefined();
    expect(after.task!.cause!.signal_count).toBe(2);
    // Retired when a line closed its problem: found again, it stays that problem's history and files no fresh copy.
    await t.run(async (ctx) => await ctx.db.patch(old._id, { task_id: undefined, retired: { at: T0, reason: "closed with ct-1, from before its fix live 2026-10-06", task_id: old.task_id! } }));
    const history = await t.mutation(internal.judgeRetire.refound, { workspace: ids.workspace, judge: "comms", judge_version: "9".repeat(40), rows: [{ key: old.fingerprint, title: "Again." }] });
    expect(history).toEqual({ live: [old.fingerprint], updated: [], held: [] });
    expect((await t.run((ctx) => ctx.db.get(old._id)))!.retired).toBeDefined();
    s.state.model.length = 0;
  }, 120_000);

  test("the backfill gives a finding its moment's latest run's words for its key, and leaves one that run did not report", async () => {
    const { t, ids, scope, post, due, claim, complete } = await setup();
    await t.mutation(api.moments.publish, { ...scope, source: "app", device_id: "host-1", root: "/repo", extractors: [{ kind: "conversation", path: ".codecast/moments/conversation.ts", version: "b".repeat(40), quiet_ms: 0, timeout_ms: 30_000 }], judges: [JUDGE] });
    await t.mutation(api.modelCalls.budgetForCli, { ...scope, set_usd: 5 });
    await post([{ type: "moment", kind: "conversation", subject: "t_1", at: T0 }]);
    await due();
    const [c] = await claim();
    s.state.judge = '{"deviations": [{"expectation": "ex-aq-1", "severity": 7, "what_happened": "Dana waited two days. She asked Monday.", "quote": "Can we talk Tuesday?", "markers": []}]}';
    s.state.vectors.push(vec(12));
    await complete(c.moment, "t_1");
    const [row] = await t.run((ctx) => ctx.db.query("signals").collect());
    const run = await t.run(async (ctx) => (await ctx.db.query("judge_runs").collect())[0]);
    // A later version's run on the same moment, as a re-judge before re-found keys took new words left it.
    const later = (what: string, quote: string) => t.run((ctx) => ctx.db.insert("judge_runs", { ...run, _id: undefined, _creationTime: undefined, judge_version: "c".repeat(40), at: run.at + 1000, findings_json: JSON.stringify([{ expectation: "ex-aq-1", severity: 5, what_happened: what, quote, markers: [] }]) } as any));
    const runId = await later("A contact waited past a business day. Dana asked Monday.", "Can we talk Tuesday?");
    const dry = await t.action(internal.judgeRetire.backfillRefound, { project_id: ids.project, dry_run: true });
    expect(dry).toMatchObject({ checked: 1, stale: 1, updated: [`${row.short_id}: A contact waited past a business day.`], unmatched: [] });
    s.state.vectors.push(vec(40));
    const done = await t.action(internal.judgeRetire.backfillRefound, { project_id: ids.project, dry_run: false });
    expect(done).toMatchObject({ updated: [row.short_id], embedded: 1 });
    expect(await t.run((ctx) => ctx.db.get(row._id))).toMatchObject({ title: "A contact waited past a business day.", severity: 5, judge_version: "c".repeat(40), task_id: row.task_id });
    // Up to date now; and a newer run that did not report the key leaves the row and lists it.
    expect(await t.action(internal.judgeRetire.backfillRefound, { project_id: ids.project, dry_run: true })).toMatchObject({ stale: 0 });
    await t.run((ctx) => ctx.db.delete(runId));
    await t.run((ctx) => ctx.db.insert("judge_runs", { ...run, _id: undefined, _creationTime: undefined, judge_version: "d".repeat(40), at: run.at + 2000, findings_json: "[]" } as any));
    expect(await t.action(internal.judgeRetire.backfillRefound, { project_id: ids.project, dry_run: false })).toMatchObject({ stale: 1, updated: [], unmatched: [row.short_id] });
    s.state.model.length = 0;
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

  test("a later moment of the same conversation showing the same words files no second finding", async () => {
    const { t, scope, post, due, claim, complete } = await setup();
    await t.mutation(api.moments.publish, { ...scope, source: "app", device_id: "host-1", root: "/repo", extractors: [{ kind: "conversation", path: ".codecast/moments/conversation.ts", version: "b".repeat(40), quiet_ms: 0, timeout_ms: 30_000 }], judges: [JUDGE] });
    await t.mutation(api.modelCalls.budgetForCli, { ...scope, set_usd: 5 });
    const late = '{"deviations": [{"expectation": "ex-aq-1", "severity": 7, "what_happened": "The agent left the broker waiting two days.", "quote": "Can we talk  Tuesday?", "markers": []}]}';
    await post([{ type: "moment", kind: "conversation", subject: "t_1", at: T0 }]);
    await due();
    const [first] = await claim();
    s.state.judge = late;
    s.state.vectors.push(vec(10));
    expect((await complete(first.moment, "t_1")).judged).toMatchObject([{ findings: 1, filed: 1 }]);

    // The conversation moves on; the judge reads the old message again, plus a new break.
    await post([{ type: "moment", kind: "conversation", subject: "t_1", at: T0 + 86_400_000 }]);
    await due();
    const [second] = await claim();
    s.state.judge = '{"deviations": [{"expectation": "ex-aq-1", "severity": 7, "what_happened": "Still waiting.", "quote": "can we talk tuesday?", "markers": []}, {"expectation": "ex-aq-1", "severity": 6, "what_happened": "A second late reply.", "quote": "Friday then?", "markers": []}]}';
    s.state.vectors.push(vec(10), vec(10));
    expect((await complete(second.moment, "t_1")).judged).toMatchObject([{ findings: 2, filed: 1 }]);
    const signals = await t.run((ctx) => ctx.db.query("signals").collect());
    expect(signals.map((sg) => sg.moment)).toEqual([first.moment, second.moment]);
    expect(signals[0].fingerprint).toMatch(/^evidence:conversation\/t_1:ex-aq-1:/);
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

  test("a source that judges on subscription hands its requests to the machine and settles the replies it brings back, on no budget", async () => {
    const { t, ids, scope, post, due, claim, complete } = await setup();
    await t.mutation(api.moments.publish, { ...scope, source: "app", device_id: "host-1", root: "/repo", extractors: [{ kind: "conversation", path: ".codecast/moments/conversation.ts", version: "b".repeat(40), quiet_ms: 0, timeout_ms: 30_000 }], judges: [JUDGE] });
    await t.mutation(api.ingest.updateSource, { ...scope, source: "app", config: { judge_on: "subscription" } });
    await post([{ type: "moment", kind: "conversation", subject: "t_1", at: T0 }]);
    await due();
    const [c] = await claim();
    // No budget is set: an API judge would be skipped. Nothing is sent from the server.
    const sent = s.state.model.length;
    const done = await complete(c.moment, "t_1");
    expect(done.judged).toEqual([]);
    expect(s.state.model).toHaveLength(sent);
    const handoff = done.judge_here!;
    expect(handoff.requests).toHaveLength(1);
    expect(handoff.requests[0]).toMatchObject({ judge: "comms", request: { model: JUDGE.model, max_tokens: JUDGE.max_tokens, output: "json" } });
    expect(handoff.requests[0].request.system).toContain(JUDGE.prompt);
    expect(handoff.requests[0].request.prompt).toContain("Can we talk Tuesday?");

    const reply = '{"deviations": [{"expectation": "ex-aq-1", "severity": 6, "what_happened": "The agent never replied. Dana asked on Monday.", "quote": "Can we talk Tuesday?", "markers": []}]}';
    const back = { moment: handoff.moment, clock: handoff.clock, record: JSON.stringify(handoff.record), results: [{ judge: "comms", result: { ok: true, text: reply, input_tokens: 900, output_tokens: 120 } }] };
    // Only the machine its extractor runs on hands it back by device.
    await expect(t.action(api.moments.judgedForCli, { api_token: TOKEN, device_id: "host-2", ...back })).rejects.toThrow("Unauthorized");
    const judged = await t.action(api.moments.judgedForCli, { api_token: TOKEN, device_id: "host-1", ...back });
    expect(judged.judged).toMatchObject([{ judge: "comms", status: "ok", findings: 1, filed: 1, cost_usd: 0 }]);
    const runs = await t.run((ctx) => ctx.db.query("judge_runs").collect());
    expect(runs).toMatchObject([{ status: "ok", findings: 1, backend: "subscription", cost_usd: 0 }]);
    expect(await t.run((ctx) => ctx.db.query("signals").collect())).toMatchObject([{ subject: "ex-aq-1", source: "judge:comms" }]);
    // A failed call is a failed run, as an API failure is.
    const failed = await t.action(api.moments.judgedForCli, { ...scope, ...back, results: [{ judge: "comms", result: { ok: false, error: "the answer held no JSON" } }] });
    expect(failed.judged).toMatchObject([{ status: "failed", reason: "the answer held no JSON" }]);

    // Back on the API, a judgment made elsewhere is not taken.
    await t.mutation(api.ingest.updateSource, { ...scope, source: "app", config: { judge_on: "api" } });
    await expect(t.action(api.moments.judgedForCli, { ...scope, ...back })).rejects.toThrow("judges on the API");
    expect(ids.source).toBeTruthy();
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

  test("a source on keep stores bodies where no lifecycle rule reaches and never expires them; 30d stays the default", async () => {
    const { t, ids, scope, post, due, claim, complete } = await setup();
    const env = { R2_ENDPOINT: "https://acct.r2.test", REPLAYS_R2_ACCESS_KEY_ID: "k", REPLAYS_R2_SECRET_ACCESS_KEY: "s" } as const;
    const prev = Object.fromEntries(Object.keys(env).map((k) => [k, process.env[k]]));
    Object.assign(process.env, env);
    const stubbed = globalThis.fetch;
    const puts: string[] = [];
    globalThis.fetch = (async (url: unknown, init: any) => {
      if (!String(url).startsWith(env.R2_ENDPOINT)) return stubbed(url as any, init);
      if (init?.method === "PUT") puts.push(new URL(String(url)).pathname);
      return new Response(null, { status: init?.method === "HEAD" ? 404 : 200 });
    }) as unknown as typeof fetch;
    const row = (subject: string) => t.run(async (ctx) => (await ctx.db.query("moments").collect()).find((m) => m.subject === subject)!);
    const store = async (subject: string) => {
      await post([{ type: "moment", kind: "conversation", subject, at: T0 }]);
      await due();
      const [c] = await claim();
      expect(await complete(c.moment, subject)).toMatchObject({ status: "ready", storage: "codecast" });
      return row(subject);
    };
    try {
      await t.mutation(api.moments.publish, { ...scope, source: "app", device_id: "host-1", root: "/repo", extractors: [{ kind: "conversation", path: ".codecast/moments/conversation.ts", version: "b".repeat(40), quiet_ms: 0, timeout_ms: 30_000 }], judges: [] });
      await t.mutation(api.ingest.updateSource, { ...scope, source: "app", config: { moment_storage: "codecast" } });

      // 30d: under moments-30d/, which the bucket's rule deletes, and dated so prune unhooks it then.
      const short = await store("t_30d");
      expect(short.body_key).toStartWith(`moments-30d/${ids.source}/`);
      expect(short.body_expires_at).toBe(short.extracted_at! + 30 * 24 * 60 * 60 * 1000);

      // A body stored under moments/ before keep was set (the trial's 200), still dated.
      const before = await t.run(async (ctx) => {
        const id = await ctx.db.insert("moments", { ...short, _id: undefined, _creationTime: undefined, subject: "t_old", short_id: "mo-90", body_key: `moments/${ids.source}/mo-90-x.json.gz` } as any);
        return ctx.db.get(id);
      });
      expect(before!.body_expires_at).toBeNumber();

      await t.mutation(api.ingest.updateSource, { ...scope, source: "app", config: { moment_retention: "keep" } });
      const jobs = await t.run(async (ctx: any) => (await ctx.db.system.query("_scheduled_functions").collect()).filter((j: any) => j.name.includes("keepBodies")));
      expect(jobs.map((j: any) => j.args[0])).toEqual([{ source_id: ids.source }]);
      expect(await t.mutation(internal.moments.keepBodies, { source_id: ids.source })).toEqual({ kept: 1 });
      // Keep lifts the date of what is under moments/; a moments-30d/ body goes at 30 days regardless.
      expect((await row("t_old")).body_expires_at).toBeUndefined();
      expect((await row("t_30d")).body_expires_at).toBe(short.body_expires_at);

      const kept = await store("t_keep");
      expect(kept.body_key).toStartWith(`moments/${ids.source}/`);
      expect(kept.body_expires_at).toBeUndefined();
      expect(puts.map((p) => p.split("/")[2])).toEqual(["moments-30d", "moments"]);

      // Prune, a year on, unhooks the 30d body and leaves the kept ones.
      const realNow = Date.now;
      Date.now = () => realNow() + 365 * 24 * 60 * 60 * 1000;
      try {
        await t.mutation(internal.moments.prune, {});
        expect(await t.query(internal.moments.bodyKeyFor, { ...scope, moment: kept.short_id })).toBe(kept.body_key!);
      } finally {
        Date.now = realNow;
      }
      expect((await row("t_30d")).body_key).toBeUndefined();
      expect((await row("t_keep")).body_key).toBe(kept.body_key);
      expect((await row("t_old")).body_key).toBe(before!.body_key);
      expect((await t.run((ctx) => ctx.db.get(ids.source)))?.config).toEqual({ moment_storage: "codecast", moment_retention: "keep" });
    } finally {
      globalThis.fetch = stubbed;
      for (const [k, val] of Object.entries(prev)) {
        if (val === undefined) delete process.env[k];
        else process.env[k] = val;
      }
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

  test("a claim handed back twice is judged once, and a late failure never undoes a ready moment", async () => {
    const { t, scope, post, due, claim, complete } = await setup();
    await t.mutation(api.moments.publish, { ...scope, source: "app", device_id: "host-1", root: "/repo", extractors: [{ kind: "conversation", path: ".codecast/moments/conversation.ts", version: "b".repeat(40), quiet_ms: 0, timeout_ms: 30_000 }], judges: [JUDGE] });
    await t.mutation(api.modelCalls.budgetForCli, { ...scope, set_usd: 5 });
    await post([{ type: "moment", kind: "conversation", subject: "t_1", at: T0 }]);
    await due();
    const [c1] = await claim();
    s.state.judge = '{"deviations": [{"expectation": "ex-aq-1", "severity": 7, "what_happened": "The agent left the broker waiting two days.", "quote": "Can we talk Tuesday?", "markers": []}]}';
    s.state.vectors.push(vec(10), vec(10));
    const judgeCalls = () => s.state.model.filter((b) => !String(b.system ?? "").includes("list of causes")).length;
    const before = judgeCalls();
    // The host retried while the first hand back was still in flight.
    const outs = await Promise.allSettled([complete(c1.moment, "t_1"), complete(c1.moment, "t_1")]);
    expect(outs.some((o) => o.status === "fulfilled" && (o.value as any).status === "ready")).toBe(true);
    expect(judgeCalls() - before).toBe(1);
    expect(await t.run((ctx) => ctx.db.query("judge_runs").collect())).toHaveLength(1);
    expect(await t.run((ctx) => ctx.db.query("signals").collect())).toHaveLength(1);
    // A failure from an older lease arrives after the moment is ready: it stays ready.
    const m = await t.run(async (ctx) => (await ctx.db.query("moments").collect())[0]);
    await t.mutation(internal.moments.markFailed, { moment_id: m._id, error: "timed out", retry: true });
    expect((await t.run(async (ctx) => await ctx.db.get(m._id)))!.status).toBe("ready");
  }, 120_000);
});
