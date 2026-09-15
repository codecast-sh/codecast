// the-line.md L4 and L8: a gate on the line is a decision in the person's
// queue, and a run belongs to the workspace its task lives in. Driven
// through the exported core functions and the mutation handlers against the
// fake db, the same way sessionDecisions.test.ts drives the ask rail.
import { describe, expect, test } from "bun:test";
import { makeFakeDb } from "./testDb";
import {
  pauseAtGateCore,
  respondToGateFromCli,
  respondToGate,
  cancel,
  createFromCli,
  listRunsCore,
  pollGateResponse,
} from "./workflow_runs";
import { resolve, withdraw, answerCore } from "./sessionDecisions";
import { hashToken } from "./apiTokens";

const HOST = "users_host" as any; // owns the run and the asking session
const MATE = "users_mate" as any; // a teammate who can read the task
const STRANGER = "users_stranger" as any; // no team membership
const TEAM = "teams_acme" as any;
const TOKEN = "gate-test-token";
const RUN = "workflow_runs_run";
const TASK = "tasks_t1";
const NOW = 1_800_000_000_000;

const choices = [
  { key: "A", label: "[A] Approve", description: "ships now", target: "exit" },
  { key: "B", label: "[B] Revise", description: "another round", target: "implement" },
];

async function seed(extra: Record<string, any[]> = {}) {
  const tables: Record<string, any[]> = {
    users: [
      { _id: HOST, name: "Host" },
      { _id: MATE, name: "Mate" },
      { _id: STRANGER, name: "Stranger" },
    ],
    teams: [{ _id: TEAM, name: "Acme" }],
    team_memberships: [
      { _id: "m1", user_id: HOST, team_id: TEAM, role: "admin" },
      { _id: "m2", user_id: MATE, team_id: TEAM, role: "member" },
    ],
    api_tokens: [
      { _id: "token_host", user_id: HOST, token_hash: await hashToken(TOKEN) },
      { _id: "token_stranger", user_id: STRANGER, token_hash: await hashToken("stranger-token") },
    ],
    org_roles: [],
    session_owners: [],
    directory_team_mappings: [],
    conversations: [
      // The session that started the run: the asker (L4 step 1).
      { _id: "conversations_spawner", session_id: "sess-spawner", user_id: HOST, team_id: TEAM, message_count: 2 },
      { _id: "conversations_primary", session_id: `wf-${RUN}`, user_id: HOST, team_id: TEAM, message_count: 1, workflow_run_id: RUN, is_workflow_primary: true },
    ],
    tasks: [{ _id: TASK, short_id: "ct-7", user_id: HOST, team_id: TEAM, workspace: `team:${TEAM}`, title: "Ship the thing", status: "in_progress", task_type: "task", priority: "medium", workflow_run_id: RUN }],
    workflows: [{ _id: "workflows_line", user_id: HOST, name: "line", slug: "line", nodes: [{ id: "review", label: "Review", shape: "hexagon", type: "human" }], edges: [] }],
    workflow_runs: [{
      _id: RUN, user_id: HOST, workflow_id: "workflows_line", task_id: TASK, status: "running", node_statuses: [],
      workspace: `team:${TEAM}`, team_id: TEAM,
      spawner_conversation_id: "conversations_spawner", primary_conversation_id: "conversations_primary",
      created_at: NOW, updated_at: NOW,
    }],
    messages: [],
    session_decisions: [],
    decision_inbox: [],
    decision_grants: [],
    decision_stacks: [],
    docs: [],
    counters: [],
    pending_messages: [],
    daemon_commands: [],
    ...extra,
  };
  const db = makeFakeDb(tables);
  const ctx = { db, scheduler: { runAfter: async () => null }, async runMutation() { return null; } } as any;
  return { ctx, tables, db };
}

const asUser = (ctx: any, userId: string) => ({ ...ctx, auth: { async getUserIdentity() { return { subject: `${userId}|session` }; } } });

async function pause(ctx: any, extra: Record<string, any> = {}) {
  return pauseAtGateCore(ctx, { userId: HOST }, {
    run_id: RUN as any,
    node_id: "review",
    prompt: "Ship the branch?\nThe reviewer approved with two notes.",
    choices,
    ...extra,
  });
}

