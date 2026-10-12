// Trial projects (lineTrial.ts): a gate on a trial project's run asks nobody
// and becomes a trial card; the card's answer moves the run; an agent stands in
// only at an earlier gate; nothing merges; the sweep never starts a trial
// problem. Driven against the fake db, the way workflow_runs.gate.test.ts
// drives the decision rail.
import { describe, expect, test } from "bun:test";
import { makeFakeDb } from "./testDb";
import { causeDescription, refreshCauseDescription } from "./signals";
import { pauseAtGateCore } from "./workflow_runs";
import { answerTrialCardCore, coverageOf, dispatchPass, dueProblems, evalsOwedBy, isTrialRun, problemEvidence, sameCode, toolingOf, trialProjectOf } from "./lineTrial";

const HOST = "users_host" as any;
const TEAM = "teams_acme" as any;
const RUN = "workflow_runs_run";
const TASK = "tasks_t1";
const TRIAL = "projects_trial";
const REAL = "projects_real";
const NOW = 1_800_000_000_000;

const card = {
  v: 1,
  headline: "x",
};

const proposalChoices = [
  { key: "A", label: "[A] Approve", description: "build it", target: "approve" },
  { key: "R", label: "[R] Revise", target: "revise_proposal" },
  { key: "D", label: "[D] Drop", target: "drop_proposal" },
];
const cardChoices = [
  { key: "S", label: "[S] Ship", target: "trial_ship" },
  { key: "R", label: "[R] Revise", target: "revise_build" },
  { key: "D", label: "[D] Drop", target: "trial_drop" },
];

function seed(project = TRIAL) {
  const tables: Record<string, any[]> = {
    users: [{ _id: HOST, name: "Host" }],
    teams: [{ _id: TEAM, name: "Acme" }],
    team_memberships: [{ _id: "m1", user_id: HOST, team_id: TEAM, role: "admin" }],
    projects: [
      { _id: TRIAL, title: "AgentWatch Trial", user_id: HOST, team_id: TEAM, workspace: `team:${TEAM}`, status: "active", line_trial: { since: NOW - 1000, by: HOST }, created_at: NOW, updated_at: NOW },
      { _id: REAL, title: "Agent Quality", user_id: HOST, team_id: TEAM, workspace: `team:${TEAM}`, status: "active", created_at: NOW, updated_at: NOW },
    ],
    conversations: [
      { _id: "conversations_spawner", session_id: "sess-spawner", user_id: HOST, team_id: TEAM, message_count: 2 },
      { _id: "conversations_primary", session_id: `wf-${RUN}`, user_id: HOST, team_id: TEAM, message_count: 1, workflow_run_id: RUN },
    ],
    tasks: [{ _id: TASK, short_id: "ct-7", user_id: HOST, team_id: TEAM, workspace: `team:${TEAM}`, project_id: project, title: "Broker denies an introduction", status: "in_progress", task_type: "task", priority: "medium", workflow_run_id: RUN }],
    workflow_runs: [{
      _id: RUN, user_id: HOST, task_id: TASK, status: "running", node_statuses: [],
      workspace: `team:${TEAM}`, team_id: TEAM,
      spawner_conversation_id: "conversations_spawner", primary_conversation_id: "conversations_primary",
      created_at: NOW, updated_at: NOW,
    }],
    trial_cards: [],
    messages: [],
    session_decisions: [],
    decision_inbox: [],
    decision_grants: [],
    decision_stacks: [],
    docs: [],
    counters: [],
    org_roles: [],
    session_owners: [],
    directory_team_mappings: [],
    pending_messages: [],
    daemon_commands: [],
  };
  const db = makeFakeDb(tables);
  return { ctx: { db, scheduler: { runAfter: async () => null } } as any, tables };
}

const pause = (ctx: any, node_id: string, choices: any[], extra: Record<string, any> = {}) =>
  pauseAtGateCore(ctx, { userId: HOST }, { run_id: RUN as any, node_id, prompt: "Build this fix?\nThe rulings.", choices, ...extra });

