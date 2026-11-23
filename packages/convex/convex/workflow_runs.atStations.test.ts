// A line's own queue reads every run of its flow standing at the stations it names (workflow_runs.listRunsAtStations).
// Union's onefix Queue read `cast workflow runs`, whose 200 most recently updated rows dropped the runs that had
// waited longest: about 400 of 600 waiting runs could never be let in (Nov 20, 2026). Run under convex-test.
import { describe, expect, test } from "bun:test";
import { convexTest } from "convex-test";
import { anyApi } from "convex/server";
import schema from "./schema";
import { hashToken } from "./apiTokens";
import { allModules } from "./testModules.testkit";
import { STATION_BYTES_MAX } from "./workflow_runs";

const api = anyApi as any;
const TOKEN = "f".repeat(64);
const T0 = 1_790_000_000_000;

async function setup() {
  const t = convexTest(schema, allModules);
  const ids = await t.run(async (ctx) => {
    const owner = await ctx.db.insert("users", { name: "Founder" } as any);
    const team = await ctx.db.insert("teams", { name: "Union", created_at: T0 } as any);
    const other = await ctx.db.insert("teams", { name: "Other", created_at: T0 } as any);
    await ctx.db.insert("team_memberships", { user_id: owner, team_id: team, role: "admin", joined_at: T0 } as any);
    await ctx.db.insert("api_tokens", { user_id: owner, token_hash: await hashToken(TOKEN), name: "cli", created_at: T0, last_used_at: T0 } as any);
    const task = await ctx.db.insert("tasks", { short_id: "ct-7", title: "a problem", status: "in_progress", created_at: T0, updated_at: T0 } as any);
    return { owner, team, other, task, workspace: `team:${team}` };
  });
  const run = (o: { node?: string; flow?: string; status?: string; workspace?: string; at?: number; harm?: number; preview?: string } = {}) => t.run((ctx) => ctx.db.insert("workflow_runs", {
    user_id: ids.owner, workspace: o.workspace ?? ids.workspace, team_id: ids.team, task_id: ids.task, workflow_name: o.flow ?? "onefix",
    status: o.status ?? "running", current_node_id: o.node ?? "queue", runner_device: "line-1",
    node_statuses: o.harm ? [{ node_id: "harm", status: "completed", result_preview: JSON.stringify({ harm: o.harm }) }] : o.preview ? [{ node_id: "triage", status: "completed", result_preview: o.preview }] : [],
    created_at: o.at ?? T0, updated_at: o.at ?? T0,
  } as any));
  const read = (args: Record<string, unknown> = {}) => t.query(api.workflow_runs.listRunsAtStations, {
    api_token: TOKEN, team_id: ids.team, workflow_name: "onefix", stations: ["queue", "build"], ...args,
  });
  return { t, ids, run, read };
}

describe("workflow_runs.listRunsAtStations", () => {
  test("lists every waiting run, the ones updated longest ago included, past the run list's 200", async () => {
    const { run, read } = await setup();
    for (let i = 0; i < 260; i++) await run({ at: T0 + i * 1000 });
    await run({ node: "build", at: T0 + 999_000 });
    const { runs, truncated } = await read();
    expect(truncated).toBe(false);
    expect(runs.filter((r: any) => r.current_node_id === "queue")).toHaveLength(260);
    expect(runs.filter((r: any) => r.current_node_id === "build")).toHaveLength(1);
    expect(Math.min(...runs.map((r: any) => r.updated_at))).toBe(T0);
  });

  test("reads only the named stations of the named flow, running, in this team", async () => {
    const { ids, run, read } = await setup();
    const mine = await run();
    await run({ node: "decide" });
    await run({ flow: "change" });
    await run({ status: "failed" });
    await run({ workspace: `team:${ids.other}` });
    const { runs } = await read();
    expect(runs.map((r: any) => r._id)).toEqual([mine]);
  });

  test("carries a station's last result when asked, and the task's short id when asked", async () => {
    const { run, read } = await setup();
    await run({ harm: 2 });
    const [row] = (await read({ results: ["harm", "triage"], tasks: true })).runs;
    expect(row).toMatchObject({ task_short_id: "ct-7", current_node_id: "queue", runner_device: "line-1", results: { harm: JSON.stringify({ harm: 2 }), triage: null } });
    const [bare] = (await read()).runs;
    expect(bare.results).toEqual({});
    expect("task_short_id" in bare).toBe(false);
  });

  test("stops before a query's read limit and says the answer is not whole", async () => {
    const { run, read } = await setup();
    const preview = "x".repeat(1024 * 1024);
    const rows = Math.ceil(STATION_BYTES_MAX / preview.length) + 4;
    for (let i = 0; i < rows; i++) await run({ preview, at: T0 + i });
    const { runs, truncated } = await read();
    expect(truncated).toBe(true);
    expect(runs.length).toBeLessThan(rows);
    expect(runs.length).toBeGreaterThan(0);
  });

  test("a caller outside the team reads nothing", async () => {
    const { t, ids, run } = await setup();
    await run();
    await expect(t.query(api.workflow_runs.listRunsAtStations, { api_token: TOKEN, team_id: ids.other, workflow_name: "onefix", stations: ["queue"] })).rejects.toThrow();
    expect(await t.query(api.workflow_runs.listRunsAtStations, { api_token: "0".repeat(64), team_id: ids.team, workflow_name: "onefix", stations: ["queue"] })).toEqual({ error: "Unauthorized" });
  });
});
