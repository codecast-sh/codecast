// The ground step before admission (the-line-end-to-end.md LE5, LE6) and the
// admission rules it feeds (line-profile.md LP1, LP6), under convex-test with
// the model call stubbed at fetch: a signal filed under a project is grounded
// against that project's brief, routes to the role that leads the project,
// and waits behind the open cards of the person that role reports to.
import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { convexTest } from "convex-test";
import schema from "./schema";
import { api, internal } from "./_generated/api";
import { hashToken } from "./apiTokens";
import { GROUND_FIELDS, GROUND_OUTPUT_SCHEMA, GROUND_PROJECT_FIELD, GROUND_PURPOSE } from "@codecast/shared/contracts/goalsBrief";
import { HEAD_OF_PEOPLE_HANDLE } from "@codecast/shared/contracts/orgLead";
import { admissionWait, LINE_RUNS_PER_RUNNER, lineCandidates, runnerLoad, runnerLoadFor } from "./orgLine";
import { setBudgetCap } from "./lib/teamBudget";

setDefaultTimeout(60_000);

const TOKEN = "g".repeat(64);
const T0 = 1_760_000_000_000;

function modelStub() {
  const realFetch = globalThis.fetch;
  const realKey = process.env.ANTHROPIC_API_KEY;
  const state = { replies: [] as string[], fail: false, calls: [] as any[] };
  return {
    state,
    install() {
      process.env.ANTHROPIC_API_KEY = "test-key";
      state.calls.length = 0;
      state.replies = [];
      state.fail = false;
      globalThis.fetch = (async (_url: unknown, init: { body: string }) => {
        state.calls.push(JSON.parse(init.body));
        if (state.fail) return new Response("overloaded", { status: 529 });
        const text = state.replies.shift() ?? '{"answer":"none"}';
        return new Response(JSON.stringify({ content: [{ type: "text", text }], stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 1 } }));
      }) as unknown as typeof fetch;
    },
    restore() {
      globalThis.fetch = realFetch;
      if (realKey === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = realKey;
    },
  };
}

const ground = (fields: Record<string, string>) => JSON.stringify({ category: "code", risk: "low", readiness: "ready", note: "Checkout errors cost orders", ...fields });

async function setup() {
  const t = convexTest(schema, {
    "./_generated/server.ts": () => import("./_generated/server"),
  "./syncOutbox.ts": () => import("./syncOutbox"),
    "./signals.ts": () => import("./signals"),
    "./lineGround.ts": () => import("./lineGround"),
    "./modelCalls.ts": () => import("./modelCalls"),
  });
  const ids = await t.run(async (ctx) => {
    const person = await ctx.db.insert("users", { name: "Founder" } as any);
    await ctx.db.insert("api_tokens", { user_id: person, token_hash: await hashToken(TOKEN), name: "cli", created_at: T0, last_used_at: T0 } as any);
    const team = await ctx.db.insert("teams", { name: "Acme", features: { org: true } } as any);
    await ctx.db.insert("team_memberships", { user_id: person, team_id: team, role: "admin", joined_at: T0 } as any);
    const workspace = `team:${team}`;
    // Ground spends from the workspace's model budget, which is off until a person sets a cap.
    await setBudgetCap(ctx, workspace, team, 100, person, Date.now());
    const project = (short_id: string, title: string, goal: string) =>
      ctx.db.insert("projects", { user_id: person, team_id: team, workspace, short_id, title, goal, status: "active", created_at: T0, updated_at: T0 } as any);
    const checkout = await project("pr-1", "Checkout", "Every cart that reaches checkout becomes an order");
    // sentry's signals open causes: the explicit conversion step (LE4).
    await ctx.db.patch(checkout, { line_profile: { finders: [{ id: "errors", source: "sentry", kind: ["bug"], fingerprint: "<group>", opens_causes: true }], changed_at: T0 } } as any);
    const avatars = await project("pr-2", "Avatars", "Profiles look like their owners");
    return { person, team, workspace, checkout, avatars };
  });
  const add = (fields: Record<string, any>) =>
    t.action(api.signals.ingest, { api_token: TOKEN, workspace: "team", team_id: ids.team, source: "sentry", kind: "bug", ...fields } as any);
  const task = (id: any) => t.run(async (ctx) => await ctx.db.get(id)) as Promise<any>;
  const sweep = () => t.action(internal.lineGround.sweep, {});
  return { t, ...ids, add, task, sweep };
}

