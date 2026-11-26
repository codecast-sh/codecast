import { expect, test } from "bun:test";
import { getFunctionName } from "convex/server";
import { withinBudget } from "./modelCalls";

// withinBudget's optional deadline (close advice after a Close stops waiting
// then): past it no hold is taken, and a hold already taken settles through
// the scheduler, so the caller's return never strands one on the cap.

const CONFLICT = 'Documents read from or written to the "team_budgets" table changed while this mutation was being run and on every subsequent retry.';

/** A fake action ctx that records each mutation and scheduled function by name. */
function budgetCtx(opts: { reserveConflicts?: number } = {}) {
  const mutations: string[] = [];
  const scheduled: Array<{ fn: string; args: any }> = [];
  let conflicts = opts.reserveConflicts ?? 0;
  return {
    mutations,
    scheduled,
    ctx: {
      runMutation: async (fn: any) => {
        const name = getFunctionName(fn);
        mutations.push(name);
        if (name === "modelCalls:reserve" && conflicts-- > 0) throw new Error(CONFLICT);
        return true;
      },
      scheduler: { runAfter: async (_ms: number, fn: any, args: any) => void scheduled.push({ fn: getFunctionName(fn), args }) },
    },
  };
}

test("with no deadline a call is as before: a conflicted reserve asks again and the settle is a mutation", async () => {
  const b = budgetCtx({ reserveConflicts: 1 });
  const realNow = Date.now;
  try {
    const r = await withinBudget(b.ctx, { workspace: "team:t" }, "judge", 0.18, async (charge) => {
      // However long the call ran.
      const later = realNow() + 3_600_000;
      Date.now = () => later;
      charge(0.02);
      return "ok";
    });
    expect(r).toEqual({ room: true, value: "ok" });
  } finally {
    Date.now = realNow;
  }
  expect(b.mutations).toEqual(["modelCalls:reserve", "modelCalls:reserve", "modelCalls:settle"]);
  expect(b.scheduled).toEqual([]);
});

test("a settle that starts past the deadline goes to the scheduler with the whole hold, never as a contended mutation", async () => {
  const b = budgetCtx();
  const realNow = Date.now;
  const deadline = realNow() + 1_000;
  try {
    const r = await withinBudget(b.ctx, { workspace: "team:t" }, "judge", 0.18, async (charge) => {
      Date.now = () => deadline + 1;
      charge(0.02);
      return "late";
    }, deadline);
    expect(r).toEqual({ room: true, value: "late" });
  } finally {
    Date.now = realNow;
  }
  expect(b.mutations).toEqual(["modelCalls:reserve"]);
  expect(b.scheduled).toEqual([{ fn: "modelCalls:settle", args: { workspace: "team:t", purpose: "judge", held: 0.18, cost: 0.02, project_ids: [] } }]);
});

test("no reserve is taken once the deadline has passed, and the call never runs", async () => {
  const b = budgetCtx();
  let ran = false;
  await expect(withinBudget(b.ctx, { workspace: "team:t" }, "judge", 0.18, async () => (ran = true), Date.now() - 1)).rejects.toThrow("deadline");
  expect(b.mutations).toEqual([]);
  expect(ran).toBe(false);
});

test("a reserve whose conflict backoff would cross the deadline stops at it without asking again", async () => {
  const b = budgetCtx({ reserveConflicts: 10 });
  const start = Date.now();
  await expect(withinBudget(b.ctx, { workspace: "team:t" }, "judge", 0.18, async () => "never", start + 50)).rejects.toThrow("deadline");
  expect(Date.now() - start).toBeLessThan(250);
  expect(b.mutations).toEqual(["modelCalls:reserve"]);
  expect(b.scheduled).toEqual([]);
});
