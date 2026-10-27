// A run outlives its runner (cli workflow/runResume.ts): Resume hands a live
// run to the daemon of the machine that drove it, and a daemon's sweep reads
// the live runs it drove. Driven against the fake db like the gate tests.
import { describe, expect, test } from "bun:test";
import { makeFakeDb } from "./testDb";
import { resumeFailedRunCore, resumeQueuedRun } from "./failedRunResume";
import { failStrandedPendingRuns, liveRunsForDevice, reaskRunCore, resumeRunCore, STRANDED_PENDING_MS } from "./workflow_runs";
import { hashToken } from "./apiTokens";

const HOST = "users_host" as any;
const MATE = "users_mate" as any;
const TEAM = "teams_acme" as any;
const RUN = "workflow_runs_run" as any;
const TOKEN = "resume-test-token";
const NOW = 1_800_000_000_000;

async function seed(run: Record<string, any> = {}) {
  const tables: Record<string, any[]> = {
    users: [{ _id: HOST, name: "Host" }, { _id: MATE, name: "Mate" }],
    teams: [{ _id: TEAM, name: "Acme" }],
    team_memberships: [
      { _id: "m1", user_id: HOST, team_id: TEAM, role: "admin" },
      { _id: "m2", user_id: MATE, team_id: TEAM, role: "member" },
    ],
    api_tokens: [{ _id: "token_host", user_id: HOST, token_hash: await hashToken(TOKEN) }],
    conversations: [{ _id: "conversations_hand", short_id: "jxhand1", session_id: "uuid-hand", user_id: HOST, team_id: TEAM, owner_device_id: "dev-laptop" }],
    managed_sessions: [],
    session_decisions: [],
    daemon_commands: [],
    workflow_runs: [{
      _id: RUN, user_id: HOST, status: "running", current_node_id: "decide", gate_node_id: "decide", gate_response: "S",
      node_statuses: [{ node_id: "card_write", status: "completed", outcome: "success", session_id: "jxhand1" }, { node_id: "decide", status: "running" }],
      workspace: `team:${TEAM}`, team_id: TEAM, created_at: NOW, updated_at: NOW,
      ...run,
    }],
  };
  const db = makeFakeDb(tables);
  return { ctx: { db } as any, tables };
}

const commandArgs = (tables: Record<string, any[]>) => tables.daemon_commands.map((c) => ({ command: c.command, device: c.target_device_id, args: JSON.parse(c.args) }));

describe("resumeRunCore", () => {
  test("hands a live run to the daemon of the machine its runner named", async () => {
    const { ctx, tables } = await seed({ runner_device: "dev-mini" });
    expect(await resumeRunCore(ctx, HOST, RUN)).toEqual({ ok: true });
    expect(commandArgs(tables)).toEqual([{ command: "run_workflow", device: "dev-mini", args: { workflow_run_id: RUN } }]);
    // The gate's answer stays on the row for the resumed runner to take.
    expect(tables.workflow_runs[0]).toMatchObject({ status: "running", gate_response: "S" });
    expect(tables.workflow_runs[0].resume_requested_at).toBeGreaterThan(0);
  });

  test("a run from before runners named their machine resumes where its last station ran", async () => {
    const { ctx, tables } = await seed();
    await resumeRunCore(ctx, HOST, RUN);
    expect(commandArgs(tables)[0].device).toBe("dev-laptop");
  });

  test("only the owner resumes, and only a live run", async () => {
    const { ctx, tables } = await seed({ runner_device: "dev-mini" });
    await expect(resumeRunCore(ctx, MATE, RUN)).rejects.toThrow("owner");
    const ended = await seed({ status: "failed" });
    await expect(resumeRunCore(ended.ctx, HOST, RUN)).rejects.toThrow("nothing to resume");
    expect(tables.daemon_commands).toEqual([]);
  });
});

