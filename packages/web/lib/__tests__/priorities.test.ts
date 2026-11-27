// /priorities as pure functions: each owner's order, the person's pending
// writes painted over the server's rows, and a refused write taking itself back.
// Run: bun test lib/__tests__/priorities.test.ts
import { describe, expect, test } from "bun:test";
import type { PriorityStep } from "@codecast/shared/contracts/priorities";
import {
  behindLabel, listMeta, listRows, passDue, milestoneStartHref, nextPassLabel, ownerGroups, paintMerge, paintMove, paintSessionMove, paintSessionNotThis, paintStatus, paintTier, pastBadge, prioritySig,
  withLiveRanks, writeOrRestore,
  type PriorityRow,
} from "../priorities";
import { parseComposeLink } from "../composeLink";
import { buildModels, lastDays } from "../priorityList";
import { priorityPlaceReader } from "../../store/priorityOrder";

describe("buildModels: each milestone's state", () => {
  const NOW = new Date(2026, 10, 26, 9).getTime();
  const sess = (state: string, mine = true) => ({ short_id: `jx7${state}`, conversation_id: `c-${state}`, title: state, state, mine, workflow: false, why: ["mapped"], last_active_at: NOW } as any);
  const model = (over: Partial<PriorityRow>, sessions: any[] = [], live: (id: string) => any = () => undefined) => buildModels([row("pri-1", {
    steps: [step("s1", "critical")],
    links: [{ key: "s1", sessions, sessions_more: 0, plan: null, part_of: [], looks_done: false, correction_pending: false }],
    ...over,
  } as any)], undefined, live, lastDays(10, NOW))[0].milestones[0].state;
  test("the inbox's live verdict sets the state; with nobody on it, the owner's active priority offers New session", () => {
    expect(model({}, [sess("dormant")]).kind).toBe("dormant");
    expect(model({}, [sess("dormant")], () => "needs_you").kind).toBe("needs_you");
    expect(model({}, []).kind).toBe("start");
  });
  test("a teammate's or a past priority offers nothing to start, and a teammate's ask never needs the viewer", () => {
    expect(model({ mine: false }).kind).toBe("none");
    expect(model({ status: "set_aside" }).kind).toBe("none");
    expect(model({}, [sess("needs_you", false)]).kind).toBe("idle");
  });
});

const step = (key: string, tier: "critical" | "polish", done = false, refs: PriorityStep["refs"] = []): PriorityStep => ({ key, title: `Step ${key}`, tier, tier_set_by: "pass", refs, done });

function row(short_id: string, over: Partial<PriorityRow> = {}): PriorityRow {
  return {
    _id: `id-${short_id}` as any,
    short_id,
    title: `Title ${short_id}`,
    summary: "",
    status: "active",
    rank: null,
    person_pos: null,
    ai_rank: null,
    rank_source: "ai",
    serves: null,
    steps: [],
    counts: { critical_done: 0, critical_total: 0 },
    workspace: "team:t1",
    user_id: "me" as any,
    owner: "Jason",
    owner_image: null,
    mine: true,
    first_seen_at: 0,
    last_active_at: 0,
    done_at: null,
    session_count: 0,
    sessions: [],
    ...over,
  } as PriorityRow;
}

const ids = (rows: PriorityRow[]) => rows.map((r) => r.short_id);

describe("ownerGroups", () => {
  test("the viewer's group first, active in rank order, then done, quiet and set aside", () => {
    const rows = [
      row("pri-3", { ai_rank: 2 }),
      row("pri-1", { ai_rank: 1 }),
      row("pri-9", { status: "set_aside" }),
      row("pri-7", { status: "quiet", last_active_at: 5 }),
      row("pri-8", { status: "done", done_at: 10 }),
      row("pri-4", { status: "merged" }),
      row("pri-5", { ai_rank: 1, user_id: "ash" as any, owner: "Ashot", mine: false }),
    ];
    const groups = ownerGroups(rows);
    expect(groups.map((g) => g.owner)).toEqual(["Jason", "Ashot"]);
    expect(ids(groups[0].active)).toEqual(["pri-1", "pri-3"]);
    expect(ids(groups[0].past)).toEqual(["pri-8", "pri-7", "pri-9"]);
    expect(ids(groups[1].active)).toEqual(["pri-5"]);
  });
});

