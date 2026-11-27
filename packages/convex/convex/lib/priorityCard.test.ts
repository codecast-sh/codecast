import { describe, expect, test } from "bun:test";
import type { PriorityPassOutput, PriorityProposal, PriorityStep } from "@codecast/shared/contracts/priorities";
import { changeLine, type PriorityChange } from "@codecast/shared/contracts/priorityCard";
import { effectivePriorityOrder, placePriority } from "@codecast/shared/contracts/priorities";
import { mergePriorities, type MergePlan, type PassPriority, type PassSession, type PriorityPassInput } from "./priorityPass";
import { findQuote, longestIncreasing, planForAccepted, splitPlan, type AcceptedPlan, type CardRow } from "./priorityCard";

const NOW = Date.UTC(2026, 10, 24, 15);
const H = 3_600_000;

const session = (id: string, over: Partial<PassSession> = {}): PassSession => ({
  id, kind: "session", title: `Session ${id}`, first_prompt: "", pin: null, idle_summary: null, last_active: NOW - H, tasks: [], prs: [], pin_events: [], typed: [], ...over,
});
const step = (key: string, over: Partial<PriorityStep> = {}): PriorityStep => ({ key, title: `Step ${key}`, tier: "critical", tier_set_by: "pass", refs: [], done: false, ...over });
const priority = (short_id: string, over: Partial<PassPriority> = {}): PassPriority => ({
  short_id, title: `Priority ${short_id}`, summary: "moving", status: "active", person_pos: null, ai_rank: null, serves: null, steps: [], last_active_at: NOW - 2 * H, sessions: [], ...over,
});
const input = (over: Partial<PriorityPassInput> = {}): PriorityPassInput => ({
  person: "Sam", workspace: "user:x", now: NOW, window_start: NOW - 3 * H, priorities: [], initiatives: [{ short_id: "in-5", title: "Goal" }], step_tasks: [], sessions: [session("a"), session("b")], calls: [], ...over,
});
const proposal = (over: Partial<PriorityProposal> = {}): PriorityProposal => ({ title: "New thing", summary: "now", status: "active", serves: null, rank: 1, steps: [], sessions: [], ...over });
const out = (priorities: PriorityProposal[], unassigned: PriorityPassOutput["unassigned"] = []): PriorityPassOutput => ({ priorities, unassigned });
/** A proposal that leaves an existing priority as it is (same title, summary, steps, serves), at `rank`. */
const same = (p: PassPriority, rank: number, over: Partial<PriorityProposal> = {}): PriorityProposal =>
  proposal({ short_id: p.short_id, title: p.title, summary: p.summary, serves: p.serves, rank, steps: p.steps.filter((s) => !s.dropped).map((s) => ({ key: s.key, title: s.title, tier: s.tier, refs: s.refs, done_judged: s.done })), ...over });

const split = (inp: PriorityPassInput, o: PriorityPassOutput) => {
  const plan = mergePriorities(inp, o);
  return { plan, ...splitPlan(plan, inp, o) };
};
const kinds = (changes: PriorityChange[]) => changes.map((c) => `${c.kind}:${c.priority}${c.step_key ? `/${c.step_key}` : ""}`);
const ranked = (n: number) => Array.from({ length: n }, (_, i) => priority(`pri-${i + 1}`, { ai_rank: i + 1 }));
/** The rows as stored: the input's priorities, as the card's answer reads them. */
const rowsOf = (inp: PriorityPassInput): CardRow[] => inp.priorities.map((p) => ({ ...p }));
const ids = (changes: PriorityChange[], pred: (c: PriorityChange) => boolean) => new Set(changes.filter(pred).map((c) => c.id));

/** What `direct` may write on a priority: nothing that changes the person's priorities. */
function expectDirectOnly(direct: MergePlan, inp: PriorityPassInput) {
  expect(direct.creates).toEqual([]);
  expect(direct.merges).toEqual([]);
  for (const u of direct.updates) {
    const p = inp.priorities.find((x) => x.short_id === u.short_id)!;
    const allowed = new Set(["summary", "last_active_at", "pass_at", "steps", ...(direct.rewritten.includes(p.short_id) ? ["title"] : [])]);
    const flip = u.patch.status !== undefined;
    if (flip) {
      expect(["active", "quiet"]).toContain(u.patch.status!);
      expect(["active", "quiet"]).toContain(p.status);
    }
    for (const k of Object.keys(u.patch)) expect(allowed.has(k) || (flip && (k === "status" || k === "ai_rank"))).toBe(true);
    if (u.patch.steps) {
      // The same milestones, titles, tiers and order; only refs (and a done state records decide) change.
      expect(u.patch.steps.map((s) => [s.key, s.title, s.tier, !!s.dropped])).toEqual(p.steps.map((s) => [s.key, s.title, s.tier, !!s.dropped]));
    }
  }
}

