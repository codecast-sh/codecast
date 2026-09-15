// the-line.md L7: a chain step reports its output head through updateProgress
// as result_preview, and the run panel shows it on the node. A later report
// for the same node without a preview keeps the stored one.
import { describe, expect, test } from "bun:test";
import { makeFakeDb } from "./testDb";
import { updateProgress } from "./workflow_runs";
import { hashToken } from "./apiTokens";

const OWNER = "users_owner";
const TOKEN = "chain-progress-token";
const RUN = "workflow_runs_1";

async function makeCtx() {
  const tables: Record<string, any[]> = {
    users: [{ _id: OWNER, name: "Owner" }],
    api_tokens: [{ _id: "token_1", user_id: OWNER, token_hash: await hashToken(TOKEN) }],
    workflow_runs: [{ _id: RUN, user_id: OWNER, workflow_name: "chain-implement", status: "running", node_statuses: [], created_at: 1, updated_at: 1 }],
    conversations: [],
  };
  const db = makeFakeDb(tables);
  const ctx = { db, scheduler: { runAfter: async () => null }, async runMutation() { return null; } } as any;
  return { ctx, tables };
}

const report = (ctx: any, extra: Record<string, any>) =>
  (updateProgress as any)._handler(ctx, { api_token: TOKEN, run_id: RUN, current_node_id: "step-1", node_id: "step-1", ...extra });

describe("workflow_runs.updateProgress result_preview (the-line.md L7)", () => {
  test("stores the step's output head on the node and keeps it on a later report", async () => {
    const { ctx, tables } = await makeCtx();
    await report(ctx, { node_status: "running" });
    await report(ctx, { node_status: "completed", outcome: "success", result_preview: "the plan" });
    const node = tables.workflow_runs[0].node_statuses.find((n: any) => n.node_id === "step-1");
    expect(node).toMatchObject({ status: "completed", outcome: "success", result_preview: "the plan" });

    await report(ctx, { node_status: "failed", run_status: "failed", fail_reason: "planner exited 2" });
    const run = tables.workflow_runs[0];
    expect(run.status).toBe("failed");
    expect(run.fail_reason).toBe("planner exited 2");
    expect(run.node_statuses[0].result_preview).toBe("the plan");
  });
});
