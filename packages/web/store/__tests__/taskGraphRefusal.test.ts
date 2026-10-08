import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { useInboxStore } from "../inboxStore";
import { applyDispatchFailure } from "../../lib/dispatchBinding";
import { applyRelationPick } from "../../lib/taskRelations";
import { isRefusedDispatchError } from "../mutativeMiddleware";
import { UNDO_SPECS } from "../undo/policy";

// A task-graph pick the server refuses (task-graph.md TG2, TG4) leaves no
// trace: blocker edges roll back through their field locks, a painted wait
// (`waits` holds none) through applyDispatchFailure, from whichever caller
// sent it. The pick's `landed` rejects, so the palette drops its own toast
// and the dispatch failure toast gives the server's reason.
const WS = "team:t1";
const task = (n: number, over: Record<string, any> = {}) => ({
  _id: `id${n}`, short_id: `ct-${n}`, title: `Task ${n}`, status: "open", priority: "medium", task_type: "task", source: "human",
  workspace: WS, created_at: n, updated_at: n, ...over,
}) as any;
const rows = (...ts: any[]) => Object.fromEntries(ts.map((t) => [t._id, t]));
const pr = { kind: "pr_merged", repository: "o/r", pr_number: 42 } as const;
const failed = { ...pr, id: "wfail", state: "failed", created_at: 1, note: "closed without merging" };
const s = () => useInboxStore.getState();

describe("a refused task-graph pick", () => {
  const owner = {};
  let refusal: string | null = null;
  beforeEach(() => {
    refusal = null;
    useInboxStore.setState({ pending: {}, lastDispatchFailure: null } as any);
    s()._setDispatch(async () => {
      if (refusal) throw new Error(`Uncaught Error: ${refusal}`);
      return null;
    }, { owner });
    s()._setDispatchError(applyDispatchFailure);
  });
  afterEach(() => {
    s()._clearDispatch(owner);
    s()._setDispatchError(() => {});
  });

  const refused = async (res: ReturnType<typeof applyRelationPick>) => {
    if (!res.ok) throw new Error(res.message);
    const error = await res.landed.then(() => null, (e) => e);
    expect(isRefusedDispatchError(error)).toBe(true);
  };

  it("takes a new PR wait back off", async () => {
    useInboxStore.setState({ tasks: rows(task(1)) } as any);
    refusal = "codecast cannot see PR o/r#42: no GitHub app installation of yours covers o/r. A wait on it would never clear.";
    const res = applyRelationPick("blocker", [s().tasks.id1 as any], { kind: "wait", target: pr });
    expect((s().tasks.id1 as any).waits).toMatchObject([{ ...pr, state: "waiting" }]);
    await refused(res);
    expect((s().tasks.id1 as any).waits).toEqual([]);
    expect(s().lastDispatchFailure).toMatchObject({ action: "addWait", message: expect.stringContaining("cannot see PR o/r#42") });
  });

  it("puts back the failed wait a refused one replaced", async () => {
    useInboxStore.setState({ tasks: rows(task(1, { waits: [failed] })) } as any);
    refusal = "PR o/r#42 was closed without merging, so a wait on it would never clear";
    const res = applyRelationPick("blocker", [s().tasks.id1 as any], { kind: "wait", target: pr });
    expect((s().tasks.id1 as any).waits.map((w: any) => w.state)).toEqual(["waiting"]);
    await refused(res);
    expect((s().tasks.id1 as any).waits).toEqual([failed]);
  });

  it("keeps a wait the server took", async () => {
    useInboxStore.setState({ tasks: rows(task(1)) } as any);
    const res = applyRelationPick("blocker", [s().tasks.id1 as any], { kind: "wait", target: pr });
    expect(res.ok && (await res.landed)).toBe("ct-1 waits on PR o/r#42");
    expect((s().tasks.id1 as any).waits).toMatchObject([{ ...pr, state: "waiting" }]);
  });

  it("rolls a refused blocker back off both rows", async () => {
    useInboxStore.setState({ tasks: rows(task(1), task(2)) } as any);
    refusal = "Task ct-2 is in another workspace";
    const res = applyRelationPick("blocker", [s().tasks.id1 as any], { kind: "task", ref: "ct-2" });
    expect([(s().tasks.id1 as any).blocked_by, (s().tasks.id2 as any).blocks]).toEqual([["ct-2"], ["ct-1"]]);
    await refused(res);
    expect([(s().tasks.id1 as any).blocked_by ?? [], (s().tasks.id2 as any).blocks ?? []]).toEqual([[], []]);
    expect(s().lastDispatchFailure).toMatchObject({ action: "addBlocker" });
  });
});

describe("undoing a wait's removal", () => {
  const label = (wait: any) => {
    const before = { tasks: rows(task(1, { waits: [wait] })) };
    return (UNDO_SPECS.removeWait!.label as any)({ args: ["ct-1", wait.id], before, after: { tasks: rows(task(1)) }, changes: [] });
  };

  it("is offered only for a wait the server would set again", () => {
    expect(label({ ...pr, id: "w1", state: "waiting", created_at: 1 })).toBe("Removed the wait on PR #42 from ct-1");
    expect(label(failed)).toBeNull();
    expect(label({ kind: "time", at: Date.now() - 1000, id: "w2", state: "met", created_at: 1 })).toBeNull();
  });
});