describe("a session's move, \"not this\" and a merge relink its inbox row at once", () => {
  // The links name each session's conversation; the inbox reads the conversation's own priority_id and step.
  const linked = (key: string, conv: string) => ({ key, sessions: [{ short_id: `jx7${conv}`, conversation_id: conv, title: conv, state: "dormant", mine: true, workflow: false, why: ["mapped"], last_active_at: 0 }], sessions_more: 0, plan: null, part_of: [], looks_done: false, correction_pending: false });
  const world = () => {
    const one = row("pri-1", { ai_rank: 1, steps: [step("s1", "critical"), step("s2", "critical")], links: [linked("s1", "c-one") as any, { ...linked("s2", "x"), sessions: [] } as any] });
    const two = row("pri-2", { ai_rank: 2, steps: [step("s1", "critical")], links: [linked("s1", "c-two") as any], sessions: [{ short_id: "jx7c-two", title: "c-two", step_key: "s1", updated_at: 0 }], session_count: 1 });
    const sessions: Record<string, any> = { "c-one": { _id: "c-one", priority_id: one._id, priority_step_key: "s1" }, "c-two": { _id: "c-two", priority_id: two._id, priority_step_key: "s1" } };
    return { one, two, s: { priorities: { [one._id]: one, [two._id]: two }, sessions } };
  };
  const rankOf = (w: ReturnType<typeof world>, conv: string) =>
    priorityPlaceReader({ priorities: w.s.priorities as any, sessions: w.s.sessions, currentUser: { _id: "me" }, clientState: { ui: { active_team_id: "t1" } } })(w.s.sessions[conv]);

  test("a move puts the conversation on its new priority and milestone: its inbox rank follows before the server echoes", () => {
    const w = world();
    expect(rankOf(w, "c-two")?.rank).toBe(2);
    paintSessionMove(w.s as any, "jx7c-two", w.two, w.one, "s2", 0);
    expect(w.s.sessions["c-two"]).toMatchObject({ priority_id: w.one._id, priority_step_key: "s2" });
    expect(rankOf(w, "c-two")).toMatchObject({ rank: 1, step: 1 });
  });

  test("\"not this priority\" leaves the conversation on none", () => {
    const w = world();
    paintSessionNotThis(w.s as any, "jx7c-two", w.two);
    expect(w.s.sessions["c-two"]).toMatchObject({ priority_id: null, priority_step_key: null });
    expect(rankOf(w, "c-two")).toBeNull();
  });

  test("a merge carries every conversation on the merged priority to its new milestone keys", () => {
    const w = world();
    paintMerge(w.s as any, w.two, w.one);
    expect(w.s.sessions["c-two"]).toMatchObject({ priority_id: w.one._id, priority_step_key: "s3" });
    expect(w.s.sessions["c-one"]).toMatchObject({ priority_id: w.one._id, priority_step_key: "s1" });
    expect(rankOf(w, "c-two")?.rank).toBe(1);
  });
});

describe("the store actions' paints", () => {
  const fresh = () => [row("pri-1", { ai_rank: 1 }), row("pri-2", { ai_rank: 2 }), row("pri-3", { ai_rank: 3 }), row("pri-4", { ai_rank: 1, user_id: "ash" as any, mine: false })];

  test("a drag places the row between its new neighbours, as the server's move does, among its owner's active ones only", () => {
    const rows = fresh();
    paintMove(rows, "pri-3", 1);
    expect(ids(ownerGroups(rows)[0].active)).toEqual(["pri-3", "pri-1", "pri-2"]);
    expect(withLiveRanks(rows).map((r) => [r.short_id, r.rank, r.person_pos, r.rank_source])).toEqual([
      ["pri-1", 2, null, "ai"], ["pri-2", 3, null, "ai"], ["pri-3", 1, 0, "person"], ["pri-4", null, null, "ai"],
    ]);
  });

  test("a teammate's priorities keep the server's rank (it counts the owner's whole group), and their order among themselves", () => {
    // Ash's pri-7 is active but not among the viewer's rows: the server's ranks count it, so pri-5 is 2, not 1.
    const rows = [row("pri-1", { ai_rank: 1 }), row("pri-6", { ai_rank: 3, rank: 3, user_id: "ash" as any, mine: false }), row("pri-5", { ai_rank: 2, rank: 2, user_id: "ash" as any, mine: false })];
    const live = withLiveRanks(rows);
    expect(live.map((r) => [r.short_id, r.rank])).toEqual([["pri-1", 1], ["pri-6", 3], ["pri-5", 2]]);
    expect(ids(ownerGroups(live)[1].active)).toEqual(["pri-5", "pri-6"]);
  });

  test("past the end lands last; up and down step one place", () => {
    const rows = fresh();
    paintMove(rows, "pri-1", 99);
    expect(ids(ownerGroups(rows)[0].active)).toEqual(["pri-2", "pri-3", "pri-1"]);
    paintMove(rows, "pri-1", "up");
    expect(ids(ownerGroups(rows)[0].active)).toEqual(["pri-2", "pri-1", "pri-3"]);
    paintMove(rows, "pri-2", "down");
    expect(ids(ownerGroups(rows)[0].active)).toEqual(["pri-1", "pri-2", "pri-3"]);
    expect(withLiveRanks(rows).find((r) => r.short_id === "pri-2")!.rank).toBe(2);
  });

  test("a step dragged across the line changes tier and the critical count follows", () => {
    const r = row("pri-1", { ai_rank: 1, steps: [step("s1", "critical", true), step("s2", "critical"), step("s3", "polish")] });
    paintTier(r, "s2", "polish");
    expect(r.steps.map((s) => s.tier)).toEqual(["critical", "polish", "polish"]);
    expect(r.steps[1].tier_set_by).toBe("person");
    expect(r.counts).toEqual({ critical_done: 1, critical_total: 1 });
  });

  test("set aside leaves the ranking; restore comes back last", () => {
    const rows = fresh();
    paintStatus(rows, "pri-1", "set_aside");
    expect(ids(ownerGroups(rows)[0].active)).toEqual(["pri-2", "pri-3"]);
    expect(ids(ownerGroups(rows)[0].past)).toEqual(["pri-1"]);
    const back = [...fresh(), row("pri-6", { status: "quiet" })];
    paintStatus(back, "pri-6", "active");
    expect(ids(ownerGroups(back)[0].active)).toEqual(["pri-1", "pri-2", "pri-3", "pri-6"]);
    // Restored with the place after every ranked one, as the server writes it: no active priority is left without a place.
    expect(back.find((r) => r.short_id === "pri-6")!.ai_rank).toBe(4);
  });
});