describe("a trial project's gate asks nobody", () => {
  test("it pauses the run and writes a trial card, and no decision, inbox row or stack exists", async () => {
    const { ctx, tables } = seed();
    const r: any = await pause(ctx, "proposal_gate", proposalChoices, { doc_md: "# Proposal", category: "approach", stack: "Line" });
    expect(r).toEqual({ ok: true, trial_card: "tc-1" });
    expect(tables.session_decisions).toHaveLength(0);
    expect(tables.decision_inbox).toHaveLength(0);
    expect(tables.decision_stacks).toHaveLength(0);
    const row = tables.trial_cards[0];
    expect(row).toMatchObject({ short_id: "tc-1", kind: "gate", node_id: "proposal_gate", question: "Build this fix?", context_md: "The rulings.", doc_md: "# Proposal", status: "waiting", project_id: TRIAL, task_id: TASK });
    expect(row.options.map((o: any) => `${o.key} ${o.label}`)).toEqual(["A Approve", "R Revise", "D Drop"]);
    const run = tables.workflow_runs[0];
    expect(run).toMatchObject({ status: "paused", gate_node_id: "proposal_gate", gate_decision_id: undefined });
    expect(tables.tasks[0].status).toBe("in_review");
  });

  test("a project without line_trial still asks through the decision rail", async () => {
    const { ctx, tables } = seed(REAL);
    const r: any = await pause(ctx, "proposal_gate", proposalChoices);
    expect(r.ok).toBe(true);
    expect(r.trial_card).toBeUndefined();
    expect(tables.session_decisions).toHaveLength(1);
    expect(tables.trial_cards).toHaveLength(0);
  });

  test("the card gate is kind card; a card failing its contract is kept out, the gate still asks", async () => {
    const { ctx, tables } = seed();
    await pause(ctx, "decide", cardChoices, { card });
    expect(tables.trial_cards[0]).toMatchObject({ kind: "card", node_id: "decide" });
    expect(tables.trial_cards[0].card).toBeUndefined();
  });
});

describe("answering a trial card", () => {
  test("the answer rides the gate path: the run reads key and note, the card keeps who and what", async () => {
    const { ctx, tables } = seed();
    await pause(ctx, "proposal_gate", proposalChoices);
    const r = await answerTrialCardCore(ctx, HOST, "tc-1", "a", "keep it small", NOW + 5);
    expect(r).toEqual({ short_id: "tc-1", answer: "Approve" });
    expect(tables.workflow_runs[0]).toMatchObject({ status: "running", gate_response: "A: keep it small" });
    expect(tables.trial_cards[0]).toMatchObject({ status: "answered", answer: { key: "A", label: "Approve", note: "keep it small", by: HOST, at: NOW + 5 } });
    await expect(answerTrialCardCore(ctx, HOST, "tc-1", "A", undefined)).rejects.toThrow("already answered");
  });

  test("an agent stands in at an earlier gate, never at the change card", async () => {
    const { ctx, tables } = seed();
    await pause(ctx, "proposal_gate", proposalChoices);
    await answerTrialCardCore(ctx, HOST, "tc-1", "A", undefined, NOW, true);
    expect(tables.trial_cards[0].answer.stand_in).toBe(true);
    await pause(ctx, "decide", cardChoices);
    await expect(answerTrialCardCore(ctx, HOST, "tc-2", "S", undefined, NOW, true)).rejects.toThrow("only a person answers it");
    expect(tables.workflow_runs[0].status).toBe("paused");
  });

  test("a card whose run moved on is closed, not answered", async () => {
    const { ctx, tables } = seed();
    await pause(ctx, "proposal_gate", proposalChoices);
    tables.workflow_runs[0].status = "failed";
    await expect(answerTrialCardCore(ctx, HOST, "tc-1", "A", undefined)).rejects.toThrow("no longer waiting");
    expect(tables.trial_cards[0].status).toBe("closed");
  });

  test("a later gate of the same run closes the earlier card still waiting", async () => {
    const { ctx, tables } = seed();
    await pause(ctx, "proposal_gate", proposalChoices);
    await pause(ctx, "decide", cardChoices);
    expect(tables.trial_cards.map((c: any) => c.status)).toEqual(["closed", "waiting"]);
  });
});

describe("a trial run never merges, and the sweep never starts one", () => {
  test("isTrialRun and trialProjectOf read the task's project", async () => {
    const { ctx, tables } = seed();
    expect(await isTrialRun(ctx, tables.workflow_runs[0])).toBe(true);
    expect((await trialProjectOf(ctx, tables.tasks[0]))?._id).toBe(TRIAL);
    tables.tasks[0].project_id = REAL;
    expect(await isTrialRun(ctx, tables.workflow_runs[0])).toBe(false);
    expect(await trialProjectOf(ctx, { project_id: undefined })).toBeNull();
  });
});