describe("pauseAtGate asks through the decision rail (the-line.md L4)", () => {
  test("creates a blocking decision bound to the task at its station, with the options and the run", async () => {
    const { ctx, tables } = await seed();
    const r = await pause(ctx, { doc_md: "# Review\n\nLooks good.", category: "review" });
    expect(r.ok).toBe(true);
    expect(r.decision_short_id).toBe("sd-1");

    const row = tables.session_decisions[0];
    expect(row.conversation_id).toBe("conversations_spawner");
    expect(row.question).toBe("Ship the branch?");
    expect(row.context_md).toBe("The reviewer approved with two notes.");
    expect(row.blocking).toBe(true);
    expect(row.task_id).toBe(TASK);
    // The gate parks the task in review; the hold (L5) binds there.
    expect(row.station).toBe("in_review");
    expect(row.options).toEqual([
      { label: "Approve", description: "ships now" },
      { label: "Revise", description: "another round" },
    ]);
    expect(row.workflow_run_id).toBe(RUN);
    expect(row.gate_node_id).toBe("review");
    expect(row.category).toBe("review");
    expect(tables.docs).toHaveLength(1);
    expect(tables.docs[0].content).toBe("# Review\n\nLooks good.");

    const run = tables.workflow_runs[0];
    expect(run.status).toBe("paused");
    expect(run.gate_decision_id).toBe(row._id);
    expect(run.gate_node_id).toBe("review");
    // The mirror for old readers keeps key, label and target.
    expect(run.gate_choices).toEqual(choices.map(({ key, label, target }) => ({ key, label, target })));
    expect(run.gate_prompt).toBe("Ship the branch?\nThe reviewer approved with two notes.");

    const gateMsg = tables.messages.find((m) => m.subtype === "workflow_event");
    const parsed = JSON.parse(gateMsg.content);
    expect(parsed.__wf).toBe("gate");
    expect(parsed.decision_id).toBe(row._id);
    expect(parsed.decision_short_id).toBe("sd-1");
  });

  test("a graph stack name creates one stack per run on the first gate and appends the next gate to it", async () => {
    const { ctx, tables } = await seed();
    await pause(ctx, { stack: "Launch checklist" });
    expect(tables.decision_stacks).toHaveLength(1);
    expect(tables.decision_stacks[0].title).toBe("Launch checklist");
    expect(tables.session_decisions[0].stack_id).toBe(tables.decision_stacks[0]._id);

    // Answer it so the run resumes, then the next gate.
    await answerCore(ctx, { userId: HOST }, { decision_id: "sd-1", answer_index: 0 });
    tables.workflow_runs[0].status = "running";
    await pause(ctx, { node_id: "ship", stack: "Launch checklist" });
    expect(tables.decision_stacks).toHaveLength(1);
    expect(tables.session_decisions[1].stack_id).toBe(tables.decision_stacks[0]._id);
    expect(tables.decision_stacks[0].decision_ids).toEqual(tables.session_decisions.map((d) => d._id));
    // Answering the first gate closed the stack; the second gate reopened it.
    expect(tables.decision_stacks[0].status).toBe("open");
  });

  test("the primary conversation asks when the run has no spawner", async () => {
    const { ctx, tables } = await seed();
    tables.workflow_runs[0].spawner_conversation_id = undefined;
    await pause(ctx);
    expect(tables.session_decisions[0].conversation_id).toBe("conversations_primary");
  });
});

describe("answering a gate resumes the run (the-line.md L4)", () => {
  test("the web resolve sets gate_response to the chosen key and status running, and delivers nothing to the asker", async () => {
    const { ctx, tables } = await seed();
    await pause(ctx);
    const row = tables.session_decisions[0];
    const r = await (resolve as any)._handler(asUser(ctx, HOST), { decision_id: row._id, status: "answered", answer_index: 1 });
    expect(r.already_resolved).toBe(false);
    const run = tables.workflow_runs[0];
    expect(run.status).toBe("running");
    expect(run.gate_response).toBe("B");
    expect(row.status).toBe("answered");
    expect(tables.pending_messages).toHaveLength(0);
    // The runner's poll reads the run as before.
    const poll = await (pollGateResponse as any)._handler(ctx, { api_token: TOKEN, run_id: RUN });
    expect(poll).toEqual({ status: "running", gate_response: "B" });
  });

  test("respondToGate with 'B: go' answers option B and keeps the note in front of the runner", async () => {
    const { ctx, tables } = await seed();
    await pause(ctx);
    await (respondToGate as any)._handler(asUser(ctx, HOST), { id: RUN, response: "B: go" });
    const row = tables.session_decisions[0];
    expect(row.status).toBe("answered");
    expect(row.answer_index).toBe(1);
    const run = tables.workflow_runs[0];
    expect(run.status).toBe("running");
    expect(run.gate_response).toBe("B: go");
    // The human's text still lands in the primary conversation.
    const userMsg = tables.messages.find((m) => m.role === "user");
    expect(userMsg.content).toBe("B: go");
  });

  test("respondToGateFromCli is the same call; free text becomes answer_text; first writer wins", async () => {
    const { ctx, tables } = await seed();
    await pause(ctx);
    const first = await (respondToGateFromCli as any)._handler(ctx, { api_token: TOKEN, run_id: RUN, response: "ship after the fix lands" });
    expect(first).toEqual({ ok: true });
    const row = tables.session_decisions[0];
    expect(row.answer_index).toBeUndefined();
    expect(row.answer_text).toBe("ship after the fix lands");
    expect(tables.workflow_runs[0].gate_response).toBe("ship after the fix lands");
    const second = await (respondToGateFromCli as any)._handler(ctx, { api_token: TOKEN, run_id: RUN, response: "A" });
    expect(second.error).toBe("Not paused");
    const late = await answerCore(ctx, { userId: HOST }, { decision_id: "sd-1", answer_index: 0 });
    expect(late.error).toMatch(/already answered/);
  });

  test("a stranger cannot answer through the run", async () => {
    const { ctx } = await seed();
    await pause(ctx);
    const r = await (respondToGateFromCli as any)._handler(ctx, { api_token: "stranger-token", run_id: RUN, response: "A" });
    expect(r.error).toBe("Not found");
  });
});