describe("splitting a plan", () => {
  test("every kind of change gets its own row, and direct writes none of them", () => {
    const inp = input({
      priorities: [
        priority("pri-1", { ai_rank: 1, steps: [step("s1", { title: "Grader" }), step("s2", { title: "Docs", tier: "polish" }), step("s3", { title: "Judge" }), step("s4", { title: "Retire old", tier: "critical" }), step("s5", { title: "Scrap" })], step_key_max: 5 }),
        priority("pri-2", { ai_rank: 2, title: "Payments" }),
        priority("pri-3", { status: "done", title: "Gift cards", last_active_at: NOW - H }),
        priority("pri-4", { ai_rank: 3, title: "Welcome emails", steps: [step("s1", { title: "Template" })] }),
        priority("pri-5", { ai_rank: 4, title: "Search", steps: [step("s1", { title: "Index", done: true, done_at: NOW - 5 * H })] }),
      ],
      sessions: [session("a"), session("b"), session("c")],
    });
    const [p1, p2, p3, p4, p5] = inp.priorities;
    const o = out([
      same(p1, 1, {
        title: "Grader that holds",
        serves: "in-5",
        steps: [
          { key: "s1", title: "Grader faults under 5%", tier: "critical", refs: [] },
          { key: "s2", title: "Docs", tier: "critical", refs: [] },
          { key: "s3", title: "Judge", tier: "critical", refs: [], done_judged: true },
          { key: "s4", title: "Retire old", tier: "polish", refs: [] },
          { title: "Calibrate", tier: "critical", refs: [] },
        ],
        sessions: [{ session: "a", step: "Calibrate" }],
      }),
      same(p2, 2, { merges: ["pri-4"] }),
      same(p3, 5, { status: "active", steps: [{ title: "Balance on receipts", tier: "critical", refs: [] }] }),
      same(p5, 3, { status: "done", steps: [{ key: "s1", title: "Index", tier: "critical", refs: [], done_judged: true }] }),
      proposal({ title: "Recipe import", rank: 4, steps: [{ title: "Paste a link", tier: "critical", refs: [] }, { title: "Substitutes", tier: "polish", refs: [] }], sessions: [{ session: "b", step: "Paste a link" }] }),
    ]);
    const { direct, changes, groups } = split(inp, o);
    expectDirectOnly(direct, inp);
    expect(kinds(changes)).toEqual([
      "rename:pri-1", "serves:pri-1", "rename_milestone:pri-1/s1", "to_critical:pri-1/s2", "milestone_done:pri-1/s3", "to_polish:pri-1/s4", "new_milestone:pri-1/s6", "drop_milestone:pri-1/s5",
      "merge:pri-2",
      "done:pri-5",
      "reopen:pri-3", "new_milestone:pri-3/s1",
      "new_priority:new-1", "new_milestone:new-1/s1", "new_milestone:new-1/s2",
    ]);
    // pri-5 is done after the plan, so the order around it closes up: nobody else moved.
    expect(changes.some((c) => c.kind === "move")).toBe(false);
    expect(changes.map((c) => c.id)).toEqual(changes.map((_, i) => `c${i + 1}`));
    const byKind = (k: string) => changes.find((c) => `${c.kind}:${c.priority}${c.step_key ? `/${c.step_key}` : ""}` === k)!;
    expect(byKind("rename:pri-1")).toMatchObject({ from: p1.title, to: "Grader that holds" });
    expect(byKind("serves:pri-1")).toMatchObject({ from: null, to: "in-5" });
    expect(byKind("rename_milestone:pri-1/s1")).toMatchObject({ from: "Grader", to: "Grader faults under 5%", milestone: { title: "Grader", state: "open" } });
    expect(byKind("merge:pri-2")).toMatchObject({ target: "pri-4", from: "Welcome emails" });
    expect(byKind("new_milestone:pri-1/s6")).toMatchObject({ to: "Calibrate" });
    expect(byKind("new_milestone:pri-1/s6").parent).toBeUndefined();
    const parent = byKind("new_priority:new-1");
    expect(byKind("new_milestone:new-1/s1").parent).toBe(parent.id);
    expect(byKind("new_milestone:new-1/s2").parent).toBe(parent.id);
    expect(changes.every((c) => Array.isArray(c.evidence) && c.evidence.length === 0)).toBe(true);
    // Groups: by place now, the ones not active after them, new ones last.
    expect(groups.map((g) => [g.priority, g.rank, g.title])).toEqual([
      ["pri-1", 1, p1.title], ["pri-2", 2, "Payments"], ["pri-5", 4, "Search"], ["pri-3", null, "Gift cards"], ["new-1", null, "Recipe import"],
    ]);
    expect(groups.flatMap((g) => g.changes)).toEqual(changes.map((c) => c.id));
    // Session a goes on pri-1 now; the milestone it serves waits for the card.
    expect(direct.sessions).toContainEqual({ session: "a", priority: "pri-1", step_key: null });
    expect(direct.sessions.some((s) => s.session === "b")).toBe(false);
    void p4;
  });

  test("a milestone's rows follow its order, new ones after the milestone they follow", () => {
    const inp = input({ priorities: [priority("pri-1", { ai_rank: 1, steps: [step("s1"), step("s2"), step("s3")], step_key_max: 3 })] });
    const p = inp.priorities[0];
    const { changes } = split(inp, out([same(p, 1, { steps: [
      { key: "s1", title: "Step s1", tier: "critical", refs: [] },
      { title: "Between", tier: "critical", refs: [] },
      { key: "s2", title: "Step s2 renamed", tier: "critical", refs: [] },
      { key: "s3", title: "Step s3", tier: "polish", refs: [] },
    ] })]));
    expect(kinds(changes)).toEqual(["new_milestone:pri-1/s4", "rename_milestone:pri-1/s2", "to_polish:pri-1/s3"]);
  });

  test("direct keeps placements, unmaps, summaries, refs and quiet flips; a milestone's records decide its done state at once", () => {
    const inp = input({
      priorities: [
        priority("pri-1", { ai_rank: 1, steps: [step("s1", { title: "Ship", refs: [{ kind: "task", id: "ct-1" }] }), step("s2", { title: "Judged" })], sessions: [{ id: "z", title: "z", step_key: null, last_active: NOW - 2 * H }] }),
        priority("pri-2", { ai_rank: 2, last_active_at: NOW - 10 * 24 * H }),
      ],
      step_tasks: [{ short_id: "ct-1", title: "t", status: "done" }],
      sessions: [session("a"), session("z")],
    });
    const p = inp.priorities[0];
    const { direct, changes } = split(inp, out([same(p, 1, { summary: "closer", steps: [
      { key: "s1", title: "Ship", tier: "critical", refs: [{ kind: "task", id: "ct-1" }, { kind: "session", id: "a" }] },
      { key: "s2", title: "Judged", tier: "critical", refs: [{ kind: "pr", id: "o/r#2" }] },
    ], sessions: [{ session: "a", step: "s1" }] })], [{ session: "z", kind: "one_off" }]));
    expectDirectOnly(direct, inp);
    expect(changes).toEqual([]);
    const u1 = direct.updates.find((u) => u.short_id === "pri-1")!;
    expect(u1.patch.summary).toBe("closer");
    expect(u1.patch.steps![0]).toMatchObject({ key: "s1", done: true, refs: [{ kind: "task", id: "ct-1" }, { kind: "session", id: "a" }] });
    expect(u1.patch.steps![1]).toMatchObject({ key: "s2", refs: [{ kind: "pr", id: "o/r#2" }] });
    expect(direct.sessions).toEqual([{ session: "a", priority: "pri-1", step_key: "s1" }]);
    expect(direct.unmap).toEqual(["z"]);
    // Nothing moved in pri-2 for ten days: it goes quiet at once and leaves the ranking.
    expect(direct.updates.find((u) => u.short_id === "pri-2")!.patch).toMatchObject({ status: "quiet", ai_rank: null });
  });

  test("a quiet priority that comes back is slotted where the plan put it, at once, without moving anyone", () => {
    const inp = input({
      priorities: [...ranked(3), priority("pri-9", { status: "quiet", sessions: [{ id: "a", title: "a", step_key: null, last_active: NOW - 9 * 24 * H }] })],
    });
    const { direct, changes, groups } = split(inp, out([same(inp.priorities[3], 2)]));
    const u = direct.updates.find((x) => x.short_id === "pri-9")!;
    expect(u.patch.status).toBe("active");
    expect(u.patch.ai_rank).toBe(1.5);
    expect(changes).toEqual([]);
    expect(groups).toEqual([]);
  });

  test("a priority the pass rewrites (it lost a session that left) takes its new title at once", () => {
    const inp = input({ priorities: [priority("pri-1", { ai_rank: 1, needs_rewrite: true, title: "Old words" })] });
    const { direct, changes } = split(inp, out([same(inp.priorities[0], 1, { title: "New words", summary: "fresh" })]));
    expect(direct.rewritten).toEqual(["pri-1"]);
    expect(direct.updates[0].patch).toMatchObject({ title: "New words", summary: "fresh" });
    expect(changes).toEqual([]);
  });
});

