// The team's decision inbox (For you): every open decision of the team's lines is listed for every teammate, whoever it
// was asked of or assigned to; each row carries what a person needs to pick one (kind, assignee, people reached,
// findings, severity); and the list narrows, orders and groups as the address says.
import { describe, expect, test } from "bun:test";
import { buildLineInbox } from "../lineInbox";
import { lineNeeds } from "../lineNeeds";
import { arrangeInbox, inboxView } from "../decisionInbox";
import { contactsOf, decisionAssignee, severityBand } from "../decisionFacts";
const given = (id: string) => ({ passed_to: { kind: "user", id } });

const now = Date.UTC(2026, 9, 20, 12);
const H = 3_600_000;
const ME = "u-me";
const SAM = "u-sam";
const JO = "u-jo";
const cause = (id: string, project: string, signals: number, contacts: string[] = []) => ({
  _id: id, short_id: `ct-${id}`, title: `Problem ${id}`, status: "in_review", created_at: now - 72 * H, updated_at: now - 2 * H, project_id: project,
  cause: { signal_count: signals, first_seen: now - 72 * H, last_seen: now - 2 * H, fingerprints: contacts.map((c, i) => `evidence:contacts/${c}:ex-${i}:abc`) },
});
const decision = (id: string, task: string, at: number, over: Record<string, unknown> = {}) => ({
  _id: `d${id}`, short_id: `sd-${id}`, status: "pending", task_id: task, workflow_run_id: `r${id}`, gate_node_id: "decide", question: `Ship fix ${id}?`, created_at: now - at * H, ...over,
});

function inbox(decisions: unknown[], trialCards: unknown[] = [], decisionsComplete = false) {
  const groups = buildLineInbox({
    decisionsComplete,
    signals: [],
    runs: [], projects: [], rollups: [], admissions: new Map(), now, viewer: ME,
    tasks: [cause("1", "calls", 2, ["a", "b", "a"]), cause("2", "infra", 7, ["a", "b", "c", "d"]), cause("3", "calls", 1), cause("4", "trial", 3)] as never,
    decisions: decisions as never,
    trialCards: trialCards as never,
  });
  return lineNeeds(groups).filter((n) => n.counted);
}