describe("a card reads its problem's evidence now, not the count it was built with", () => {
  const W = `team:${TEAM}`;
  const tasks = [
    { _id: "tasks_a", short_id: "ct-7", workspace: W, title: "emptied by a re-judge", status: "in_review" },
    { _id: "tasks_b", short_id: "ct-8", workspace: W, title: "open, same email", status: "open" },
    { _id: "tasks_c", short_id: "ct-9", workspace: W, title: "still has findings", status: "open" },
    { _id: "tasks_d", short_id: "ct-10", workspace: W, title: "dropped", status: "dropped" },
    { _id: "tasks_e", short_id: "ct-11", workspace: W, title: "emptied by moves and a duplicate", status: "in_review" },
  ];
  const retired = (reason: string, task_id: string) => ({ at: NOW, reason, task_id });
  const signals = [
    // ct-7: two findings withdrawn by a re-judge. The first email is filed on ct-8 under another expectation (another finding,
    // not this one); the second's very key is live again on ct-8, found from another moment.
    { _id: "signals_1", short_id: "sg-1", title: "too short notice", workspace: W, fingerprint: "evidence:emails/123:ex1:abcdef12", detail_md: "x\n\n> 1:45 works", retired: retired("judged again by comms 1234abcd, which did not find it", "tasks_a"), created_at: NOW },
    { _id: "signals_2", short_id: "sg-2", title: "other ask", workspace: W, fingerprint: "evidence:emails/123:ex43:12345678", task_id: "tasks_b", created_at: NOW },
    { _id: "signals_5", short_id: "sg-5", title: "pitch admits", workspace: W, fingerprint: "evidence:emails/77:ex40:77777777", retired: retired("judged again by match 9, which did not find it", "tasks_a"), created_at: NOW },
    { _id: "signals_6", short_id: "sg-6", title: "pitch admits", workspace: W, fingerprint: "evidence:emails/77:ex40:77777777", task_id: "tasks_b", created_at: NOW },
    // ct-9: two findings from one email are one conversation.
    { _id: "signals_3", short_id: "sg-3", title: "a", workspace: W, fingerprint: "evidence:emails/9:ex1:aaaaaaaa", task_id: "tasks_c", created_at: NOW },
    { _id: "signals_4", short_id: "sg-4", title: "b", workspace: W, fingerprint: "evidence:emails/9:ex2:bbbbbbbb", task_id: "tasks_c", created_at: NOW },
    // ct-11: a duplicate of a finding that sits on a dropped problem goes nowhere live.
    { _id: "signals_7", short_id: "sg-7", title: "dup", workspace: W, fingerprint: "evidence:emails/5:ex1:55555555", retired: retired("the same message as sg-8, filed again from another moment", "tasks_e"), created_at: NOW },
    { _id: "signals_8", short_id: "sg-8", title: "kept", workspace: W, fingerprint: "evidence:emails/5:ex1:55555555", task_id: "tasks_d", created_at: NOW },
  ];
  const task_comments = [
    // Moves before the card was built are not where its evidence went; after it, an open target is, a dropped one is not.
    { _id: "c1", task_id: "tasks_e", author: "line", text: "Reports moved: 4 out\nOut: 4 to ct-9", created_at: NOW - 10 },
    { _id: "c2", task_id: "tasks_e", author: "line", text: "Reports moved: 3 out\nOut: 2 to ct-8, 1 to ct-10", created_at: NOW + 10 },
  ];
  test("a re-judged finding moved only when its very key is live on an open problem, not when its contact is", async () => {
    const db = makeFakeDb({ tasks, signals, task_comments });
    const e = await problemEvidence({ db } as any, tasks[0] as any);
    expect(e.moved_to).toEqual(["ct-8"]);
    expect(e.gone?.map((g) => [g.short_id, g.fate, g.to])).toEqual([["sg-1", "rejudged", undefined], ["sg-5", "moved", "ct-8"]]);
    expect(e.gone?.[0].quote).toBe("1:45 works");
  });
  test("a duplicate of a dropped problem's finding and moves off before the card name no problem; later moves to open ones do", async () => {
    const db = makeFakeDb({ tasks, signals, task_comments });
    const e = await problemEvidence({ db } as any, tasks[4] as any, NOW);
    expect(e.moved_to).toEqual(["ct-8"]);
    expect(e.withdrawn).toBe(4);
    expect(e.gone?.map((g) => [g.short_id, g.fate, g.to])).toEqual([["sg-7", "duplicate", undefined]]);
  });
  test("a problem with findings counts them and their conversations", async () => {
    const db = makeFakeDb({ tasks, signals, task_comments });
    expect(await problemEvidence({ db } as any, tasks[2] as any)).toEqual({ findings: 2, conversations: 1, withdrawn: 0, moved_to: [] });
  });
});