describe("moves", () => {
  test("one priority moved among eleven is one row; the ones it passed get none", () => {
    const inp = input({ priorities: ranked(11) });
    const { changes, held } = split(inp, out([same(inp.priorities[0], 8)]));
    expect(changes).toEqual([{ id: "c1", kind: "move", priority: "pri-1", from: 1, to: 8, evidence: [] }]);
    expect(held.order).toEqual(["pri-2", "pri-3", "pri-4", "pri-5", "pri-6", "pri-7", "pri-8", "pri-1", "pri-9", "pri-10", "pri-11"]);
    const { moves, skipped } = planForAccepted(held, new Set(["c1"]), rowsOf(inp), NOW);
    expect(moves).toEqual([{ short_id: "pri-1", to: 8 }]);
    expect(skipped).toEqual([]);
  });

  test("two swaps are two rows, and each lands where the card said even when the other is left unticked", () => {
    const inp = input({ priorities: ranked(4) });
    const [a, b, c, d] = inp.priorities;
    const { changes, held } = split(inp, out([same(b, 1), same(a, 2), same(d, 3), same(c, 4)]));
    expect(changes.map((x) => [x.kind, x.priority, x.from, x.to])).toEqual([["move", "pri-2", 2, 1], ["move", "pri-4", 4, 3]]);
    const rows = rowsOf(inp);
    expect(planForAccepted(held, new Set(["c1", "c2"]), rows, NOW).moves).toEqual([{ short_id: "pri-2", to: 1 }, { short_id: "pri-4", to: 3 }]);
    expect(planForAccepted(held, new Set(["c2"]), rows, NOW).moves).toEqual([{ short_id: "pri-4", to: 3 }]);
    expect(planForAccepted(held, new Set(["c1"]), rows, NOW).moves).toEqual([{ short_id: "pri-2", to: 1 }]);
  });

  test("a new priority inserted shifts the ones below it without a row for any of them", () => {
    const inp = input({ priorities: ranked(5) });
    const { changes } = split(inp, out([proposal({ title: "Fresh", rank: 2 })]));
    expect(changes.map((c) => [c.kind, c.priority, c.to])).toEqual([["new_priority", "new-1", 2]]);
  });

  test("a priority the person placed can be moved by the card, by the reply's rank", () => {
    const inp = input({ priorities: [priority("pri-1", { person_pos: 1 }), priority("pri-2", { ai_rank: 2 }), priority("pri-3", { ai_rank: 3 })] });
    const { plan, changes, held } = split(inp, out([same(inp.priorities[0], 3)]));
    // The pass alone never moves it.
    expect(plan.updates.find((u) => u.short_id === "pri-1")?.patch.person_pos).toBeUndefined();
    expect(changes.map((c) => [c.kind, c.priority, c.from, c.to])).toEqual([["move", "pri-1", 1, 3]]);
    expect(planForAccepted(held, new Set(["c1"]), rowsOf(inp), NOW).moves).toEqual([{ short_id: "pri-1", to: 3 }]);
  });

  test("a move whose priority is no longer active is skipped", () => {
    const inp = input({ priorities: ranked(3) });
    const { held } = split(inp, out([same(inp.priorities[0], 3)]));
    const rows = rowsOf(inp).map((r) => (r.short_id === "pri-1" ? { ...r, status: "set_aside" as const } : r));
    expect(planForAccepted(held, new Set(["c1"]), rows, NOW)).toMatchObject({ moves: [], skipped: ["c1"] });
  });

  test("longest increasing run keeps the earliest on a tie", () => {
    expect([...longestIncreasing([1, 0, 3, 2])].sort()).toEqual([0, 2]);
    expect([...longestIncreasing([])]).toEqual([]);
    expect(longestIncreasing([0, 1, 2]).size).toBe(3);
  });
});

describe("what the person set is never proposed", () => {
  test("a milestone's person-set title, tier and done state, a dropped one, and a person-done priority", () => {
    const inp = input({
      priorities: [
        priority("pri-1", { ai_rank: 1, steps: [
          step("s1", { title: "Mine", title_set_by: "person" }),
          step("s2", { tier: "polish", tier_set_by: "person" }),
          step("s3", { done: true, done_at: NOW - H, done_set_by: "person" }),
          step("s4", { title: "Gone for good", dropped: true }),
          step("s5", { done: true, done_at: NOW - H, done_set_by: "evidence" }),
        ], step_key_max: 5 }),
        priority("pri-2", { status: "done", status_set_by: "person" }),
      ],
    });
    const { direct, changes } = split(inp, out([
      same(inp.priorities[0], 1, { steps: [
        { key: "s1", title: "Theirs", tier: "critical", refs: [] },
        { key: "s2", title: "Step s2", tier: "critical", refs: [] },
        { key: "s3", title: "Step s3", tier: "critical", refs: [], done_judged: false },
        { title: "Gone for good", tier: "critical", refs: [] },
        { key: "s5", title: "Step s5", tier: "critical", refs: [], done_judged: false },
      ] }),
      same(inp.priorities[1], 2, { status: "active" }),
    ]));
    expect(changes).toEqual([]);
    expectDirectOnly(direct, inp);
  });

  test("a milestone the person set something on is never proposed dropped, though the reply leaves it out", () => {
    const inp = input({ priorities: [priority("pri-1", { ai_rank: 1, steps: [step("s1", { tier_set_by: "person" }), step("s2")] })] });
    const { changes } = split(inp, out([same(inp.priorities[0], 1, { steps: [] })]));
    expect(kinds(changes)).toEqual(["drop_milestone:pri-1/s2"]);
  });
});