describe("lineGround.sweep (LE5)", () => {
  const stub = modelStub();
  beforeEach(() => stub.install());
  afterEach(() => stub.restore());

  test("grounds a fresh cause against its own project's brief and records why", async () => {
    const { add, task, sweep, t } = await setup();
    const filed = await add({ fingerprint: "err-1", title: "Checkout throws on empty cart", project: "pr-1", detail_md: "TypeError at cart.ts:40" });
    stub.state.replies.push(ground({ goal_ref: "pr-1" }));
    expect(await sweep()).toMatchObject({ grounded: 1, unreadable: 0, unanswered: 0 });

    const call = stub.state.calls.at(-1);
    expect(call.output_config).toEqual({ format: { type: "json_schema", schema: GROUND_OUTPUT_SCHEMA } });
    expect(call.system).toContain(GROUND_PURPOSE);
    expect(call.system).toContain(GROUND_FIELDS);
    const prompt: string = call.messages[0].content;
    expect(prompt).toContain("Checkout throws on empty cart");
    expect(prompt).toContain("TypeError at cart.ts:40");
    expect(prompt).toContain("Every cart that reaches checkout becomes an order");
    // Only the cause's project: the other project's charter stays out.
    expect(prompt).not.toContain("Profiles look like their owners");

    expect(await task(filed.task_id)).toMatchObject({ goal_ref: "pr-1", category: "code", risk: "low", readiness: "ready", readiness_note: "Checkout errors cost orders" });
    const comments = await t.run(async (ctx) => await ctx.db.query("task_comments").collect());
    expect(comments.some((c: any) => c.author === "ground" && c.text.startsWith("Grounded: serves pr-1."))).toBe(true);

    // Grounded causes are not asked about again.
    const before = stub.state.calls.length;
    expect(await sweep()).toMatchObject({ grounded: 0 });
    expect(stub.state.calls.length).toBe(before);
  });

  // pl-882: ct-59578's note said "All 3 reports show ..." at 65 findings.
  test("a cause whose findings doubled since its note is grounded again over what it holds now", async () => {
    const { add, task, sweep } = await setup();
    const first = await add({ fingerprint: "err-1", title: "Checkout throws on empty cart", project: "pr-1" });
    stub.state.replies.push(ground({ goal_ref: "pr-1", note: "One report so far" }));
    await sweep();
    expect((await task(first.task_id)).cause.grounded_count).toBe(1);
    await add({ fingerprint: "err-1", title: "Checkout throws on empty cart", project: "pr-1" });
    const grown = await task(first.task_id);
    expect(grown.readiness).toBeUndefined();
    expect(grown.readiness_note).toBeUndefined();
    stub.state.replies.push(ground({ goal_ref: "pr-1", note: "Both reports" }));
    expect(await sweep()).toMatchObject({ grounded: 1 });
    expect(await task(first.task_id)).toMatchObject({ readiness: "ready", readiness_note: "Both reports", cause: { signal_count: 2, grounded_count: 2 } });
    // Three of the two it read is not yet a different problem.
    await add({ fingerprint: "err-1", title: "Checkout throws on empty cart", project: "pr-1" });
    expect(await task(first.task_id)).toMatchObject({ readiness: "ready", readiness_note: "Both reports" });
  });

  test("a cause with no project is grounded against the whole workspace's goals, and placed in one", async () => {
    const { add, sweep, task, avatars, t } = await setup();
    const filed = await add({ fingerprint: "err-2", title: "Avatar upload rejects PNG" });
    stub.state.replies.push(ground({ goal_ref: "pr-2", category: "ux", project: "pr-2" }));
    expect(await sweep()).toMatchObject({ grounded: 1 });
    const call = stub.state.calls.at(-1);
    const prompt: string = call.messages[0].content;
    expect(prompt).toContain("Every cart that reaches checkout becomes an order");
    expect(prompt).toContain("Profiles look like their owners");
    expect(prompt).toContain("filed under: no project");
    expect(call.system).toContain(GROUND_PROJECT_FIELD);
    expect(call.output_config.format.schema.properties.project.enum).toEqual(["pr-1", "pr-2", "none"]);
    expect(await task(filed.task_id)).toMatchObject({ project_id: avatars, goal_ref: "pr-2", cause: { placed: "ground" } });
    const row = await t.run(async (ctx) => await ctx.db.get(filed.signal_id));
    expect(row).toMatchObject({ project_id: avatars });
    expect(row?.filed_for_project_id).toBeUndefined();
  });

  test("a cause filed under the repo's default project is placed by what it is about: it moves with its signals and keeps where it was filed", async () => {
    const { add, sweep, task, checkout, avatars, t } = await setup();
    const filed = await add({ fingerprint: "err-3", title: "Avatar upload rejects PNG", default_project: "pr-1" });
    const again = await add({ fingerprint: "err-3", title: "Avatar upload rejects PNG", default_project: "pr-1" });
    expect(again).toMatchObject({ attach: "fingerprint", task_id: filed.task_id });
    expect(await task(filed.task_id)).toMatchObject({ project_id: checkout, cause: { placed: "default" } });
    stub.state.replies.push(ground({ goal_ref: "pr-2", category: "ux", project: "pr-2" }));
    expect(await sweep()).toMatchObject({ grounded: 1 });
    const prompt: string = stub.state.calls.at(-1).messages[0].content;
    expect(prompt).toContain("filed under: pr-1 Checkout, by default");
    // Placing reads every project's charter, not only the default's.
    expect(prompt).toContain("Profiles look like their owners");

    expect(await task(filed.task_id)).toMatchObject({ project_id: avatars, cause: { placed: "ground", signal_count: 2 } });
    const rows = await t.run(async (ctx) => await ctx.db.query("signals").withIndex("by_task", (q: any) => q.eq("task_id", filed.task_id)).collect());
    expect(rows).toHaveLength(2);
    for (const row of rows) expect(row).toMatchObject({ project_id: avatars, filed_for_project_id: checkout });
    const comments = await t.run(async (ctx) => await ctx.db.query("task_comments").collect());
    expect(comments.some((c: any) => c.author === "ground" && c.text.includes("Placed in Avatars, moved from Checkout, where it was filed by default."))).toBe(true);
  });

  test("a cause ground keeps in its default project stays there, and one no charter covers leaves it", async () => {
    const { add, sweep, task, checkout } = await setup();
    const kept = await add({ fingerprint: "err-4", title: "Checkout throws on empty cart", default_project: "pr-1" });
    const left = await add({ fingerprint: "err-5", title: "Office printer jams", default_project: "pr-1" });
    stub.state.replies.push(ground({ goal_ref: "pr-1", project: "pr-1" }), ground({ goal_ref: "none", readiness: "not_actionable", project: "none" }));
    expect(await sweep()).toMatchObject({ grounded: 2 });
    expect(await task(kept.task_id)).toMatchObject({ project_id: checkout, cause: { placed: "ground" } });
    const gone = await task(left.task_id);
    expect(gone.project_id).toBeUndefined();
    expect(gone.cause.placed).toBe("ground");
  });

  test("a project the brief does not list leaves a cause being placed needing a person", async () => {
    const { add, sweep, task } = await setup();
    const filed = await add({ fingerprint: "err-6", title: "Avatar upload rejects PNG" });
    stub.state.replies.push(ground({ goal_ref: "pr-2", project: "pr-9" }));
    expect(await sweep()).toMatchObject({ grounded: 0, unreadable: 1 });
    expect((await task(filed.task_id)).readiness_note).toContain('project "pr-9" is not a project the brief lists');
  });

  test("an answer it cannot use leaves the cause needing a person, with the reason, and is not asked again", async () => {
    const { add, task, sweep } = await setup();
    const filed = await add({ fingerprint: "err-1", title: "Checkout throws on empty cart", project: "pr-1" });
    // pr-2 is not in this project's brief.
    stub.state.replies.push(ground({ goal_ref: "pr-2" }));
    expect(await sweep()).toMatchObject({ grounded: 0, unreadable: 1 });
    const cause = await task(filed.task_id);
    expect(cause.readiness).toBe("needs_context");
    expect(cause.readiness_note).toContain('goal_ref "pr-2" is not a ref the brief offers');
    expect(cause.goal_ref).toBeUndefined();
    const before = stub.state.calls.length;
    await sweep();
    expect(stub.state.calls.length).toBe(before);
  });

  test("each call is charged to the workspace's budget and the cause's project, and a full cap leaves the cause for a later pass", async () => {
    const { add, task, sweep, t, workspace, team, person, checkout } = await setup();
    const filed = await add({ fingerprint: "err-1", title: "Checkout throws on empty cart", project: "pr-1" });
    stub.state.replies.push(ground({ goal_ref: "pr-1" }));
    expect(await sweep()).toMatchObject({ grounded: 1 });
    const { budget, spend } = await t.run(async (ctx) => ({
      budget: await ctx.db.query("team_budgets").withIndex("by_workspace", (q: any) => q.eq("workspace", workspace)).first(),
      spend: await ctx.db.query("model_spend_hours").collect(),
    }));
    expect(budget!.by_purpose.grouping).toBeGreaterThan(0);
    expect(budget!.held_usd).toBe(0);
    expect(spend.map((r: any) => r.project_id)).toEqual([checkout]);

    const next = await add({ fingerprint: "err-2", title: "Checkout drops the coupon", project: "pr-1" });
    await t.run(async (ctx) => setBudgetCap(ctx, workspace, team, 0, person, Date.now()));
    const before = stub.state.calls.length;
    expect(await sweep()).toMatchObject({ grounded: 0, unbudgeted: 1 });
    expect(stub.state.calls.length).toBe(before);
    expect((await task(next.task_id)).readiness).toBeUndefined();
    expect((await task(filed.task_id)).readiness).toBe("ready");
  });

  test("no reply at all leaves the cause untouched for the next pass", async () => {
    const { add, task, sweep } = await setup();
    const filed = await add({ fingerprint: "err-1", title: "Checkout throws on empty cart", project: "pr-1" });
    stub.state.fail = true;
    expect(await sweep()).toMatchObject({ grounded: 0, unanswered: 1 });
    expect((await task(filed.task_id)).readiness).toBeUndefined();
    stub.state.fail = false;
    stub.state.replies.push(ground({ goal_ref: "none", readiness: "not_actionable" }));
    expect(await sweep()).toMatchObject({ grounded: 1 });
    expect(await task(filed.task_id)).toMatchObject({ goal_ref: "none", readiness: "not_actionable" });
  });

  test("a cause a person grounded, or one a run holds, is left alone", async () => {
    const { add, sweep, t } = await setup();
    const a = await add({ fingerprint: "err-1", title: "Checkout throws on empty cart", project: "pr-1" });
    const b = await add({ fingerprint: "err-9", title: "Avatar upload rejects PNG", project: "pr-2" });
    await t.run(async (ctx) => {
      await ctx.db.patch(a.task_id, { readiness: "ready", goal_ref: "pr-1" } as any);
      await ctx.db.patch(b.task_id, { status: "in_progress" } as any);
    });
    const before = stub.state.calls.length;
    expect(await sweep()).toMatchObject({ grounded: 0, unreadable: 0, unanswered: 0 });
    expect(stub.state.calls.length).toBe(before);
  });
});

