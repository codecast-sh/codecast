// A station that takes only so many of the team's runs at once (the line
// profile's caps.stations): the runner asks workflow_runs.admitToStation for a
// place before the station starts, and waits outside it while the station is
// full. Eval proofs had queued for the eval host's slots inside Eval's own
// clock (ct-68695, 2026-10-29). Run through the real mutations under convex-test.
import { describe, expect, test } from "bun:test";
import { convexTest } from "convex-test";
import { anyApi } from "convex/server";
import schema from "./schema";
import { hashToken } from "./apiTokens";

const api = anyApi as any;
const TOKEN = "e".repeat(64);
const T0 = 1_790_000_000_000;
const modules = {
  "./_generated/server.ts": () => import("./_generated/server"),
  "./syncOutbox.ts": () => import("./syncOutbox"),
  "./workflow_runs.ts": () => import("./workflow_runs"),
};

async function setup() {
  const t = convexTest(schema, modules);
  const ids = await t.run(async (ctx) => {
    const owner = await ctx.db.insert("users", { name: "Founder" } as any);
    const team = await ctx.db.insert("teams", { name: "Union", created_at: T0 } as any);
    const other = await ctx.db.insert("teams", { name: "Other", created_at: T0 } as any);
    await ctx.db.insert("team_memberships", { user_id: owner, team_id: team, role: "admin", joined_at: T0 } as any);
    await ctx.db.insert("api_tokens", { user_id: owner, token_hash: await hashToken(TOKEN), name: "cli", created_at: T0, last_used_at: T0 } as any);
    return { owner, team, workspace: `team:${team}`, otherWorkspace: `team:${other}` };
  });
  const run = (workspace = ids.workspace, current = "ship") => t.run((ctx) => ctx.db.insert("workflow_runs", {
    user_id: ids.owner, workspace, team_id: ids.team, workflow_name: "agentwatch", status: "running", current_node_id: current,
    node_statuses: [], created_at: T0, updated_at: T0,
  } as any));
  const admit = (runId: unknown, cap = 2) => t.mutation(api.workflow_runs.admitToStation, { api_token: TOKEN, run_id: runId, node_id: "eval", cap });
  const report = (runId: unknown, node: string) => t.mutation(api.workflow_runs.updateProgress, { api_token: TOKEN, run_id: runId, current_node_id: node, node_id: node, node_status: "running" });
  return { t, ids, run, admit, report };
}

describe("workflow_runs.admitToStation", () => {
  test("admits up to the cap, then holds the next run outside until a place frees", async () => {
    const { run, admit, report } = await setup();
    const [a, b, c] = [await run(), await run(), await run()];
    expect(await admit(a)).toMatchObject({ admitted: true, inside: 1 });
    expect(await admit(b)).toMatchObject({ admitted: true, inside: 2 });
    expect(await admit(c)).toMatchObject({ admitted: false, inside: 2, cap: 2 });
    // a goes in, finishes the station and moves on: its place frees.
    await report(a, "eval");
    expect(await admit(c)).toMatchObject({ admitted: false });
    await report(a, "push");
    expect(await admit(c)).toMatchObject({ admitted: true, inside: 2 });
  });

  // A resumed runner reports its machine and graph before it asks for a place; marking Eval running then read the
  // waiting runs as inside it (Eval 6 and Prove 8 under caps of 4, 07:08 UTC Nov 5).
  test("a report naming no station leaves the run's stations as they were", async () => {
    const { t, run } = await setup();
    const a = await run(undefined, "eval");
    await t.mutation(api.workflow_runs.updateProgress, { api_token: TOKEN, run_id: a, current_node_id: "eval", runner_device: "dev-1", graph_hash: "h1" });
    const row = await t.run((ctx) => ctx.db.get(a as any)) as any;
    expect(row).toMatchObject({ current_node_id: "eval", runner_device: "dev-1", graph_hash: "h1", node_statuses: [] });
  });

  test("a run that holds its place keeps it when its runner asks again", async () => {
    const { run, admit } = await setup();
    const [a, b] = [await run(), await run()];
    await admit(a, 1);
    expect(await admit(b, 1)).toMatchObject({ admitted: false });
    expect(await admit(a, 1)).toMatchObject({ admitted: true });
  });

  test("a run that ends gives its place back", async () => {
    const { t, run, admit } = await setup();
    const [a, b] = [await run(), await run()];
    await admit(a, 1);
    await t.mutation(api.workflow_runs.updateProgress, { api_token: TOKEN, run_id: a, current_node_id: "eval", node_id: "eval", node_status: "failed", run_status: "failed", fail_reason: "test" });
    expect(await admit(b, 1)).toMatchObject({ admitted: true });
  });

  test("another workspace's runs take none of this one's places", async () => {
    const { ids, run, admit } = await setup();
    const elsewhere = await run(ids.otherWorkspace);
    await admit(elsewhere, 1);
    expect(await admit(await run(), 1)).toMatchObject({ admitted: true });
  });
});