describe("a problem's description follows its findings", () => {
  const W = `team:${TEAM}`;
  const seed = (detail: string) => causeDescription({ kind: "prompt_miss", source: "judge:comms", detail_md: detail });
  const tasks = () => [
    { _id: "tasks_a", short_id: "ct-7", workspace: W, title: "missed-call emails", status: "open", description: seed("Steve: we never connected and that's on us.") },
    { _id: "tasks_b", short_id: "ct-8", workspace: W, title: "edited", status: "open", description: "A person's own words." },
  ];
  const signals = [
    { _id: "s1", short_id: "sg-1", workspace: W, kind: "prompt_miss", source: "judge:comms", detail_md: "Steve: we never connected and that's on us.", severity: 9, observed_at: 1, task_id: "tasks_c" },
    { _id: "s2", short_id: "sg-2", workspace: W, kind: "prompt_miss", source: "judge:comms", detail_md: "Sorry we missed you, just wanted to try you.", severity: 6, observed_at: 2, task_id: "tasks_a" },
    { _id: "s3", short_id: "sg-3", workspace: W, kind: "prompt_miss", source: "judge:comms", detail_md: "We tried calling, no news yet.", severity: 7, observed_at: 1, task_id: "tasks_a" },
  ];
  test("once the finding it was written from leaves, it is written from the strongest finding left", async () => {
    const db = makeFakeDb({ tasks: tasks(), signals });
    expect(await refreshCauseDescription({ db } as any, "tasks_a" as any, [signals[0] as any])).toBe(true);
    expect((await db.get("tasks_a" as any)).description).toBe(seed("We tried calling, no news yet."));
  });
  test("a description a person wrote, or one whose finding did not leave, stays", async () => {
    const db = makeFakeDb({ tasks: tasks(), signals });
    expect(await refreshCauseDescription({ db } as any, "tasks_b" as any, [signals[0] as any])).toBe(false);
    expect(await refreshCauseDescription({ db } as any, "tasks_a" as any, [signals[1] as any])).toBe(false);
  });
});

