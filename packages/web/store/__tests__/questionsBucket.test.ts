import { describe, expect, it } from "bun:test";
import type { InboxSession, SessionDecisionItem } from "../inboxStore";
import { placeSections } from "./placeTestHarness";

// The QUESTIONS bucket at the chokepoint (sync-convergence C3/C5). The former
// client-only liftQuestions pass is gone: `asking` is a placement INPUT the
// shared placeInboxRow reads (own open ask or permission prompt, a pending
// `cast decide`, or a child's open ask lifting its parent), so every replica
// files a question identically. These pin the behaviors that pass carried.

const T0 = Date.now();
const decide = (conversation_id: string, status: SessionDecisionItem["status"] = "pending"): SessionDecisionItem => ({
  _id: `d-${conversation_id}`,
  conversation_id,
  session_id: `sess-${conversation_id}`,
  question: "q",
  options: [{ label: "a" }, { label: "b" }],
  blocking: true,
  status,
  created_at: T0,
});
const row = (id: string, over: Partial<InboxSession> = {}): InboxSession => ({
  _id: id,
  session_id: `sess-${id}`,
  agent_type: "claude_code",
  agent_status: "idle",
  is_idle: true,
  has_pending: false,
  message_count: 3,
  updated_at: T0,
  title: id,
  ...(over as any),
});
const ids = (xs: InboxSession[]) => xs.map((s) => s._id);
const place = (rows: InboxSession[], decisions: Record<string, SessionDecisionItem> = {}) =>
  placeSections(Object.fromEntries(rows.map((s) => [s._id, s])), new Set(), undefined, { sessionDecisions: decisions });