describe("writeOrRestore", () => {
  const refused = (e: unknown) => String((e as Error)?.message).includes("Uncaught");
  async function run(error?: Error) {
    const restored: PriorityRow[][] = [];
    const errors: string[] = [];
    const before = [row("pri-3", { rank: 3 })];
    await writeOrRestore(async () => { if (error) throw error; }, before, (rows) => restored.push(rows), (m) => errors.push(m), refused);
    return { restored, errors, before };
  }

  test("a write that lands leaves its paint", async () => {
    expect(await run()).toMatchObject({ restored: [], errors: [] });
  });

  test("a refused write puts the rows back and reports the server's reason", async () => {
    const r = await run(new Error("[CONVEX M(dispatch:dispatch)] [Request ID: x] Server Error\nUncaught Error: pri-3 is Ashot's priority; only they can change it"));
    expect(r.restored).toEqual([r.before]);
    expect(r.errors).toEqual(["pri-3 is Ashot's priority; only they can change it"]);
  });

  test("a write still on its way keeps its paint", async () => {
    expect(await run(new Error("network down"))).toMatchObject({ restored: [], errors: [] });
  });
});

describe("steps", () => {
  const s = step("s1", "critical", false, [{ kind: "task", id: "ct-12" }, { kind: "session", id: "jx2" }, { kind: "pr", id: "acme/web#4" }]);
  const r = row("pri-1", { title: "Trusted evals", steps: [s] });

  test("Start opens the composer on a brief of live references, linked to the milestone and its plan", () => {
    const link = (href: string) => parseComposeLink(new URLSearchParams(href.split("?")[1]));
    const tasks: Record<string, { title: string; status: string }> = { "ct-12": { title: "Grader faults", status: "done" }, "ct-13": { title: "Seed the goals", status: "in_progress" } };
    const m = { step: step("s1", "critical", false, [{ kind: "task", id: "ct-12" }, { kind: "task", id: "ct-13" }, { kind: "task", id: "ct-14" }, { kind: "pr", id: "acme/web#4" }]), plan: { short_id: "pl-7" } };
    // A finished task is left out; one the store does not know goes by its id.
    expect(link(milestoneStartHref(r, m, (id) => tasks[id]))).toEqual({
      draft: "pri-1, milestone: Step s1\nOpen tasks:\n- ct-13 Seed the goals\n- ct-14\nPlan: pl-7\nRun `cast priorities show pri-1` for current detail.",
      task: "ct-13", priority: "pri-1", step: "s1", plan: "pl-7",
    });
    // No milestone plan: the priority's own. No task, no plan: the reference lines alone.
    expect(link(milestoneStartHref({ ...r, plan: { short_id: "pl-2" } }, { step: step("s9", "polish"), plan: null }, () => undefined))).toEqual({
      draft: "pri-1, milestone: Step s9\nPlan: pl-2\nRun `cast priorities show pri-1` for current detail.",
      priority: "pri-1", step: "s9", plan: "pl-2",
    });
    expect(link(milestoneStartHref(r, { step: step("s9", "polish") }, () => undefined))).toEqual({
      draft: "pri-1, milestone: Step s9\nRun `cast priorities show pri-1` for current detail.",
      priority: "pri-1", step: "s9",
    });
  });
});

