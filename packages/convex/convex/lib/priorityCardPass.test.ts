// What a pass run writes at once and puts on its card (lib/priorityCardPass.ts):
// the run without its merges, evidence, typed shares, repeats an open card
// holds, declined merges, and the card's words. Pure.
import { describe, expect, test } from "bun:test";
import type { PriorityChange } from "@codecast/shared/contracts/priorityCard";
import type { PriorityPassOutput } from "@codecast/shared/contracts/priorities";
import { mergePriorities, type PassPriority, type PassSession, type PriorityPassInput } from "./priorityPass";
import { splitPlan } from "./priorityCard";
import { cardContext, cardQuestion, declinedMerges, dropDeclined, dropRepeats, mergeCardDraft, planWithoutMerges, spanWords, typedByPriority, withEvidence, type CardDraft } from "./priorityCardPass";

const H = 3_600_000;
const NOW = 1_800_000_000_000;
const session = (id: string, typed: string[], over: Partial<PassSession> = {}): PassSession => ({
  id, kind: "session", title: `Session ${id}`, first_prompt: "", pin: null, idle_summary: null, last_active: NOW - H, tasks: [], prs: [], pin_events: [], typed: typed.map((text, i) => ({ at: NOW - H + i, text })), ...over,
});
const priority = (short_id: string, over: Partial<PassPriority> = {}): PassPriority => ({
  short_id, title: short_id, summary: "", status: "active", person_pos: null, ai_rank: Number(short_id.slice(4)), serves: null, steps: [], last_active_at: NOW - H, sessions: [], ...over,
});
const input = (over: Partial<PriorityPassInput> = {}): PriorityPassInput => ({
  person: "Ana", workspace: "Acme", now: NOW, window_start: NOW - 3 * H, priorities: [], initiatives: [], step_tasks: [], sessions: [], calls: [], ...over,
});
/** Every change the core splits out of a reply, with evidence, as a draft. */
const draftOf = (inp: PriorityPassInput, output: PriorityPassOutput): CardDraft => {
  const plan = mergePriorities(inp, output);
  const split = splitPlan(plan, inp, output);
  return { changes: withEvidence(split.changes, plan, inp, output), groups: split.groups, held: split.held, typed: [], sessions: 0, calls: 0 };
};

