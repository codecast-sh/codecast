// A run outlives its runner (cli workflow/runResume.ts): Resume hands a live
// run to the daemon of the machine that drove it, and a daemon's sweep reads
// the live runs it drove. Driven against the fake db like the gate tests.
import { describe, expect, test } from "bun:test";
import { makeFakeDb } from "./testDb";
import { liveRunsForDevice, resumeRunCore } from "./workflow_runs";
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

describe("liveRunsForDevice", () => {
  test("lists the caller's live runs a machine drove, for its daemon's sweep", async () => {
    const { ctx } = await seed({ runner_device: "dev-mini", status: "paused" });
    const handler = (liveRunsForDevice as any)._handler ?? (liveRunsForDevice as any).handler;
    const mine = await handler(ctx, { api_token: TOKEN, device: "dev-mini" });
    expect(mine.runs.map((r: any) => [r.run_id, r.status, r.current_node_id])).toEqual([[RUN, "paused", "decide"]]);
    expect((await handler(ctx, { api_token: TOKEN, device: "dev-other" })).runs).toEqual([]);
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