describe("the team's decision inbox", () => {
  test("a decision asked of a teammate, of several people or of nobody's queue is listed all the same", () => {
    const needs = inbox([
      decision("1", "1", 30, { asked_user_ids: [SAM] }),
      decision("2", "2", 10, { asked_user_ids: [ME, SAM, JO] }),
      decision("3", "3", 5, { trial: undefined }),
    ]);
    expect(needs.map((n) => n.ref).sort()).toEqual(["sd-1", "sd-2", "sd-3"]);
  });

  test("each row says what is decided and carries its kind, assignee, people reached, findings and worst severity", () => {
    const needs = inbox([
      decision("1", "1", 30, { ...given(SAM), problem_severity: 6, card: { headline: "Problem 1 in other words" } }),
      decision("2", "2", 10, { asked_user_ids: [ME, SAM], ...given(JO), problem_severity: 9 }),
      // Asked of one person by routing is not assigned to them: assigning is a person's act.
      decision("3", "3", 5, { gate_node_id: "plan", asked_user_ids: [SAM] }),
    ]);
    const by = new Map(needs.map((n) => [n.ref, n]));
    expect(by.get("sd-1")).toMatchObject({ line: "Ship fix 1?", change: "fix", assignee: SAM, reach: 2, findings: 2, severity: 6, decisionId: "d1" });
    expect(by.get("sd-2")).toMatchObject({ assignee: JO, reach: 4, findings: 7, severity: 9 });
    expect(by.get("sd-3")).toMatchObject({ change: "other", assignee: null, reach: null, severity: null });
  });

  test("a waiting trial card is listed with its kind, read off the card, and says its decision's question", () => {
    const card = (id: string, over: Record<string, unknown>) => ({
      _id: `tc${id}`, short_id: `tc-${id}`, project_id: "trial", task_id: "4", run_id: `r${id}`, kind: "card", question: "Old words?", options: [], status: "waiting", created_at: now - H,
      card: { headline: "Problem 4", checks: [] }, decision: { _id: `dt${id}`, short_id: `sd-${id}`, status: "pending" }, run_status: "paused", ...over,
    });
    const needs = inbox(
      [decision("70", "4", 1, { _id: "dt70", trial: true, question: "Should callers be told? It changes the tip." }), decision("71", "4", 1, { _id: "dt71", trial: true, ...given(JO) })],
      [card("70", { evidence: { findings: 3, conversations: 5, withdrawn: 0, moved_to: [] } }), card("71", { judge_fix: { ab: { verdict: "better" } } })],
    );
    const by = new Map(needs.map((n) => [n.ref, n]));
    expect(by.get("sd-70")).toMatchObject({ line: "Should callers be told?", change: "fix", assignee: null, reach: 5, findings: 3, trial: true });
    expect(by.get("sd-71")).toMatchObject({ change: "judge", assignee: JO });
    // Each trial decision is listed once, from its card.
    expect(needs.filter((n) => n.ref === "sd-70")).toHaveLength(1);
  });

  test("a trial card whose decision is no longer among the open ones (its run moved past it) is not listed", () => {
    const card = { _id: "tc80", short_id: "tc-80", project_id: "trial", task_id: "4", run_id: "r80", kind: "card", question: "Q?", options: [], status: "waiting", created_at: now - H, card: { checks: [] }, decision: { _id: "dt80", short_id: "sd-80", status: "pending" }, run_status: "paused" };
    expect(inbox([], [card], true).map((n) => n.ref)).toEqual([]);
    // Before the team's decisions have arrived, the card's own word stands.
    expect(inbox([], [card], false).map((n) => n.ref)).toEqual(["sd-80"]);
    expect(inbox([decision("80", "4", 1, { _id: "dt80", trial: true })], [card], true).map((n) => n.ref)).toEqual(["sd-80"]);
  });

  test("an answered or withdrawn decision leaves the list for everyone", () => {
    const needs = inbox([decision("1", "1", 30, { status: "answered" }), decision("2", "2", 10, { status: "withdrawn" })]);
    expect(needs).toEqual([]);
  });

  test("the list narrows by who holds it, kind and area, and each filter counts what picking it would show", () => {
    const needs = inbox([
      decision("1", "1", 30, given(SAM)),
      decision("2", "2", 10, { ...given(ME), asked_user_ids: [ME] }),
      decision("3", "3", 5, { gate_node_id: "plan" }),
    ]);
    const ctx = { viewer: ME, areaName: (p: string | null) => p ?? "", personName: (u: string) => u };
    const mine = arrangeInbox(needs, inboxView({ who: "me" }), ctx);
    expect(mine.order.map((n) => n.ref)).toEqual(["sd-2"]);
    expect(arrangeInbox(needs, inboxView({ who: "none" }), ctx).order.map((n) => n.ref)).toEqual(["sd-3"]);
    expect(arrangeInbox(needs, inboxView({ who: SAM }), ctx).order.map((n) => n.ref)).toEqual(["sd-1"]);
    expect(arrangeInbox(needs, inboxView({ kind: "other" }), ctx).order.map((n) => n.ref)).toEqual(["sd-3"]);
    expect(arrangeInbox(needs, inboxView({ area: "calls" }), ctx).order.map((n) => n.ref).sort()).toEqual(["sd-1", "sd-3"]);
    // The counts of one filter are read under the others.
    expect(mine.counts.who.get("all")).toBe(3);
    expect(mine.counts.who.get("me")).toBe(1);
    expect(mine.counts.who.get("none")).toBe(1);
    expect(mine.counts.kind.get("fix")).toBe(1);
    expect(mine.counts.area.get("infra")).toBe(1);
  });

  test("it orders by impact, severity or age, and groups lead with their most pressing decision", () => {
    const needs = inbox([
      decision("1", "1", 30, { problem_severity: 6 }),
      decision("2", "2", 10, { problem_severity: 9 }),
      decision("3", "3", 5),
    ]);
    const ctx = { viewer: ME, areaName: (p: string | null) => p ?? "", personName: (u: string) => u };
    const flat = (order: string) => arrangeInbox(needs, inboxView({ order, group: "none" }), ctx).order.map((n) => n.ref);
    expect(flat("impact")).toEqual(["sd-2", "sd-1", "sd-3"]);
    expect(flat("severity")).toEqual(["sd-2", "sd-1", "sd-3"]);
    expect(flat("age")).toEqual(["sd-1", "sd-2", "sd-3"]);
    expect(flat("findings")).toEqual(["sd-2", "sd-1", "sd-3"]);
    expect(flat("area")).toEqual(["sd-1", "sd-3", "sd-2"]);
    const byArea = arrangeInbox(needs, inboxView({}), ctx);
    expect(byArea.sections.map((s) => [s.key, s.needs.map((n) => n.ref)])).toEqual([["infra", ["sd-2"]], ["calls", ["sd-1", "sd-3"]]]);
    expect(byArea.order.map((n) => n.ref)).toEqual(["sd-2", "sd-1", "sd-3"]);
    const byWho = arrangeInbox(needs, inboxView({ group: "who" }), ctx);
    expect(byWho.sections.map((s) => s.label)).toEqual(["Unassigned"]);
  });

  test("an address with nothing or nonsense in it is everyone's, by impact, by area", () => {
    expect(inboxView({ order: "loudest", group: "planet", kind: "x" })).toEqual({ who: "all", kind: null, area: null, order: "impact", group: "area" });
  });
});

describe("decision facts", () => {
  test("the assignee is the teammate it was given to, and nobody else", () => {
    expect(decisionAssignee({ passed_to: { kind: "user", id: "a" } })).toBe("a");
    expect(decisionAssignee({ passed_to: { kind: "role", id: "r" } })).toBeNull();
    expect(decisionAssignee({ passed_to: null })).toBeNull();
    expect(decisionAssignee(null)).toBeNull();
  });
  test("people are the distinct contacts the evidence names; severity reads as a band", () => {
    expect(contactsOf(["evidence:contacts/x:e1:1", "evidence:contacts/x:e2:2", "evidence:contacts/y:e1:3", "union:ask:fix"])).toBe(2);
    expect([severityBand(9), severityBand(6), severityBand(2), severityBand(null)]).toEqual(["high", "mid", "low", null]);
  });
});