describe("reaskRunCore", () => {
  const SD = "session_decisions_old" as any;
  const WF = "workflows_line" as any;
  async function waiting(run: Record<string, any> = {}, task: Record<string, any> = {}) {
    const w = await seed({ status: "paused", runner_device: "dev-mini", task_id: "tasks_cause", workflow_id: WF, gate_decision_id: SD, gate_prompt: "Ship this change?", gate_response: undefined, ...run });
    w.tables.tasks = [{ _id: "tasks_cause", short_id: "ct-9", title: "A problem", status: "in_review", user_id: HOST, team_id: TEAM, workspace: `team:${TEAM}`, created_at: NOW, updated_at: NOW, ...task }];
    w.tables.projects = [{ _id: "projects_trial", title: "Trial", line_trial: { by: HOST } }];
    w.tables.workflows = [{ _id: WF, slug: "line", nodes: [{ id: "card_write", type: "prompt" }, { id: "decide", type: "human" }] }];
    w.tables.session_decisions = [{ _id: SD, short_id: "sd-1", status: "pending", user_id: HOST, workflow_run_id: RUN, conversation_id: "conversations_hand", question: "Ship this change?", options: [], created_at: NOW }];
    return w;
  }

  test("a waiting decision is asked again by the station that presents it, and the old one is withdrawn without failing the run", async () => {
    const { ctx, tables } = await waiting();
    expect(await reaskRunCore(ctx, HOST, RUN, { asker: "card_write" }, NOW + 1)).toEqual({ run_id: RUN, task: "ct-9", resumed_at: "card_write", replaced: "sd-1" });
    expect(tables.workflow_runs[0]).toMatchObject({ status: "running", current_node_id: "card_write", fresh_branch: true });
    expect(tables.workflow_runs[0].gate_decision_id).toBeUndefined();
    expect(tables.workflow_runs[0].gate_node_id).toBeUndefined();
    expect(tables.session_decisions[0].status).toBe("withdrawn");
    expect(commandArgs(tables)).toEqual([{ command: "run_workflow", device: "dev-mini", args: { workflow_run_id: RUN } }]);
  });

  test("a named station wins over the asker, and a gate with no asker is asked again where it stands", async () => {
    const named = await waiting();
    expect((await reaskRunCore(named.ctx, HOST, RUN, { at: "analyze", asker: "card_write" }, NOW + 1)).resumed_at).toBe("analyze");
    const bare = await waiting();
    expect((await reaskRunCore(bare.ctx, HOST, RUN, {}, NOW + 1)).resumed_at).toBe("decide");
  });

  test("a run that failed standing at its gate is asked again, and its blocked problem is unblocked", async () => {
    const { ctx, tables } = await waiting({ status: "failed", fail_reason: "hand killed", gate_node_id: undefined, gate_decision_id: undefined }, { status: "open", execution_status: "blocked", execution_concerns: "hand killed" });
    expect(await reaskRunCore(ctx, HOST, RUN, { asker: "card_write" }, NOW + 1)).toMatchObject({ resumed_at: "card_write", replaced: null });
    expect(tables.workflow_runs[0]).toMatchObject({ status: "running", current_node_id: "card_write" });
    expect(tables.workflow_runs[0].fail_reason).toBeUndefined();
    expect(tables.tasks[0].execution_status).toBeUndefined();
  });

  test("refused, or only checked, writes nothing: another person, a run not at a decision, a closed problem, a trial problem", async () => {
    const mate = await waiting();
    await expect(reaskRunCore(mate.ctx, MATE, RUN)).rejects.toThrow("owner");
    const working = await waiting({ status: "running", current_node_id: "implement", gate_node_id: undefined, gate_decision_id: undefined });
    await expect(reaskRunCore(working.ctx, HOST, RUN)).rejects.toThrow("not waiting on a decision");
    const midway = await waiting({ status: "failed", current_node_id: "card_write", gate_node_id: undefined, gate_decision_id: undefined });
    await expect(reaskRunCore(midway.ctx, HOST, RUN)).rejects.toThrow("did not end at one");
    const closed = await waiting({}, { status: "done" });
    await expect(reaskRunCore(closed.ctx, HOST, RUN)).rejects.toThrow("closed problem");
    const trial = await waiting({}, { project_id: "projects_trial" });
    await expect(reaskRunCore(trial.ctx, HOST, RUN)).rejects.toThrow("cast flow trial rerun ct-9 --reask");
    const checked = await waiting();
    expect(await reaskRunCore(checked.ctx, HOST, RUN, { asker: "card_write", check: true })).toMatchObject({ resumed_at: "card_write", replaced: null });
    expect(checked.tables.workflow_runs[0]).toMatchObject({ status: "paused", gate_decision_id: SD });
    for (const w of [mate, working, midway, closed, trial, checked]) expect(w.tables.daemon_commands).toEqual([]);
    expect(trial.tables.session_decisions[0].status).toBe("pending");
  });
});