describe("the trial dispatcher starts the problems most in need of a run", () => {
  const W = `team:${TEAM}`;
  const task = (id: string, status: string, extra: Record<string, any> = {}) => ({ _id: `tasks_${id}`, short_id: `ct-${id}`, workspace: W, project_id: TRIAL, title: id, status, created_at: NOW, ...extra });
  const run = (id: string, status: string, created_at: number, extra: Record<string, any> = {}) => ({ _id: `workflow_runs_${id}`, user_id: HOST, task_id: `tasks_${id}`, status, node_statuses: [], workflow_name: "agentwatch_trial", workflow_id: "workflows_trial", project_path: "/union/outreach", created_at, updated_at: created_at, ...extra });
  const findings = (id: string, n: number, severity: number) => Array.from({ length: n }, (_, i) => ({ _id: `signals_${id}_${i}`, short_id: `sg-${id}${i}`, workspace: W, fingerprint: `k:${id}:${i}`, task_id: `tasks_${id}`, severity, created_at: NOW }));
  function world(cap = 100) {
    const { ctx, tables } = seed();
    tables.workflow_runs[0].status = "completed";
    tables.projects[0].line_trial = { since: NOW - 1000, by: HOST, dispatch: { cap_usd: cap } };
    tables.tasks.push(
      task("never", "open"),
      task("big", "open"),
      task("regrouped", "open", { workflow_run_id: "workflow_runs_regrouped", cause: { joined_at: NOW - 50 } }),
      task("stale", "in_review", { workflow_run_id: "workflow_runs_stale", cause: { joined_at: NOW - 200 } }),
      task("ruled", "in_review", { workflow_run_id: "workflow_runs_ruled", cause: { joined_at: NOW - 50 } }),
      task("live", "in_review", { workflow_run_id: "workflow_runs_live" }),
      task("closed", "done"),
      task("empty", "open"),
    );
    tables.workflow_runs.push(
      run("regrouped", "completed", NOW - 100),
      run("stale", "failed", NOW - 100),
      run("ruled", "completed", NOW - 100),
      run("live", "running", NOW - 10, { runner_device: "dev-mac" }),
    );
    tables.trial_cards.push({ _id: "trial_cards_1", run_id: "workflow_runs_ruled", kind: "card", status: "answered", answer: { key: "S", label: "Ship", by: HOST, at: NOW } });
    tables.signals = [...findings("never", 3, 5), ...findings("big", 5, 4), ...findings("regrouped", 3, 7), ...findings("stale", 9, 9), ...findings("ruled", 9, 9), ...findings("live", 9, 9), ...findings("closed", 9, 9)];
    tables.workflows = [{ _id: "workflows_trial", name: "agentwatch_trial", nodes: [], edges: [] }];
    tables.budgets = tables.budgets ?? [];
    return { ctx, tables };
  }

  test("due: open, holding findings, no live run, and never run or regrouped since its run; most findings, then severity, first", async () => {
    const { ctx } = world();
    const { due, running, like } = await dueProblems(ctx, (await ctx.db.get(TRIAL))!);
    expect(due.map((d) => d.task)).toEqual(["ct-big", "ct-regrouped", "ct-never"]);
    expect(due.find((d) => d.task === "ct-regrouped")).toMatchObject({ regrouped: true, last_run: "completed" });
    expect(running).toBe(1);
    expect(like.product?._id).toBe("workflow_runs_live" as any);
    expect(like.judge).toBeNull();
  });

  test("a problem of cases against a judge runs the judge route: held until a judge-route run names a machine, then started from it, never from the product graph (ct-59527)", async () => {
    const judgeWorld = (withJudgeRun: boolean) => {
      const w = world();
      w.tables.projects[0].line_trial.judge = { graph: "/union/outreach/line/agentwatch-trial-judge.cast", cwd: "/union/outreach", name: "agentwatch_trial_judge" };
      // Its last run was the product graph's (the misroute this replaces): it is due again, on its own route.
      w.tables.tasks.push(task("case", "in_review", { workflow_run_id: "workflow_runs_case", cause: { issue_key: "extractor:union-moments:contact-conversation", fingerprints: ["extractor:union-moments:contact-conversation"], joined_at: NOW - 200 } }));
      w.tables.workflow_runs.push(run("case", "completed", NOW - 100));
      w.tables.signals.push(...findings("case", 12, 9));
      if (withJudgeRun) {
        w.tables.tasks.push(task("judged", "done", { workflow_run_id: "workflow_runs_judged" }));
        w.tables.workflow_runs.push(run("judged", "completed", NOW - 5, { workflow_name: "agentwatch_trial_judge", workflow_id: "workflows_judge", runner_device: "dev-mac" }));
        w.tables.workflows.push({ _id: "workflows_judge", name: "agentwatch_trial_judge", nodes: [], edges: [] });
      }
      return w;
    };
    const held = judgeWorld(false);
    let r = await dispatchPass(held.ctx, (await held.ctx.db.get(TRIAL))!, NOW);
    expect(r.due.find((d: any) => d.task === "ct-case")).toMatchObject({ route: "judge" });
    expect(r.started).toEqual(["ct-big", "ct-regrouped"]);
    expect(r.held).toContain("judge-route");
    const ready = judgeWorld(true);
    r = await dispatchPass(ready.ctx, (await ready.ctx.db.get(TRIAL))!, NOW);
    expect(r.started[0]).toBe("ct-case");
    const queued = ready.tables.workflow_runs.filter((x: any) => x.fresh_branch && x.task_id === "tasks_case");
    expect(queued.map((x: any) => x.workflow_name)).toEqual(["agentwatch_trial_judge"]);
    const product = ready.tables.workflow_runs.filter((x: any) => x.fresh_branch && x.task_id !== "tasks_case");
    expect(product.every((x: any) => x.workflow_name === "agentwatch_trial")).toBe(true);
  });

  test("a pass fills the free slots in that order on the machine of the newest run, and records what it started", async () => {
    const { ctx, tables } = world();
    const r = await dispatchPass(ctx, (await ctx.db.get(TRIAL))!, NOW);
    expect(r.started).toEqual(["ct-big", "ct-regrouped"]);
    expect(r.held).toBeNull();
    const queued = tables.daemon_commands.filter((c: any) => c.command === "run_workflow");
    expect(queued.map((c: any) => c.target_device_id)).toEqual(["dev-mac", "dev-mac"]);
    const started = tables.workflow_runs.filter((x: any) => x.fresh_branch);
    expect(started.map((x: any) => x.goal_override).sort()).toEqual(["big", "regrouped"]);
    expect(tables.projects[0].line_trial.dispatch.last).toMatchObject({ at: NOW, started: ["ct-big", "ct-regrouped"] });
  });

  test("a pass that would cross the cap starts nothing and says why", async () => {
    const { ctx, tables } = world(5);
    const r = await dispatchPass(ctx, (await ctx.db.get(TRIAL))!, NOW);
    expect(r.started).toEqual([]);
    expect(r.held).toContain("would cross the cap");
    expect(tables.daemon_commands.length).toBe(0);
  });

  test("a dry pass starts and writes nothing", async () => {
    const { ctx, tables } = world();
    const r = await dispatchPass(ctx, (await ctx.db.get(TRIAL))!, NOW, true);
    expect(r.due.length).toBe(3);
    expect(r.started).toEqual([]);
    expect(tables.daemon_commands.length).toBe(0);
    expect(tables.projects[0].line_trial.dispatch.last).toBeUndefined();
  });
});

