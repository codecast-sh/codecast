import { expect, test } from "bun:test";
import { makeFakeDb } from "./testDb";
import { liveIds } from "./workflow_runs";

// The live runs check's answer (web useLiveRunsCheck): a workspace with more stale live runs than its share of the
// cap is left out, and every other workspace is still named in full. Synthetic data only.

const ME = "user_me";
const BIG = "team_big";
const SMALL = "team_small";

test("a workspace over its share is not named, so the others are still checked", async () => {
  const run = (id: string, team: string, status: string) => ({ _id: id, user_id: ME, workspace: `team:${team}`, status, created_at: 1, updated_at: 1, node_statuses: [] });
  // Three workspaces (personal, BIG, SMALL) share 2000 ids: 666 each. BIG holds 700 live runs, SMALL one live and one ended.
  const big = Array.from({ length: 700 }, (_, i) => run(`run_big_${i}`, BIG, i % 2 ? "running" : "paused"));
  const t: Record<string, any[]> = {
    users: [{ _id: ME, name: "Ana" }],
    team_memberships: [{ _id: "m1", user_id: ME, team_id: BIG, role: "member" }, { _id: "m2", user_id: ME, team_id: SMALL, role: "member" }],
    workflow_runs: [...big, run("run_small_live", SMALL, "running"), run("run_small_done", SMALL, "completed")],
  };
  const ctx = { db: makeFakeDb(t), auth: { getUserIdentity: async () => ({ subject: `${ME}|sess` }) } } as any;
  const answer = await (liveIds as any)._handler(ctx, {});
  expect(answer.workspaces).toEqual([`user:${ME}`, `team:${SMALL}`]);
  expect(answer.ids).toEqual(["run_small_live"]);
  expect(answer.complete).toBe(false);
});
