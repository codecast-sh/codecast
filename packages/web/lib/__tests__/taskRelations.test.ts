// The task page's relations (task-graph.md TG12): the Blocked by row's lines,
// the add-blocker and related palettes, the draft writes behind the store
// actions, and how the timeline reads a graph history row.
import { afterAll, describe, expect, test } from "bun:test";
import { useInboxStore } from "../../store/inboxStore";
import { addWaitDraft, removeWaitDraft, setBlockerEdge, setRelatedEdge, waitTargetOf } from "../../store/taskGraphDraft";
import { applyRelationPick, blockerLines, foundHereOf, parseRelationQuery, relationItems, storeBlockerLines } from "../taskRelations";
import { storeStatusOf } from "../taskBlockers";
import { graphChange } from "../../components/tasks/taskGraphHistory";

const WS = "team:t1";
const NOW = Date.UTC(2026, 9, 8, 12);
const TZ = "UTC";
const task = (n: number, over: Record<string, any> = {}) => ({
  _id: `id${n}`, short_id: `ct-${n}`, title: `Task ${n}`, status: "open", priority: "medium", task_type: "task", source: "human",
  workspace: WS, created_at: n, updated_at: n, ...over,
}) as any;
const rows = (...ts: any[]) => Object.fromEntries(ts.map((t) => [t._id, t]));

describe("blockerLines", () => {
  test("lists every blocker: open, closed as met, looked up and gone as missing, unanswered as unknown, then waits", () => {
    const tasks = rows(task(2, { status: "in_progress" }), task(3, { status: "done" }));
    const t = task(1, {
      blocked_by: ["ct-2", "id3", "ct-404", "ct-9", "ct-10"],
      graph_status: [{ ref: "ct-404", status: null }, { ref: "ct-9", short_id: "ct-9", status: "done" }],
      waits: [{ id: "w1", kind: "pr_merged", repository: "o/r", pr_number: 42, state: "met", created_at: 0, note: "merged" }],
    });
    const lines = blockerLines(t, storeStatusOf(tasks, t));
    expect(lines.map((l) => (l.kind === "task" ? `${l.ref}:${l.state}:${l.raw}` : `${l.wait.id}:${l.wait.state}`))).toEqual([
      "ct-2:open:ct-2",
      // An _id ref reads as its short id but is removed as stored.
      "ct-3:met:id3",
      "ct-404:missing:ct-404",
      // Not in the store: the list row's snapshot answers for it.
      "ct-9:met:ct-9",
      "ct-10:unknown:ct-10",
      "w1:met",
    ]);
  });

  test("a blocker named twice (short id and _id) is one line", () => {
    const tasks = rows(task(2));
    expect(storeBlockerLines(task(1, { blocked_by: ["ct-2", "id2"] }), tasks)).toHaveLength(1);
  });
});

describe("found here", () => {
  test("the store's tasks found during this one, in its workspace, oldest first", () => {
    const tasks = rows(task(1), task(5, { found_during: "ct-1" }), task(4, { found_during: "ct-1" }), task(6, { found_during: "ct-1", workspace: "user:x" }));
    expect(foundHereOf(task(1), tasks).map((t) => t.short_id)).toEqual(["ct-4", "ct-5"]);
  });
});

describe("the palette", () => {
  const tasks = rows(task(1, { blocked_by: ["ct-2"] }), task(2, { blocks: ["ct-1"] }), task(3, { blocked_by: ["ct-1"] }), task(4, { title: "Ship the schema" }), task(9, { status: "done" }));

  test("reads every TG3 form; a related link takes tasks only", () => {
    expect(parseRelationQuery("#42", "blocker", NOW, TZ)).toEqual({ pick: { kind: "wait", target: { kind: "pr_merged", repository: "", pr_number: 42 } } });
    expect(parseRelationQuery("o/r#7:checks", "blocker", NOW, TZ)).toEqual({ pick: { kind: "wait", target: { kind: "pr_checks_green", repository: "o/r", pr_number: 7 } } });
    expect(parseRelationQuery("sd-4", "blocker", NOW, TZ)).toEqual({ pick: { kind: "wait", target: { kind: "decision", decision: "sd-4" } } });
    expect(parseRelationQuery("2h", "blocker", NOW, TZ)).toEqual({ pick: { kind: "wait", target: { kind: "time", at: NOW + 2 * 3_600_000 } } });
    expect(parseRelationQuery("ct-012", "blocker", NOW, TZ)).toEqual({ pick: { kind: "task", ref: "ct-12" } });
    expect(parseRelationQuery("42", "blocker", NOW, TZ)).toMatchObject({ error: expect.stringContaining("ambiguous") });
    expect(parseRelationQuery("#42", "related", NOW, TZ)).toMatchObject({ error: expect.stringContaining("to a task") });
    expect(parseRelationQuery("  ", "blocker", NOW, TZ)).toBeNull();
  });

  test("a pasted wait comes first, worded as the wait", () => {
    const items = relationItems("blocker", "#42", [tasks.id1], tasks, NOW, TZ);
    expect(items[0]).toMatchObject({ label: "Wait until PR #42 merges", pick: { kind: "wait" } });
    expect(relationItems("blocker", "o/r#42", [tasks.id1], tasks, NOW, TZ)[0]!.label).toBe("Wait until PR o/r#42 merges");
  });

  test("searches open tasks of the workspace, without itself, its blockers or closed work; marks a loop", () => {
    const all = relationItems("blocker", "", [tasks.id1], tasks, NOW, TZ);
    expect(all.map((i) => i.key)).toEqual(["task:ct-4", "task:ct-3"]);
    // ct-3 already waits on ct-1, so ct-1 waiting on ct-3 closes a loop.
    expect(all.find((i) => i.key === "task:ct-3")!.hint).toBe("would close a loop");
    expect(relationItems("blocker", "schema", [tasks.id1], tasks, NOW, TZ).map((i) => i.key)).toEqual(["task:ct-4"]);
    expect(relationItems("related", "", [tasks.id1], tasks, NOW, TZ).map((i) => i.key)).toEqual(["task:ct-4", "task:ct-3", "task:ct-2"]);
  });
});