describe("merges wait, the rest is written", () => {
  const step = (key: string, title: string) => ({ key, title, tier: "critical" as const, tier_set_by: "pass" as const, refs: [], done: false });
  const inp = input({
    priorities: [
      priority("pri-1", { title: "Evals", steps: [step("s1", "Faults"), step("s2", "Docs")], sessions: [{ id: "a", title: "a", step_key: "s1", last_active: NOW - H }] }),
      priority("pri-2", { title: "Grader", steps: [step("s1", "Calibrate"), step("s2", "Docs")], sessions: [{ id: "b", title: "b", step_key: "s1", last_active: NOW - H }] }),
    ],
    sessions: [session("a", ["x"]), session("b", ["y"])],
  });
  const output: PriorityPassOutput = { priorities: [{
    short_id: "pri-1", title: "Trusted evals", summary: "", status: "active", serves: null, rank: 1, merges: ["pri-2"],
    steps: [{ key: "s1", title: "Faults", tier: "critical", refs: [] }, { key: "s2", title: "Docs", tier: "polish", refs: [] }, { key: "pri-2/s1", title: "Calibrate", tier: "critical", refs: [] }],
    sessions: [{ session: "a", step: "s1" }, { session: "b", step: "pri-2/s1" }],
  }], unassigned: [] };

  test("the run without its merges: the survivor takes no milestone of the absorbed one (its own same-titled one stays), and the absorbed one's sessions stay", () => {
    const plan = mergePriorities(inp, output);
    const direct = planWithoutMerges(inp, output, plan);
    expect(direct.merges).toEqual([]);
    const evals = direct.updates.find((u) => u.short_id === "pri-1")!;
    expect([evals.patch.title, evals.patch.steps?.map((s) => [s.key, s.title, s.tier])]).toEqual(["Trusted evals", [["s1", "Faults", "critical"], ["s2", "Docs", "polish"]]]);
    expect(direct.updates.some((u) => u.short_id === "pri-2" && u.patch.status)).toBe(false);
    expect(direct.sessions.map((s) => s.session)).not.toContain("b");
  });

  test("the card holds the merge alone, and the session waiting on it", () => {
    const plan = mergePriorities(inp, output);
    const direct = planWithoutMerges(inp, output, plan);
    const card = mergeCardDraft(splitPlan(plan, inp, output), plan, direct, inp, output);
    expect(card.changes.map((c) => [c.kind, c.priority, c.target])).toEqual([["merge", "pri-1", "pri-2"]]);
    expect(card.held.changes.map((c) => c.kind)).toEqual(["merge"]);
    expect(card.held.sessions.map((s) => [s.session, s.needs])).toEqual([["b", [card.changes[0].id]]]);
    expect(card.groups.map((g) => g.changes)).toEqual([[card.changes[0].id]]);
  });

  test("a merge declined (unticked, or on a dismissed card) is remembered either way round, and left off a later card", () => {
    const merge = { id: "c1", kind: "merge", priority: "pri-1", target: "pri-2", from: "Grader", evidence: [] } as PriorityChange;
    const other = { ...merge, id: "c2", target: "pri-3" } as PriorityChange;
    expect(declinedMerges([{ status: "answered", card: { changes: [merge, other], outcome: { accepted: ["c2"], skipped: [], at: 1 } } }])).toEqual([{ absorbed: "pri-2", into: "pri-1" }]);
    expect(declinedMerges([{ status: "dismissed", card: { changes: [merge] } }])).toEqual([{ absorbed: "pri-2", into: "pri-1" }]);
    expect(declinedMerges([{ status: "answered", card: { changes: [merge], outcome: { accepted: [], skipped: ["c1"], at: 1 } } }])).toEqual([]);
    const draft: CardDraft = { changes: [{ ...merge, priority: "pri-2", target: "pri-1" }, other], groups: [{ priority: "pri-1", rank: 1, title: "Evals", changes: ["c1", "c2"] }], held: { v: 1, order: [], creates: [], changes: [], sessions: [] }, typed: [], sessions: 0, calls: 0 };
    expect(dropDeclined(draft, [{ absorbed: "pri-2", into: "pri-1" }]).changes.map((c) => c.id)).toEqual(["c2"]);
  });
});

describe("evidence", () => {
  test("a call's action item is an event naming the call; a goal is named by title", () => {
    const inp = input({
      priorities: [priority("pri-1", { title: "Broker email" })],
      initiatives: [{ short_id: "in-5", title: "Win brokers" }],
      calls: [{ id: "cl-244", title: "Broker email quality", at: NOW - 2 * H, summary: "", action_items: ["Jason works on the change request flow"] }],
    });
    const { changes } = draftOf(inp, { priorities: [{ short_id: "pri-1", title: "Broker email", summary: "", status: "active", serves: "in-5", rank: 1, steps: [], sessions: [], why: ["works on the change request flow", "never said"] }], unassigned: [] });
    expect(changes).toEqual([expect.objectContaining({
      kind: "serves", from: null, to: "Win brokers",
      evidence: [{ kind: "event", text: "Action item on “Broker email quality”: Jason works on the change request flow", ref: "cl-244", at: NOW - 2 * H }],
    })]);
  });

  test("a milestone the card marks done gets an event for each closed task and merged pull request", () => {
    const inp = input({
      priorities: [priority("pri-1", { steps: [{ key: "s1", title: "Ship it", tier: "critical", tier_set_by: "pass", refs: [], done: false }] })],
      sessions: [session("jx7a", ["ship it"], { tasks: [{ short_id: "ct-9", title: "Ship", status: "done" }], prs: [{ ref: "acme/app#12", merged: true }] })],
    });
    const { changes } = draftOf(inp, { priorities: [{ short_id: "pri-1", title: "pri-1", summary: "", status: "active", serves: null, rank: 1, sessions: [], steps: [
      { key: "s1", title: "Ship it", tier: "critical", refs: [], done_judged: true },
      { title: "Launch", tier: "critical", refs: [{ kind: "task", id: "ct-9" }, { kind: "pr", id: "acme/app#12" }] },
    ] }], unassigned: [] });
    const born = changes.find((c) => c.kind === "new_milestone")!;
    expect(born.evidence).toEqual([
      { kind: "event", text: "Task ct-9 “Ship” closed", ref: "ct-9" },
      { kind: "event", text: "Pull request acme/app#12 merged", ref: "acme/app#12" },
    ]);
    expect(changes.find((c) => c.kind === "milestone_done")!.evidence).toEqual([]);
  });
});

