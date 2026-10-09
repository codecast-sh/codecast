// The task page's relations (task-graph.md TG12): the Blocked by row's lines,
// the add-blocker and related palettes, the draft writes behind the store
// actions, and how the timeline reads a graph history row.
import { afterAll, describe, expect, test } from "bun:test";
import { useInboxStore } from "../../store/inboxStore";
import { addWaitDraft, removeBlockerEdge, removeBlocksEdge, removeWaitDraft, setBlockerEdge, setRelatedEdge } from "../../store/taskGraphDraft";
import { applyRelationPick, blockerForms, blockerLines, blocksOf, foundHereOf, lineStateLabel, parseRelationQuery, relatedOf, relationItems, relationQueryError, storeBlockerLines } from "../taskRelations";
import { storeStatusOf } from "../taskBlockers";
import { graphChange, GRAPH_LINK_CAP, waitTargetOf } from "@codecast/shared/tasks";

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
    expect(lines.map((l) => (l.kind === "task" ? `${l.ref}:${l.state}:${l.raws.join("+")}` : `${l.wait.id}:${l.wait.state}`))).toEqual([
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

  test("a blocker named twice (short id and _id) is one line that removes both forms", () => {
    const tasks = rows(task(2));
    const lines = storeBlockerLines(task(1, { blocked_by: ["ct-2", "id2"] }), tasks);
    expect(lines).toEqual([{ key: "task:ct-2", kind: "task", ref: "ct-2", raws: ["ct-2", "id2"], state: "open", status: "open" }]);
  });
});

describe("found here", () => {
  test("the store's tasks found during this one, in its workspace, oldest first", () => {
    const tasks = rows(task(1), task(5, { found_during: "ct-1" }), task(4, { found_during: "ct-1" }), task(6, { found_during: "ct-1", workspace: "user:x" }));
    expect(foundHereOf(task(1), tasks).map((t) => t.short_id)).toEqual(["ct-4", "ct-5"]);
  });

  test("a legacy row carrying no workspace key is personal to its owner, so its relations still read", () => {
    const legacy = (n: number, over: Record<string, any> = {}) => task(n, { workspace: undefined, team_id: undefined, user_id: "u1", ...over });
    const tasks = rows(legacy(1), legacy(4, { found_during: "ct-1" }), task(6, { found_during: "ct-1" }));
    expect(foundHereOf(legacy(1), tasks).map((t) => t.short_id)).toEqual(["ct-4"]);
  });
});

describe("the link mirrors", () => {
  test("blocks lists what the dependent still names, keeps a ref no row answers for, and stops at the cap", () => {
    const tasks = rows(
      task(1, { blocks: ["ct-2", "id3", "ct-4", "ct-99"] }),
      task(2, { blocked_by: ["ct-1"] }),
      // Named by this task's _id, the form an older plan row stores.
      task(3, { blocked_by: ["id1"] }),
      // Its row has moved on: the mirror entry is stale.
      task(4, { blocked_by: ["ct-7"] }),
    );
    expect(blocksOf(tasks.id1, tasks)).toEqual(["ct-2", "id3", "ct-99"]);
    const many = task(1, { blocks: Array.from({ length: 60 }, (_, i) => `ct-${i + 100}`) });
    expect(blocksOf(many, rows(many)).length).toBe(GRAPH_LINK_CAP);
  });

  test("a dependent in another workspace is no answer, so its entry stands", () => {
    const tasks = rows(task(1, { blocks: ["ct-2"] }), task(2, { workspace: "user:x", blocked_by: ["ct-9"] }));
    expect(blocksOf(tasks.id1, tasks)).toEqual(["ct-2"]);
  });

  test("related stops at the same cap", () => {
    expect(relatedOf(task(1)).length).toBe(0);
    expect(relatedOf(task(1, { related: Array.from({ length: 60 }, (_, i) => `ct-${i + 100}`) })).length).toBe(GRAPH_LINK_CAP);
  });
});

