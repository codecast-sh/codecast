import { describe, expect, test } from "bun:test";
import { LINE_RUNS_PER_RUNNER, runnerLoad } from "./orgLine";
import { deviceWorking, linePoolFor } from "./lib/linePlacement";
import { normalizeGitOrigin } from "@codecast/shared/contracts";
import { HOST, NOW, ROLE, TEAM, fixtures } from "./orgLine.testkit";

// A machine's load is read up to its cap: on Nov 22 Union's pool machines held about 2,500 runs that never left
// "running", and counting them all read past the 100 MB a Convex query may read, so `cast flow ls` and the Flows page
// could not show the team's live flow.

const STUCK = 500;
const run = (n: number, over: Record<string, any> = {}) => ({ _id: `workflow_runs_s${n}`, user_id: HOST, status: "running", org_role_id: ROLE, task_id: `tasks_s${n}`, node_statuses: [], ...over });

/** The ctx with every workflow_runs row a query hands out counted, however it is read. */
function counting(ctx: any) {
  const read = { runs: 0 };
  const wrap = (b: any): any => new Proxy(b, {
    get(target, prop) {
      if (prop === Symbol.asyncIterator) return async function* () { for await (const r of target) { read.runs++; yield r; } };
      const f = target[prop];
      if (typeof f !== "function") return f;
      return (...a: any[]) => {
        const r = f.apply(target, a);
        if (r instanceof Promise) return r.then((v: any) => { read.runs += Array.isArray(v) ? v.length : v ? 1 : 0; return v; });
        return r && typeof r === "object" ? wrap(r) : r;
      };
    },
  });
  const db = new Proxy(ctx.db, { get: (t, p) => (p === "query" ? (table: string) => (table === "workflow_runs" ? wrap(t.query(table)) : t.query(table)) : typeof t[p] === "function" ? t[p].bind(t) : t[p]) });
  return { ctx: { ...ctx, db }, read };
}

describe("a machine's load is read only up to its cap", () => {
  test("a pool machine with hundreds of runs still working reads as many as its slot runs, and is full", async () => {
    const ORIGIN = normalizeGitOrigin("git@github.com:Acme/Growth.git")!;
    const laptop = { _id: "devices_laptop", user_id: HOST, device_id: "dev-laptop", last_seen: NOW, git_plane: [{ root: "/srv", origin: "git@github.com:Acme/Growth.git", origin_ok: true }] };
    const box = { _id: "devices_box", user_id: HOST, device_id: "box", last_seen: NOW, line_slots: [{ root: "/home/ubuntu/box", origin: ORIGIN, runs: 6 }] };
    const base = fixtures({ extra: { devices: [laptop, box], workflow_runs: Array.from({ length: STUCK }, (_, n) => run(n, { runner_device: "box" })) } });
    const { ctx, read } = counting(base.ctx);

    const pool = await linePoolFor(ctx, HOST, "/srv/growth", NOW, TEAM);
    expect(pool!.slots).toEqual([expect.objectContaining({ device: "box", runs: 6, working: 6 })]);
    expect(read.runs).toBe(6);

    // A run waiting on a person holds no slot, and the count reads past it to the cap.
    read.runs = 0;
    expect(await deviceWorking(ctx, "box", new Set(["workflow_runs_s0", "workflow_runs_s1"]), 6)).toBe(6);
    expect(read.runs).toBe(8);
    // A held machine (no runs) reads nothing.
    read.runs = 0;
    expect(await deviceWorking(ctx, "box", new Set(), 0)).toBe(0);
    expect(read.runs).toBe(0);
  });

  test("the runner's own machine reads its working runs up to the runner's cap", async () => {
    const base = fixtures({ extra: { workflow_runs: Array.from({ length: STUCK }, (_, n) => run(n)) } });
    const { ctx, read } = counting(base.ctx);
    expect(await runnerLoad(ctx, HOST)).toMatchObject({ working: LINE_RUNS_PER_RUNNER, cap: LINE_RUNS_PER_RUNNER });
    expect(read.runs).toBe(LINE_RUNS_PER_RUNNER);
  });
});
