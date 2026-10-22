import { describe, expect, test } from "bun:test";
import schema from "./schema";
import { makeFakeDb, schemaIndexes } from "./testDb";
import { page } from "./lineTimeline";

const h = (fn: any) => fn._handler;
const WS = "team:team_1";
const TEAM = { workspace: "team" as const, team_id: "team_1" as any };

function world(extra: Record<string, any[]> = {}) {
  const db = makeFakeDb(
    {
      users: [{ _id: "u1", active_team_id: "team_1" }, { _id: "u2" }],
      teams: [{ _id: "team_1", name: "Acme" }],
      team_memberships: [{ _id: "m1", user_id: "u1", team_id: "team_1" }],
      projects: [], conversations: [], event_sources: [{ _id: "src1", workspace: WS, name: "acme-moments", project_id: "p1" }],
      moments: [], judge_runs: [], agent_reviews: [], signals: [], tasks: [], workflow_runs: [], external_events: [], replays: [], deploys: [],
      ...extra,
    },
    { indexes: schemaIndexes(schema as any) },
  );
  const as = (userId: string) => ({ auth: { getUserIdentity: async () => ({ subject: `${userId}|sess` }) }, db }) as any;
  return { as };
}

describe("lineTimeline.page", () => {
  test("a moment, its review, the finding it filed, the problem, a run's steps, all named by what they touch", async () => {
    const w = world({
      moments: [{ _id: "m1", workspace: WS, source_id: "src1", kind: "conversation", subject: "c_1", who: "Pat Doe", short_id: "mo-1", created_at: 100 }],
      agent_reviews: [{ _id: "rv1", workspace: WS, moment_id: "m1", judge: "comms", short_id: "rv-1", status: "done", findings: 1, finished_at: 150, created_at: 110, run_id: "j1" }],
      judge_runs: [{ _id: "j1", workspace: WS, moment_id: "m1", moment_short_id: "mo-1", judge: "comms", status: "ok", findings: 1, expectations: [], at: 150 }],
      signals: [{ _id: "s1", workspace: WS, short_id: "sg-1", source: "judge:comms", kind: "bug", title: "Promised a call", fingerprint: "f", moment: "mo-1", task_id: "t1", project_id: "p1", created_at: 200, observed_at: 200 }],
      tasks: [
        { _id: "t1", workspace: WS, short_id: "ct-1", title: "Missed callbacks", source: "signal", cause: {}, status: "in_progress", created_at: 210, updated_at: 400, project_id: "p1" },
        { _id: "t2", workspace: WS, short_id: "ct-2", title: "Callbacks dropped", source: "signal", cause: { merged_into: "t1" }, status: "dropped", closed_at: 260, created_at: 220, updated_at: 260 },
        { _id: "t3", workspace: WS, short_id: "ct-3", title: "Not a problem", source: "manual", status: "open", created_at: 230, updated_at: 230 },
      ],
      workflow_runs: [{ _id: "r1", workspace: WS, task_id: "t1", status: "running", workflow_name: "line", created_at: 300, updated_at: 350, node_statuses: [{ node_id: "prove", status: "completed", outcome: "reproduced", completed_at: 340 }] }],
    });
    const res = await h(page)(w.as("u1"), TEAM);
    expect(res.cutoff).toBe(0);
    expect(res.events.map((e: any) => [e.kind, e.at])).toEqual([
      ["station", 340], ["run_started", 300], ["problem_merged", 260], ["problem_opened", 220], ["problem_opened", 210], ["finding", 200], ["review", 150], ["moment", 100],
    ]);
    const byKind = Object.fromEntries(res.events.map((e: any) => [e.kind + (e.task ?? ""), e]));
    expect(byKind["moment"]).toMatchObject({ source: "acme-moments", title: "Pat Doe", moment: "mo-1", project_id: "p1" });
    expect(byKind["review"]).toMatchObject({ source: "judge:comms", review: "rv-1", detail: "1 findings", title: "Pat Doe" });
    expect(byKind["findingt1"]).toMatchObject({ signal_ref: "sg-1", task_ref: "ct-1", moment: "mo-1" });
    expect(byKind["problem_mergedt2"]).toMatchObject({ into_ref: "ct-1" });
    expect(byKind["stationt1"]).toMatchObject({ node: "prove", detail: "reproduced", run: "r1" });
  });

  test("paging: complete from the newest of the full sources' oldest rows; another workspace's rows never show", async () => {
    const signals = Array.from({ length: 5 }, (_, i) => ({ _id: `s${i}`, workspace: WS, short_id: `sg-${i}`, source: "union.desk", kind: "bug", title: `f${i}`, fingerprint: "f", created_at: 100 + i * 10, observed_at: 0 }));
    const w = world({
      signals: [...signals, { _id: "x", workspace: "team:other", short_id: "sg-x", source: "union.desk", kind: "bug", title: "theirs", fingerprint: "f", created_at: 500, observed_at: 0 }],
      deploys: [{ _id: "d1", workspace: WS, short_id: "dp-1", target: "production", status: "live", created_at: 90, live_at: 95 }],
    });
    const first = await h(page)(w.as("u1"), { ...TEAM, rows: 2 });
    expect(first.cutoff).toBe(130);
    expect(first.events.map((e: any) => e.signal_ref ?? e.deploy)).toEqual(["sg-4", "sg-3", "dp-1"]);
    const next = await h(page)(w.as("u1"), { ...TEAM, rows: 2, before: first.cutoff });
    expect(next.events.map((e: any) => e.signal_ref)).toEqual(["sg-2", "sg-1"]);
    // A poll asks only for what came after its last read.
    const poll = await h(page)(w.as("u1"), { ...TEAM, after: 125 });
    expect(poll.events.map((e: any) => e.signal_ref)).toEqual(["sg-4", "sg-3"]);
  });
});
