// The card's two halves through the real writes: splitPlan's `direct` and
// planForAccepted's plan through applyPlan, its moves through the person's
// own move (priorityWrite doMove). Synthetic data only.
import { describe, expect, test } from "bun:test";
import type { MergePlan, PassPriority, PriorityPassInput } from "./lib/priorityPass";
import { mergePriorities } from "./lib/priorityPass";
import { planForAccepted, splitPlan, type CardRow } from "./lib/priorityCard";
import { doMove } from "./priorityWrite";
import { H, pass, world } from "./priorityPassRun.testkit";
import type { Doc } from "./_generated/dataModel";

type World = Awaited<ReturnType<typeof world>>;

let clock = Date.now();
const apply = (w: World, plan: MergePlan) => {
  const started_at = (clock += 10_000);
  return w.t.mutation(pass.applyPlan, { user_id: w.ana, workspace: w.team, started_at, from_cursor: 0, cursor_at: started_at, model: "m", plan });
};
const rows = async (w: World): Promise<Doc<"priorities">[]> => (await w.priorities()).filter((p: Doc<"priorities">) => p.workspace === w.team);
const asPass = (p: Doc<"priorities">, sessions: PassPriority["sessions"] = []): PassPriority => ({
  short_id: p.short_id, title: p.title, summary: p.summary, status: p.status as PassPriority["status"], person_pos: p.person_pos ?? null, ai_rank: p.ai_rank ?? null,
  serves: p.serves ?? null, steps: p.steps, last_active_at: p.last_active_at, sessions, step_key_max: p.step_key_max,
});
const session = (id: string) => ({ id, kind: "session" as const, title: id, first_prompt: "", pin: null, idle_summary: null, last_active: Date.now() - H, tasks: [], prs: [], pin_events: [], typed: [] });

describe("a card through the real writes", () => {
  test("direct changes nothing the person sees; the ticked rows land, the moves through the person's own move", async () => {
    const w = await world();
    const now = Date.now();
    const create = (ref: string, title: string, ai_rank: number, steps: MergePlan["creates"][number]["steps"]) =>
      ({ ref, first_seen_at: now, title, summary: "", status: "active" as const, ai_rank, serves: null, steps, last_active_at: now - H, done_at: null, pass_at: now });
    await apply(w, {
      creates: [
        create("new-1", "Grader", 1, [{ key: "s1", title: "Faults", tier: "critical", tier_set_by: "pass", refs: [], done: false }, { key: "s2", title: "Docs", tier: "polish", tier_set_by: "pass", refs: [], done: false }]),
        create("new-2", "Payments", 2, []),
      ],
      updates: [], merges: [], sessions: [{ session: "jx7team", priority: "new-1", step_key: "s1" }], unmap: [], notes: [], rewritten: [],
    });
    const before = await rows(w);
    const grader = before.find((p) => p.title === "Grader")!;
    const payments = before.find((p) => p.title === "Payments")!;

    const inp: PriorityPassInput = {
      person: "Ana", workspace: w.team, now, window_start: now - 3 * H, initiatives: [{ short_id: "in-5", title: "Goal" }], step_tasks: [], calls: [],
      priorities: [asPass(grader, [{ id: "jx7team", title: "jx7team", step_key: "s1", last_active: now - H }]), asPass(payments)],
      sessions: [session("jx7team"), session("jx7old")],
    };
    const output = { priorities: [
      { short_id: grader.short_id, title: "Grader holds", summary: "closer", status: "active" as const, serves: null, rank: 2, sessions: [{ session: "jx7old", step: "Calibrate" }], steps: [
        { key: "s1", title: "Faults under 5%", tier: "critical" as const, refs: [] },
        { key: "s2", title: "Docs", tier: "polish" as const, refs: [] },
        { title: "Calibrate", tier: "critical" as const, refs: [] },
      ] },
      { title: "Recipes", summary: "new", status: "active" as const, serves: null, rank: 3, steps: [{ title: "Paste", tier: "critical" as const, refs: [] }], sessions: [] },
    ], unassigned: [] };
    const { direct, changes, held } = splitPlan(mergePriorities(inp, output), inp, output);
    expect(changes.map((c) => c.kind)).toEqual(["move", "rename", "rename_milestone", "new_milestone", "new_priority", "new_milestone"]);

    await apply(w, direct);
    const mid = await rows(w);
    expect(mid).toHaveLength(2);
    const g1 = mid.find((p) => p._id === grader._id)!;
    expect([g1.title, g1.summary, g1.ai_rank, g1.steps.map((s) => s.title)]).toEqual(["Grader", "closer", 1, ["Faults", "Docs"]]);
    const old = await w.conversation(w.oldConv);
    expect([old?.priority_id, old?.priority_step_key]).toEqual([grader._id, undefined]);

    // The person renamed a milestone while the card waited: that row is skipped, the rest land.
    await w.t.run((ctx) => ctx.db.patch(grader._id, { steps: g1.steps.map((s) => (s.key === "s1" ? { ...s, title: "My words", title_set_by: "person" as const } : s)) }));
    const { plan, moves, skipped } = planForAccepted(held, new Set(changes.map((c) => c.id)), (await rows(w)) as unknown as CardRow[], Date.now());
    expect(skipped).toEqual([changes.find((c) => c.kind === "rename_milestone")!.id]);
    await apply(w, plan);
    for (const m of moves) await w.t.run((ctx) => doMove(ctx as any, w.ana, m.short_id, m.to));

    const after = await rows(w);
    const g2 = after.find((p) => p._id === grader._id)!;
    expect(g2.title).toBe("Grader holds");
    expect(g2.steps.map((s) => [s.key, s.title])).toEqual([["s1", "My words"], ["s2", "Docs"], ["s3", "Calibrate"]]);
    // The reply moved Grader, so the card's row and the move name it: it is the person's placement now, Payments is not.
    expect(moves).toEqual([{ short_id: grader.short_id, to: 2 }]);
    expect([g2.person_pos != null, after.find((p) => p._id === payments._id)!.person_pos]).toEqual([true, undefined]);
    const recipes = after.find((p) => p.title === "Recipes")!;
    expect(recipes.steps.map((s) => s.title)).toEqual(["Paste"]);
    const oldAfter = await w.conversation(w.oldConv);
    expect([oldAfter?.priority_id, oldAfter?.priority_step_key]).toEqual([grader._id, "s3"]);
    const order = after.filter((p) => p.status === "active").sort((a, b) => (a.person_pos ?? a.ai_rank!) - (b.person_pos ?? b.ai_rank!)).map((p) => p.title);
    expect(order).toEqual(["Payments", "Grader holds", "Recipes"]);
  });
});