describe("a relations line's state in words", () => {
  test("every state names what it is about, so a glyph-only line still says it", () => {
    expect(["waiting", "met", "failed"].map((st) => lineStateLabel(st as any, "blocker")))
      .toEqual(["still waiting on this blocker", "blocker met", "blocker failed, needs a re-plan"]);
    expect(["waiting", "met", "failed"].map((st) => lineStateLabel(st as any, "wait")))
      .toEqual(["still waiting on this wait", "wait met", "wait failed, needs a re-plan"]);
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
    // Text with no ref's shape is flagged, so the hint lists the forms instead of the grammar error.
    expect(parseRelationQuery("tomorrow 9am", "blocker", NOW, TZ)).toMatchObject({ unrecognized: true });
    expect(parseRelationQuery("#42", "related", NOW, TZ)).toMatchObject({ unrecognized: true });
    expect(parseRelationQuery("42", "blocker", NOW, TZ)).not.toHaveProperty("unrecognized");
  });

  test("the hint's error is set only once nothing matched and the query reads as no ref", () => {
    // A title match is never an error, whatever the text looks like.
    expect(relationQueryError("42", "blocker", true)).toBeNull();
    expect(relationQueryError("42", "blocker", false)).toMatchObject({ error: expect.stringContaining("ambiguous") });
    // A readable ref is no error either.
    expect(relationQueryError("ct-12", "blocker", false)).toBeNull();
    expect(relationQueryError("", "blocker", false)).toBeNull();
  });

  test("a pasted wait comes first, worded as the wait", () => {
    const items = relationItems("blocker", "#42", [tasks.id1], tasks, NOW, TZ);
    expect(items[0]).toMatchObject({ label: "Wait on PR #42", pick: { kind: "wait" } });
    expect(relationItems("blocker", "o/r#42", [tasks.id1], tasks, NOW, TZ)[0]!.label).toBe("Wait on PR o/r#42");
  });

  test("searches open tasks of the workspace, without itself, its blockers or closed work; marks a loop", () => {
    const all = relationItems("blocker", "", [tasks.id1], tasks, NOW, TZ);
    expect(all.map((i) => i.key)).toEqual(["task:ct-4", "task:ct-3"]);
    // ct-3 already waits on ct-1, so ct-1 waiting on ct-3 closes a loop.
    expect(all.find((i) => i.key === "task:ct-3")!.hint).toBe("would close a loop");
    expect(relationItems("blocker", "schema", [tasks.id1], tasks, NOW, TZ).map((i) => i.key)).toEqual(["task:ct-4"]);
    expect(relationItems("related", "", [tasks.id1], tasks, NOW, TZ).map((i) => i.key)).toEqual(["task:ct-4", "task:ct-3", "task:ct-2"]);
  });

  test("offers active work only, the target's plan siblings then its project's first", () => {
    const placed = rows(
      task(1, { plan_id: "p1", project_id: "pr1" }),
      task(2, { updated_at: 90 }),
      task(3, { project_id: "pr1", updated_at: 50 }),
      task(4, { plan_id: "p1", updated_at: 10 }),
      task(5, { source: "insight", updated_at: 99 }),
      task(6, { triage_status: "suggested", updated_at: 98 }),
    );
    expect(relationItems("blocker", "", [placed.id1], placed, NOW, TZ).map((i) => i.key)).toEqual(["task:ct-4", "task:ct-3", "task:ct-2"]);
  });

  test("a pasted ref already linked, or the task itself, is listed with why", () => {
    expect(relationItems("blocker", "ct-2", [tasks.id1], tasks, NOW, TZ)[0]).toMatchObject({ key: "task:ct-2", hint: "already a blocker" });
    expect(relationItems("blocker", "ct-1", [tasks.id1], tasks, NOW, TZ)[0]).toMatchObject({ key: "task:ct-1", hint: "this task" });
    expect(relationItems("blocker", "ct-3", [tasks.id1], tasks, NOW, TZ)[0]).toMatchObject({ key: "task:ct-3", hint: "would close a loop" });
    // A ref the store does not hold is the server's to check, and says so.
    expect(relationItems("blocker", "ct-99999", [tasks.id1], tasks, NOW, TZ)[0]).toMatchObject({ key: "task:ct-99999", hint: "not loaded: the server will check it" });
    expect(relationItems("blocker", "ct-4", [tasks.id1], tasks, NOW, TZ)[0]!.hint).toBeUndefined();
  });

  test("the Blocks add searches the other way: who could wait on this one", () => {
    // ct-3 already waits on ct-1 (the dependent's own row says so, with no
    // mirror on ct-1), so it is not offered again; ct-2, which ct-1 waits on,
    // would close a loop the other way round.
    const all = relationItems("blocks", "", [tasks.id1], tasks, NOW, TZ);
    expect(all.map((i) => i.key)).toEqual(["task:ct-4", "task:ct-2"]);
    expect(all.find((i) => i.key === "task:ct-2")!.hint).toBe("would close a loop");
    expect(relationItems("blocks", "ct-3", [tasks.id1], tasks, NOW, TZ)[0]).toMatchObject({ key: "task:ct-3", hint: "already waiting on this" });
    expect(relationItems("blocks", "ct-1", [tasks.id1], tasks, NOW, TZ)[0]).toMatchObject({ hint: "this task" });
    // It takes a task and nothing else: a wait is a blocker of this task.
    expect(parseRelationQuery("2h", "blocks", NOW, TZ)).toMatchObject({ error: expect.stringContaining("is a task"), unrecognized: true });
  });

  test("the forms offer a bare #42 only with a project, and a date still ahead", () => {
    const forms = blockerForms([tasks.id1], NOW);
    expect(forms.slice(0, 3)).toEqual(["ct-12", "owner/repo#42", "owner/repo#42:checks"]);
    expect(blockerForms([task(1, { project_path: "/src/x" })], NOW)[1]).toBe("#42");
    expect(parseRelationQuery(forms.at(-1)!, "blocker", NOW)).toMatchObject({ pick: { kind: "wait", target: { kind: "time" } } });
  });
});

