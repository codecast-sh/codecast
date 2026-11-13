import { describe, expect, it } from "bun:test";
import { flatViewSessions, inboxNestParentOf, isSpawnedWorker, nestsWorkers, type InboxSession } from "../inboxStore";
import { placeSections } from "./placeTestHarness";

// In Modern focused (nestsWorkers), sessions an agent spawned (`cast spawn`
// workers, workflow subs) fold under the session that spawned them in the web
// list, like Task subagents: hidden
// until the Sub-agents and workers option is on. Display only: the shared
// nestParentIdOf (server kill cascade, org counts, revive) still treats them
// as first-class. Nothing waiting on the person may fold away.

const T0 = Date.now();
const row = (id: string, over: Partial<InboxSession> = {}): InboxSession => ({
  _id: id,
  session_id: `sess-${id}`,
  agent_type: "claude_code",
  agent_status: "idle",
  is_idle: true,
  has_pending: false,
  message_count: 3,
  updated_at: T0 - 60_000,
  agent_status_updated_at: T0 - 60_000,
  last_role_is_user: false,
  title: id,
  ...(over as any),
});
const working = { agent_status: "working", is_idle: false } as Partial<InboxSession>;
const done = { inbox_rest: "done", inbox_rest_at: T0, updated_at: T0 } as Partial<InboxSession>;
const ids = (xs: InboxSession[] | undefined) => (xs ?? []).map((s) => s._id);
const place = (rows: InboxSession[], modern = true) => placeSections(Object.fromEntries(rows.map((s) => [s._id, s])), new Set(), new Set(), { modern });
const flat = (placed: ReturnType<typeof place>, showSubagents: boolean) =>
  ids(flatViewSessions(placed.sorted, placed.subsByParent, { mode: "recent", showSubagents, nestWorkers: true }));

describe("spawned workers nest under their spawner (web display only)", () => {
  it("only Modern focused nests: Classic, Minimal and plain Modern do not", () => {
    expect(nestsWorkers({ modern_style: true, modern_focused: true })).toBe(true);
    expect(nestsWorkers({ modern_style: true })).toBe(false);
    // Modern is the default, so an unset modern_style is Modern.
    expect(nestsWorkers({ modern_focused: true })).toBe(true);
    expect(nestsWorkers({ modern_style: false, modern_focused: true })).toBe(false);
    expect(nestsWorkers({ visual_style: "minimal", modern_focused: true })).toBe(false);
    expect(nestsWorkers(undefined)).toBe(false);
  });

  it("only in Modern focused: every other style keeps every worker as its own row", () => {
    const parent = row("par0", working);
    const worker = row("wk0", { ...working, spawned_by_conversation_id: "par0" });
    const placed = place([parent, worker], false);
    expect(ids(placed.working).sort()).toEqual(["par0", "wk0"]);
    expect(placed.subsByParent.get("par0")).toBeUndefined();
    expect(placed.workerCountByParent.get("par0")).toBeUndefined();
    expect(inboxNestParentOf([parent, worker])(worker)).toBeNull();
  });

  it("a cast-spawn worker nests under its present parent and hides with the option off", () => {
    const parent = row("par1", working);
    const worker = row("wk1", { ...working, spawned_by_conversation_id: "par1" });
    const placed = place([parent, worker]);
    expect(ids(placed.working)).toEqual(["par1"]);
    expect(ids(placed.subsByParent.get("par1"))).toEqual(["wk1"]);
    expect(placed.workerCountByParent.get("par1")).toBe(1);
    expect(placed.workersNeedingYouByParent.has("par1")).toBe(false);
    expect(flat(placed, false)).toEqual(["par1"]);
    // With the option on it renders, directly under its parent.
    expect(flat(placed, true)).toEqual(["par1", "wk1"]);
  });

  it("nests whatever its own bucket, and counts in the section it renders in", () => {
    const parent = row("par1", working);
    const worker = row("wk1", { ...done, spawned_by_conversation_id: "par1" });
    const placed = place([parent, worker]);
    expect(placed.placements.get("wk1")?.bucket).toBe("done");
    expect(ids(placed.done)).toEqual([]);
    expect(ids(placed.subsByParent.get("par1"))).toEqual(["wk1"]);
    expect(placed.counts.done).toBe(0);
    expect(placed.counts.working).toBe(2);
  });

  it("a worker whose parent is absent stays visible as its own row", () => {
    const worker = row("wk1", { ...done, spawned_by_conversation_id: "gone" });
    const placed = place([worker]);
    expect(ids(placed.done)).toEqual(["wk1"]);
    expect(ids(placed.sorted)).toEqual(["wk1"]);
    expect(flat(placed, false)).toEqual(["wk1"]);
  });

  it("a worker whose parent is set aside stays visible as its own row", () => {
    const parent = row("par1", { inbox_stashed_at: T0 });
    const worker = row("wk1", { ...done, spawned_by_conversation_id: "par1" });
    const placed = place([parent, worker]);
    expect(ids(placed.done)).toEqual(["wk1"]);
    expect(flat(placed, false)).toEqual(["wk1"]);
  });

  it("a worker that needs input keeps its own row and the parent names it", () => {
    const parent = row("par1", working);
    const asking = row("wk1", { spawned_by_conversation_id: "par1", agent_status: "permission_blocked" });
    const quiet = row("wk2", { ...working, spawned_by_conversation_id: "par1" });
    const placed = place([parent, asking, quiet]);
    const bucket = placed.placements.get("wk1")?.bucket;
    expect(bucket === "needs_input" || bucket === "questions").toBe(true);
    expect([...ids(placed.needsInput), ...ids(placed.questions)]).toContain("wk1");
    expect(ids(placed.subsByParent.get("par1"))).toEqual(["wk2"]);
    expect(placed.workerCountByParent.get("par1")).toBe(2);
    expect(ids(placed.workersNeedingYouByParent.get("par1"))).toEqual(["wk1"]);
    // Folded workers hide; the one waiting on the person never does.
    expect(flat(placed, false).sort()).toEqual(["par1", "wk1"]);
  });

  it("a pinned worker keeps its pinned card", () => {
    const parent = row("par1", working);
    const worker = row("wk1", { ...working, spawned_by_conversation_id: "par1", is_pinned: true, inbox_pinned_at: T0 });
    const placed = place([parent, worker]);
    expect(ids(placed.pinned)).toEqual(["wk1"]);
    expect(placed.subsByParent.has("par1")).toBe(false);
  });

  it("a worker a nested worker spawned rides the card at the top of the chain", () => {
    const parent = row("par1", working);
    const mid = row("wk1", { ...working, spawned_by_conversation_id: "par1" });
    const leaf = row("wk2", { ...working, spawned_by_conversation_id: "wk1" });
    const placed = place([parent, mid, leaf]);
    expect(ids(placed.subsByParent.get("par1")).sort()).toEqual(["wk1", "wk2"]);
    expect(placed.subsByParent.has("wk1")).toBe(false);
    expect(placed.workerCountByParent.get("par1")).toBe(2);
    expect(placed.counts.working).toBe(3);
  });

  it("a workflow sub nests under the run's host session", () => {
    const host = row("host1", { ...working, workflow_run_id: "run1" });
    const sub = row("sub1", { ...working, workflow_run_id: "run1", is_workflow_sub: true });
    const placed = place([host, sub]);
    expect(ids(placed.subsByParent.get("host1"))).toEqual(["sub1"]);
    expect(placed.workerCountByParent.get("host1")).toBe(1);
    expect(flat(placed, false)).toEqual(["host1"]);
    expect(flat(placed, true)).toEqual(["host1", "sub1"]);
  });

  it("a workflow sub waiting on the person is named on the host row", () => {
    const host = row("host1", { ...working, workflow_run_id: "run1" });
    const sub = row("sub1", { workflow_run_id: "run1", is_workflow_sub: true, agent_status: "permission_blocked" });
    const placed = place([host, sub]);
    expect(ids(placed.workersNeedingYouByParent.get("host1"))).toEqual(["sub1"]);
  });

  it("a workflow sub whose host is absent stays in the flat list", () => {
    const sub = row("sub1", { ...working, workflow_run_id: "run1", is_workflow_sub: true });
    const placed = place([sub]);
    expect(flatViewSessions([sub], placed.subsByParent, { mode: "recent", showSubagents: false }).map((s) => s._id)).toEqual(["sub1"]);
  });
});

