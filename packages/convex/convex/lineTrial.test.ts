// Trial projects (lineTrial.ts): a gate on a trial project's run is a trial
// decision of its station's session, indexed by a trial card; the decision's
// answer moves the run; an agent stands in
// only at an earlier gate; nothing merges; the sweep never starts a trial
// problem. Driven against the fake db, the way workflow_runs.gate.test.ts
// drives the decision rail.
import { describe, expect, test } from "bun:test";
import { makeFakeDb } from "./testDb";
import { causeDescription, refreshCauseDescription } from "./signals";
import { pauseAtGateCore } from "./workflow_runs";
import { askCore } from "./sessionDecisions";
import { answerTrialCardCore, gateGone, workMinutes, dropAtCardCore, reaskRoute, gateLossOf, repeatedOutside, rerunCore, rerunFromMainCore, OUTSIDE_REPEAT_MS, coverageOf, supersedeMerged, dispatchPass, dueProblems, sweepClosed, evalsOwedBy, gatherDue, GATHER_NOTE, isTrialRun, overlapOf, sameCode, stopOf, toolingOf, routeOf, trialProjectOf, trialSpend, priceStale, RUN_SETTLE_MS, TRIAL_RUNNING_CAP, sessionBilling, quotaHold, UNNAMED_BILLER, problemCost } from "./lineTrial";
import { problemEvidence } from "./lib/problemEvidence";

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
      { _id: "conversations_primary", session_id: `wf-${RUN}`, user_id: HOST, team_id: TEAM, message_count: 1, workflow_run_id: RUN, is_workflow_primary: true },
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

/** A station of the run: a session nested under the run's primary conversation (runner spawnHand). */
function station(tables: Record<string, any[]>) {
  tables.conversations[1].is_workflow_primary = true;
  tables.conversations.push({ _id: "conversations_station", session_id: "sess-station", short_id: "jx7stat", user_id: HOST, team_id: TEAM, message_count: 3, parent_conversation_id: "conversations_primary" });
}

const pause = (ctx: any, node_id: string, choices: any[], extra: Record<string, any> = {}) =>
  pauseAtGateCore(ctx, { userId: HOST }, { run_id: RUN as any, node_id, prompt: "Build this fix?\nThe rulings.", choices, ...extra });

describe("a trial project's gate is its station's decision, in the trial's stack", () => {
  test("with nothing posted, the gate asks from the run's primary, never the session that started it: flagged trial, in the trial stack, in nobody's inbox", async () => {
    const { ctx, tables } = seed();
    const r: any = await pause(ctx, "proposal_gate", proposalChoices, { doc_md: "# Proposal", category: "approach", stack: "Line" });
    expect(r).toMatchObject({ ok: true, trial_card: "tc-1" });
    expect(tables.session_decisions).toHaveLength(1);
    const d = tables.session_decisions[0];
    expect(d).toMatchObject({ trial: true, question: "Build this fix?", context_md: "The rulings.", conversation_id: "conversations_primary", workflow_run_id: RUN, gate_node_id: "proposal_gate", task_id: TASK, hops: [] });
    expect(d.options.map((o: any) => o.label)).toEqual(["Approve", "Revise", "Drop"]);
    expect(tables.decision_inbox).toHaveLength(0);
    expect(tables.decision_stacks).toHaveLength(1);
    expect(tables.decision_stacks[0]).toMatchObject({ title: "AgentWatch Trial trial", client_key: `trial:${TRIAL}`, decision_ids: [d._id] });
    expect(tables.projects[0].line_trial.stack_id).toBe(tables.decision_stacks[0]._id);
    const row = tables.trial_cards[0];
    expect(row).toMatchObject({ short_id: "tc-1", kind: "gate", node_id: "proposal_gate", decision_id: d._id, status: "waiting", project_id: TRIAL, task_id: TASK });
    expect(row.question).toBeUndefined();
    expect(row.options).toBeUndefined();
    expect(tables.workflow_runs[0]).toMatchObject({ status: "paused", gate_node_id: "proposal_gate", gate_decision_id: d._id });
    expect(tables.tasks[0].status).toBe("in_review");
  });

  test("a station's own post is filed as the trial's, and the gate adopts it, its options mapped onto the edges by verdict", async () => {
    const { ctx, tables } = seed();
    station(tables);
    const posted: any = await askCore(ctx, { userId: HOST }, {
      session_id: "sess-station",
      question: "Should follow-ups to members stop promising a date nobody set?",
      options: [{ label: "Drop" }, { label: "Approve: the prompt change only" }, { label: "Revise: count the replies first" }],
      report_slug: "page-1",
    });
    expect(posted.error).toBeUndefined();
    expect(tables.session_decisions[0]).toMatchObject({ trial: true, task_id: TASK, report_slug: "page-1" });
    expect(tables.decision_inbox).toHaveLength(0);
    await pause(ctx, "proposal_gate", proposalChoices, { asker_session_id: "jx7stat" });
    expect(tables.session_decisions).toHaveLength(1);
    const run = tables.workflow_runs[0];
    expect(run.gate_decision_id).toBe(posted.id);
    expect(run.gate_choices.map((c: any) => c.key)).toEqual(["D", "A", "R"]);
    expect(tables.session_decisions[0]).toMatchObject({ workflow_run_id: RUN, gate_node_id: "proposal_gate", blocking: true });
    expect(tables.trial_cards[0].decision_id).toBe(posted.id);
  });

  test("a station's report and option pages get the trial's page password; a page already gated keeps its own", async () => {
    const { ctx, tables } = seed();
    station(tables);
    tables.artifacts = [
      { _id: "artifacts_1", slug: "page-1", created_at: NOW, updated_at: NOW },
      { _id: "artifacts_2", slug: "page-2", created_at: NOW, updated_at: NOW },
      { _id: "artifacts_3", slug: "page-3", password_hash: "theirs", created_at: NOW, updated_at: NOW },
    ];
    const posted: any = await askCore(ctx, { userId: HOST }, {
      session_id: "sess-station",
      question: "Should follow-ups to members stop promising a date nobody set?",
      options: [{ label: "Drop", page_slug: "page-2" }, { label: "Approve", page_slug: "page-3" }],
      report_slug: "page-1",
    });
    expect(posted.error).toBeUndefined();
    const password = tables.projects[0].line_trial.page_password;
    expect(password).toMatch(/^\w{12}$/);
    const { passwordHash } = await import("./lib/artifactGates");
    expect(tables.artifacts[0].password_hash).toBe(await passwordHash(password, "page-1"));
    expect(tables.artifacts[1].password_hash).toBe(await passwordHash(password, "page-2"));
    expect(tables.artifacts[2].password_hash).toBe("theirs");
  });

  test("a session outside the run cannot post the trial's decision", async () => {
    const { ctx, tables } = seed();
    const r: any = await askCore(ctx, { userId: HOST }, { session_id: "sess-spawner", question: "Ship this change?", options: [{ label: "Ship" }, { label: "Drop" }], context_md: "x".repeat(300), task: "ct-7", trial: true });
    expect(r.error).toMatch(/station of the trial run/);
    expect(tables.session_decisions).toHaveLength(0);
  });

  test("a project without line_trial still asks through the decision rail, into the queue", async () => {
    const { ctx, tables } = seed(REAL);
    const r: any = await pause(ctx, "proposal_gate", proposalChoices);
    expect(r.ok).toBe(true);
    expect(r.trial_card).toBeUndefined();
    expect(tables.session_decisions).toHaveLength(1);
    expect(tables.session_decisions[0].trial).toBeUndefined();
    expect(tables.trial_cards).toHaveLength(0);
  });

  test("the card gate is kind card; a card failing its contract is kept out, the gate still asks", async () => {
    const { ctx, tables } = seed();
    await pause(ctx, "decide", cardChoices, { card });
    expect(tables.trial_cards[0]).toMatchObject({ kind: "card", node_id: "decide" });
    expect(tables.trial_cards[0].card).toBeUndefined();
    expect(tables.session_decisions[0].card).toBeUndefined();
  });
});