describe("answering the card", () => {
  const base = () => {
    const inp = input({
      priorities: [
        priority("pri-1", { ai_rank: 1, title: "Grader", steps: [step("s1", { title: "Faults" }), step("s2", { title: "Docs" }), step("s3", { title: "Judge" })], step_key_max: 3 }),
        priority("pri-2", { ai_rank: 2, title: "Payments", steps: [step("s1", { title: "Refunds" })] }),
        priority("pri-3", { ai_rank: 3, title: "Emails", steps: [step("s1", { title: "Template" })], sessions: [{ id: "c", title: "c", step_key: "s1", last_active: NOW - 2 * H }] }),
        priority("pri-4", { status: "done", title: "Search", last_active_at: NOW - H }),
      ],
      sessions: [session("a"), session("b"), session("c"), session("d")],
    });
    const [p1, p2, p3, p4] = inp.priorities;
    const o = out([
      same(p1, 1, { title: "Grader holds", steps: [
        { key: "s1", title: "Faults under 5%", tier: "critical", refs: [] },
        { key: "s2", title: "Docs", tier: "polish", refs: [], done_judged: true },
        { title: "Calibrate", tier: "critical", refs: [] },
      ], sessions: [{ session: "a", step: "Calibrate" }] }),
      same(p2, 2, { merges: ["pri-3"], serves: "in-5", steps: [{ key: "s1", title: "Refunds", tier: "critical", refs: [] }, { key: "pri-3/s1", title: "Template", tier: "critical", refs: [] }] }),
      same(p4, 3, { status: "active" }),
      proposal({ title: "Recipes", rank: 4, steps: [{ title: "Paste", tier: "critical", refs: [] }, { title: "Swap", tier: "polish", refs: [] }], sessions: [{ session: "b", step: "Paste" }, { session: "d" }] }),
    ]);
    const s = split(inp, o);
    const id = (k: string) => s.changes.find((c) => `${c.kind}:${c.priority}${c.step_key ? `/${c.step_key}` : ""}` === k)!.id;
    return { inp, ...s, id };
  };

  test("ticking everything writes what the pass would have", () => {
    const { inp, changes, held, id } = base();
    const all = new Set(changes.map((c) => c.id));
    const { plan, skipped } = planForAccepted(held, all, rowsOf(inp), NOW + H);
    expect(skipped).toEqual([]);
    expect(plan.creates).toHaveLength(1);
    expect(plan.creates[0]).toMatchObject({ ref: "new-1", title: "Recipes", status: "active" });
    expect(plan.creates[0].steps.map((s) => s.title)).toEqual(["Paste", "Swap"]);
    const u1 = plan.updates.find((u) => u.short_id === "pri-1")!;
    expect(u1.patch.title).toBe("Grader holds");
    expect(u1.patch.steps!.map((s) => [s.key, s.title, s.tier, s.done])).toEqual([["s1", "Faults under 5%", "critical", false], ["s2", "Docs", "polish", true], ["s4", "Calibrate", "critical", false]]);
    expect(plan.updates.find((u) => u.short_id === "pri-2")!.patch.serves).toBe("in-5");
    expect(plan.updates.find((u) => u.short_id === "pri-4")!.patch).toMatchObject({ status: "active", done_at: null });
    expect(plan.merges).toEqual([{ short_id: "pri-3", merged_into: "pri-2", step_keys: { s1: "s2" } }]);
    expect(plan.updates.find((u) => u.short_id === "pri-2")!.patch.steps!.map((s) => [s.key, s.title])).toEqual([["s1", "Refunds"], ["s2", "Template"]]);
    // Sessions that waited: b and d onto the new priority (b on its milestone), a onto the new milestone, c with the merge.
    expect(plan.sessions).toEqual(expect.arrayContaining([
      { session: "a", priority: "pri-1", step_key: "s4" },
      { session: "b", priority: "new-1", step_key: "s1" },
      { session: "d", priority: "new-1", step_key: null },
      { session: "c", priority: "pri-2", step_key: "s2" },
    ]));
    expect(plan.sessions).toHaveLength(4);
    void id;
  });

  test("a new priority left unticked drops its milestones and its sessions, whatever their tick", () => {
    const { inp, changes, held, id } = base();
    const ticked = new Set(changes.map((c) => c.id).filter((x) => x !== id("new_priority:new-1")));
    const { plan, skipped } = planForAccepted(held, ticked, rowsOf(inp), NOW);
    expect(plan.creates).toEqual([]);
    expect(skipped.sort()).toEqual([id("new_milestone:new-1/s1"), id("new_milestone:new-1/s2")].sort());
    expect(plan.sessions.some((s) => s.priority === "new-1")).toBe(false);
  });

  test("a new priority keeps only its ticked milestones; a session on an unticked one lands without its step", () => {
    const { inp, changes, held, id } = base();
    const ticked = new Set(changes.map((c) => c.id).filter((x) => x !== id("new_milestone:new-1/s1")));
    const { plan } = planForAccepted(held, ticked, rowsOf(inp), NOW);
    expect(plan.creates[0].steps.map((s) => s.title)).toEqual(["Swap"]);
    expect(plan.sessions).toContainEqual({ session: "b", priority: "new-1", step_key: null });
  });

  test("a new milestone left unticked keeps its session where direct put it", () => {
    const { inp, held, id } = base();
    const { plan } = planForAccepted(held, new Set([id("rename:pri-1")]), rowsOf(inp), NOW);
    expect(plan.sessions).toEqual([]);
    expect(plan.updates).toEqual([{ short_id: "pri-1", patch: { title: "Grader holds" }, seen_steps: ["s1", "s2", "s3"] }]);
    expect(plan.merges).toEqual([]);
  });

  test("an unticked merge carries neither milestones nor sessions", () => {
    const { inp, changes, held, id } = base();
    const { plan } = planForAccepted(held, new Set(changes.map((c) => c.id).filter((x) => x !== id("merge:pri-2"))), rowsOf(inp), NOW);
    expect(plan.merges).toEqual([]);
    expect(plan.updates.find((u) => u.short_id === "pri-2")!.patch.steps).toBeUndefined();
    expect(plan.sessions.some((s) => s.session === "c")).toBe(false);
  });

  test("done, reopen and drop write the status and the milestone list as the pass would", () => {
    const inp = input({ priorities: [
      priority("pri-1", { ai_rank: 1, steps: [step("s1", { done: true, done_at: NOW - H })] }),
      priority("pri-2", { ai_rank: 2, steps: [step("s1"), step("s2")] }),
    ] });
    const [p1, p2] = inp.priorities;
    const { changes, held } = split(inp, out([same(p1, 1, { status: "done" }), same(p2, 1, { steps: [{ key: "s1", title: "Step s1", tier: "critical", refs: [] }] })]));
    expect(kinds(changes)).toEqual(["done:pri-1", "drop_milestone:pri-2/s2"]);
    const { plan } = planForAccepted(held, new Set(changes.map((c) => c.id)), rowsOf(inp), NOW + H);
    expect(plan.updates.find((u) => u.short_id === "pri-1")!.patch).toEqual({ status: "done", done_at: NOW + H, ai_rank: null });
    expect(plan.updates.find((u) => u.short_id === "pri-2")!.patch.steps!.map((s) => s.key)).toEqual(["s1"]);
  });

  test("a reopened priority comes back where the plan put it, between the ones there now", () => {
    const inp = input({ priorities: [...ranked(3), priority("pri-9", { status: "done" })] });
    const { changes, held } = split(inp, out([same(inp.priorities[3], 2, { status: "active" })]));
    expect(kinds(changes)).toEqual(["reopen:pri-9"]);
    const { plan, moves } = planForAccepted(held, new Set(["c1"]), rowsOf(inp), NOW);
    expect(plan.updates[0].patch).toEqual({ status: "active", done_at: null, ai_rank: 1.5 });
    expect(moves).toEqual([]);
  });

  test("a new priority lands where the plan slotted it among the ones there now", () => {
    const inp = input({ priorities: ranked(3) });
    const { held } = split(inp, out([proposal({ title: "Fresh", rank: 3 })]));
    const { plan } = planForAccepted(held, new Set(["c1"]), rowsOf(inp), NOW);
    expect(plan.creates[0].ai_rank).toBe(2.5);
  });
});