describe("a palette pick", () => {
  const before = useInboxStore.getState();
  afterAll(() => useInboxStore.setState(before, true));
  const calls: string[] = [];
  const spy = (name: string) => (...args: any[]) => { calls.push(`${name}:${JSON.stringify(args)}`); return Promise.resolve(); };

  test("a task blocker is added, a loop is refused before anything paints", async () => {
    useInboxStore.setState({
      tasks: rows(task(1), task(3, { blocked_by: ["ct-1"] }), task(4)),
      addBlocker: spy("addBlocker"), addWait: spy("addWait"), relateTasks: spy("relateTasks"),
    } as any);
    const [t1] = [useInboxStore.getState().tasks.id1 as any];
    expect(applyRelationPick("blocker", [t1], { kind: "task", ref: "ct-4" })).toMatchObject({ ok: true, message: "ct-1 waits on ct-4" });
    expect(applyRelationPick("blocker", [t1], { kind: "task", ref: "ct-3" })).toMatchObject({ ok: false, message: expect.stringContaining("loop") });
    expect(applyRelationPick("related", [t1], { kind: "task", ref: "ct-1" })).toMatchObject({ ok: false });
    expect(applyRelationPick("related", [t1], { kind: "task", ref: "ct-3" })).toMatchObject({ ok: true });
    const r = applyRelationPick("blocker", [t1], { kind: "wait", target: { kind: "decision", decision: "sd-4" } });
    expect(r).toMatchObject({ ok: true, message: "ct-1 waits on sd-4" });
    expect(r.ok && (await r.landed)).toBe("ct-1 waits on sd-4");
    expect(calls[0]).toBe('addBlocker:["ct-1","ct-4"]');
    expect(calls[1]).toBe('relateTasks:["ct-1","ct-3"]');
    expect(calls[2]).toMatch(/^addWait:\["ct-1",\{"id":"w[0-9a-z]+","target":\{"kind":"decision","decision":"sd-4"\}\}\]$/);
    expect(calls).toHaveLength(3);
    // The Blocks add writes the one edge from the other side.
    useInboxStore.setState({ tasks: rows(task(1), task(3, { blocked_by: ["ct-1"] }), task(4)) } as any);
    const t1b = useInboxStore.getState().tasks.id1 as any;
    expect(applyRelationPick("blocks", [t1b], { kind: "task", ref: "ct-4" })).toMatchObject({ ok: true, message: "ct-4 waits on ct-1" });
    expect(calls.at(-1)).toBe('addBlocker:["ct-4","ct-1"]');
    // ct-3 already waits on ct-1, and ct-1 waiting on ct-3 is the loop.
    expect(applyRelationPick("blocks", [t1b], { kind: "task", ref: "ct-3" })).toEqual({ ok: false, message: "ct-3 already waits on ct-1" });
    expect(applyRelationPick("blocks", [useInboxStore.getState().tasks.id3 as any], { kind: "task", ref: "ct-1" })).toMatchObject({ ok: false, message: expect.stringContaining("loop") });
    expect(calls).toHaveLength(4);

    // Already there: refused, nothing sent.
    useInboxStore.setState({ tasks: rows(task(1, { blocked_by: ["ct-4"] }), task(4)) } as any);
    expect(applyRelationPick("blocker", [useInboxStore.getState().tasks.id1 as any], { kind: "task", ref: "ct-4" })).toEqual({ ok: false, message: "ct-1 already waits on ct-4" });
    expect(calls).toHaveLength(4);
    // A decision already answered is met at once, and the pick says so.
    useInboxStore.setState({ addWait: () => Promise.resolve({ met: true, wait: { note: "already answered: yes" } }) } as any);
    const met = applyRelationPick("blocker", [useInboxStore.getState().tasks.id1 as any], { kind: "wait", target: { kind: "decision", decision: "sd-5" } });
    expect(met.ok && (await met.landed)).toBe("ct-1 waits on sd-5: already answered: yes");
  });

  test("a wait the task already has, waiting or met, is refused, and only the targets without it get one", () => {
    const pr = { kind: "pr_merged", repository: "o/r", pr_number: 42 } as const;
    const has = { ...pr, id: "w1", state: "waiting", created_at: 0 };
    const tasks = rows(task(1, { waits: [has] }), task(2), task(3, { waits: [{ ...has, state: "met" }] }));
    useInboxStore.setState({ tasks, addWait: spy("addWait") } as any);
    calls.length = 0;
    expect(applyRelationPick("blocker", [tasks.id1], { kind: "wait", target: pr })).toEqual({ ok: false, message: "ct-1 already waits on PR o/r#42" });
    expect(calls).toEqual([]);
    // A bare #42 may resolve to another repository, so the server decides; it
    // is refused here only beside another unresolved #42.
    expect(applyRelationPick("blocker", [tasks.id1], { kind: "wait", target: { ...pr, repository: "" } })).toMatchObject({ ok: true, pending: true });
    useInboxStore.setState({ tasks: rows(task(4, { waits: [{ ...has, repository: "" }] })) } as any);
    expect(applyRelationPick("blocker", [useInboxStore.getState().tasks.id4 as any], { kind: "wait", target: { ...pr, repository: "" } })).toMatchObject({ ok: false });
    useInboxStore.setState({ tasks } as any);
    calls.length = 0;
    expect(applyRelationPick("blocker", [tasks.id1, tasks.id2, tasks.id3], { kind: "wait", target: pr })).toMatchObject({ ok: true, pending: true, message: "Checking PR o/r#42 for ct-2…" });
    expect(calls.map((c) => c.slice(0, "addWait:[\"ct-2\"".length))).toEqual(['addWait:["ct-2"']);
    expect(applyRelationPick("blocker", [tasks.id3], { kind: "wait", target: pr })).toEqual({ ok: false, message: "ct-3 already has a wait on PR o/r#42" });
    expect(relationItems("blocker", "o/r#42", [tasks.id1], tasks, NOW, TZ)[0]).toMatchObject({ hint: "already waiting" });
    expect(relationItems("blocker", "o/r#42", [tasks.id1, tasks.id3], tasks, NOW, TZ)[0]).toMatchObject({ hint: "already set" });
    expect(relationItems("blocker", "#42", [tasks.id1], tasks, NOW, TZ)[0]!.hint).toBeUndefined();
    expect(relationItems("blocker", "o/r#42", [tasks.id1, tasks.id2], tasks, NOW, TZ)[0]!.hint).toBeUndefined();
  });
});