describe("the questions bucket", () => {
  // The bug the pass existed for: an advisory decide keeps the agent working,
  // and Working was never sampled — the queue badge said 1 while the rail
  // showed nothing. Pin is the same story: asking outranks pinned.
  it("files a working or pinned session with a pending decide under QUESTIONS, out of its section", () => {
    const working = row("w1", { agent_status: "working", is_idle: false });
    const pinned = row("p1", { is_pinned: true, inbox_pinned_at: T0 });
    const placed = place([working, pinned], { a: decide("w1"), b: decide("p1") });
    expect(ids(placed.questions).sort()).toEqual(["p1", "w1"]);
    expect(placed.working).toEqual([]);
    expect(placed.pinned).toEqual([]);
    expect(placed.isQuestion(working)).toBe(true);
    expect(placed.isQuestion(pinned)).toBe(true);
    expect(placed.placements.get("w1")).toMatchObject({ bucket: "questions", work_state: "working" });
    expect(placed.tally.shown.questions).toBe(2);
  });

  it("an answered decide lifts nothing", () => {
    const working = row("w1", { agent_status: "working", is_idle: false });
    const placed = place([working], { d: decide("w1", "answered") });
    expect(placed.questions).toEqual([]);
    expect(ids(placed.working)).toEqual(["w1"]);
  });

  // The decision queue is user-scoped and membership-blind. A decide on a row
  // outside the rendered set (here: aged past the 30-day working set) is still
  // the viewer's question, so it renders in QUESTIONS — from the unscoped
  // row set — while the tally (working-set members only) leaves it out.
  it("pulls a non-member session in from the viewer's rows, without counting it in the tally", () => {
    const aged = row("h1", { updated_at: T0 - 40 * 24 * 60 * 60 * 1000 });
    const placed = place([aged], { d: decide("h1") });
    expect(ids(placed.questions)).toEqual(["h1"]);
    expect(placed.placements.has("h1")).toBe(false);
    expect(placed.tally.shown.questions).toBe(0);
  });

  it("never lifts killed or dismissed rows loose", () => {
    const rows = [
      row("k1", { inbox_killed_at: T0 }),
      row("x1", { inbox_dismissed_at: T0 }),
    ];
    const placed = place(rows, { k: decide("k1"), x: decide("x1") });
    expect(placed.questions).toEqual([]);
    // The dismissed row keeps its own set-aside slice (dismissed outranks asking).
    expect(ids(placed.dismissed)).toEqual(["x1"]);
  });

  it("a nested child never renders loose — its PRESENT parent lifts instead", () => {
    const parent = row("par1");
    const sub = row("sub1", { parent_conversation_id: "par1", agent_status: "permission_blocked" });
    const teamParent = row("tp1");
    const teamChild = row("tm1", { spawned_by_conversation_id: "tp1", agent_team_name: "team" });
    const placed = place([parent, sub, teamParent, teamChild], { t: decide("tm1") });
    expect(ids(placed.questions).sort()).toEqual(["par1", "tp1"]);
    expect(placed.isQuestion(parent)).toBe(true);
    expect(ids(placed.subsByParent.get("par1") ?? [])).toEqual(["sub1"]);
    expect(ids(placed.subsByParent.get("tp1") ?? [])).toEqual(["tm1"]);
    expect(placed.needsInput).toEqual([]);
  });

  it("grouping never crosses a section: a teammate nests under its lead only in the lead's bucket", () => {
    // Prod, 2026-09-01: seven teammates (spawned_by + agent_team_name, their
    // own members per rollupParentIdOf) sat in needs_input on the server and
    // in the tally, but the panel nested them under working / pinned leads
    // and rendered "Needs Input (2)" against a tally of 12.
    const lead = row("lead1", { agent_status: "working", is_idle: false });
    const mateDone = row("mate1", { spawned_by_conversation_id: "lead1", agent_team_name: "team", agent_status: "stopped" });
    const mateWorking = row("mate2", { spawned_by_conversation_id: "lead1", agent_team_name: "team", agent_status: "working", is_idle: false });
    const placed = place([lead, mateDone, mateWorking]);
    expect(placed.placements.get("mate1")?.bucket).toBe("needs_input");
    expect(ids(placed.needsInput)).toEqual(["mate1"]);
    expect(placed.tally.shown.needs_input).toBe(1);
    expect(ids(placed.working).sort()).toEqual(["lead1"]);
    // The working teammate shares the lead's bucket and nests as before.
    expect(ids(placed.subsByParent.get("lead1") ?? [])).toEqual(["mate2"]);
    expect(placed.tally.shown.working).toBe(2);
  });

  it("a killed child's question lifts nothing", () => {
    const parent = row("par1");
    const sub = row("sub1", { parent_conversation_id: "par1", agent_status: "permission_blocked", inbox_killed_at: T0 });
    const placed = place([parent, sub]);
    expect(placed.questions).toEqual([]);
    expect(ids(placed.needsInput)).toEqual(["par1"]);
  });

  // The phantom-card regression (Product aggregation super page, 2026-08-21):
  // the feed stops emitting subagent children once their parent is stashed or
  // dismissed, and the liveness overlay never covers subagent rows — so a
  // locally-held child frozen at permission_blocked would lift its stashed
  // parent into QUESTIONS forever, a card with no answerable question behind it.
  it("a frozen child under a stashed, dismissed, or absent parent lifts nothing", () => {
    const frozenChild = (parentId: string) =>
      row(`sub-${parentId}`, { parent_conversation_id: parentId, agent_status: "permission_blocked" });
    const stashed = row("st1", { inbox_stashed_at: T0 });
    const dismissed = row("dx1", { inbox_dismissed_at: T0 });
    const placed = place([stashed, dismissed, frozenChild("st1"), frozenChild("dx1"), frozenChild("gone")]);
    expect(placed.questions).toEqual([]);
    expect(placed.isQuestion(stashed)).toBe(false);
    expect(placed.isQuestion(dismissed)).toBe(false);
    expect(ids(placed.stashed)).toEqual(["st1"]);
    expect(ids(placed.dismissed)).toEqual(["dx1"]);
  });

  it("an open AskUserQuestion qualifies without any decide row, once", () => {
    const asking = row("a1", { awaiting_input: true });
    const silent = row("b1");
    const placed = place([asking, silent], { d: decide("a1") });
    expect(ids(placed.questions)).toEqual(["a1"]);
    expect(ids(placed.needsInput)).toEqual(["b1"]);
    expect(placed.tally.shown.questions).toBe(1);
  });
});