describe("merges", () => {
  const card = () => {
    const inp = input({
      priorities: [
        priority("pri-1", { person_pos: 1, title: "Emails", steps: [step("s1", { title: "Template" })], sessions: [{ id: "c", title: "c", step_key: "s1", last_active: NOW - 2 * H }] }),
        priority("pri-2", { ai_rank: 2 }),
      ],
      sessions: [session("c")],
    });
    return { inp, ...split(inp, out([proposal({ title: "Onboarding", rank: 1, merges: ["pri-1"], steps: [{ key: "pri-1/s1", title: "Template", tier: "critical", refs: [] }] })])) };
  };

  test("a merge into a new priority hangs off it and carries its milestones and sessions, not rows of their own", () => {
    const { changes, groups, direct } = card();
    expect(changes.map((c) => [c.kind, c.priority, c.target ?? null, c.parent ?? null])).toEqual([["new_priority", "new-1", null, null], ["merge", "new-1", "pri-1", "c1"]]);
    expect(groups).toEqual([{ priority: "new-1", rank: null, title: "Onboarding", changes: ["c1", "c2"] }]);
    expect(direct.sessions).toEqual([]);
  });

  test("both ticked: the new priority takes the absorbed one's milestones and sessions, and lands where the card showed it", () => {
    const { inp, held } = card();
    const { plan, skipped } = planForAccepted(held, new Set(["c1", "c2"]), rowsOf(inp), NOW);
    expect(skipped).toEqual([]);
    // Not the absorbed one's place, as a pass's merge would carry: the card showed it first, ahead of pri-2.
    expect(plan.creates[0].person_pos).toBeUndefined();
    expect(plan.creates[0]).toMatchObject({ ref: "new-1", ai_rank: 1 });
    expect(held.order).toEqual(["new-1", "pri-2"]);
    expect(plan.creates[0].steps.map((s) => [s.key, s.title])).toEqual([["s1", "Template"]]);
    expect(plan.merges).toEqual([{ short_id: "pri-1", merged_into: "new-1", step_keys: { s1: "s1" } }]);
    expect(plan.sessions).toEqual([{ session: "c", priority: "new-1", step_key: "s1" }]);
  });

  test("only the new priority ticked: no merge, no carried place, no milestones or sessions from it", () => {
    const { inp, held } = card();
    const { plan, skipped } = planForAccepted(held, new Set(["c1"]), rowsOf(inp), NOW);
    expect(skipped).toEqual([]);
    expect(plan.merges).toEqual([]);
    expect(plan.creates[0].person_pos).toBeUndefined();
    expect(plan.creates[0].steps).toEqual([]);
    expect(plan.creates[0].ai_rank).toBe(0);
    expect(plan.sessions).toEqual([]);
  });

  test("only the merge ticked: it cannot land without the priority it goes into", () => {
    const { inp, held } = card();
    expect(planForAccepted(held, new Set(["c2"]), rowsOf(inp), NOW)).toMatchObject({ plan: { creates: [], merges: [] }, skipped: ["c2"] });
  });

  test("a merge into an existing priority leaves the survivor where the card showed it, not at the absorbed one's place", () => {
    const inp = input({ priorities: [priority("pri-1", { ai_rank: 1 }), priority("pri-2", { ai_rank: 2 }), priority("pri-3", { person_pos: 3 })] });
    const { plan: passPlan, changes, held } = split(inp, out([same(inp.priorities[0], 1, { merges: ["pri-3"] })]));
    // The pass alone would carry the person's place over; the card shows pri-1 first and writes that.
    expect(passPlan.updates.find((u) => u.short_id === "pri-1")!.patch.person_pos).toBe(3);
    expect(kinds(changes)).toEqual(["merge:pri-1"]);
    const res = planForAccepted(held, new Set(["c1"]), rowsOf(inp), NOW);
    expect(res.plan.updates).toEqual([]);
    expect(res.plan.merges).toEqual([{ short_id: "pri-3", merged_into: "pri-1", step_keys: {} }]);
    expect(orderAfterAnswer(rowsOf(inp), res)).toEqual(held.order);
    // The absorbed one was set aside since: the merge no longer applies.
    const aside = rowsOf(inp).map((r) => (r.short_id === "pri-3" ? { ...r, status: "set_aside" as const } : r));
    expect(planForAccepted(held, new Set(["c1"]), aside, NOW)).toMatchObject({ plan: { merges: [], updates: [] }, skipped: ["c1"] });
  });
});

