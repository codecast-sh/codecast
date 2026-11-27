// The pure core of priority change cards (lib/priorityCard.ts): the rows for a
// plan's merges, and where a quote was said. Synthetic data only.
import { describe, expect, test } from "bun:test";
import type { PriorityPassOutput, PriorityProposal } from "@codecast/shared/contracts/priorities";
import { mergePriorities, type PassPriority, type PassSession, type PriorityPassInput } from "./priorityPass";
import { findQuote, mergeRows } from "./priorityCard";

const NOW = Date.UTC(2026, 10, 24, 15);
const H = 3_600_000;

const session = (id: string, over: Partial<PassSession> = {}): PassSession => ({
  id, kind: "session", title: `Session ${id}`, first_prompt: "", pin: null, idle_summary: null, last_active: NOW - H, tasks: [], prs: [], pin_events: [], typed: [], ...over,
});
const priority = (short_id: string, over: Partial<PassPriority> = {}): PassPriority => ({
  short_id, title: `Priority ${short_id}`, summary: "moving", status: "active", person_pos: null, ai_rank: null, serves: null, steps: [], last_active_at: NOW - 2 * H, sessions: [], ...over,
});
const input = (over: Partial<PriorityPassInput> = {}): PriorityPassInput => ({
  person: "Sam", workspace: "user:x", now: NOW, window_start: NOW - 3 * H, priorities: [], initiatives: [], step_tasks: [], sessions: [session("a"), session("b")], calls: [], ...over,
});
const proposal = (over: Partial<PriorityProposal> = {}): PriorityProposal => ({ title: "New thing", summary: "now", status: "active", serves: null, rank: 1, steps: [], sessions: [], ...over });
const out = (priorities: PriorityProposal[]): PriorityPassOutput => ({ priorities, unassigned: [] });

describe("merge rows", () => {
  const inp = input({ priorities: [priority("pri-1", { ai_rank: 2 }), priority("pri-2", { ai_rank: 1 }), priority("pri-3", { ai_rank: 3 }), priority("pri-4", { ai_rank: 4 })] });

  test("one row per absorbed priority, under the one it goes into, existing survivors by their place, then new ones; ids follow", () => {
    const plan = mergePriorities(inp, out([
      proposal({ short_id: "pri-1", title: "Priority pri-1", merges: ["pri-3"] }),
      proposal({ title: "Fresh", merges: ["pri-4"] }),
      proposal({ short_id: "pri-2", title: "Priority pri-2", merges: [] }),
    ]));
    const { changes, groups } = mergeRows(plan, inp);
    expect(changes).toEqual([
      { id: "c1", kind: "merge", priority: "pri-1", target: "pri-3", from: "Priority pri-3", evidence: [] },
      { id: "c2", kind: "merge", priority: "new-1", target: "pri-4", from: "Priority pri-4", evidence: [] },
    ]);
    expect(groups).toEqual([
      { priority: "pri-1", rank: 2, title: "Priority pri-1", changes: ["c1"] },
      { priority: "new-1", rank: null, title: "Fresh", changes: ["c2"] },
    ]);
  });

  test("no merge, no rows", () => {
    expect(mergeRows(mergePriorities(inp, out([proposal({ short_id: "pri-1", title: "Renamed" })])), inp)).toEqual({ changes: [], groups: [] });
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