describe("resumeFailedRunCore (cast workflow resume)", () => {
  async function failed(run: Record<string, any> = {}, task: Record<string, any> = {}) {
    const w = await seed({ status: "failed", current_node_id: "implement", gate_node_id: undefined, gate_response: undefined, fail_reason: "max_visits=3 exceeded on implement", runner_device: "dev-mini", task_id: "tasks_cause", ...run });
    w.tables.tasks = [{ _id: "tasks_cause", short_id: "ct-9", title: "A problem", status: "open", execution_status: "blocked", execution_concerns: "max_visits", user_id: HOST, team_id: TEAM, workspace: `team:${TEAM}`, created_at: NOW, updated_at: NOW, ...task }];
    w.tables.projects = [{ _id: "projects_trial", title: "Trial", line_trial: { by: HOST } }];
    return w;
  }

  test("a failed run goes on from the named station on its machine, as a new attempt, its problem unblocked", async () => {
    const { ctx, tables } = await failed();
    expect(await resumeFailedRunCore(ctx, HOST, RUN, "verify", {}, NOW + 1)).toEqual({ run_id: RUN, task: "ct-9", resumed_at: "verify", queued: false });
    expect(tables.workflow_runs[0]).toMatchObject({ status: "running", current_node_id: "verify", visits_reset_at: NOW + 1, fresh_branch: true });
    expect(tables.workflow_runs[0].fail_reason).toBeUndefined();
    expect(tables.tasks[0].execution_status).toBeUndefined();
    expect(commandArgs(tables)).toEqual([{ command: "run_workflow", device: "dev-mini", args: { workflow_run_id: RUN } }]);
  });

  test("queued, a resume is recorded for the line's sweep and starts nothing yet", async () => {
    const { ctx, tables } = await failed();
    expect(await resumeFailedRunCore(ctx, HOST, RUN, "verify", { queue: true }, NOW + 1)).toMatchObject({ resumed_at: "verify", queued: true });
    expect(tables.workflow_runs[0]).toMatchObject({ status: "failed", resume_queued: { at: "verify", by: HOST, since: NOW + 1 } });
    expect(commandArgs(tables)).toEqual([]);
  });

  test("a run that ended through one of its graph's failure stations resumes like a failed one; one that ended well does not", async () => {
    // Oct 26: ct-61693's Revise ended at failed_at_build, then exit, so the run read completed and could not be resumed.
    const ended = (last: string) => failed({
      status: "completed", fail_reason: undefined, current_node_id: "exit",
      node_statuses: [{ node_id: "build", status: "completed", completed_at: NOW - 2 }, { node_id: last, status: "completed", completed_at: NOW - 1 }, { node_id: "exit", status: "completed", completed_at: NOW }],
    });
    const stopped = await ended("failed_at_build");
    expect(await resumeFailedRunCore(stopped.ctx, HOST, RUN, "decide", {}, NOW + 1)).toMatchObject({ resumed_at: "decide" });
    expect(stopped.tables.workflow_runs[0]).toMatchObject({ status: "running", current_node_id: "decide", visits_reset_at: NOW + 1 });
    const shipped = await ended("watch");
    await expect(resumeFailedRunCore(shipped.ctx, HOST, RUN, "decide")).rejects.toThrow("only a failed run");
  });

  test("an approved run whose merge station left the merge to a person resumes at its merge station, now or queued; one that merged does not", async () => {
    // Oct 27: 31 of Union's approved fixes walked on from a merge left to a person (merge was off) to watch and exit.
    const ended = (merge: string) => failed({
      status: "completed", fail_reason: undefined, current_node_id: "exit",
      node_statuses: [{ node_id: "push", status: "completed", completed_at: NOW - 3 }, { node_id: "merge", status: "completed", completed_at: NOW - 2, result_preview: merge }, { node_id: "watch", status: "completed", completed_at: NOW - 1 }, { node_id: "exit", status: "completed", completed_at: NOW }],
    }, { status: "in_review", execution_status: undefined, execution_concerns: undefined });
    const left = await ended("merge left to a person: merge is off for this flow; a person turns it on with cast role line --merge on");
    expect(await resumeFailedRunCore(left.ctx, HOST, RUN, "merge", {}, NOW + 1)).toMatchObject({ resumed_at: "merge", queued: false });
    expect(left.tables.workflow_runs[0]).toMatchObject({ status: "running", current_node_id: "merge", visits_reset_at: NOW + 1 });
    expect(commandArgs(left.tables)).toEqual([{ command: "run_workflow", device: "dev-mini", args: { workflow_run_id: RUN } }]);
    const queued = await ended("merge left to a person: the role has reached its daily merge limit (25 of 25)");
    expect(await resumeFailedRunCore(queued.ctx, HOST, RUN, "merge", { queue: true }, NOW + 1)).toMatchObject({ queued: true });
    expect(await resumeQueuedRun(queued.ctx, RUN, NOW + 2)).toBe(RUN);
    expect(queued.tables.workflow_runs[0]).toMatchObject({ status: "running", current_node_id: "merge" });
    const merged = await ended("merged codecast/agentwatch-ct-9 into main at 0123456789 (3 of 25 today)");
    await expect(resumeFailedRunCore(merged.ctx, HOST, RUN, "merge")).rejects.toThrow("only a failed run, or an approved one whose merge was left to a person");
  });

  test("refused, or only checked, writes nothing: another person, a run that is not failed, a closed problem, a trial problem, no station", async () => {
    const mate = await failed();
    await expect(resumeFailedRunCore(mate.ctx, MATE, RUN, "verify")).rejects.toThrow("owner");
    const waiting = await failed({ status: "paused", gate_node_id: "decide" });
    await expect(resumeFailedRunCore(waiting.ctx, HOST, RUN, "verify")).rejects.toThrow("cast workflow reask");
    const closed = await failed({}, { status: "done" });
    await expect(resumeFailedRunCore(closed.ctx, HOST, RUN, "verify")).rejects.toThrow("closed problem");
    const trial = await failed({}, { project_id: "projects_trial" });
    await expect(resumeFailedRunCore(trial.ctx, HOST, RUN, "verify")).rejects.toThrow("cast flow trial rerun ct-9 --at <station>");
    const blank = await failed();
    await expect(resumeFailedRunCore(blank.ctx, HOST, RUN, " ")).rejects.toThrow("Name the station");
    const checked = await failed();
    expect(await resumeFailedRunCore(checked.ctx, HOST, RUN, "verify", { check: true })).toMatchObject({ resumed_at: "verify" });
    expect(checked.tables.workflow_runs[0]).toMatchObject({ status: "failed", current_node_id: "implement" });
    for (const w of [mate, waiting, closed, trial, blank, checked]) expect(w.tables.daemon_commands).toEqual([]);
  });
});