describe("a palette pick", () => {
  const before = useInboxStore.getState();
  afterAll(() => useInboxStore.setState(before, true));
  const calls: string[] = [];
  const spy = (name: string) => (...args: any[]) => { calls.push(`${name}:${JSON.stringify(args)}`); return Promise.resolve(); };

  test("a task blocker is added, a loop is refused before anything paints", () => {
    useInboxStore.setState({
      tasks: rows(task(1), task(3, { blocked_by: ["ct-1"] }), task(4)),
      addBlocker: spy("addBlocker"), addWait: spy("addWait"), relateTasks: spy("relateTasks"),
    } as any);
    const [t1] = [useInboxStore.getState().tasks.id1 as any];
    expect(applyRelationPick("blocker", [t1], { kind: "task", ref: "ct-4" })).toEqual({ ok: true, message: "ct-1 waits on ct-4" });
    expect(applyRelationPick("blocker", [t1], { kind: "task", ref: "ct-3" })).toMatchObject({ ok: false, message: expect.stringContaining("loop") });
    expect(applyRelationPick("related", [t1], { kind: "task", ref: "ct-1" })).toMatchObject({ ok: false });
    expect(applyRelationPick("related", [t1], { kind: "task", ref: "ct-3" })).toMatchObject({ ok: true });
    const r = applyRelationPick("blocker", [t1], { kind: "wait", target: { kind: "decision", decision: "sd-4" } });
    expect(r).toEqual({ ok: true, message: "ct-1 waits until sd-4 answered" });
    expect(calls[0]).toBe('addBlocker:["ct-1","ct-4"]');
    expect(calls[1]).toBe('relateTasks:["ct-1","ct-3"]');
    expect(calls[2]).toMatch(/^addWait:\["ct-1",\{"id":"w[0-9a-z]+","target":\{"kind":"decision","decision":"sd-4"\}\}\]$/);
    expect(calls).toHaveLength(3);
  });
});

describe("draft writes", () => {
  test("a blocker edge paints both rows, every copy, and comes off both", () => {
    const tasks: any = { id1: task(1), stub1: task(1, { _id: "stub1" }), id2: task(2) };
    setBlockerEdge(tasks, "ct-1", "ct-2", true, 7);
    expect([tasks.id1.blocked_by, tasks.stub1.blocked_by, tasks.id2.blocks, tasks.id2.updated_at]).toEqual([["ct-2"], ["ct-2"], ["ct-1"], 7]);
    setBlockerEdge(tasks, "ct-1", "ct-2", true, 8);
    expect(tasks.id1.blocked_by).toEqual(["ct-2"]);
    setBlockerEdge(tasks, "ct-1", "ct-2", false, 9);
    expect([tasks.id1.blocked_by, tasks.id2.blocks]).toEqual([[], []]);
  });

  test("related is mirrored", () => {
    const tasks: any = { id1: task(1), id2: task(2) };
    setRelatedEdge(tasks, "ct-1", "ct-2", true);
    expect([tasks.id1.related, tasks.id2.related]).toEqual([["ct-2"], ["ct-1"]]);
  });

  test("a wait paints as waiting under the client's id, once, and its target sets it again", () => {
    const tasks: any = { id1: task(1) };
    addWaitDraft(tasks, "ct-1", { id: "wx", target: { kind: "pr_merged", repository: "o/r", pr_number: 4 } }, "u1", 5);
    addWaitDraft(tasks, "ct-1", { id: "wx", target: { kind: "pr_merged", repository: "o/r", pr_number: 4 } }, "u1", 6);
    expect(tasks.id1.waits).toEqual([{ kind: "pr_merged", repository: "o/r", pr_number: 4, id: "wx", state: "waiting", created_at: 5, created_by: "u1" }]);
    expect(waitTargetOf({ ...tasks.id1.waits[0], state: "met", note: "merged" })).toEqual({ kind: "pr_merged", repository: "o/r", pr_number: 4 });
    removeWaitDraft(tasks, "ct-1", "wx");
    expect(tasks.id1.waits).toEqual([]);
  });
});