describe("stale answers", () => {
  const card = () => {
    const inp = input({ priorities: [
      priority("pri-1", { ai_rank: 1, steps: [step("s1", { title: "Faults" }), step("s2", { title: "Docs" })], step_key_max: 2 }),
      priority("pri-2", { ai_rank: 2, serves: null }),
    ] });
    const [p1, p2] = inp.priorities;
    const s = split(inp, out([
      same(p1, 1, { steps: [
        { key: "s1", title: "Faults under 5%", tier: "polish", refs: [], done_judged: true },
        { key: "s2", title: "Docs", tier: "critical", refs: [] },
        { title: "Calibrate", tier: "critical", refs: [] },
      ] }),
      same(p2, 2, { title: "Payments again", serves: "in-5" }),
      proposal({ title: "Recipes", rank: 3 }),
    ]));
    return { inp, ...s, all: new Set(s.changes.map((c) => c.id)) };
  };

  test("a milestone the person dropped since skips every row on it", () => {
    const { inp, changes, held, all } = card();
    const rows = rowsOf(inp).map((r) => (r.short_id === "pri-1" ? { ...r, steps: [{ ...r.steps[0], dropped: true }, r.steps[1]] } : r));
    const { skipped, plan } = planForAccepted(held, all, rows, NOW);
    const onS1 = changes.filter((c) => c.priority === "pri-1" && c.step_key === "s1").map((c) => c.id);
    expect(onS1).toHaveLength(3);
    expect(skipped.sort()).toEqual(onS1.sort());
    const steps = plan.updates.find((u) => u.short_id === "pri-1")!.patch.steps!;
    expect(steps.find((s) => s.key === "s1")).toEqual({ ...rows[0].steps[0] });
  });

  test("a milestone the person renamed, re-tiered or marked since keeps what they set", () => {
    const { inp, changes, held, all } = card();
    const rows = rowsOf(inp).map((r) => (r.short_id === "pri-1" ? { ...r, steps: [{ ...r.steps[0], title: "Mine", title_set_by: "person" as const, tier_set_by: "person" as const, done: false, done_set_by: "person" as const }, r.steps[1]] } : r));
    const { skipped } = planForAccepted(held, all, rows, NOW);
    expect(skipped.sort()).toEqual(changes.filter((c) => c.step_key === "s1").map((c) => c.id).sort());
  });

  test("a priority merged or deleted since skips its rows", () => {
    const { inp, changes, held, all } = card();
    const merged = rowsOf(inp).map((r) => (r.short_id === "pri-2" ? { ...r, status: "merged" as const } : r));
    expect(planForAccepted(held, all, merged, NOW).skipped.sort()).toEqual(changes.filter((c) => c.priority === "pri-2").map((c) => c.id).sort());
    const deleted = rowsOf(inp).filter((r) => r.short_id !== "pri-1");
    expect(planForAccepted(held, all, deleted, NOW).skipped.sort()).toEqual(changes.filter((c) => c.priority === "pri-1").map((c) => c.id).sort());
  });

  test("a milestone or priority whose title now exists is not added twice", () => {
    const { inp, changes, held, all } = card();
    const rows: CardRow[] = [
      ...rowsOf(inp).map((r) => (r.short_id === "pri-1" ? { ...r, steps: [...r.steps, step("s3", { title: "calibrate" })], step_key_max: 3 } : r)),
      priority("pri-7", { title: "Recipes", ai_rank: 3 }),
    ];
    const { skipped, plan } = planForAccepted(held, all, rows, NOW);
    expect(skipped.sort()).toEqual(changes.filter((c) => c.kind === "new_milestone" || c.kind === "new_priority").map((c) => c.id).sort());
    expect(plan.creates).toEqual([]);
  });

  test("a new milestone repeating one the person dropped since is skipped", () => {
    const { inp, changes, held, all } = card();
    const rows = rowsOf(inp).map((r) => (r.short_id === "pri-1" ? { ...r, steps: [...r.steps, step("s3", { title: "Calibrate", dropped: true })], step_key_max: 3 } : r));
    expect(planForAccepted(held, all, rows, NOW).skipped).toEqual(changes.filter((c) => c.kind === "new_milestone").map((c) => c.id));
  });

  test("a milestone added takes a key after every key the priority holds now", () => {
    const { inp, held, all } = card();
    const rows = rowsOf(inp).map((r) => (r.short_id === "pri-1" ? { ...r, steps: [...r.steps, step("s3", { title: "Someone's own" })], step_key_max: 4 } : r));
    const steps = planForAccepted(held, all, rows, NOW).plan.updates.find((u) => u.short_id === "pri-1")!.patch.steps!;
    expect(steps.map((s) => [s.key, s.title])).toEqual([["s1", "Faults under 5%"], ["s2", "Docs"], ["s5", "Calibrate"], ["s3", "Someone's own"]]);
  });

  test("a change already made since is skipped, not written again", () => {
    const { inp, changes, held } = card();
    const rows = rowsOf(inp).map((r) => (r.short_id === "pri-2" ? { ...r, title: "Payments again", serves: "in-5" } : r));
    const ticked = new Set(changes.filter((c) => c.priority === "pri-2").map((c) => c.id));
    const { plan, skipped } = planForAccepted(held, ticked, rows, NOW);
    expect(plan.updates).toEqual([]);
    expect(skipped.sort()).toEqual([...ticked].sort());
  });

  test("the held plan survives JSON", () => {
    const { inp, held, all } = card();
    const again = JSON.parse(JSON.stringify(held));
    expect(planForAccepted(again, all, rowsOf(inp), NOW)).toEqual(planForAccepted(held, all, rowsOf(inp), NOW));
  });
});