describe("withdrawing a gate (the-line.md L4)", () => {
  test("cancel withdraws the run's open gate decision through the shared withdraw path", async () => {
    const { ctx, tables } = await seed();
    await pause(ctx);
    await (cancel as any)._handler(asUser(ctx, HOST), { id: RUN });
    const row = tables.session_decisions[0];
    expect(row.status).toBe("withdrawn");
    expect(tables.decision_inbox.every((i) => i.status === "done")).toBe(true);
    expect(tables.workflow_runs[0].status).toBe("failed");
    expect(tables.workflow_runs[0].fail_reason).toBe("Cancelled by user");
  });

  test("withdraw on the gate decision fails the run with 'gate withdrawn'", async () => {
    const { ctx, tables } = await seed();
    await pause(ctx);
    const r = await (withdraw as any)._handler(ctx, { api_token: TOKEN, decision_id: "sd-1" });
    expect(r.status).toBe("withdrawn");
    expect(tables.workflow_runs[0].status).toBe("failed");
    expect(tables.workflow_runs[0].fail_reason).toBe("gate withdrawn");
  });
});

describe("runs belong to the workspace (the-line.md L8)", () => {
  test("a teammate reads the run through listRuns, on the task and in the team; a stranger reads nothing", async () => {
    const { ctx, tables } = await seed();
    await pause(ctx);
    const mine = await listRunsCore(ctx, MATE, { task_id: "ct-7" });
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({
      _id: RUN,
      task_short_id: "ct-7",
      workflow_name: "line",
      current_node_label: "Review",
      gate_decision_short_id: "sd-1",
      gate_decision_status: "pending",
    });
    const team = await listRunsCore(ctx, MATE, { team_id: TEAM, status: "paused" });
    expect(team.map((r) => r._id)).toEqual([RUN]);
    expect(await listRunsCore(ctx, MATE, { team_id: TEAM, status: "completed" })).toEqual([]);

    expect(await listRunsCore(ctx, STRANGER, { task_id: "ct-7" })).toEqual([]);
    expect(await listRunsCore(ctx, STRANGER, {})).toEqual([]);
    await expect(listRunsCore(ctx, STRANGER, { team_id: TEAM })).rejects.toThrow();
    void tables;
  });

  test("createFromCli stamps workspace and team_id from the bound task", async () => {
    const { ctx, tables } = await seed();
    const r = await (createFromCli as any)._handler(ctx, { api_token: TOKEN, workflow_name: "line", task_id: "ct-7", spawner_session: "sess-spawner" });
    const run = tables.workflow_runs.find((x) => x._id === r.run_id);
    expect(run.workspace).toBe(`team:${TEAM}`);
    expect(run.team_id).toBe(TEAM);
    expect(run.spawner_conversation_id).toBe("conversations_spawner");
    expect(run.workflow_id).toBe("workflows_line");
  });

  test("createFromCli with no task stamps the personal key from an unmapped directory", async () => {
    const { ctx, tables } = await seed();
    const r = await (createFromCli as any)._handler(ctx, { api_token: TOKEN, workflow_name: "line", project_path: "/tmp/private" });
    const run = tables.workflow_runs.find((x) => x._id === r.run_id);
    expect(run.workspace).toBe(`user:${HOST}`);
    expect(run.team_id).toBeUndefined();
  });
});