describe("the timeline's graph rows", () => {
  test("blockers, links and waits read as what happened", () => {
    expect(graphChange({ field: "blocked_by", old_value: "ct-1", new_value: "ct-1, ct-2" })).toEqual({ tone: "blocked", clauses: [{ verb: "made it wait on", refs: ["ct-2"] }] });
    expect(graphChange({ field: "blocked_by", old_value: "ct-1, ct-2", new_value: "ct-2" })).toEqual({ tone: "met", clauses: [{ verb: "removed blocker", refs: ["ct-1"] }] });
    expect(graphChange({ field: "related", old_value: "", new_value: "ct-3" })).toEqual({ tone: "link", clauses: [{ verb: "linked it to", refs: ["ct-3"] }] });
    expect(graphChange({ field: "found_during", old_value: "", new_value: "ct-12" })!.clauses[0]).toEqual({ verb: "found it while working on", refs: ["ct-12"] });
    expect(graphChange({ field: "superseded_by", old_value: "", new_value: "ct-9" })!.clauses[0]).toEqual({ verb: "superseded it with", refs: ["ct-9"] });
    expect(graphChange({ field: "waits", old_value: "", new_value: "Waiting on PR #42" })).toEqual({ tone: "blocked", clauses: [{ verb: "set a wait:", text: "Waiting on PR #42" }] });
    expect(graphChange({ field: "waits", old_value: "Waiting on PR #42", new_value: "PR #42 merged" })!.tone).toBe("met");
    expect(graphChange({ field: "waits", old_value: "Waiting on PR #42", new_value: "PR #42 merges (failed: closed without merging)" })!.tone).toBe("failed");
    expect(graphChange({ field: "waits", old_value: "sd-4 answered", new_value: "Waiting on sd-4" })!.clauses[0]!.verb).toBe("reopened the wait:");
    expect(graphChange({ field: "waits", old_value: "Waiting on sd-4", new_value: "" })!.clauses[0]!.verb).toBe("removed the wait:");
    expect(graphChange({ field: "status", old_value: "open", new_value: "done" })).toBeNull();
  });
});

describe("undo", () => {
  const { WORK_UNDO_POLICY } = require("../../store/undo/policies/work") as typeof import("../../store/undo/policies/work");
  const spec = (name: string) => (WORK_UNDO_POLICY[name] as any).spec;
  const wait = { id: "w1", kind: "pr_merged", repository: "o/r", pr_number: 42, state: "met", created_at: 0, note: "merged" };
  const ctx = (action: string, args: unknown[], field: string, cells = true) => ({
    action, args, result: undefined,
    before: { tasks: { id1: task(1, { waits: [wait] }) } },
    after: { tasks: { id1: task(1) } },
    changes: cells ? [{ store: "tasks", id: "id1", field, kind: "protected", before: [], after: [], hadBefore: true, hadAfter: true }] : [],
  });

  test("each graph verb undoes through its pair, and a skipped row sends nothing", () => {
    expect(spec("addBlocker").label(ctx("addBlocker", ["ct-1", "ct-2"], "blocked_by"))).toBe("Made ct-1 wait on ct-2");
    expect(spec("addBlocker").inverse(ctx("addBlocker", ["ct-1", "ct-2"], "blocked_by"))).toEqual([{ action: "removeBlocker", args: ["ct-1", "ct-2"], runDraft: false }]);
    expect(spec("addBlocker").inverse(ctx("addBlocker", ["ct-1", "ct-2"], "blocked_by", false))).toEqual([]);
    expect(spec("unrelateTasks").inverse(ctx("unrelateTasks", ["ct-1", "ct-2"], "related"))[0].action).toBe("relateTasks");
    const add = ctx("addWait", ["ct-1", { id: "w9", target: { kind: "time", at: Date.UTC(2026, 9, 14, 9) } }], "waits");
    expect(spec("addWait").label(add)).toMatch(/^Made ct-1 wait until /);
    expect(spec("addWait").inverse(add)).toEqual([{ action: "removeWait", args: ["ct-1", "w9"], runDraft: false }]);
    const rm = ctx("removeWait", ["ct-1", "w1"], "waits");
    expect(spec("removeWait").label(rm)).toBe("Removed the wait until PR #42 merges from ct-1");
    expect(spec("removeWait").inverse(rm)).toEqual([{ action: "addWait", args: ["ct-1", { id: "w1", target: { kind: "pr_merged", repository: "o/r", pr_number: 42 } }], runDraft: false }]);
  });
});
