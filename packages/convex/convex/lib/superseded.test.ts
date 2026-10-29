// The server's half of the superseded rule over a list: a person's queue of
// line decisions asked by runs of the same line reads that line's published
// graph once per call (it read every saved version and twenty runs per
// decision, 96 MB a call for a queue of 160), and still drops a card whose
// gate the line no longer has.
import { describe, expect, test } from "bun:test";
import { currentDecisions } from "./superseded";

type Row = Record<string, any>;

function fakeCtx(docs: Row[], tables: Record<string, Row[]>) {
  const reads: string[] = [];
  const byId = new Map(docs.map((d) => [String(d._id), d]));
  return {
    reads,
    db: {
      get: async (id: unknown) => byId.get(String(id)) ?? null,
      query: (table: string) => {
        let rows = tables[table] ?? [];
        let index = "";
        const builder = {
          withIndex: (name: string, f: (q: any) => any) => {
            index = name;
            const eqs: Array<[string, unknown]> = [];
            const q = { eq: (field: string, value: unknown) => { eqs.push([field, value]); return q; } };
            f(q);
            rows = rows.filter((r) => eqs.every(([k, v]) => String(r[k]) === String(v)));
            return builder;
          },
          order: (dir: "asc" | "desc") => {
            rows = [...rows].sort((a, b) => (dir === "desc" ? b.created_at - a.created_at : a.created_at - b.created_at));
            return builder;
          },
          take: async (n: number) => { reads.push(`${table}.${index}`); return rows.slice(0, n); },
          collect: async () => { reads.push(`${table}.${index}`); return rows; },
        };
        return builder;
      },
    },
  };
}

describe("currentDecisions", () => {
  const workflow = {
    _id: "wf1",
    nodes: [{ id: "build", type: "agent" }, { id: "ship", type: "human" }],
    origin: { nodes: [{ id: "build", h: "1" }, { id: "ship", h: "2" }] },
  };
  // A run waiting at a gate the line has since dropped, and one waiting at a gate it still has.
  const dropped = { _id: "run_old", status: "paused", gate_node_id: "decide", workflow_id: "wf1", task_id: "t1", created_at: 10 };
  const current = { _id: "run_new", status: "paused", gate_node_id: "ship", workflow_id: "wf1", task_id: "t2", created_at: 20 };
  const tasks = [{ _id: "t1", status: "open" }, { _id: "t2", status: "open" }];
  const decision = (id: string, run: Row) => ({ _id: id, status: "pending", workflow_run_id: run._id, gate_node_id: run.gate_node_id, task_id: run.task_id });

  test("a queue of one line's decisions reads the line's graph once and drops the card whose gate is gone", async () => {
    const ctx = fakeCtx([workflow, dropped, current, ...tasks], { workflow_runs: [dropped, current], workflow_versions: [] });
    const rows = [decision("d1", dropped), decision("d2", current), decision("d3", current), decision("d4", current)];
    const kept = await currentDecisions(ctx, rows as any);
    expect(kept.map((d) => d._id)).toEqual(["d2", "d3", "d4"]);
    expect(ctx.reads.filter((r) => r === "workflow_versions.by_workflow_at")).toHaveLength(1);
    expect(ctx.reads.filter((r) => r === "workflow_runs.by_workflow_id")).toHaveLength(1);
  });
});
