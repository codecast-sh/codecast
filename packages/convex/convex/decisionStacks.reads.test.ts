import { describe, expect, test } from "bun:test";
import schema from "./schema";
import { makeFakeDb, schemaIndexes } from "./testDb";
import { listStacksCore } from "./decisionStacks";

// listStacks feeds every open window (useSyncDecisionStacks), so what it reads
// is paid per subscriber. Open stacks whose pending gate decisions come from
// runs of the same line must read that line's graph once per call, not once
// per stack: read per stack, a person's queue timed the query out (eg-1453).

const ME = "users_me" as any;
const NOW = 1_800_000_000_000;
const STACKS = 40;
const VERSIONS = 30;
const LINE_RUNS = 20;

function countingDb(db: any) {
  let docs = 0;
  const count = (v: any) => {
    if (Array.isArray(v)) docs += v.length;
    else if (v && typeof v === "object") docs += Array.isArray(v.page) ? v.page.length : 1;
    return v;
  };
  const wrap = (q: any): any => new Proxy(q, {
    get(target, prop) {
      const value = target[prop];
      if (typeof value !== "function") return value;
      return (...args: any[]) => {
        const out = value.apply(target, args);
        if (out && typeof out.then === "function") return out.then(count);
        return out && typeof out === "object" ? wrap(out) : out;
      };
    },
  });
  return { db: wrap(db), reads: () => docs };
}

function fixture() {
  const nodes = [{ id: "build", type: "agent" }, { id: "decide", type: "human" }];
  const hashes = nodes.map((n) => ({ id: n.id, hash: `h-${n.id}` }));
  const workflows = [{ _id: "workflows_line", nodes, created_at: NOW - 100_000 }];
  const workflow_versions = Array.from({ length: VERSIONS }, (_, i) => ({
    _id: `workflow_versions_${i}`, workflow_id: "workflows_line", at: NOW - 90_000 + i, nodes: hashes,
  }));
  const workflow_runs: any[] = Array.from({ length: LINE_RUNS }, (_, i) => ({
    _id: `workflow_runs_old_${i}`, workflow_id: "workflows_line", status: "completed", created_at: NOW - 80_000 + i, graph_nodes: hashes,
  }));
  const tasks: any[] = [];
  const session_decisions: any[] = [];
  const decision_stacks: any[] = [];
  for (let i = 0; i < STACKS; i++) {
    tasks.push({ _id: `tasks_${i}`, short_id: `ct-${i}`, status: "in_progress", title: "t", created_at: NOW - 70_000 });
    workflow_runs.push({
      _id: `workflow_runs_${i}`, workflow_id: "workflows_line", task_id: `tasks_${i}`, status: "paused",
      gate_node_id: "decide", current_node_id: "decide", created_at: NOW - 60_000 + i, graph_nodes: hashes,
    });
    session_decisions.push({
      _id: `session_decisions_${i}`, short_id: `dc-${i}`, user_id: ME, status: "pending", question: "q",
      options: [{ label: "A" }], blocking: true, workflow_run_id: `workflow_runs_${i}`, gate_node_id: "decide",
      task_id: `tasks_${i}`, created_at: NOW - 50_000 + i,
    });
    decision_stacks.push({
      _id: `decision_stacks_${i}`, short_id: `st-${i}`, title: `stack ${i}`, owner_user_id: ME, scope_user_id: ME,
      status: "open", decision_ids: [`session_decisions_${i}`], policy: {}, created_at: NOW - 40_000 + i, updated_at: NOW,
    });
  }
  return { workflows, workflow_versions, workflow_runs, tasks, session_decisions, decision_stacks, team_memberships: [] };
}

describe("listStacks reads", () => {
  test("reads a shared line's graph once per call, not once per stack", async () => {
    const { db, reads } = countingDb(makeFakeDb(fixture(), { indexes: schemaIndexes(schema as any) }));
    const rows = await listStacksCore({ db } as any, ME, { include_done: true });
    expect(rows).toHaveLength(STACKS);
    expect(rows.every((r) => r.total === 1 && r.pending === 1)).toBe(true);
    // Per stack: its member, run, problem, the problem's newest run (a few
    // documents). The line (VERSIONS + LINE_RUNS + the workflows row) once.
    // Read per stack, the line alone is STACKS * (VERSIONS + LINE_RUNS + 1) = 2040.
    expect(reads()).toBeLessThanOrEqual(STACKS * 8 + VERSIONS + LINE_RUNS + 1);
  });
});
