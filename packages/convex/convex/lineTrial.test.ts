// Trial projects (lineTrial.ts): a gate on a trial project's run asks nobody
// and becomes a trial card; the card's answer moves the run; an agent stands in
// only at an earlier gate; nothing merges; the sweep never starts a trial
// problem. Driven against the fake db, the way workflow_runs.gate.test.ts
// drives the decision rail.
import { describe, expect, test } from "bun:test";
import { makeFakeDb } from "./testDb";
import { pauseAtGateCore } from "./workflow_runs";
import { answerTrialCardCore, isTrialRun, problemEvidence, trialProjectOf } from "./lineTrial";

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