// ── Admission (LP1, LP6) ──

async function orgSetup() {
  const base = await setup();
  const { t, person, team, workspace, checkout } = base;
  const roles = await t.run(async (ctx) => {
    const role = async (handle: string, scope: any[], reports_to: any, cards?: number) => {
      const conv = await ctx.db.insert("conversations", { session_id: `standing-${handle}`, user_id: person, team_id: team, status: "active", title: handle, agent_type: "claude_code", message_count: 1, updated_at: T0 } as any);
      const anchor = await ctx.db.insert("anchors", { team_id: team, bot_user_id: person, host_user_id: person, conversation_id: conv, project_path: `/srv/${handle}` } as any);
      const id = await ctx.db.insert("org_roles", {
        short_id: `or-${handle}`, scope_type: "team", team_id: team, host_user_id: person, name: handle, handle,
        scope: { project_ids: scope, plan_ids: [] }, reports_to, status: "active", trust: "direct", anchor_id: anchor,
        caps: { hands_per_day: 10, wakes_per_day: 10, tokens_per_day: 1_000_000, line_on: true, ...(cards ? { cards } : {}) },
        created_by: person, created_at: T0, updated_at: T0,
      } as any);
      return { id, conv };
    };
    const hop = await role(HEAD_OF_PEOPLE_HANDLE, [], { kind: "user", user_id: person });
    const checkoutLead = await role("checkout", [checkout], { kind: "role", role_id: hop.id }, 2);
    return { hop, checkoutLead };
  });
  const role = (id: any) => t.run(async (ctx) => await ctx.db.get(id)) as Promise<any>;
  const run = (conv: any, taskId: any) => t.run(async (ctx) => {
    await ctx.db.insert("workflow_runs", { user_id: person, workspace, team_id: team, workflow_name: "line", status: "running", spawner_conversation_id: conv, task_id: taskId, node_statuses: [], created_at: T0, updated_at: T0 } as any);
  });
  return { ...base, ...roles, role, run };
}