describe("inboxNestParentOf / isSpawnedWorker", () => {
  const parent = row("p");
  it("resolves a cast-spawn worker to its spawner", () => {
    const w = row("w", { spawned_by_conversation_id: "p" });
    expect(isSpawnedWorker(w)).toBe(true);
    expect(inboxNestParentOf([parent, w], true)(w)).toBe("p");
  });
  it("leaves a spawned team lead first-class", () => {
    const lead = row("l", { spawned_by_conversation_id: "p", agent_team_name: "t", agent_name: "team-lead" });
    expect(isSpawnedWorker(lead)).toBe(false);
    expect(inboxNestParentOf([parent, lead], true)(lead)).toBeNull();
  });
  it("keeps the shared kinds on the shared rule", () => {
    const task = row("t", { is_subagent: true, parent_conversation_id: "p", spawned_by_conversation_id: "x" });
    const mate = row("m", { spawned_by_conversation_id: "p", agent_team_name: "t", agent_name: "reviewer" });
    expect(isSpawnedWorker(task)).toBe(false);
    expect(isSpawnedWorker(mate)).toBe(false);
    expect(inboxNestParentOf([parent, task, mate], true)(task)).toBe("p");
    expect(inboxNestParentOf([parent, task, mate], true)(mate)).toBe("p");
  });
  it("never nests a row under itself", () => {
    const self = row("s", { spawned_by_conversation_id: "s" });
    expect(inboxNestParentOf([self], true)(self)).toBeNull();
  });
  it("a workflow sub with no host present has no parent", () => {
    const sub = row("ws", { workflow_run_id: "r", is_workflow_sub: true });
    const runLog = row("log", { workflow_run_id: "r", is_workflow_primary: true });
    expect(inboxNestParentOf([sub, runLog], true)(sub)).toBeNull();
  });
});