describe("draft writes", () => {
  test("a blocker edge paints both rows, every copy, and comes off both", () => {
    const tasks: any = { id1: task(1), stub1: task(1, { _id: "stub1" }), id2: task(2) };
    setBlockerEdge(tasks, "ct-1", "ct-2", true);
    // updated_at is the server's to set: a client stamp would be a lock it never echoes.
    expect([tasks.id1.blocked_by, tasks.stub1.blocked_by, tasks.id2.blocks, tasks.id2.updated_at]).toEqual([["ct-2"], ["ct-2"], ["ct-1"], 2]);
    setBlockerEdge(tasks, "ct-1", "ct-2", true);
    expect(tasks.id1.blocked_by).toEqual(["ct-2"]);
    setBlockerEdge(tasks, "ct-1", "ct-2", false);
    expect([tasks.id1.blocked_by, tasks.id2.blocks]).toEqual([[], []]);
  });

  test("removed from the blocker's side, a dependent naming it by its _id is freed too", () => {
    const tasks: any = { id1: task(1, { blocks: ["ct-2"] }), id2: task(2, { blocked_by: ["id1", "ct-3"] }) };
    removeBlocksEdge(tasks, "ct-1", "ct-2");
    expect([tasks.id1.blocks, tasks.id2.blocked_by]).toEqual([[], ["ct-3"]]);
  });

  test("a blocker comes off under every form it is stored by, mirror included", () => {
    const tasks: any = { id1: task(1, { blocked_by: ["ct-2", "id2", "ct-9", "id9", "ct-3"] }), id2: task(2, { blocks: ["ct-1"] }) };
    // ct-2 is in the store; ct-9 is not, so the row's own forms name its _id.
    removeBlockerEdge(tasks, "ct-1", "ct-2");
    removeBlockerEdge(tasks, "ct-1", "ct-9", ["ct-9", "id9"]);
    expect([tasks.id1.blocked_by, tasks.id2.blocks]).toEqual([["ct-3"], []]);
  });

  test("related is mirrored", () => {
    const tasks: any = { id1: task(1), id2: task(2) };
    setRelatedEdge(tasks, "ct-1", "ct-2", true);
    expect([tasks.id1.related, tasks.id2.related]).toEqual([["ct-2"], ["ct-1"]]);
  });

  test("a wait paints as waiting under the client's id, once, and its target sets it again", () => {
    const tasks: any = { id1: task(1) };
    addWaitDraft(tasks, "ct-1", { id: "wx", target: { kind: "pr_merged", repository: "o/r", pr_number: 4 } }, "u1", 5);
    expect(tasks.id1.updated_at).toBe(1);
    addWaitDraft(tasks, "ct-1", { id: "wx", target: { kind: "pr_merged", repository: "o/r", pr_number: 4 } }, "u1", 6);
    expect(tasks.id1.waits).toEqual([{ kind: "pr_merged", repository: "o/r", pr_number: 4, id: "wx", state: "waiting", created_at: 5, created_by: "u1" }]);
    expect(waitTargetOf({ ...tasks.id1.waits[0], state: "met", note: "merged" })).toEqual({ kind: "pr_merged", repository: "o/r", pr_number: 4 });
    removeWaitDraft(tasks, "ct-1", "wx");
    expect(tasks.id1.waits).toEqual([]);
  });

  test("a wait on a failed wait's target takes its place, as the server does; a bare #42 waits for the server", () => {
    const failed = { kind: "pr_merged", repository: "o/r", pr_number: 4, id: "w1", state: "failed", note: "closed without merging", created_at: 1 };
    const tasks: any = { id1: task(1, { waits: [failed] }) };
    expect(relationItems("blocker", "o/r#4", [tasks.id1], tasks, NOW, TZ)[0].hint).toBe("replaces the failed wait");
    addWaitDraft(tasks, "ct-1", { id: "w2", target: { kind: "pr_merged", repository: "", pr_number: 4 } }, "u1", 5);
    expect(tasks.id1.waits.map((w: any) => w.id)).toEqual(["w1", "w2"]);
    addWaitDraft(tasks, "ct-1", { id: "w3", target: { kind: "pr_merged", repository: "o/r", pr_number: 4 } }, "u1", 6);
    expect(tasks.id1.waits.map((w: any) => w.id)).toEqual(["w2", "w3"]);
  });

  test("a met checks wait is not set for good: a push can turn the checks red, so a new wait takes its place", () => {
    const met = { kind: "pr_checks_green", repository: "o/r", pr_number: 4, id: "w1", state: "met", note: "green", created_at: 1 };
    const tasks: any = { id1: task(1, { waits: [met] }) };
    expect(relationItems("blocker", "o/r#4:checks", [tasks.id1], tasks, NOW, TZ)[0].hint).toBeUndefined();
    addWaitDraft(tasks, "ct-1", { id: "w2", target: { kind: "pr_checks_green", repository: "o/r", pr_number: 4 } }, "u1", 5);
    expect(tasks.id1.waits.map((w: any) => [w.id, w.state])).toEqual([["w2", "waiting"]]);
  });
});

