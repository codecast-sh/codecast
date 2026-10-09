// `plans.fork` and `plans.createFromTemplate` are the write paths that store
// `blocked_by` without going through `assertDependencyEdges`, and the only
// ones whose tasks are born `open`. So the edges every other path refuses have
// to be refused here too, or they are live and uncuttable on the rows they
// make: a loop (TG4 accepts one STORED through a terminal task, and
// `cutReopenedLoops` only fires when a task leaves a terminal status, which a
// fresh row never does), a ref into another workspace (readiness never reads
// across, so it stays `unknown` forever and no release path reaches it), and a
// self edge, which holds a task back for good.
import { describe, expect, test } from "bun:test";
import { makeFakeDb } from "./testDb";
import { hashToken } from "./apiTokens";
import { createFromTemplate, fork } from "./plans";

const USER = "u_owner";
const OTHER = "u_other";
const TEAM = "team_codecast";
const TOKEN = "plan-fork-token";

async function ctxFor(over: Record<string, any[]> = {}) {
  const t: Record<string, any[]> = {
    users: [{ _id: USER, name: "Owner" }, { _id: OTHER, name: "Other" }],
    teams: [{ _id: TEAM, name: "Codecast" }],
    team_memberships: [{ _id: "m1", user_id: USER, team_id: TEAM, status: "active" }],
    api_tokens: [{ _id: "tok", user_id: USER, token_hash: await hashToken(TOKEN) }],
    plans: [],
    tasks: [],
    // Seeded past the source ids so a copy never reuses one.
    counters: [{ _id: "c_ct", name: "ct", value: 500 }, { _id: "c_pl", name: "pl", value: 500 }],
    task_history: [],
    task_comments: [],
    docs: [],
    conversations: [],
    entity_conversations: [],
    ...over,
  };
  return {
    ctx: {
      auth: { async getUserIdentity() { return null; } },
      db: makeFakeDb(t),
      scheduler: { runAfter: async () => null },
      runMutation: async () => null,
    } as any,
    t,
  };
}

/** The fork's copies, keyed by the title they were copied from. */
function copies(t: Record<string, any[]>, planShortId: string) {
  const plan = t.plans.find((p) => p.short_id === planShortId)!;
  const rows = t.tasks.filter((x) => String(x.plan_id) === String(plan._id));
  return { plan, byTitle: new Map(rows.map((r) => [r.title, r])), rows };
}