describe("quotes", () => {
  const sessions = [session("k3v", { title: "Retry storm", typed: [{ at: NOW - H, text: "Checkout is the thing\n  customers feel this week." }] })];
  const calls = [{ id: "cl-1", title: "Weekly", at: NOW - 2 * H, summary: "", action_items: ["Sam owns the change request flow"] }];

  test("found verbatim in a typed message, whitespace aside, in the person's own words", () => {
    expect(findQuote("the thing customers feel", sessions, calls)).toEqual({ kind: "session", session: "k3v", title: "Retry storm", at: NOW - H, text: "the thing\n  customers feel" });
  });

  test("found in a call's action item", () => {
    expect(findQuote("owns the change request flow", sessions, calls)).toEqual({ kind: "call", call: "cl-1", title: "Weekly", action_item: "Sam owns the change request flow", at: NOW - 2 * H, text: "owns the change request flow" });
  });

  test("case is ignored and the person's casing shown; a quote nobody said, or one too short to mean anything, is null", () => {
    expect(findQuote("checkout is the thing", sessions, calls)).toMatchObject({ session: "k3v", text: "Checkout is the thing" });
    expect(findQuote("Checkout is great today", sessions, calls)).toBeNull();
    expect(findQuote("the thing", sessions, calls)).toBeNull();
    expect(findQuote("customers feel this", sessions, calls)).toBeNull();
    expect(findQuote("   ", sessions, calls)).toBeNull();
  });

  test("a quote and its message fold alike: a Greek word-final sigma matches in either case", () => {
    const greek = [session("g1", { title: "Δρόμος", typed: [{ at: NOW, text: "ΤΟ ΣΧΕΔΙΟ ΤΗΣ ΟΔΟΣ ΜΕΝΕΙ ΙΔΙΟ" }] })];
    expect(findQuote("ΣΧΕΔΙΟ ΤΗΣ ΟΔΟΣ ΜΕΝΕΙ", greek, [])).toMatchObject({ session: "g1", text: "ΣΧΕΔΙΟ ΤΗΣ ΟΔΟΣ ΜΕΝΕΙ" });
    expect(findQuote("σχεδιο της οδος μενει", greek, [])).toMatchObject({ session: "g1", text: "ΣΧΕΔΙΟ ΤΗΣ ΟΔΟΣ ΜΕΝΕΙ" });
  });
});

/** The active order once an answer is written: its plan's statuses, places and new priorities, then its moves as the person's own (placePriority, as doMove). */
function orderAfterAnswer(rows: CardRow[], res: AcceptedPlan): string[] {
  const out = rows.map((r) => ({ ...r }));
  for (const m of res.plan.merges) out.find((r) => r.short_id === m.short_id)!.status = "merged";
  for (const u of res.plan.updates) {
    const r = out.find((x) => x.short_id === u.short_id)! as Record<string, unknown>;
    for (const [k, v] of Object.entries(u.patch)) if (k !== "person_pos" || r.person_pos == null) r[k] = v === null ? undefined : v;
  }
  for (const c of res.plan.creates) out.push({ short_id: c.ref, title: c.title, status: c.status, person_pos: c.person_pos ?? null, ai_rank: c.ai_rank, last_active_at: c.last_active_at, steps: c.steps });
  for (const m of res.moves) {
    const row = out.find((r) => r.short_id === m.short_id)!;
    for (const w of placePriority(out, row, m.to)) Object.assign(w.row, w.person_pos !== undefined ? { person_pos: w.person_pos } : { ai_rank: w.ai_rank });
  }
  return effectivePriorityOrder(out).map((r) => r.short_id);
}