describe("typed shares", () => {
  test("by the priority each session sits on once the direct part is written; none is its own row", () => {
    const inp = input({
      priorities: [priority("pri-1", { sessions: [{ id: "a", title: "a", step_key: null, last_active: NOW - H }] }), priority("pri-2")],
      sessions: [session("a", ["12345"]), session("b", ["1234567890"]), session("c", ["12"])],
    });
    const plan = mergePriorities(inp, { priorities: [{ short_id: "pri-2", title: "pri-2", summary: "", status: "active", serves: null, rank: 2, steps: [], sessions: [{ session: "b" }] }], unassigned: [] });
    expect(typedByPriority(inp, plan).sort((x, y) => y.chars - x.chars)).toEqual([{ priority: "pri-2", chars: 10 }, { priority: "pri-1", chars: 5 }, { priority: null, chars: 2 }]);
  });
});

describe("repeats", () => {
  const inp = input({ priorities: [priority("pri-1", { title: "Grader" })] });
  const output: PriorityPassOutput = { priorities: [
    { short_id: "pri-1", title: "Grader holds", summary: "", status: "active", serves: null, rank: 1, steps: [], sessions: [] },
    { title: "Recipes", summary: "", status: "active", serves: null, rank: 2, steps: [{ title: "Paste", tier: "critical", refs: [] }], sessions: [] },
  ], unassigned: [] };

  test("a change an open card holds goes, a new priority by its title with its milestones; ids stay", () => {
    const first = draftOf(inp, output);
    expect(first.changes.map((c) => [c.id, c.kind])).toEqual([["c1", "rename"], ["c2", "new_priority"], ["c3", "new_milestone"]]);
    const open = { held: first.held, changes: first.changes.filter((c) => c.kind === "new_priority") };
    const again = dropRepeats(draftOf(inp, output), [open]);
    expect(again.changes.map((c) => c.id)).toEqual(["c1"]);
    expect(again.groups.map((g) => [g.priority, g.changes])).toEqual([["pri-1", ["c1"]]]);
    // A different rename is a different change.
    const other = dropRepeats(draftOf(inp, output), [{ held: first.held, changes: [{ ...first.changes[0], to: "Grader stays" } as PriorityChange] }]);
    expect(other.changes.map((c) => c.id)).toEqual(["c1", "c2", "c3"]);
  });
});

describe("words", () => {
  test("the question names the merge; the context, the window the run read", () => {
    expect(spanWords(40 * 60_000)).toBe("hour");
    expect(spanWords(5 * H)).toBe("5 hours");
    expect(spanWords(14 * 24 * H)).toBe("14 days");
    const merge = { id: "c1", kind: "merge", priority: "pri-1", target: "pri-2", from: "Grader", evidence: [] } as PriorityChange;
    expect(cardQuestion([merge], () => "Trusted evals")).toBe("Merge “Grader” into “Trusted evals”?");
    expect(cardQuestion([merge, { ...merge, id: "c2" }], () => "x")).toBe("Merge 2 pairs of your priorities?");
    expect(cardContext({ sessions: 2, calls: 0, window: { from: 0, to: 3 * H } })).toStartWith("The priorities pass read 2 sessions from your last 3 hours and wrote its other changes.");
  });
});