describe("liveRunsForDevice", () => {
  test("lists the caller's live runs a machine drove, for its daemon's sweep", async () => {
    const { ctx } = await seed({ runner_device: "dev-mini", status: "paused" });
    const handler = (liveRunsForDevice as any)._handler ?? (liveRunsForDevice as any).handler;
    const mine = await handler(ctx, { api_token: TOKEN, device: "dev-mini" });
    expect(mine.runs.map((r: any) => [r.run_id, r.status, r.current_node_id])).toEqual([[RUN, "paused", "decide"]]);
    expect((await handler(ctx, { api_token: TOKEN, device: "dev-other" })).runs).toEqual([]);
  });
});

describe("failStrandedPendingRuns", () => {
  const pending = { status: "pending", current_node_id: undefined, gate_node_id: undefined, gate_response: undefined, node_statuses: [] };
  const took = (tables: Record<string, any[]>, at: number) =>
    tables.daemon_commands.push({ _id: "cmd1", user_id: HOST, command: "run_workflow", args: JSON.stringify({ workflow_run_id: RUN }), created_at: NOW, executed_at: at });

  test("a run a daemon took that no runner claimed fails after ten minutes, naming why", async () => {
    const { ctx, tables } = await seed(pending);
    took(tables, NOW + 3_000);
    expect(await failStrandedPendingRuns(ctx, HOST, NOW + STRANDED_PENDING_MS - 1)).toEqual([]);
    expect(await failStrandedPendingRuns(ctx, HOST, NOW + STRANDED_PENDING_MS + 1)).toEqual([RUN]);
    expect(tables.workflow_runs[0].status).toBe("failed");
    expect(tables.workflow_runs[0].fail_reason).toContain("No runner started it");
  });

  test("a run no machine has taken yet stays pending, and so does another person's", async () => {
    const offline = await seed(pending);
    expect(await failStrandedPendingRuns(offline.ctx, HOST, NOW + 60 * 60_000)).toEqual([]);
    expect(offline.tables.workflow_runs[0].status).toBe("pending");
    const theirs = await seed(pending);
    took(theirs.tables, NOW + 3_000);
    expect(await failStrandedPendingRuns(theirs.ctx, MATE, NOW + 60 * 60_000)).toEqual([]);
  });
});

describe("cancelRunByPerson", () => {
  test("a person stops a line run: the run ends and its task reads blocked, saying why", async () => {
    const { ctx, tables } = await seed({ task_id: "tasks_cause" });
    tables.tasks = [{ _id: "tasks_cause", short_id: "ct-9", title: "A problem", status: "in_progress", user_id: HOST, team_id: TEAM, workspace: `team:${TEAM}`, created_at: NOW, updated_at: NOW }];
    tables.task_history = [];
    const { cancelRunByPerson } = await import("./workflow_runs");
    await cancelRunByPerson(ctx, HOST, RUN, NOW + 1);
    expect(tables.workflow_runs[0]).toMatchObject({ status: "failed", fail_reason: "Cancelled by user" });
    expect(tables.tasks[0]).toMatchObject({ execution_status: "blocked", execution_concerns: "Cancelled by user" });
  });
});
