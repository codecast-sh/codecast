import { describe, expect, test } from "bun:test";
import { claimSlot, freeSlots, LINE_RUNS_PER_RUNNER, lineLoadFor, type LineLoads } from "./orgLine";
import { normalizeGitOrigin } from "@codecast/shared/contracts";
import { HOST, NOW, ROLE, fixtures } from "./orgLine.testkit";

// A pass reads each machine once, however many roles it serves. On Nov 22 Union's pool machines held ~2,500 runs
// parked at its merge queue (running, but holding no slot), and every one of its 62 roles, each seated in its own
// folder of the repository, read them all again: past the 100 MB a Convex query may read, so neither `cast flow ls`
// nor the Flows page could show the team's live flow.

const ORIGIN = normalizeGitOrigin("git@github.com:Acme/Growth.git")!;
const PARKED = 500;
const OPS = "org_roles_ops";
const laptop = { _id: "devices_laptop", user_id: HOST, device_id: "dev-laptop", last_seen: NOW, git_plane: [{ root: "/srv", origin: "git@github.com:Acme/Growth.git", origin_ok: true }] };
const box = { _id: "devices_box", user_id: HOST, device_id: "box", last_seen: NOW, line_slots: [{ root: "/home/ubuntu/box", origin: ORIGIN, runs: 3 }] };

/** The growth role in /srv/growth, and an ops role seated in /srv/ops of the same repository. */
function twoFolders(extra: Record<string, any[]>) {
  const base = fixtures();
  const growth = base.tables.org_roles[0];
  const { ctx, tables } = fixtures({
    extra: {
      org_roles: [growth, { ...growth, _id: OPS, short_id: "or-ops", handle: "ops", name: "ops", anchor_id: "anchors_ops" }],
      anchors: [...base.tables.anchors, { ...base.tables.anchors[0], _id: "anchors_ops", conversation_id: "conversations_ops" }],
      conversations: [...base.tables.conversations, { ...base.tables.conversations[0], _id: "conversations_ops", session_id: "ops", standing_role_id: OPS, anchor_id: "anchors_ops", project_path: "/srv/ops" }],
      ...extra,
    },
  });
  // Every workflow_runs row any query hands out.
  const read = { runs: 0 };
  const db = new Proxy(ctx.db, {
    get(t: any, p) {
      if (p !== "query") return typeof t[p] === "function" ? t[p].bind(t) : t[p];
      return (table: string) => {
        const q = t.query(table);
        if (table !== "workflow_runs") return q;
        const wrap = (b: any): any => new Proxy(b, { get: (bt, bp) => (typeof bt[bp] !== "function" ? bt[bp] : (...a: any[]) => { const r = bt[bp](...a); return r instanceof Promise ? r.then((v: any) => { read.runs += Array.isArray(v) ? v.length : v ? 1 : 0; return v; }) : r && typeof r === "object" ? wrap(r) : r; }) });
        return wrap(q);
      };
    },
  });
  return { ctx: { ...ctx, db }, roles: tables.org_roles, read };
}

const run = (n: number, over: Record<string, any> = {}) => ({ _id: `workflow_runs_r${n}`, user_id: HOST, status: "running", org_role_id: ROLE, task_id: `tasks_r${n}`, node_statuses: [], ...over });

describe("a pass reads each machine once", () => {
  test("roles in different folders of one repository share their pool machine: its runs read once, a slot taken through one is gone for the other", async () => {
    // One run holds a slot; the rest are parked waiting on a person (a blocking decision), so they hold none.
    const runs = Array.from({ length: PARKED }, (_, n) => run(n, { runner_device: "box" }));
    const decisions = runs.slice(1).map((r, n) => ({ _id: `session_decisions_${n}`, user_id: HOST, status: "pending", blocking: true, workflow_run_id: r._id, conversation_id: "conversations_standing", question: "?", options: [], created_at: NOW }));
    const { ctx, roles, read } = twoFolders({ devices: [laptop, box], workflow_runs: runs, session_decisions: decisions });
    const loads: LineLoads = new Map();

    const growth = await lineLoadFor(ctx, roles[0], NOW, loads, roles);
    const ops = await lineLoadFor(ctx, roles[1], NOW, loads, roles);
    expect(growth.pool!.subpath).toBe("growth");
    expect(ops.pool!.subpath).toBe("ops");
    expect([growth.working, ops.working]).toEqual([1, 1]);
    // The agents a flow needs make a pool of their own, on the same machine.
    await lineLoadFor(ctx, roles[0], NOW, loads, roles, ["claude"]);
    expect(read.runs).toBe(PARKED);

    expect(freeSlots(ops)).toBe(2);
    claimSlot(growth);
    claimSlot(growth);
    expect(freeSlots(ops)).toBe(0);
  });

  test("roles with no pool on one runner share the runner's own machine: its runs read once, a run claimed through one counts for the other", async () => {
    const { ctx, roles, read } = twoFolders({ workflow_runs: [run(0)] });
    const loads: LineLoads = new Map();
    const growth = await lineLoadFor(ctx, roles[0], NOW, loads, roles);
    const readOnce = read.runs;
    const ops = await lineLoadFor(ctx, roles[1], NOW, loads, roles);
    expect(read.runs).toBe(readOnce);
    expect(ops).toBe(growth);
    claimSlot(growth);
    expect(freeSlots(ops)).toBe(LINE_RUNS_PER_RUNNER - 2);
  });
});
