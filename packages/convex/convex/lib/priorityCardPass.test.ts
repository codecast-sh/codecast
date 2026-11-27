// What a pass run writes at once and puts on its card (lib/priorityCardPass.ts):
// the run without its merges, the merge rows with their evidence, typed
// shares, repeats an open card holds, declined merges, and the card's words. Pure.
import { describe, expect, test } from "bun:test";
import type { PriorityChange } from "@codecast/shared/contracts/priorityCard";
import type { PriorityPassOutput } from "@codecast/shared/contracts/priorities";
import { mergePriorities, type PassPriority, type PassSession, type PriorityPassInput } from "./priorityPass";
import { cardContext, cardQuestion, declinedFromCorrections, declinedMergeText, dropDeclined, dropRepeats, mergeCardDraft, planWithoutMerges, spanWords, typedByPriority, withCreatedIds, type CardDraft } from "./priorityCardPass";

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
const draftOf = (inp: PriorityPassInput, output: PriorityPassOutput): CardDraft => {
  const plan = mergePriorities(inp, output);
  return mergeCardDraft(plan, planWithoutMerges(inp, output, plan), inp, output);
};
const merge = { id: "c1", kind: "merge", priority: "pri-1", target: "pri-2", from: "Grader", evidence: [] } as PriorityChange;

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

  test("the card holds the merge row alone", () => {
    const card = draftOf(inp, output);
    expect(card.changes.map((c) => [c.kind, c.priority, c.target])).toEqual([["merge", "pri-1", "pri-2"]]);
    expect(card.groups.map((g) => g.changes)).toEqual([[card.changes[0].id]]);
  });

  test("a new priority that absorbs one is created now, with its own milestones and sessions; the merge names it once it has its short id", () => {
    const out: PriorityPassOutput = { priorities: [{ title: "Grading", summary: "", status: "active", serves: null, rank: 1, merges: ["pri-2"], steps: [{ key: "pri-2/s1", title: "Calibrate", tier: "critical", refs: [] }, { title: "Essays", tier: "critical", refs: [] }], sessions: [{ session: "a", step: "Essays" }, { session: "b", step: "pri-2/s1" }] }], unassigned: [] };
    const plan = mergePriorities(inp, out);
    const direct = planWithoutMerges(inp, out, plan);
    expect(direct.creates.map((c) => [c.ref, c.title, c.steps.map((s) => s.title)])).toEqual([["new-1", "Grading", ["Essays"]]]);
    expect(direct.sessions.map((s) => [s.session, s.priority])).toEqual([["a", "new-1"]]);
    const card = withCreatedIds(mergeCardDraft(plan, direct, inp, out), { "new-1": "pri-9" });
    expect([card.changes.map((c) => [c.kind, c.priority, c.target]), card.groups.map((g) => g.priority)]).toEqual([[["merge", "pri-9", "pri-2"]], ["pri-9"]]);
  });

  test("a declined merge, read back from its correction (not deleted), either way round, is left off a later card", () => {
    const other = { ...merge, id: "c2", target: "pri-3" } as PriorityChange;
    const declined = declinedFromCorrections([
      { text: declinedMergeText("pri-1", "Evals"), snapshot: { short_id: "pri-2" } },
      { text: declinedMergeText("pri-4", "Docs"), snapshot: { short_id: "pri-3" }, deleted_at: 1 },
      { text: "Grading is its own thing", snapshot: { short_id: "pri-3" } },
    ]);
    expect(declined).toEqual([{ absorbed: "pri-2", into: "pri-1" }]);
    const draft: CardDraft = { changes: [{ ...merge, priority: "pri-2", target: "pri-1" }, other], groups: [{ priority: "pri-1", rank: 1, title: "Evals", changes: ["c1", "c2"] }], typed: [], sessions: 0, calls: 0 };
    expect(dropDeclined(draft, declined).changes.map((c) => c.id)).toEqual(["c2"]);
  });
});

describe("evidence", () => {
  test("the survivor's why: a typed line is a quote, a call's action item an event naming the call, one never said is dropped", () => {
    const inp = input({
      priorities: [priority("pri-1", { title: "Broker email" }), priority("pri-2", { title: "Change requests" })],
      sessions: [session("jx7a", ["the change request flow is the same thing"])],
      calls: [{ id: "cl-244", title: "Broker email quality", at: NOW - 2 * H, summary: "", action_items: ["Jason works on the change request flow"] }],
    });
    const { changes } = draftOf(inp, { priorities: [{ short_id: "pri-1", title: "Broker email", summary: "", status: "active", serves: null, rank: 1, merges: ["pri-2"], steps: [], sessions: [], why: ["the change request flow is the same", "Jason works on the change", "never said by anyone"] }], unassigned: [] });
    expect(changes.map((c) => c.evidence)).toEqual([[
      { kind: "quote", text: "the change request flow is the same", session: "jx7a", session_title: "Session jx7a", at: NOW - H },
      { kind: "event", text: "Action item on “Broker email quality”: Jason works on the change request flow", ref: "cl-244", at: NOW - 2 * H },
    ]]);
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
  test("a merge an open card holds goes; another merge into the same priority stays; ids stay", () => {
    const other = { ...merge, id: "c2", target: "pri-3" } as PriorityChange;
    const draft: CardDraft = { changes: [merge, other], groups: [{ priority: "pri-1", rank: 1, title: "Evals", changes: ["c1", "c2"] }], typed: [], sessions: 0, calls: 0 };
    const again = dropRepeats(draft, [{ changes: [{ ...merge, id: "c7" }] }]);
    expect(again.changes.map((c) => c.id)).toEqual(["c2"]);
    expect(again.groups.map((g) => g.changes)).toEqual([["c2"]]);
  });
});

describe("words", () => {
  test("the question names the merge; the context, the window the run read", () => {
    expect(spanWords(40 * 60_000)).toBe("hour");
    expect(spanWords(5 * H)).toBe("5 hours");
    expect(spanWords(14 * 24 * H)).toBe("14 days");
    expect(cardQuestion([merge], () => "Trusted evals")).toBe("Merge “Grader” into “Trusted evals”?");
    expect(cardQuestion([merge, { ...merge, id: "c2" }], () => "x")).toBe("Merge 2 pairs of your priorities?");
    expect(cardContext({ sessions: 2, calls: 0, window: { from: 0, to: 3 * H } })).toStartWith("The priorities pass read 2 sessions from your last 3 hours and wrote its other changes.");
  });
});
