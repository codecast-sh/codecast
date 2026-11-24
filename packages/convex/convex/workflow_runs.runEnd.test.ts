// A run that ends closes every station it still marks running (lib/runEnd.ts).
// ct-98114's run failed on a 502 reported from deploy__failed, and deploy__wait
// kept "running" with no completed_at: a spinner and a clock counting for 70h.
import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { makeFakeDb } from "./testDb";
import { cancelCore, updateProgress } from "./workflow_runs";
import { closeEndedRunStations } from "./migrations";
import { hashToken } from "./apiTokens";

const OWNER = "users_owner";
const TOKEN = "run-end-token";
const RUN = "workflow_runs_1";
const WAIT = { node_id: "deploy__wait", status: "running", started_at: 1_000, result_preview: "b3de1449bf landed; waiting for aivery-operator.", visits: 1 };
const DONE = { node_id: "deploy", status: "completed", outcome: "success", started_at: 500, completed_at: 900 };

async function makeCtx(run: Record<string, any> = {}) {
  const tables: Record<string, any[]> = {
    users: [{ _id: OWNER, name: "Owner" }],
    api_tokens: [{ _id: "token_1", user_id: OWNER, token_hash: await hashToken(TOKEN) }],
    workflow_runs: [{ _id: RUN, user_id: OWNER, workflow_name: "change", status: "running", current_node_id: "deploy__wait", node_statuses: [DONE, WAIT], created_at: 1, updated_at: 1, ...run }],
    conversations: [],
  };
  const ctx = { db: makeFakeDb(tables), scheduler: { runAfter: async () => null }, async runMutation() { return null; } } as any;
  return { ctx, tables };
}

const node = (tables: Record<string, any[]>, id: string) => tables.workflow_runs[0].node_statuses.find((n: any) => n.node_id === id);

describe("a run that ends closes the stations it still marks running", () => {
  test("a runner reporting the run failed from another station closes the one it was waiting in", async () => {
    const { ctx, tables } = await makeCtx();
    await (updateProgress as any)._handler(ctx, { api_token: TOKEN, run_id: RUN, current_node_id: "deploy__failed", node_id: "deploy__failed", node_status: "failed", run_status: "failed", fail_reason: "Stopped: HTTP 502" });
    expect(tables.workflow_runs[0].status).toBe("failed");
    expect(node(tables, "deploy__wait")).toMatchObject({ status: "failed", outcome: "stopped", started_at: 1_000, completed_at: expect.any(Number), result_preview: WAIT.result_preview });
    expect(node(tables, "deploy")).toEqual(DONE);
    expect(tables.workflow_runs[0].node_statuses.filter((n: any) => n.status === "running")).toEqual([]);
  });

  test("a run that completes closes its running station as completed; a report that keeps the run going closes nothing", async () => {
    const { ctx, tables } = await makeCtx();
    await (updateProgress as any)._handler(ctx, { api_token: TOKEN, run_id: RUN, current_node_id: "deploy__wait", node_id: "deploy__wait", node_status: "running", result_preview: "still waiting" });
    expect(node(tables, "deploy__wait")).toMatchObject({ status: "running" });
    expect(node(tables, "deploy__wait").completed_at).toBeUndefined();
    await (updateProgress as any)._handler(ctx, { api_token: TOKEN, run_id: RUN, current_node_id: "exit", run_status: "completed" });
    expect(node(tables, "deploy__wait")).toMatchObject({ status: "completed", outcome: "stopped", completed_at: expect.any(Number) });
  });

  test("a cancel closes the station the run was in", async () => {
    const { ctx, tables } = await makeCtx();
    await cancelCore(ctx, tables.workflow_runs[0], 5_000);
    expect(tables.workflow_runs[0]).toMatchObject({ status: "failed", fail_reason: "Cancelled by user" });
    expect(node(tables, "deploy__wait")).toMatchObject({ status: "failed", outcome: "stopped", completed_at: 5_000 });
  });

  test("the repair closes a station an ended run left running, at the run's own end, and leaves live runs alone", async () => {
    const { ctx, tables } = await makeCtx({ status: "failed", updated_at: 9_000 });
    tables.workflow_runs.push({ _id: "workflow_runs_2", user_id: OWNER, status: "running", node_statuses: [WAIT], created_at: 1, updated_at: 1 });
    const dry = await (closeEndedRunStations as any)._handler(ctx, {});
    expect(dry).toMatchObject({ dryRun: true, closed: [RUN] });
    expect(node(tables, "deploy__wait").status).toBe("running");
    await (closeEndedRunStations as any)._handler(ctx, { dryRun: false });
    expect(node(tables, "deploy__wait")).toMatchObject({ status: "failed", outcome: "stopped", completed_at: 9_000 });
    expect(tables.workflow_runs[1].node_statuses[0].status).toBe("running");
  });

  // Every writer of a run's end goes through lib/runEnd.ts, so a new way to end a run cannot leave a station spinning.
  test("no module ends a run with a bare status patch", () => {
    const dir = import.meta.dir;
    const bare = /patch\(\s*(?:run\._id|args\.run_id|runId)\s*,\s*\{\s*status:\s*"(?:failed|completed)"/;
    const offenders = fs.readdirSync(dir, { recursive: true }).map(String)
      .filter((f) => f.endsWith(".ts") && !f.includes(".test.") && !f.includes("_generated"))
      .filter((f) => bare.test(fs.readFileSync(path.join(dir, f), "utf-8")));
    expect(offenders).toEqual([]);
  });
});