describe("what a trial card reads beside its words", () => {
  test("a problem whose case is filed against a judge or an extractor is review tooling, not the product (ct-59532, ct-59527)", () => {
    expect(toolingOf({ cause: { issue_key: "judge:codecast:comms", fingerprints: [] } } as any)).toBe("judge");
    expect(toolingOf({ cause: { issue_key: "extractor:union-moments:contact-conversation", fingerprints: [] } } as any)).toBe("extractor");
    expect(toolingOf({ cause: { fingerprints: ["evidence:contacts/x:ex-agentwatch-trial-34:fa10997c"] } } as any)).toBeNull();
  });

  test("the evals a diff owes come from its eval_scope station (tc-9: core, matching)", () => {
    expect(evalsOwedBy({ node_statuses: [{ node_id: "eval_scope", status: "completed", result_preview: '{"scoped":true,"select":"core,matching"}' }] } as any)).toEqual(["core", "matching"]);
    expect(evalsOwedBy({ node_statuses: [] } as any)).toEqual([]);
  });

  test("coverage splits the live conversations into reached, read and left out, and arrived since the card", () => {
    const live = [
      { short_id: "sg-1", conv: "a" }, { short_id: "sg-2", conv: "b" }, { short_id: "sg-3", conv: "c" },
      { short_id: "sg-9", conv: "d" }, { short_id: "sg-10", conv: "a" },
    ];
    expect(coverageOf({ covers: ["sg-1"], read: ["sg-1", "sg-2", "sg-3", "sg-4"] }, live)).toEqual({ covered: 1, other: 2, fresh: 1, gone: 1 });
    expect(coverageOf({}, live)).toBeNull();
  });

  test("two fixes touch the same code when one path ends with the other and the lines are near (tc-26 and tc-9 on matching.njk)", () => {
    expect(sameCode("backend/src/lib/agent/prompts/templates/layers/matching.njk:319", "outreach/backend/src/lib/agent/prompts/templates/layers/matching.njk:326")).toBe(true);
    expect(sameCode("templates/layers/matching.njk:432-433", "backend/src/lib/agent/prompts/templates/layers/matching.njk:319")).toBe(false);
    expect(sameCode(".codecast/moments/contact-conversation.ts:364", ".codecast/moments/contact-conversation.ts:346-370")).toBe(true);
    expect(sameCode("partials/daily-review.njk:15", "backend/x/partials/promise-follow-through.njk:13")).toBe(false);
  });
});