describe("plans.fork refuses the edges it cannot carry", () => {
  test("a loop the source stored through a dropped task does not come over live", async () => {
    // ct-1 waits on ct-2 and ct-2 waits on ct-1: storable while one of them is
    // dropped, because a terminal task holds nothing back.
    const { ctx, t } = await ctxFor({
      plans: [{ _id: "plan_src", short_id: "pl-1", user_id: USER, title: "Source", status: "active", task_ids: ["t_a", "t_b"] }],
      tasks: [
        { _id: "t_a", short_id: "ct-1", user_id: USER, title: "A", status: "dropped", plan_id: "plan_src", blocked_by: ["ct-2"], blocks: ["ct-2"] },
        { _id: "t_b", short_id: "ct-2", user_id: USER, title: "B", status: "open", plan_id: "plan_src", blocked_by: ["ct-1"], blocks: ["ct-1"] },
      ],
    });

    const result = await (fork as any)._handler(ctx, { api_token: TOKEN, source_short_id: "pl-1" });
    const { byTitle } = copies(t, result.short_id);
    const [a, b] = [byTitle.get("A")!, byTitle.get("B")!];

    // One direction survives, the one that would close the loop is dropped,
    // so neither copy waits on the other forever.
    const edges = [...(a.blocked_by ?? []).map((r: string) => `A→${r}`), ...(b.blocked_by ?? []).map((r: string) => `B→${r}`)];
    expect(edges).toHaveLength(1);
    expect(edges[0]).toBe(`A→${b.short_id}`);
    expect(result.dropped_dependencies).toEqual([`${b.short_id} → ${a.short_id}`]);
    // Said where the plan is read, not swallowed.
    expect(JSON.stringify(t.plans.find((p) => p.short_id === result.short_id)!.entries)).toContain("could not carry over");
  });

  test("a blocker in another workspace is dropped, one in this workspace is kept", async () => {
    const { ctx, t } = await ctxFor({
      plans: [{ _id: "plan_src", short_id: "pl-1", user_id: USER, title: "Source", status: "active", task_ids: ["t_a"] }],
      tasks: [
        { _id: "t_a", short_id: "ct-1", user_id: USER, title: "A", status: "open", plan_id: "plan_src", blocked_by: ["ct-9", "ct-8", "ct-7"] },
        // Outside the plan, same (personal) workspace: a real edge the fork keeps.
        { _id: "t_near", short_id: "ct-9", user_id: USER, title: "Near", status: "open" },
        // Another workspace: readiness would never clear it.
        { _id: "t_far", short_id: "ct-8", user_id: OTHER, title: "Far", status: "open" },
        // ct-7 names no task at all.
      ],
    });

    const result = await (fork as any)._handler(ctx, { api_token: TOKEN, source_short_id: "pl-1" });
    const { byTitle } = copies(t, result.short_id);
    const a = byTitle.get("A")!;

    expect(a.blocked_by).toEqual(["ct-9"]);
    expect(result.dropped_dependencies).toEqual([`${a.short_id} → ct-8`, `${a.short_id} → ct-7`]);
    // The kept edge's mirror is written, so a release path can reach the copy.
    expect(t.tasks.find((x) => x.short_id === "ct-9")!.blocks).toContain(a.short_id);
    // The foreign task is never touched.
    expect(t.tasks.find((x) => x.short_id === "ct-8")!.blocks ?? []).toHaveLength(0);
  });

  test("an ordinary chain forks unchanged", async () => {
    const { ctx, t } = await ctxFor({
      plans: [{ _id: "plan_src", short_id: "pl-1", user_id: USER, title: "Source", status: "active", task_ids: ["t_a", "t_b"] }],
      tasks: [
        { _id: "t_a", short_id: "ct-1", user_id: USER, title: "A", status: "open", plan_id: "plan_src" },
        { _id: "t_b", short_id: "ct-2", user_id: USER, title: "B", status: "open", plan_id: "plan_src", blocked_by: ["ct-1"] },
      ],
    });

    const result = await (fork as any)._handler(ctx, { api_token: TOKEN, source_short_id: "pl-1" });
    const { byTitle } = copies(t, result.short_id);
    const [a, b] = [byTitle.get("A")!, byTitle.get("B")!];

    expect(b.blocked_by).toEqual([a.short_id]);
    expect(a.blocks).toContain(b.short_id);
    expect(result.dropped_dependencies).toBeUndefined();
  });
});

describe("plans.createFromTemplate refuses the edges it cannot carry", () => {
  test("a step that names its own index is not born blocked by itself", async () => {
    // `blocked_by_indices` is a stored field of a public mutation, so a row
    // naming its own position is reachable however `templateSteps` writes one.
    // Only a BACK edge may come over: a task blocked by itself can never clear
    // (nothing closes it), and no later pass cuts it, since these tasks are
    // born `open` and never pass assertDependencyEdges.
    const { ctx, t } = await ctxFor({
      plan_templates: [{
        _id: "tpl_1",
        user_id: USER,
        name: "Template",
        goal_template: "Ship it",
        task_templates: [
          { title: "First", blocked_by_indices: [0] },
          { title: "Second", blocked_by_indices: [0, 1, 2] },
        ],
      }],
    });
    const out = await (createFromTemplate as any)._handler(ctx, { api_token: TOKEN, template_id: "tpl_1" });
    expect(out.task_count).toBe(2);
    const { byTitle } = copies(t, out.short_id);
    const first = byTitle.get("First")!;
    const second = byTitle.get("Second")!;
    expect(first.blocked_by).toEqual([]);
    expect(second.blocked_by).toEqual([first.short_id]);
    // And the mirror the create writes names only the edge it kept.
    expect(first.blocks).toEqual([second.short_id]);
    expect(second.blocks ?? []).toEqual([]);
  });
});
