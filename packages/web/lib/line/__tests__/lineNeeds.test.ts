import { describe, expect, test } from "bun:test";
import { buildLineInbox, inboxCount, type InboxGroup, type InboxRow } from "../lineInbox";
import { lineNeeds, needCount, needForRef, needGroups, needOfCase, needOrder, notStarted } from "../lineNeeds";
import type { LineAdmission, RollupRow } from "../../lineFlow";

const now = Date.UTC(2026, 9, 12, 12);
const H = 3_600_000;
const row = (kind: InboxRow["kind"], key: string, over: Partial<InboxRow> = {}): InboxRow => ({
  key: `${kind}:${key}`, kind, at: now - H, projectId: "p1", title: `Problem ${key}`, ref: `ct-${key}`, detail: null, caseId: key, runId: null, cardId: null, cardRef: null, ...over,
});
const group = (kind: InboxRow["kind"], rows: InboxRow[]): InboxGroup => ({ kind, label: kind, rows });

describe("what waits on the viewer (lineNeeds)", () => {
  // A deadend run with outcome success stopped needing a yes; one that failed at its step is a failure, not a need.
  const stopped = { key: "deadend:prove", step: "prove", label: "Prove: needs Cameron's yes before it ships", raw: "no outgoing edge from prove (outcome success)" };
  const failed = { key: "deadend-failed:prove", step: "prove", label: "Prove failed", raw: "no outgoing edge from prove (outcome failure)" };
  const groups: InboxGroup[] = [
    group("decide", [row("decide", "1", { cardId: "d1", cardRef: "sd-1", ask: "Ship the shorter close?", at: now - 2 * H }), row("decide", "2", { cardId: "d2", cardRef: "sd-2", at: now - 5 * H })]),
    group("question", [row("question", "3", { ask: "Has Quinn left, or is Riley wrong?", note: "Akash took the call. Has Quinn left, or is Riley wrong?" })]),
    group("unapproved", [row("unapproved", "4")]),
    group("confirm", [row("confirm", "5", { ask: "Is this a real problem?" })]),
    group("failed", [row("failed", "6", { runId: "r6", fail: stopped }), row("failed", "7", { runId: "r7", fail: failed })]),
    group("stalled", [row("stalled", "8", { runId: "r8" })]),
    group("watching", [row("watching", "9")]),
    group("proposal", [row("proposal", "10", { trial: true, cardRef: "tc-10", hold: "No session asked this card" })]),
    group("stuck", [row("stuck", "p1", { caseId: null, ref: null, waiting: 47, switchOff: true }), row("stuck", "p2", { caseId: null, ref: null, waiting: 3, switchOff: false })]),
  ];
  const needs = lineNeeds(groups, { row: (r) => (r.caseId === "1" ? "agentwatch" : "codecast-line") });

  test("counts only what can be answered now, in the reader: a decision, a question, a confirm", () => {
    expect(needs.map((n) => [n.ref, n.kind, n.counted])).toEqual([
      ["sd-1", "decision", true], ["sd-2", "decision", true], ["ct-3", "question", true], ["ct-4", "lapsed", false],
      ["ct-5", "confirm", true], ["ct-6", "stopped", false], ["tc-10", "reask", false],
    ]);
    expect(needCount(needs)).toBe(4);
    // The old count and the new one are one reading.
    expect(inboxCount(groups)).toBe(needCount(needs));
  });

  test("a failed step, a silent run, a problem waiting for findings and a line that is off are never needs", () => {
    expect(needs.some((n) => ["ct-7", "ct-8", "ct-9"].includes(n.ref))).toBe(false);
    expect(notStarted(groups)).toEqual({ problems: 47, lines: 1 });
  });

  test("groups are named for the act, oldest first; Needs a new ask comes last, a built fix leading it", () => {
    const g = needGroups(needs);
    expect(g.map((x) => [x.label, x.counted, x.needs.map((n) => n.ref)])).toEqual([
      ["Fixes to decide", true, ["sd-2", "sd-1"]],
      ["Questions", true, ["ct-3"]],
      ["New: is this real?", true, ["ct-5"]],
      ["Needs a new ask", false, ["ct-4", "ct-6", "tc-10"]],
    ]);
    expect(needOrder(g).map((n) => n.ref)).toEqual(["sd-2", "sd-1", "ct-3", "ct-5", "ct-4", "ct-6", "tc-10"]);
  });

  test("a need carries what its reader shows: the question whole, its process, the stopped step's words", () => {
    expect(needs[0]).toMatchObject({ ask: "Ship the shorter close?", process: "agentwatch", decisionRef: "sd-1", caseId: "1" });
    expect(needs[2]).toMatchObject({ ask: "Has Quinn left, or is Riley wrong?", note: "Akash took the call. Has Quinn left, or is Riley wrong?" });
    // A stopped run's row names its problem; its reader carries what the step said.
    expect(needs.find((n) => n.kind === "stopped")?.line).toBe("Problem 6");
    expect(needs.find((n) => n.kind === "stopped")).toMatchObject({ ask: "Prove: needs Cameron's yes before it ships", runId: "r6" });
    expect(needs.find((n) => n.kind === "reask")).toMatchObject({ why: "No session asked this card", trial: true });
  });

  test("a list row says the question when it stands on its own, else the problem; a note cut mid-word ends at a sentence", () => {
    const cut = `Two reports of the card name. ${"The card's name set is thin. ".repeat(16)}Confirm whether the card's name set came from truncated data or from th`.slice(0, 500);
    const [n] = lineNeeds([group("confirm", [row("confirm", "11", { title: "Card names come out cut", note: cut, ask: "Confirm whether ... from th" })])]);
    expect(n.ask.endsWith("from th")).toBe(false);
    expect(n.ask.endsWith(".")).toBe(true);
    const [q] = lineNeeds([group("question", [row("question", "12", { title: "Eval gate fails", note: "Two causes fit. Choose which before work starts." })])]);
    expect(q.line).toBe("Eval gate fails");
    expect(q.ask).toBe("Choose which before work starts.");
  });

  test("a ref finds its need: the URL's own, an older link's decision or card, a problem", () => {
    expect(needForRef(needs, "sd-1")?.key).toBe("decide:1");
    expect(needForRef(needs, "d2")?.key).toBe("decide:2");
    expect(needForRef(needs, "tc-10")?.kind).toBe("reask");
    expect(needForRef(needs, "ct-3")?.kind).toBe("question");
    expect(needForRef(needs, "ct-404")).toBeNull();
    expect(needOfCase(needs, "4")?.kind).toBe("lapsed");
  });

  test("a trial card a session posted opens its decision; one nobody can answer is named by its card", () => {
    const off: LineAdmission = { role: { id: "r", handle: "lead", paused: false }, on: false, slots: 1, busy: null, hands: null, handsCap: null };
    const built = buildLineInbox({
      signals: [], runs: [], projects: [], rollups: [] as RollupRow[], admissions: new Map([["p1", off]]), now, decisions: [],
      tasks: [{ _id: "t1", short_id: "ct-1", title: "One", status: "open", project_id: "p1" }, { _id: "t2", short_id: "ct-2", title: "Two", status: "open", project_id: "p1" }] as never,
      trialCards: [
        { _id: "c1", short_id: "tc-1", project_id: "p1", task_id: "t1", run_id: "r1", kind: "card", question: "Ship?", options: [], status: "waiting", created_at: now - H, decision: { _id: "dd1", short_id: "sd-9", status: "pending" } },
        { _id: "c2", short_id: "tc-2", project_id: "p1", task_id: "t2", run_id: "r2", kind: "card", question: "Ship?", options: [], status: "waiting", created_at: now - H },
      ],
    });
    const n = lineNeeds(built);
    expect(n.map((x) => [x.ref, x.kind, x.counted, x.trial])).toEqual([["sd-9", "decision", true, true], ["tc-2", "reask", false, true]]);
  });
});