describe("answering a trial card", () => {
  test("the answer is the decision's: the run reads key and note, the card stops waiting, nothing else is asked", async () => {
    const { ctx, tables } = seed();
    await pause(ctx, "proposal_gate", proposalChoices);
    const r = await answerTrialCardCore(ctx, HOST, "tc-1", "a", "keep it small", NOW + 5);
    expect(r).toEqual({ short_id: "tc-1", answer: "Approve" });
    expect(tables.workflow_runs[0]).toMatchObject({ status: "running", gate_response: "A: keep it small" });
    expect(tables.session_decisions[0]).toMatchObject({ status: "answered", answer_index: 0, answer_text: "keep it small" });
    expect(tables.trial_cards[0].status).toBe("answered");
    expect(tables.trial_cards[0].answer).toBeUndefined();
    expect(tables.pending_messages).toHaveLength(0);
    await expect(answerTrialCardCore(ctx, HOST, "tc-1", "A", undefined)).rejects.toThrow("already answered");
  });

  test("a gate key none of the session's options carries routes as text (the dispatcher's gather)", async () => {
    const { ctx, tables } = seed();
    station(tables);
    await askCore(ctx, { userId: HOST }, { session_id: "sess-station", question: "Build it?", options: [{ label: "Build it" }, { label: "Not now" }] });
    await pause(ctx, "proposal_gate", proposalChoices, { asker_session_id: "sess-station" });
    await answerTrialCardCore(ctx, HOST, "tc-1", "R", GATHER_NOTE, NOW, true);
    expect(tables.workflow_runs[0].gate_response).toBe(`R: ${GATHER_NOTE}`);
    expect(tables.trial_cards[0]).toMatchObject({ status: "answered", answer: { key: "R", stand_in: true } });
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

  test("a later gate of the same run closes the earlier card and takes back its question", async () => {
    const { ctx, tables } = seed();
    await pause(ctx, "proposal_gate", proposalChoices);
    tables.workflow_runs[0].status = "running";
    await pause(ctx, "decide", cardChoices, { prompt: "Ship this change?" });
    expect(tables.trial_cards.map((c: any) => c.status)).toEqual(["closed", "waiting"]);
    expect(tables.session_decisions.map((d: any) => d.status)).toEqual(["withdrawn", "pending"]);
    expect(tables.workflow_runs[0].status).toBe("paused");
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
    // The machine is busy but for two slots, whatever the cap: the passes below fill exactly those two.
    for (let i = 0; i < TRIAL_RUNNING_CAP - 3; i++) {
      tables.tasks.push(task(`busy${i}`, "in_review", { workflow_run_id: `workflow_runs_busy${i}` }));
      tables.workflow_runs.push(run(`busy${i}`, "running", NOW - 20, { runner_device: "dev-mac" }));
    }
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
    expect(running).toBe(TRIAL_RUNNING_CAP - 2);
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

  /** A settled price row for one run: `usd` its sessions at list price, `key` the part on a metered key. */
  const priceRow = (run: string, usd: number, sessions: number, extra: Record<string, any> = {}) => ({ _id: `trial_run_prices_${run}`, project_id: TRIAL, run_id: `workflow_runs_${run}`, run_created_at: NOW - 100, sessions, usd, tokens: 1000, unpriced_tokens: 0, key: { sessions: 0, tokens: 0, usd: 0 }, providers: ["claude"], device: "dev-mac", at: NOW, settled: true, ...extra });

  test("the cap limits billed money only: subscription runs worth far more than it at list price still start", async () => {
    const { ctx, tables } = world(5);
    tables.trial_run_prices = [priceRow("a", 400, 30), priceRow("b", 300, 20)];
    const r = await dispatchPass(ctx, (await ctx.db.get(TRIAL))!, NOW);
    expect(r.started).toEqual(["ct-big", "ct-regrouped"]);
    expect(r).toMatchObject({ billed_usd: 0, per_run_usd: 0, held: null });
  });

  test("a run on a metered key bills: past the cap at its billed cost nothing starts, and the hold says billed money", async () => {
    const { ctx, tables } = world(20);
    tables.trial_run_prices = [priceRow("a", 30, 4, { key: { sessions: 2, tokens: 500, usd: 12 } })];
    const r = await dispatchPass(ctx, (await ctx.db.get(TRIAL))!, NOW);
    expect(r.started).toEqual([]);
    expect(r.held).toBe("billed $12 of $20: another run (~$12.00 billed) would cross the cap");
    expect(tables.daemon_commands.length).toBe(0);
  });

  test("the trial's model spend is its own project's calls from when it began, not the workspace's month", async () => {
    const { ctx, tables } = world(1000);
    tables.budgets = [];
    tables.team_budgets = [{ _id: "team_budgets_1", workspace: `team:${TEAM}`, cap_usd: 400, month: new Date(NOW).toISOString().slice(0, 7), spent_usd: 287, held_usd: 0, by_purpose: { judge: 129, grouping: 0.25, call: 158 }, refused: 1, history: [], updated_at: NOW }];
    const hour = (at: number) => Math.floor(at / 3_600_000) * 3_600_000;
    tables.model_spend_hours = [
      { _id: "msh_1", workspace: `team:${TEAM}`, project_id: TRIAL, hour: hour(NOW), usd: 3, calls: 40, by_purpose: { judge: 2, grouping: 0, call: 1 } },
      { _id: "msh_2", workspace: `team:${TEAM}`, project_id: REAL, hour: hour(NOW), usd: 50, calls: 9, by_purpose: { judge: 50, grouping: 0, call: 0 } },
      { _id: "msh_3", workspace: `team:${TEAM}`, project_id: TRIAL, hour: hour(NOW) - 10 * 3_600_000, usd: 70, calls: 5, by_purpose: { judge: 70, grouping: 0, call: 0 } },
    ];
    const spend = await trialSpend(ctx, (await ctx.db.get(TRIAL))!, NOW);
    expect(spend.billed.model).toMatchObject({ usd: 3, calls: 40, by_purpose: { judge: 2, grouping: 0, call: 1 }, team_budget: { cap_usd: 400, spent_usd: 287, refused: 1 } });
    expect(spend.billed.usd).toBe(3);
  });

  test("a problem's cost: judging and its runs' call nodes and key sessions are billed; its subscription sessions are a list-price equivalent only", async () => {
    const { ctx, tables } = world(1000);
    tables.workflow_runs.push(run("priced", "completed", NOW - 100, { task_id: "tasks_big", primary_conversation_id: "conversations_pp", node_statuses: [{ node_id: "grade", status: "completed", started_at: NOW - 90, completed_at: NOW - 80, cost_usd: 0.3 }] }));
    const usage = { input: 1_000_000, output: 0, cache_read: 0, cache_write: 0 };
    tables.conversations.push(
      { _id: "conversations_c1", session_id: "s1", user_id: HOST, message_count: 1, parent_conversation_id: "conversations_pp", agent_type: "claude_code", model: "claude-opus-4-8", usage_totals: usage },
      { _id: "conversations_c2", session_id: "s2", user_id: HOST, message_count: 1, parent_conversation_id: "conversations_pp", agent_type: "opencode", model: "claude-opus-4-8", usage_totals: usage },
    );
    const c = await problemCost(ctx, tables.tasks.find((t: any) => t._id === "tasks_big"));
    expect(c.sessions).toBe(2);
    expect(c.run_list_usd).toBeGreaterThan(0);
    expect(c.run_billed_usd).toBeCloseTo(0.3 + c.run_list_usd, 2);
    expect(c.billed_usd).toBe(c.run_billed_usd + c.judge_usd);
  });

  test("a session's billing follows its agent: Claude Code and Codex logins are subscription, any other agent's key bills", () => {
    expect(sessionBilling("claude_code")).toEqual({ provider: "claude" });
    expect(sessionBilling("codex")).toEqual({ provider: "codex" });
    expect(sessionBilling("opencode")).toBeNull();
    expect(sessionBilling("pi")).toBeNull();
  });

  /** The runner machine's Claude account, its 5h window at `percent`. */
  function machine(w: ReturnType<typeof world>, percent: number) {
    w.tables.devices = [{ _id: "devices_mac", user_id: HOST, device_id: "dev-mac", label: "MacBook", cc_accounts: { active_email: "a@x.com", profiles: [{ name: "work", email: "a@x.com", usage: { fetched_at: NOW - 60_000, session: { percent, resets_at: NOW + 3_600_000 }, weekly: { percent: 40, resets_at: NOW + 86_400_000 } } }] } }];
  }

  test("runs wait for quota: an account the runs use at the warning line holds the pass and a rerun, and says which account and when it resets", async () => {
    const w = world(1000);
    machine(w, 91);
    w.tables.trial_run_prices = [priceRow("a", 50, 6)];
    const r = await dispatchPass(w.ctx, (await w.ctx.db.get(TRIAL))!, NOW);
    expect(r.started).toEqual([]);
    expect(r.held).toBe("quota 91% on work (claude): runs wait for its reset in 1h");
    expect(r.quota).toEqual([expect.objectContaining({ device: "MacBook", provider: "claude", account: "work", percent: 91 })]);
    lostAt(w, "lost", "decide", "card");
    await expect(rerunCore(w.ctx, HOST, "ct-lost", NOW)).rejects.toThrow("quota 91% on work");
    const ok = world(1000);
    machine(ok, 60);
    expect((await dispatchPass(ok.ctx, (await ok.ctx.db.get(TRIAL))!, NOW)).started).toEqual(["ct-big", "ct-regrouped"]);
  });

  test("quotaHold names the tightest account past the warning line, and none under it", () => {
    const q = (account: string, percent: number | null) => ({ device: "m", provider: "claude" as const, account, percent, windows: [], fetched_at: NOW, resets_at: null });
    expect(quotaHold([q("a", 50), q("b", null)], NOW)).toBeNull();
    expect(quotaHold([q("a", 86), q("b", 99)], NOW)).toBe("quota 99% on b (claude): runs wait");
  });

  test("a run limit holds next to the dollar cap: at the limit nothing starts, one under it one starts (sd-577: no runs past those used)", async () => {
    const used = (await trialSpend(world().ctx, (await world().ctx.db.get(TRIAL))!, NOW)).runs;
    const at = world(1000);
    at.tables.projects[0].line_trial.dispatch.max_runs = used;
    let r = await dispatchPass(at.ctx, (await at.ctx.db.get(TRIAL))!, NOW);
    expect(r.started).toEqual([]);
    expect(r.held).toBe(`${used} of ${used} runs used: the trial starts no more`);
    expect(at.tables.daemon_commands.length).toBe(0);
    const one = world(1000);
    one.tables.projects[0].line_trial.dispatch.max_runs = used + 1;
    r = await dispatchPass(one.ctx, (await one.ctx.db.get(TRIAL))!, NOW);
    expect(r.started).toEqual(["ct-big"]);
    expect(r).toMatchObject({ max_runs: used + 1, runs: used });
  });

  test("the trial's spend sums each run's price row and reads no task, run or session: a rerun or dispatch never waits on ~500 conversations", async () => {
    const { ctx, tables } = world(1000);
    tables.trial_run_prices = [
      priceRow("stale", 12.5, 3, { unpriced_tokens: 5, key: { sessions: 1, tokens: 200, usd: 2.5 } }),
      priceRow("live", 4, 2, { unpriced_tokens: 5, providers: ["claude", "codex"] }),
      priceRow("before", 50, 9, { run_created_at: NOW - 5000 }),
    ];
    const project = (await ctx.db.get(TRIAL))!;
    for (const t of ["tasks", "workflow_runs", "conversations"]) tables[t] = new Proxy([], { get: () => { throw new Error(`trialSpend read ${t}`); } }) as any;
    expect(await trialSpend(ctx, project, NOW)).toMatchObject({
      runs: 2,
      billed: { usd: 2.5, run_sessions: { sessions: 1, tokens: 200, usd: 2.5 } },
      subscription: { sessions: 4, tokens: 1800, list_usd: 14, unpriced_tokens: 10, providers: ["claude", "codex"], devices: ["dev-mac"] },
    });
  });

  test("a run started for a trial problem opens its price row, so the trial's run count holds before the run is priced", async () => {
    const { ctx, tables } = world(1000);
    const before = (await trialSpend(ctx, (await ctx.db.get(TRIAL))!, NOW)).runs;
    const r = await dispatchPass(ctx, (await ctx.db.get(TRIAL))!, NOW);
    expect(r.started.length).toBeGreaterThan(0);
    expect((await trialSpend(ctx, (await ctx.db.get(TRIAL))!, NOW)).runs).toBe(before + r.started.length);
    expect(tables.trial_run_prices.every((p: any) => p.project_id === TRIAL && p.usd === 0 && !p.settled)).toBe(true);
  });

  test("a run's price is priced again while the run is live, ended recently, or moved after it was priced", () => {
    const settled = { at: NOW, settled: true, key: { sessions: 0, tokens: 0, usd: 0 } };
    // Priced before billed and subscription use were told apart: priced again.
    expect(priceStale({ status: "completed", updated_at: NOW - RUN_SETTLE_MS }, { at: NOW, settled: true })).toBe(true);
    expect(priceStale({ status: "completed", updated_at: NOW - RUN_SETTLE_MS }, null)).toBe(true);
    expect(priceStale({ status: "completed", updated_at: NOW - RUN_SETTLE_MS }, settled)).toBe(false);
    expect(priceStale({ status: "running", updated_at: NOW - RUN_SETTLE_MS }, settled)).toBe(true);
    expect(priceStale({ status: "completed", updated_at: NOW + 1 }, settled)).toBe(true);
    expect(priceStale({ status: "completed", updated_at: NOW - 1 }, { ...settled, settled: false })).toBe(true);
  });

  test("hand entries are billed money, grouped by the key that billed them, and count toward the cap (ledger 2026-10-12: ~$250 on the evals key)", async () => {
    const { ctx, tables } = world(100);
    tables.projects[0].line_trial.outside = [
      { usd: 60, what: "judge A/B", billed_by: "evals key", at: NOW - 2, by: HOST },
      { usd: 30, what: "shadow", billed_by: "evals key", at: NOW - 1, by: HOST },
      { usd: 10, what: "verify round", at: NOW, by: HOST },
    ];
    const project = (await ctx.db.get(TRIAL))!;
    const spend = await trialSpend(ctx, project, NOW);
    expect(spend.billed.usd).toBe(100);
    expect(spend.billed.keys).toEqual([{ billed_by: "evals key", usd: 90, entries: 2 }, { billed_by: UNNAMED_BILLER, usd: 10, entries: 1 }]);
    const r = await dispatchPass(ctx, project, NOW);
    expect(r.started).toEqual([]);
    expect(r.held).toBe("billed $100 of $100: the cap is reached");
  });

  test("a proposal whose author recommends waiting goes back once to gather its own evidence, in a run slot, instead of asking (tc-23)", async () => {
    const { ctx, tables } = world();
    tables.tasks.push(task("wait", "in_review", { workflow_run_id: "workflow_runs_wait" }));
    tables.workflow_runs.push(run("wait", "paused", NOW - 100, { gate_node_id: "proposal_gate" }));
    tables.trial_cards.push({
      _id: "trial_cards_wait", short_id: "tc-23", project_id: TRIAL, task_id: "tasks_wait", run_id: "workflow_runs_wait", node_id: "proposal_gate", kind: "gate", status: "waiting",
      options: [{ key: "A", label: "Build it" }, { key: "R", label: "Revise" }, { key: "D", label: "Not now" }],
      proposal: { kind: "proposal", recommend: { verdict: "wait", why: "A replay of the 19 found pairs would settle it." } }, created_at: NOW - 50,
    });
    const r = await dispatchPass(ctx, (await ctx.db.get(TRIAL))!, NOW);
    expect(r.gathering).toEqual(["tc-23"]);
    expect(r.started).toEqual(["ct-big"]);
    expect(tables.trial_cards.find((c: any) => c.short_id === "tc-23")).toMatchObject({ status: "answered", answer: { key: "R", note: GATHER_NOTE, stand_in: true } });
    expect(tables.workflow_runs.find((x: any) => x._id === "workflow_runs_wait")).toMatchObject({ status: "running", gate_response: `R: ${GATHER_NOTE}` });
    // It came back still recommending wait: held for a person to see, never sent back a second time.
    tables.workflow_runs.find((x: any) => x._id === "workflow_runs_wait").status = "paused";
    tables.trial_cards.push({ ...tables.trial_cards.find((c: any) => c.short_id === "tc-23"), _id: "trial_cards_wait2", short_id: "tc-40", status: "waiting", answer: undefined, created_at: NOW });
    expect((await gatherDue(ctx, (await ctx.db.get(TRIAL))!)).map((c) => c.short_id)).toEqual([]);
  });

  test("a run that reached Exit through a failure station with its problem open is stopped, with that station's words (ct-59438)", () => {
    const nodes = [
      { node_id: "dissolve", status: "completed", result_preview: "Both findings are real caller misses." },
      { node_id: "investigate", status: "completed", result_preview: "Union asked the caller for discovery on both calls; the human caller skipped it." },
      { node_id: "failed_at_investigate", status: "completed", result_preview: "ok Comment added to ct-59438" },
      { node_id: "exit", status: "completed" },
    ];
    expect(stopOf({ status: "completed", node_statuses: nodes } as any, "in_review")).toEqual({ station: "investigate", words: "Union asked the caller for discovery on both calls; the human caller skipped it." });
    expect(stopOf({ status: "completed", node_statuses: nodes } as any, "done")).toBeNull();
    expect(stopOf({ status: "completed", node_statuses: nodes.filter((n) => !n.node_id.startsWith("failed_at_")) } as any, "in_review")).toBeNull();
    expect(stopOf({ status: "failed", node_statuses: nodes } as any, "in_review")).toBeNull();
  });

  // The 16:31Z poll failure (ledger verify round 7): nine runs died waiting at their own cards.
  const lostAt = (w: ReturnType<typeof world>, id: string, node: string, kind: "gate" | "card" = "gate") => {
    w.tables.tasks.push(task(id, "in_review", { workflow_run_id: `workflow_runs_${id}`, execution_status: "blocked", execution_concerns: "x" }));
    w.tables.workflow_runs.push(run(id, "failed", NOW - 300, { runner_device: "dev-mac", current_node_id: node, fail_reason: `no outgoing edge from ${node} (outcome failure, review_verdict none)` }));
    w.tables.trial_cards.push({ _id: `trial_cards_${id}`, short_id: `tc-${id}`, project_id: TRIAL, task_id: `tasks_${id}`, run_id: `workflow_runs_${id}`, node_id: node, kind, status: "closed", options: [], created_at: NOW - 400 });
    w.tables.signals.push(...findings(id, 22, 8));
  };

  test("a run that died waiting at its own card is named by that card, and nothing else is", async () => {
    const w = world();
    lostAt(w, "lost", "proposal_gate");
    expect(await gateLossOf(w.ctx, (await w.ctx.db.get("workflow_runs_lost"))!)).toEqual({ node: "proposal_gate", card: "tc-lost", kind: "gate" });
    // Failed elsewhere (a station's rounds ran out): a fresh rerun, not a gate.
    expect(await gateLossOf(w.ctx, { _id: "workflow_runs_stale", status: "failed", fail_reason: "max_visits=2 exceeded on prove" } as any)).toBeNull();
    // The same words with no card at that node (not a trial gate): not a lost gate.
    expect(await gateLossOf(w.ctx, { _id: "workflow_runs_stale", status: "failed", fail_reason: "no outgoing edge from review (outcome failure)" } as any)).toBeNull();
  });

  test("the dispatcher picks a lost run up at its gate first, as the same run, past the run limit (ct-59338)", async () => {
    const w = world(1000);
    lostAt(w, "lost", "proposal_gate");
    const used = (await trialSpend(w.ctx, (await w.ctx.db.get(TRIAL))!, NOW)).runs;
    w.tables.projects[0].line_trial.dispatch.max_runs = used;
    const before = w.tables.workflow_runs.length;
    const r = await dispatchPass(w.ctx, (await w.ctx.db.get(TRIAL))!, NOW);
    expect(r.resumed).toEqual(["ct-lost"]);
    expect(r.started).toEqual([]);
    expect(r.due.map((d: any) => d.task)).not.toContain("ct-lost");
    expect(w.tables.workflow_runs.find((x: any) => x._id === "workflow_runs_lost")).toMatchObject({ status: "running", current_node_id: "proposal_gate", fail_reason: undefined, fresh_branch: true });
    expect(w.tables.workflow_runs.length).toBe(before);
    expect(w.tables.tasks.find((t: any) => t._id === "tasks_lost").execution_status).toBeUndefined();
    expect(w.tables.daemon_commands.map((c: any) => [c.command, JSON.parse(c.args).workflow_run_id, c.target_device_id])).toEqual([["run_workflow", "workflow_runs_lost", "dev-mac"]]);
    expect(w.tables.projects[0].line_trial.dispatch.last.started).toEqual(["ct-lost"]);
  });

  test("a rerun goes through the dispatcher's limits: a lost gate resumes past the run limit, a fresh rerun does not, and neither crosses the spend cap", async () => {
    const w = world(1000);
    lostAt(w, "lost", "decide", "card");
    w.tables.tasks.find((t: any) => t._id === "tasks_stale").workflow_run_id = "workflow_runs_stale";
    w.tables.workflow_runs.find((x: any) => x._id === "workflow_runs_stale").runner_device = "dev-mac";
    const used = (await trialSpend(w.ctx, (await w.ctx.db.get(TRIAL))!, NOW)).runs;
    w.tables.projects[0].line_trial.dispatch.max_runs = used;
    await expect(rerunCore(w.ctx, HOST, "ct-stale", NOW)).rejects.toThrow(`${used} of ${used} runs used`);
    expect(await rerunCore(w.ctx, HOST, "ct-lost", NOW)).toMatchObject({ task: "ct-lost", run_id: "workflow_runs_lost", resumed_at: "decide" });
    const broke = world(1000);
    lostAt(broke, "lost", "decide", "card");
    broke.tables.projects[0].line_trial.outside = [{ usd: 1000, what: "x", billed_by: "evals key", at: NOW, by: HOST }];
    await expect(rerunCore(broke.ctx, HOST, "ct-lost", NOW)).rejects.toThrow("billed $1000 of $1000: the cap is reached");
  });

  test("a run no machine ever claimed reruns on its route's newest machine, as the dispatcher would start it (ct-59568)", async () => {
    const w = world(1000);
    lostAt(w, "lost", "decide", "card");
    const r = await rerunCore(w.ctx, HOST, "ct-stale", NOW);
    expect(r.run_id).not.toBe("workflow_runs_stale");
    expect(w.tables.daemon_commands.map((c: any) => [JSON.parse(c.args).workflow_run_id, c.target_device_id])).toEqual([[r.run_id, "dev-mac"]]);
    const bare = world(1000);
    for (const x of bare.tables.workflow_runs) delete x.runner_device;
    await expect(rerunCore(bare.ctx, HOST, "ct-stale", NOW)).rejects.toThrow("names no machine, nor does any earlier run on its route");
  });

  /** A problem paused at its change card: the card's author read `read` and its fix reaches `covers`. */
  function carded(w: ReturnType<typeof world>, id: string, n: number, reach: { read: string[]; covers: string[] }, extra: Record<string, any> = {}) {
    w.tables.tasks.push(task(id, "in_review", { workflow_run_id: `workflow_runs_${id}`, user_id: HOST, team_id: TEAM, task_type: "task", priority: "medium", ...extra }));
    w.tables.workflow_runs.push(run(id, "paused", NOW - 100, { runner_device: "dev-mac", current_node_id: "decide", gate_node_id: "decide" }));
    w.tables.trial_cards.push({ _id: `trial_cards_${id}`, short_id: `tc-${id}`, run_id: `workflow_runs_${id}`, task_id: `tasks_${id}`, project_id: TRIAL, node_id: "decide", kind: "card", status: "waiting", card: { reach }, created_at: NOW - 60, updated_at: NOW - 60 });
    w.tables.signals.push(...findings(id, n, 6));
    w.tables.task_comments = w.tables.task_comments ?? [];
    w.tables.task_history = w.tables.task_history ?? [];
    return { task: () => w.tables.tasks.find((t: any) => t._id === `tasks_${id}`), run: () => w.tables.workflow_runs.find((x: any) => x._id === `workflow_runs_${id}`), card: () => w.tables.trial_cards.find((c: any) => c._id === `trial_cards_${id}`) };
  }
  const ids = (id: string, ...i: number[]) => i.map((k) => `sg-${id}${k}`);

  test("a re-ask words a card again only while its fix still answers the problem: findings changed and under half reached goes back to work, none reached ends the run and makes the problem due from main (ct-59433: one build, six cards)", async () => {
    const w = world(1000);
    // The fix reaches every finding the problem holds: asked again by its station.
    const same = carded(w, "same", 3, { read: ids("same", 0, 1, 2), covers: ids("same", 0, 1, 2) });
    expect(await reaskRoute(w.ctx, same.task(), same.card())).toEqual({ to: "card" });
    expect(await rerunCore(w.ctx, HOST, "ct-same", NOW, true, undefined, "card_write", "shared")).toMatchObject({ resumed_at: "card_write" });
    // Two findings arrived since the card and the fix reaches 1 of 4: the run reads the problem again.
    const moved = carded(w, "moved", 4, { read: ids("moved", 0, 1), covers: ids("moved", 0) });
    expect(await reaskRoute(w.ctx, moved.task(), moved.card())).toMatchObject({ to: "investigate" });
    expect(await rerunCore(w.ctx, HOST, "ct-moved", NOW, true, undefined, "card_write", "shared")).toMatchObject({ resumed_at: "shared", rebuild: "investigate" });
    expect(moved.run()).toMatchObject({ status: "running", current_node_id: "shared" });
    expect(moved.card().status).toBe("closed");
    same.run().status = moved.run().status = "completed";
    // The same split with nothing changed since the card is a person's Revise to make, not a rebuild.
    const partial = carded(w, "partial", 4, { read: ids("partial", 0, 1, 2, 3), covers: ids("partial", 0) });
    expect(await reaskRoute(w.ctx, partial.task(), partial.card())).toEqual({ to: "card" });
    // The fix reaches none of what the problem holds: no card session is spent, the run ends, the problem is open and due.
    const none = carded(w, "none", 7, { read: ids("none", 0, 1, 2, 3, 4, 5, 6), covers: [] });
    const used = (await trialSpend(w.ctx, (await w.ctx.db.get(TRIAL))!, NOW)).runs;
    w.tables.projects[0].line_trial.dispatch.max_runs = used;
    const r = await rerunCore(w.ctx, HOST, "ct-none", NOW, true, undefined, "card_write", "shared");
    expect(r).toMatchObject({ rebuild: "main", resumed_at: null });
    expect((r as any).why).toContain("none of the 7 conversations");
    expect(none.run()).toMatchObject({ status: "failed" });
    expect(none.card()).toMatchObject({ status: "closed", reopened_at: NOW });
    expect(none.task().status).toBe("open");
    const due = (await dueProblems(w.ctx, (await w.ctx.db.get(TRIAL))!)).due.find((d: any) => d.task === "ct-none");
    expect(due).toMatchObject({ findings: 7, reopened: "tc-none", regrouped: false });
    // The station the caller names is always taken.
    const forced = carded(w, "forced", 7, { read: ids("forced", 0), covers: [] });
    expect(await rerunCore(w.ctx, HOST, "ct-forced", NOW, true, "card_write", "card_write", "shared")).toMatchObject({ resumed_at: "card_write" });
    expect(forced.card().reopened_at).toBeUndefined();
  });

  test("--fresh starts a problem again from main wherever its run stands: the run ends, its card closes with the fix set aside, and a fresh-branch run of the same graph is queued (ct-59945: picked up at investigate, the old fix stayed on its branch and Prove refused it)", async () => {
    const w = world(1000);
    const old = carded(w, "old", 3, { read: ids("old", 0, 1, 2), covers: ids("old", 0, 1, 2) });
    // Picked up at investigate earlier: now working, on its old branch.
    Object.assign(old.run(), { status: "running", current_node_id: "prove", gate_node_id: undefined });
    const r = await rerunFromMainCore(w.ctx, HOST, "ct-old", NOW);
    expect(r).toMatchObject({ task: "ct-old", resumed_at: null, set_aside: "workflow_runs_old" });
    expect(old.run()).toMatchObject({ status: "failed", fail_reason: "Stopped: the problem was started again from main" });
    expect(old.card()).toMatchObject({ status: "closed", reopened_at: NOW });
    const next = w.tables.workflow_runs.find((x: any) => x._id === r.run_id);
    expect(next).toMatchObject({ fresh_branch: true, workflow_name: old.run().workflow_name });
    expect(w.tables.task_comments.at(-1).text).toContain("Started again from main");
    // A closed problem is not started again.
    old.task().status = "dropped";
    await expect(rerunFromMainCore(w.ctx, HOST, "ct-old", NOW)).rejects.toThrow("a closed problem is not run again");
  });

  test("Drop at the card does what the problem's findings call for: with findings left it stays open and due a run from main, with none it closes (tc-66 left 7 live findings in review with no run; tc-67, tc-70 held none)", async () => {
    const w = world(1000);
    const left = carded(w, "left", 7, { read: ids("left", 0, 1, 2, 3, 4, 5, 6), covers: [] });
    Object.assign(left.run(), { status: "running", current_node_id: "trial_drop", gate_node_id: undefined });
    Object.assign(left.card(), { status: "answered", answer: { key: "D", label: "Drop", by: HOST, at: NOW } });
    expect(await dropAtCardCore(w.ctx, HOST, "ct-left", "not this fix", NOW)).toMatchObject({ closed: false, status: "open", findings: 7, conversations: 7, card: "tc-left" });
    expect(left.task().status).toBe("open");
    // The run is the one dropping: it goes on to its exit.
    expect(left.run().status).toBe("running");
    expect(w.tables.task_comments.at(-1).text).toContain("7 findings in 7 conversations still need a fix");
    left.run().status = "completed";
    // A person's answer at a card normally keeps the problem off the queue; a dropped fix with findings left does not.
    expect((await dueProblems(w.ctx, (await w.ctx.db.get(TRIAL))!)).due.find((d: any) => d.task === "ct-left")).toMatchObject({ findings: 7, reopened: "tc-left" });

    const empty = carded(w, "gone", 0, { read: ids("gone", 0), covers: [] }, { cause: { fingerprints: [] } });
    Object.assign(empty.run(), { status: "running", current_node_id: "trial_drop", gate_node_id: undefined });
    expect(await dropAtCardCore(w.ctx, HOST, "ct-gone", undefined, NOW)).toMatchObject({ closed: true, status: "dropped", findings: 0 });
    expect(empty.task()).toMatchObject({ status: "dropped", cause: { dissolved: { at: NOW } } });
    expect((await dueProblems(w.ctx, (await w.ctx.db.get(TRIAL))!)).due.map((d: any) => d.task)).not.toContain("ct-gone");
  });

  test("a run still waiting at a gate on a closed problem is ended by the next pass: no card can answer it (ct-59242 at decide, ct-59534 at proposal_gate)", async () => {
    const w = world(1000);
    const merged = carded(w, "merged", 0, { read: [], covers: [] }, { cause: { merged_into: "tasks_big" } });
    merged.task().status = "dropped";
    const dry = await dispatchPass(w.ctx, (await w.ctx.db.get(TRIAL))!, NOW, true);
    expect(dry.ended).toEqual(["ct-merged"]);
    expect(merged.run().status).toBe("paused");
    const r = await dispatchPass(w.ctx, (await w.ctx.db.get(TRIAL))!, NOW);
    expect(r.ended).toEqual(["ct-merged"]);
    expect(merged.run()).toMatchObject({ status: "failed", fail_reason: "Stopped: the problem was merged into another while the run waited" });
    expect((await dispatchPass(w.ctx, (await w.ctx.db.get(TRIAL))!, NOW, true)).ended).toEqual([]);
  });

  test("the sweep closes every card still waiting on a closed problem, however its run ended, and leaves an open problem's card (retiring the old AgentWatch, 2026-10-20)", async () => {
    const w = world(1000);
    const paused = carded(w, "paused", 0, { read: [], covers: [] });
    paused.task().status = "dropped";
    const gone = carded(w, "gone", 0, { read: [], covers: [] });
    gone.task().status = "dropped";
    // Its run ended past a proposal whose question still stands (proposalHolds): the question goes with the card.
    Object.assign(gone.run(), { status: "completed", gate_node_id: undefined });
    w.tables.session_decisions.push({ _id: "session_decisions_gone", user_id: HOST, status: "pending", question: "Build it?", options: [], trial: true, workflow_run_id: "workflow_runs_gone", task_id: "tasks_gone", created_at: NOW - 60 });
    gone.card().decision_id = "session_decisions_gone";
    const open = carded(w, "open", 2, { read: ids("open", 0, 1), covers: ids("open", 0, 1) });
    const project = (await w.ctx.db.get(TRIAL))!;
    expect((await sweepClosed(w.ctx, project, NOW, true)).cards_closed.sort()).toEqual(["tc-gone", "tc-paused"]);
    // Naming problems closes only theirs.
    expect((await sweepClosed(w.ctx, project, NOW, true, ["ct-gone"])).cards_closed).toEqual(["tc-gone"]);
    expect(paused.card().status).toBe("waiting");
    const r = await sweepClosed(w.ctx, project, NOW, false);
    expect(r.ended).toEqual(["ct-paused"]);
    expect(paused.run()).toMatchObject({ status: "failed", fail_reason: "Stopped: the problem was dropped while the run waited" });
    expect([paused.card().status, gone.card().status, open.card().status]).toEqual(["closed", "closed", "waiting"]);
    expect(w.tables.session_decisions.find((d: any) => d._id === "session_decisions_gone").status).toBe("withdrawn");
  });

  test("a problem that closes, by whatever path, withdraws its pending questions with the close's reason and closes their waiting cards (sd-668, sd-686 sat pending on closed problems)", async () => {
    const w = world(1000);
    const gone = carded(w, "shut", 0, { read: [], covers: [] }, { cause: { fingerprints: [] } });
    Object.assign(gone.run(), { status: "running", current_node_id: "trial_drop", gate_node_id: undefined });
    w.tables.session_decisions.push({ _id: "session_decisions_shut", short_id: "sd-9", user_id: HOST, status: "pending", question: "Ship it?", options: [], trial: true, task_id: "tasks_shut", created_at: NOW - 60 });
    gone.card().decision_id = "session_decisions_shut";
    await dropAtCardCore(w.ctx, HOST, "ct-shut", undefined, NOW);
    const asked = w.tables.session_decisions.find((d: any) => d._id === "session_decisions_shut");
    expect(asked).toMatchObject({ status: "withdrawn" });
    expect(asked.withdrawn_reason).toContain("Trial: dropped at the card");
    expect(gone.card().status).toBe("closed");
  });

  test("the same outside spend twice within the hour is a repeat (card fix round 6, $40.67 twice)", () => {
    const outside = [{ usd: 40.67, what: "card fix round 6 dry runs, login", at: NOW }];
    expect(repeatedOutside(outside, 40.67, "card fix round 6 dry runs, login", NOW + 118_000)).toBe(outside[0]);
    expect(repeatedOutside(outside, 40.67, "card fix round 7 dry runs, login", NOW + 118_000)).toBeNull();
    expect(repeatedOutside(outside, 40.67, "card fix round 6 dry runs, login", NOW + OUTSIDE_REPEAT_MS)).toBeNull();
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
    // ct-59688: a problem gathered from two judges' cases, keyed per ruled finding, with no issue key, is still the judge route.
    expect(routeOf({ cause: { fingerprints: ["judge:codecast:match:sg-2713", "extractor:match:sg-2733"] } } as any)).toBe("judge");
    expect(routeOf({ cause: { fingerprints: ["judge:codecast:match:sg-2713", "evidence:contacts/x:ex-3:aa"] } } as any)).toBe("product");
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

  test("a shared rule is an overlap only where the fixes change the same file (tc-33, tc-22, tc-29, tc-40 all break ex-3)", () => {
    const tc22 = ["outreach/backend/src/lib/agent/prompts/templates/partials/proactive-task.njk:264"];
    const tc29 = ["outreach/backend/src/lib/agent/prompts/templates/layers/matching.njk:347"];
    const tc40 = ["backend/src/lib/agent/timelineRender.ts:669", "backend/src/lib/agent/tools/sendEmail.ts:1516"];
    expect(overlapOf(tc22, tc29, true)).toBeNull();
    expect(overlapOf(tc22, tc40, true)).toBeNull();
    expect(overlapOf(tc29, ["backend/src/lib/agent/prompts/templates/layers/matching.njk:120"], true)).toEqual({ on: "rule", where: tc29[0] });
    expect(overlapOf(tc29, ["backend/src/lib/agent/prompts/templates/layers/matching.njk:120"], false)).toBeNull();
    expect(overlapOf(tc40, ["backend/src/lib/agent/tools/sendEmail.ts:1510"], false)).toEqual({ on: "code", where: tc40[1] });
  });
});

// ct-59534 merged into ct-59254: its card tc-28 is answered by the survivor's,
// never linked beside it as a live "Same rule as" sibling (pl-882 clustering).
describe("a merged problem's card is superseded by the survivor's", () => {
  test("the chain is followed to the problem that still stands and its newest card", async () => {
    const tasks: Record<string, any> = {
      t1: { _id: "t1", short_id: "ct-1", cause: { merged_into: "t2" } },
      t2: { _id: "t2", short_id: "ct-2", cause: { merged_into: "t3" } },
      t3: { _id: "t3", short_id: "ct-3", cause: {} },
      t4: { _id: "t4", short_id: "ct-4", cause: {} },
      t5: { _id: "t5", short_id: "ct-5", cause: { merged_into: "t4" } },
    };
    const v = (short_id: string, task: string, created_at: number) => ({ short_id, task_id: task as any, task_short_id: tasks[task].short_id, created_at, merged_into: tasks[task].cause.merged_into ?? null, superseded_by: null as any });
    const cards = [v("tc-1", "t1", 1), v("tc-2", "t3", 2), v("tc-3", "t3", 3), v("tc-4", "t5", 4)];
    await supersedeMerged(cards, async (id) => tasks[id as any] ?? null);
    expect(cards.map((c) => c.superseded_by)).toEqual([{ card: "tc-3", task: "ct-3" }, null, null, { task: "ct-4" }]);
  });
});

describe("card fix round 10", () => {
  test("a gate its line no longer has is gone; an unknown graph says nothing (tc-41 at proposal_gate)", () => {
    const nodes = [{ id: "propose" }, { id: "build" }, { id: "decide" }] as any;
    expect(gateGone("proposal_gate", { nodes })).toBe(true);
    expect(gateGone("decide", { nodes })).toBe(false);
    expect(gateGone("proposal_gate", { nodes: [] })).toBe(false);
    expect(gateGone("proposal_gate", null)).toBe(false);
  });

  test("a run's working minutes are its stations' own time, a gate's wait left out (tc-70 read 1059 min for a 41 min build)", () => {
    const m = 60_000;
    const run = { node_statuses: [
      { node_id: "build", status: "completed", started_at: 0, completed_at: 30 * m },
      { node_id: "proposal_gate", status: "completed", started_at: 30 * m, completed_at: 900 * m },
      { node_id: "card_write", status: "completed", started_at: 900 * m, completed_at: 911 * m },
      { node_id: "decide", status: "running", started_at: 911 * m },
    ] } as any;
    expect(workMinutes(run, (n) => n === "proposal_gate" || n === "decide")).toBe(41);
  });
});