describe("the timeline's graph rows", () => {
  test("blockers, links and waits read as what happened", () => {
    expect(graphChange({ field: "blocked_by", old_value: "ct-1", new_value: "ct-1, ct-2" })).toEqual({ tone: "blocked", clauses: [{ verb: "made it wait on", refs: ["ct-2"] }] });
    // A removal is withdrawn, not met: green beside "removed blocker ct-1" would read as "ct-1 finished".
    expect(graphChange({ field: "blocked_by", old_value: "ct-1, ct-2", new_value: "ct-2" })).toEqual({ tone: "withdrawn", clauses: [{ verb: "removed blocker", refs: ["ct-1"] }] });
    expect(graphChange({ field: "related", old_value: "", new_value: "ct-3" })).toEqual({ tone: "link", clauses: [{ verb: "marked it related to", refs: ["ct-3"] }] });
    expect(graphChange({ field: "found_during", old_value: "", new_value: "ct-12" })!.clauses[0]).toEqual({ verb: "found it while working on", refs: ["ct-12"] });
    expect(graphChange({ field: "superseded_by", old_value: "", new_value: "ct-9" })!.clauses[0]).toEqual({ verb: "superseded it with", refs: ["ct-9"] });
    expect(graphChange({ field: "waits", old_value: "", new_value: "Waiting on PR #42" })).toEqual({ tone: "blocked", clauses: [{ verb: "made it wait", text: "on PR #42" }] });
    expect(graphChange({ field: "waits", old_value: "", new_value: "Wait on PR #42, already merged" })).toEqual({ tone: "met", clauses: [{ verb: "made it wait", text: "on PR #42, already merged" }] });
    expect(graphChange({ field: "waits", old_value: "Waiting on PR #42", new_value: "PR #42 merged" })!.tone).toBe("met");
    expect(graphChange({ field: "waits", old_value: "Waiting on PR #42", new_value: "Wait on PR #42 failed: closed without merging" })!.tone).toBe("failed");
    expect(graphChange({ field: "waits", old_value: "sd-4 answered", new_value: "Waiting on sd-4" })!.clauses[0]).toEqual({ verb: "reopened the wait", text: "on sd-4" });
    expect(graphChange({ field: "waits", old_value: "Waiting on sd-4", new_value: "" })).toEqual({ tone: "withdrawn", clauses: [{ verb: "stopped waiting", text: "on sd-4" }] });
    expect(graphChange({ field: "waits", old_value: "PR #42 merged", new_value: "" })).toEqual({ tone: "withdrawn", clauses: [{ verb: "removed the wait:", text: "PR #42 merged" }] });
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
    // A blocker stored by `_id` is set again by its short id, the only form addBlocker finds.
    const byId = { ...ctx("removeBlocker", ["ct-1", "id2"], "blocked_by"), before: { tasks: { id1: task(1), id2: task(2) } } };
    expect(spec("removeBlocker").inverse(byId)).toEqual([{ action: "addBlocker", args: ["ct-1", "ct-2"], runDraft: false }]);
    expect(spec("unrelateTasks").inverse(ctx("unrelateTasks", ["ct-1", "ct-2"], "related"))[0].action).toBe("relateTasks");
    // Removed from the blocker's side, it is set again from the dependent's.
    const blocks = ctx("removeBlocks", ["ct-1", "ct-5"], "blocks");
    expect(spec("removeBlocks").label(blocks)).toBe("ct-5 no longer waits on ct-1");
    expect(spec("removeBlocks").inverse(blocks)).toEqual([{ action: "addBlocker", args: ["ct-5", "ct-1"], runDraft: false }]);
    const add = ctx("addWait", ["ct-1", { id: "w9", target: { kind: "time", at: Date.UTC(2026, 9, 14, 9) } }], "waits");
    expect(spec("addWait").label(add)).toMatch(/^Made ct-1 wait until /);
    expect(spec("addWait").inverse(add)).toEqual([{ action: "removeWait", args: ["ct-1", "w9"], runDraft: false }]);
    const rm = ctx("removeWait", ["ct-1", "w1"], "waits");
    expect(spec("removeWait").label(rm)).toBe("Removed the wait on PR #42 from ct-1");
    expect(spec("removeWait").inverse(rm)).toEqual([{ action: "addWait", args: ["ct-1", { id: "w1", target: { kind: "pr_merged", repository: "o/r", pr_number: 42 } }], runDraft: false }]);
  });
});