describe("admission after grounding (LP1, LP6)", () => {
  const stub = modelStub();
  beforeEach(() => stub.install());
  afterEach(() => stub.restore());

  test("a grounded cause under a project goes to the project's lead, a cause with no project to the Head of People", async () => {
    const { add, sweep, t, hop, checkoutLead } = await orgSetup();
    const inProject = await add({ fingerprint: "err-1", title: "Checkout throws on empty cart", project: "pr-1" });
    const unprojected = await add({ fingerprint: "err-2", title: "Avatar upload rejects PNG" });
    // Ground finds no project for the unprojected one, so it stays the Head of People's.
    stub.state.replies.push(ground({ goal_ref: "pr-1" }), ground({ goal_ref: "pr-2", project: "none" }));

    // Ungrounded causes are nobody's candidates yet.
    expect(await t.run(async (ctx) => lineCandidates(ctx, await ctx.db.get(checkoutLead.id)))).toEqual([]);
    await sweep();

    const lead = await t.run(async (ctx) => (await lineCandidates(ctx, await ctx.db.get(checkoutLead.id))).map((c: any) => String(c._id)));
    const head = await t.run(async (ctx) => (await lineCandidates(ctx, await ctx.db.get(hop.id))).map((c: any) => String(c._id)));
    expect(lead).toEqual([String(inProject.task_id)]);
    expect(head).toEqual([String(unprojected.task_id)]);
  });

  test("a project two roles list goes to the one its owner_role_id names", async () => {
    const { add, sweep, t, checkoutLead, person, team, checkout } = await orgSetup();
    const second = await t.run(async (ctx) => ctx.db.insert("org_roles", {
      short_id: "or-second", scope_type: "team", team_id: team, host_user_id: person, name: "Second", handle: "second",
      scope: { project_ids: [checkout], plan_ids: [] }, reports_to: { kind: "user", user_id: person }, status: "active", trust: "direct",
      created_by: person, created_at: T0, updated_at: T0,
    } as any));
    const filed = await add({ fingerprint: "err-1", title: "Checkout throws on empty cart", project: "pr-1" });
    stub.state.replies.push(ground({ goal_ref: "pr-1" }));
    await sweep();
    const candidatesOf = (id: any) => t.run(async (ctx) => (await lineCandidates(ctx, await ctx.db.get(id))).map((c: any) => String(c._id)));
    // Two roles list it and neither is above the other: nobody owns it.
    expect(await candidatesOf(checkoutLead.id)).toEqual([]);
    await t.run(async (ctx) => { await ctx.db.patch(checkout, { owner_role_id: second } as any); });
    expect(await candidatesOf(second)).toEqual([String(filed.task_id)]);
    expect(await candidatesOf(checkoutLead.id)).toEqual([]);
  });

  test("working runs count per runner across every line they run, against one cap", async () => {
    const { t, person, hop, checkoutLead, run, role, add } = await orgSetup();
    const a = await add({ fingerprint: "err-1", title: "Checkout throws on empty cart", project: "pr-1" });
    const b = await add({ fingerprint: "err-2", title: "Avatar upload rejects PNG" });
    // One working run on each line; both roles run on the founder's machine.
    await run(hop.conv, b.task_id);
    await run(checkoutLead.conv, a.task_id);
    const load = await t.run(async (ctx) => runnerLoad(ctx, String(person)));
    expect(load).toMatchObject({ runner: String(person), working: 2, cap: LINE_RUNS_PER_RUNNER });
    const hopRole = await role(hop.id);
    const viaRole = await t.run(async (ctx) => runnerLoadFor(ctx, hopRole));
    expect(viaRole).toMatchObject({ working: 2, cap: LINE_RUNS_PER_RUNNER });
    // caps.cards, 2 on the checkout lead, no longer limits anything.
    expect(admissionWait(hopRole, viaRole.working, Date.now())).toBeNull();
    expect(admissionWait(hopRole, LINE_RUNS_PER_RUNNER, Date.now())).toBe("runs");
  });
});