/** A seeded generator, so a failing case reruns as it failed. */
function rng(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A random list (some placed by the person, some done) and a random reply that reranks some, reopens some, adds some and merges some. */
function randomCard(seed: number) {
  const r = rng(seed);
  const int = (lo: number, hi: number) => lo + Math.floor(r() * (hi - lo + 1));
  const n = int(2, 9);
  const prios: PassPriority[] = Array.from({ length: n }, (_, i) => priority(`pri-${i + 1}`, {
    last_active_at: NOW - (i + 1) * H, ...(r() < 0.3 ? { person_pos: i + 1 } : { ai_rank: i + 1 }),
  }));
  for (let d = int(0, 2); d > 0; d--) prios.push(priority(`pri-${prios.length + 1}`, { status: "done", last_active_at: NOW - H }));
  const props: PriorityProposal[] = [];
  for (const p of prios) {
    if (p.status === "active" && r() < 0.5) props.push(same(p, int(1, n + 2)));
    if (p.status === "done" && r() < 0.6) props.push(same(p, int(1, n + 2), { status: "active" }));
  }
  for (let k = int(0, 2); k > 0; k--) props.push(proposal({ title: `Fresh ${k}`, rank: int(1, n + 2) }));
  // An active priority the reply left alone may be absorbed by one it proposed, existing or new.
  const proposed = new Set(props.map((p) => p.short_id).filter(Boolean));
  for (const p of prios) {
    if (p.status !== "active" || proposed.has(p.short_id) || !props.length || r() >= 0.3) continue;
    const into = props[int(0, props.length - 1)];
    into.merges = [...(into.merges ?? []), p.short_id];
  }
  const inp = input({ priorities: prios });
  return { inp, r, ...split(inp, out(props)) };
}

describe("answering puts priorities where the card showed them", () => {
  test("ranks 1..5 reranked: the card's order is the order written", () => {
    const inp = input({ priorities: ranked(5) });
    const [p1, p2, p3, p4] = inp.priorities;
    const { changes, held } = split(inp, out([same(p1, 6), same(p2, 2), same(p3, 5), same(p4, 4)]));
    expect(held.order).toEqual(["pri-5", "pri-2", "pri-4", "pri-3", "pri-1"]);
    const res = planForAccepted(held, new Set(changes.map((c) => c.id)), rowsOf(inp), NOW);
    expect(orderAfterAnswer(rowsOf(inp), res)).toEqual(held.order);
  });

  test("a new priority among moves lands at its slot, and so do the moves", () => {
    const inp = input({ priorities: ranked(5) });
    const [p1, p2, , p4, p5] = inp.priorities;
    const { changes, held } = split(inp, out([same(p1, 5), same(p2, 2), same(p4, 1), same(p5, 4), proposal({ title: "Fresh", rank: 3 })]));
    expect(held.order[2]).toBe("new-1");
    const res = planForAccepted(held, new Set(changes.map((c) => c.id)), rowsOf(inp), NOW);
    expect(orderAfterAnswer(rowsOf(inp), res)).toEqual(held.order);
  });

  test("property: everything ticked, the order written is the card's", () => {
    const failures: number[] = [];
    for (let seed = 1; seed <= 400; seed++) {
      const { inp, changes, held } = randomCard(seed);
      const res = planForAccepted(held, new Set(changes.map((c) => c.id)), rowsOf(inp), NOW);
      if (JSON.stringify(orderAfterAnswer(rowsOf(inp), res)) !== JSON.stringify(held.order) || res.skipped.length) failures.push(seed);
    }
    expect(failures).toEqual([]);
  });

  test("property: some ticked, every priority whose move was not ticked keeps its order among the others", () => {
    const failures: number[] = [];
    for (let seed = 1; seed <= 400; seed++) {
      const { inp, changes, held, r } = randomCard(seed);
      const ticked = new Set(changes.filter(() => r() < 0.5).map((c) => c.id));
      const res = planForAccepted(held, ticked, rowsOf(inp), NOW);
      const moved = new Set(changes.filter((c) => c.kind === "move" && ticked.has(c.id)).map((c) => c.priority));
      const before = effectivePriorityOrder(rowsOf(inp)).map((p) => p.short_id).filter((id) => !moved.has(id));
      const written = orderAfterAnswer(rowsOf(inp), res);
      const afterOrder = written.filter((id) => before.includes(id));
      // A merged-away priority leaves the list; the rest keep their order.
      before.splice(0, before.length, ...before.filter((id) => written.includes(id)));
      if (JSON.stringify(afterOrder) !== JSON.stringify(before)) failures.push(seed);
    }
    expect(failures).toEqual([]);
  });

  test("a new priority between two that share a key is put in place by a move", () => {
    const tied = input({ priorities: [priority("pri-1", { ai_rank: 1 }), priority("pri-2", { ai_rank: 1, last_active_at: NOW - 5 * H }), priority("pri-3", { ai_rank: 2 })] });
    const t = split(tied, out([proposal({ title: "Fresh", rank: 2 })]));
    const res = planForAccepted(t.held, new Set(["c1"]), rowsOf(tied), NOW);
    expect(res.moves).toEqual([{ short_id: "new-1", to: 2 }]);
    expect(orderAfterAnswer(rowsOf(tied), res)).toEqual(t.held.order);
  });

  test("a ticked move the person already made is reported, and no move is made for it", () => {
    const inp = input({ priorities: ranked(3) });
    const { held } = split(inp, out([same(inp.priorities[0], 3)]));
    const rows = rowsOf(inp).map((r) => (r.short_id === "pri-1" ? { ...r, person_pos: 4 } : r));
    expect(planForAccepted(held, new Set(["c1"]), rows, NOW)).toMatchObject({ moves: [], skipped: ["c1"] });
  });
});

describe("review fixes", () => {
  test("move rows: none says a priority stays where it is, and the one the reply moved is named", () => {
    const two = input({ priorities: ranked(2) });
    expect(split(two, out([same(two.priorities[0], 2)])).changes.map((c) => [c.priority, c.from, c.to])).toEqual([["pri-1", 1, 2]]);
    const three = input({ priorities: ranked(3) });
    const [a, b, c] = three.priorities;
    const rows = split(three, out([same(c, 1), same(b, 2), same(a, 3)])).changes;
    expect(rows.every((x) => x.from !== x.to)).toBe(true);
    expect(rows.map((x) => x.priority).sort()).toEqual(["pri-1", "pri-3"]);
  });

  test("a new priority named like one it absorbs still lands", () => {
    const inp = input({ priorities: [priority("pri-1", { ai_rank: 1, title: "Emails" }), priority("pri-2", { ai_rank: 2 })] });
    const { changes, held } = split(inp, out([proposal({ title: "emails", rank: 1, merges: ["pri-1"] })]));
    const res = planForAccepted(held, new Set(changes.map((c) => c.id)), rowsOf(inp), NOW);
    expect(res.skipped).toEqual([]);
    expect(res.plan.creates.map((c) => c.title)).toEqual(["emails"]);
    // Without the merge ticked, it is a duplicate of the one that stays.
    expect(planForAccepted(held, new Set(["c1"]), rowsOf(inp), NOW).skipped).toEqual(["c1"]);
  });

  test("done lands only when the critical path it needs is done as written", () => {
    const inp = input({ priorities: [priority("pri-1", { ai_rank: 1, steps: [step("s1", { done: true, done_at: NOW - H }), step("s2")] })] });
    const p = inp.priorities[0];
    const { changes, held } = split(inp, out([same(p, 1, { status: "done", steps: [
      { key: "s1", title: "Step s1", tier: "critical", refs: [], done_judged: true },
      { key: "s2", title: "Step s2", tier: "critical", refs: [], done_judged: true },
    ] })]));
    expect(kinds(changes)).toEqual(["done:pri-1", "milestone_done:pri-1/s2"]);
    const alone = planForAccepted(held, new Set(["c1"]), rowsOf(inp), NOW);
    expect(alone).toMatchObject({ skipped: ["c1"], plan: { updates: [] } });
    const both = planForAccepted(held, new Set(["c1", "c2"]), rowsOf(inp), NOW);
    expect(both.skipped).toEqual([]);
    expect(both.plan.updates[0].patch.status).toBe("done");
  });

  test("a new milestone after an unticked new one follows the step that one followed, not a key the person has since", () => {
    const inp = input({ priorities: [priority("pri-1", { ai_rank: 1, steps: [step("s1"), step("s2")], step_key_max: 2 })] });
    const p = inp.priorities[0];
    const { changes, held } = split(inp, out([same(p, 1, { steps: [
      { key: "s1", title: "Step s1", tier: "critical", refs: [] },
      { key: "s2", title: "Step s2", tier: "critical", refs: [] },
      { title: "X", tier: "critical", refs: [] },
      { title: "Y", tier: "critical", refs: [] },
    ] })]));
    expect(kinds(changes)).toEqual(["new_milestone:pri-1/s3", "new_milestone:pri-1/s4"]);
    const rows = rowsOf(inp).map((r) => ({ ...r, steps: [...r.steps, step("s3", { title: "Mine" })], step_key_max: 3 }));
    const steps = planForAccepted(held, new Set(["c2"]), rows, NOW).plan.updates[0].patch.steps!;
    expect(steps.map((s) => [s.key, s.title])).toEqual([["s1", "Step s1"], ["s2", "Step s2"], ["s4", "Y"], ["s3", "Mine"]]);
  });

  test("a new priority that is not active reads without a slot", () => {
    const c: PriorityChange = { id: "c1", kind: "new_priority", priority: "new-1", to: null, evidence: [] };
    expect(changeLine(c, () => "Recipes")).toBe("New priority: Recipes");
    expect(changeLine({ ...c, to: 3 }, () => "Recipes")).toBe("New priority at #3: Recipes");
  });
});