test("finished reads won, quiet and set aside say so", () => {
  const day = new Date(2026, 10, 19, 12).getTime();
  expect(pastBadge({ status: "done", done_at: day, last_active_at: 0 })).toBe("✓ Done Nov 19");
  expect(pastBadge({ status: "quiet", done_at: null, last_active_at: day })).toBe("Quiet since Nov 19");
  expect(pastBadge({ status: "set_aside", done_at: null, last_active_at: day })).toBe("Set aside");
});

describe("the pass's timing", () => {
  test("a list answer's rows feed the store; its timing reads beside them", () => {
    const rows = [row("pri-1")];
    const answer = { priorities: rows, own_truncated: false, teammates_truncated: false, next_pass_at: 5, behind_by_ms: 7 };
    expect(listRows(answer)).toBe(rows);
    expect(listRows(null)).toBeUndefined();
    expect(listMeta(answer)).toEqual({ next_pass_at: 5, behind_by_ms: 7 });
    expect(listMeta(undefined)).toEqual({ next_pass_at: null, behind_by_ms: null });
    // A next pass that is due is a pass running now.
    expect(passDue({ next_pass_at: 5, behind_by_ms: null }, 5)).toBe(true);
    expect(passDue({ next_pass_at: 6, behind_by_ms: null }, 5)).toBe(false);
    expect(passDue({ next_pass_at: null, behind_by_ms: null }, 5)).toBe(false);
  });

  test("the header says behind only past six hours", () => {
    expect(behindLabel(undefined)).toBeNull();
    expect(behindLabel(6 * 3_600_000)).toBeNull();
    expect(behindLabel(8.5 * 3_600_000)).toBe("Behind by 8h");
  });

  test("the next pass reads as a time today, with its weekday on another day, and not once it has passed", () => {
    const now = new Date(2026, 10, 25, 10, 0).getTime();
    expect(nextPassLabel(new Date(2026, 10, 25, 15, 0).getTime(), now)).toBe("Next pass 3:00 PM");
    expect(nextPassLabel(new Date(2026, 10, 26, 1, 5).getTime(), now)).toBe("Next pass Thu 1:05 AM");
    expect(nextPassLabel(now - 1, now)).toBeNull();
    expect(nextPassLabel(null, now)).toBeNull();
  });
});

describe("prioritySig", () => {
  const plan = (short_id: string, title: string, done = 1) => ({ short_id, title, done, total: 4, size: 4 });
  const sess = (over: Record<string, unknown> = {}) => ({ short_id: "jx7a", conversation_id: "conv-a", title: "A session", state: "dormant", mine: true, workflow: false, why: ["mapped"], last_active_at: 1, ...over });
  const link = (over: Record<string, unknown> = {}) => ({ key: "s1", sessions: [sess()], sessions_more: 0, plan: plan("pl-1", "The plan"), part_of: [plan("pl-2", "The program")], looks_done: false, correction_pending: false, ...over });
  const base = row("pri-1", { steps: [step("s1", "critical")], links: [link()] as any, plan: plan("pl-3", "Priority plan") as any });
  const changed = (links: unknown, over: Partial<PriorityRow> = {}) => prioritySig({ ...base, links: links as any, ...over }) !== prioritySig(base);

  test("wakes on every field a row draws from its links: looks done, a session's identity and kind, plan titles, what a milestone is part of", () => {
    expect(changed([link({ looks_done: true })])).toBe(true);
    expect(changed([link({ sessions: [sess({ conversation_id: "conv-b" })] })])).toBe(true);
    expect(changed([link({ sessions: [sess({ mine: false })] })])).toBe(true);
    expect(changed([link({ sessions: [sess({ workflow: true })] })])).toBe(true);
    expect(changed([link({ plan: plan("pl-1", "The plan, renamed") })])).toBe(true);
    expect(changed([link({ part_of: [plan("pl-2", "Another program")] })])).toBe(true);
    expect(changed([link()], { plan: plan("pl-3", "Priority plan, renamed") as any })).toBe(true);
    expect(changed([link()])).toBe(false);
  });
});
