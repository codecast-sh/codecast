import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { useInboxStore } from "../inboxStore";
import { liveRowId } from "../liveArtifactsSlice";
import { applyElementsPayload, sendLiveOps, settleAfter, whenLiveSent } from "../../components/live/useLiveArtifact";
import { _releaseOrphanLocksForTests } from "../../hooks/useSyncLiveArtifact";

// Live artifact elements are localFirst: an edit paints from the action draft
// and its field locks hold until the echo. These pin the two ways the locks
// could go wrong (found by the first independent review): a later writer's
// value arriving before this tab ever saw its own echo, and closing a draft.
const DOC = "k17docaaaaaaaaaaaaaaaaaaaaaaaaaa";
const A = liveRowId(DOC, "main", "el_a");
const row = (fields: Record<string, any>, rev: number, layer = "main") => ({ doc_id: DOC, layer, key: "el_a", kind: "sticky", fields, rev, by: "u:x", at: 1 });
const payload = (rows: any[], head: number, draft: any = null) => ({ doc_id: DOC, title: "B", doc_type: "board", head, draft, rows, more: false, next: head });
const s = () => useInboxStore.getState() as any;

describe("live artifact store", () => {
  const owner = {};
  beforeEach(() => {
    useInboxStore.setState({ liveElements: {}, liveHeads: {}, pending: {} } as any);
    s()._setDispatch(async () => ({ rev: 2, keys: ["el_a"] }), { owner });
  });
  afterEach(() => s()._clearDispatch(owner));

  it("marks the cache complete only when its rows number what the server holds", () => {
    const B = { ...row({ x: 1 }, 2), key: "el_b" };
    // Two rows on the server, both arrived: the cache is whole through r2.
    applyElementsPayload({ ...payload([row({ x: 0 }, 1), B], 2), total: 2, rev_sum: 3 });
    expect(s().liveHeads[DOC].complete).toBe(2);
    // A tail that says the doc holds a row this cache never saw: not whole.
    applyElementsPayload({ ...payload([row({ x: 3 }, 4)], 4), total: 3, rev_sum: 9 });
    expect(s().liveHeads[DOC].complete).toBeNull();
    // A row this tab made that the server has not stamped never counts toward the proof.
    s().applyLiveOps(DOC, "main", [{ k: "el_new", put: { kind: "sticky", x: 9 } }]);
    applyElementsPayload({ ...payload([row({ x: 3 }, 5)], 5), total: 3, rev_sum: 10 });
    expect(s().liveHeads[DOC].complete).toBeNull();
    // Same count, but a row held at an older revision: the sum gives it away.
    applyElementsPayload({ ...payload([row({ x: 7 }, 6)], 6), total: 2, rev_sum: 99 });
    expect(s().liveHeads[DOC].complete).toBeNull();
    // An unknown total proves nothing.
    applyElementsPayload({ ...payload([row({ x: 4 }, 6)], 6), total: null });
    expect(s().liveHeads[DOC].complete).toBeNull();
  });

  it("a draft close waits for the draft writes queued ahead of it", async () => {
    // The first send is held at the server; a second queues behind it.
    let release!: () => void;
    const held = new Promise<void>((r) => { release = r; });
    s()._setDispatch(async (action: string) => { if (action === "applyLiveOps") await held; return { rev: 2, keys: ["el_a"] }; }, { owner });
    sendLiveOps(DOC, "draft", [{ k: "el_a", put: { kind: "sticky", x: 1 } }]);
    sendLiveOps(DOC, "draft", [{ k: "el_a", set: { x: 2 } }]);
    let closed = false;
    const close = whenLiveSent(DOC).then(() => { closed = true; });
    await new Promise((r) => setTimeout(r, 120));
    expect(closed).toBe(false);
    release();
    await close;
    expect(closed).toBe(true);
  });

  it("a draft close that cannot wait for its queued writes does not happen", async () => {
    // A send that never lands: the wait gives up, and says so, rather than letting the close go first.
    // Its own doc: the send it leaves hanging must not hold up another test's queue.
    const STUCK = "k17stuckaaaaaaaaaaaaaaaaaaaaaaaa";
    s()._setDispatch((action: string) => (action === "applyLiveOps" ? new Promise(() => {}) : Promise.resolve(null)), { owner });
    sendLiveOps(STUCK, "draft", [{ k: "el_b", put: { kind: "sticky", x: 1 } }]);
    sendLiveOps(STUCK, "draft", [{ k: "el_b", set: { x: 2 } }]);
    await expect(whenLiveSent(STUCK, 100)).rejects.toThrow(/still sending/);
  });

  it("paints an edit at once and holds it against a stale push", () => {
    applyElementsPayload(payload([row({ x: 0 }, 1)], 1));
    s().applyLiveOps(DOC, "main", [{ k: "el_a", set: { x: 100 } }]);
    expect(s().liveElements[A].x).toBe(100);
    applyElementsPayload(payload([row({ x: 0 }, 1)], 1));
    expect(s().liveElements[A].x).toBe(100);
  });

  it("lets a later writer's value stand once its own write is acknowledged, even if its echo never came", () => {
    applyElementsPayload(payload([row({ x: 0 }, 1)], 1));
    s().applyLiveOps(DOC, "main", [{ k: "el_a", set: { x: 100 } }]);
    const before = Date.now();
    // Our write landed at r2; someone else wrote x=7 at r3 before our tab read r2.
    applyElementsPayload(payload([row({ x: 7 }, 3)], 3));
    expect(s().liveElements[A].x).toBe(100); // still locked: no ack yet
    settleAfter(DOC, 2, [A], before);
    expect(s().liveElements[A].x).toBe(7);
    expect(Object.keys(s().pending).some((k) => k.startsWith(`liveElements:${A}:`))).toBe(false);
  });

  it("closing a draft hides its rows without planting excludes, so the next draft shows", () => {
    const D = liveRowId(DOC, "draft", "el_a");
    applyElementsPayload(payload([row({ x: 0 }, 1), row({ x: 5 }, 2, "draft")], 2, { by: "s:1", by_name: "agent", at: 1 }));
    expect(s().liveElements[D].x).toBe(5);
    s().liveDraft(DOC, "discard");
    expect(s().liveHeads[DOC].draft).toBeNull();
    expect(Object.keys(s().pending).some((k) => k.includes("|draft|"))).toBe(false);
    // The server retires the row; a new draft on the same key arrives later.
    applyElementsPayload(payload([{ ...row({}, 3, "draft"), dead: true }], 3));
    expect(s().liveElements[D]).toBeUndefined();
    applyElementsPayload(payload([row({ x: 9 }, 4, "draft")], 4, { by: "s:1", by_name: "agent", at: 2 }));
    expect(s().liveElements[D].x).toBe(9);
  });

  it("sends one batch per doc at a time, in order, painting the rest at once", async () => {
    const calls: any[] = [];
    let release!: () => void;
    s()._clearDispatch(owner);
    s()._setDispatch(async (action: string, args: any[]) => {
      if (action !== "applyLiveOps") return null;
      calls.push(args[2]);
      if (calls.length === 1) await new Promise<void>((r) => (release = r));
      return { rev: calls.length, keys: [] };
    }, { owner });
    sendLiveOps(DOC, "main", [{ k: "el_new", put: { kind: "sticky", text: "" } }]);
    sendLiveOps(DOC, "main", [{ k: "el_new", set: { text: "Write the launch post" } }]);
    sendLiveOps(DOC, "main", [{ k: "el_new", set: { x: 5 } }]);
    await Bun.sleep(20);
    // Only the put is on the wire; the text already shows from the queue.
    expect(calls).toHaveLength(1);
    const { docRows } = await import("../../components/live/useLiveArtifact");
    expect(docRows(DOC).main.get("el_new")).toBeDefined();
    release();
    await Bun.sleep(50);
    expect(calls).toHaveLength(2);
    // The queued writes went out together, after the put.
    expect(calls[1]).toEqual([{ k: "el_new", set: { text: "Write the launch post", x: 5 } }]);
  });

  it("a rewrite whose first batch is refused sends nothing more", async () => {
    const calls: any[][] = [];
    s()._clearDispatch(owner);
    s()._setDispatch(async (action: string, args: any[]) => {
      if (action !== "applyLiveOps" && action !== "liveSendOps") return null;
      calls.push(args);
      throw new Error("Uncaught ConvexError: Sheets is rewriting this range; try again when it's saved");
    }, { owner });
    const ops = Array.from({ length: 1000 }, (_, i) => ({ k: `el_r${i}`, put: { kind: "sticky", x: i } }));
    sendLiveOps(DOC, "main", ops, { claim: { scope: "tab:t1", base: 5 } });
    await Bun.sleep(50);
    // Only the first batch went out, carrying the claim; the other 600 ops never left.
    expect(calls).toHaveLength(1);
    expect(calls[0][4]).toMatchObject({ scope: "tab:t1", base: 5, first: true, last: false });
    expect(s().liveElements[liveRowId(DOC, "main", "el_r999")]).toBeUndefined();
    await whenLiveSent(DOC, 1000);
  });

  it("a write that clears a field shows the field gone while it waits behind another send", async () => {
    const { layerElements } = await import("../../components/live/useLiveArtifact");
    const { applyOp, fromElement } = await import("@codecast/shared/artifacts");
    const stored = { _id: "x", doc_id: DOC, layer: "comments", key: "cm_1", kind: "comment", text: "Hi", resolved: true, resolved_by_name: "Rosa", rev: 4 };
    const queued = applyOp(fromElement(stored as any), { k: "cm_1", set: { resolved: null, resolved_by_name: null } });
    const [el] = layerElements(new Map([["cm_1", stored]]), new Map([["cm_1", queued]]));
    expect(el.resolved).toBeUndefined();
    expect(el.resolved_by_name).toBeUndefined();
    expect(el).toMatchObject({ key: "cm_1", kind: "comment", text: "Hi", rev: 4 });
  });

  it("locks from before this page loaded go once the feed answers", async () => {
    const old = performance.timeOrigin - 60_000;
    const A1 = liveRowId(DOC, "main", "c:Sheet1!A1");
    useInboxStore.setState({ liveElements: { [A1]: { _id: A1, doc_id: DOC, layer: "main", key: "c:Sheet1!A1", kind: "cell", input: "Name 9998", rev: 1 } }, pending: {
      [`liveElements:${A1}`]: { type: "include", ts: old },
      [`liveElements:${A1}:input`]: { type: "field", value: "Name 9998", ts: old },
      [`liveElements:${A1}:bold`]: { type: "field", value: true, ts: Date.now() + 1 },
      [`liveElements:${A1}:gone`]: { type: "exclude", ts: old },
    } } as any);
    // The feed brings a newer value than the old lock holds: the lock pins the old one until it goes.
    applyElementsPayload(payload([{ ...row({ input: "Name 238" }, 3), key: "c:Sheet1!A1", kind: "cell" }], 3));
    expect(s().liveElements[A1].input).toBe("Name 9998");
    _releaseOrphanLocksForTests();
    expect(s().liveElements[A1].input).toBe("Name 238");
    // The old field lock and the put's include go; this page's own lock and the exclude stay.
    expect(Object.keys(s().pending).sort()).toEqual([`liveElements:${A1}:bold`, `liveElements:${A1}:gone`]);
  });

  it("a write bigger than one server batch paints at once and reaches the store a batch per task, in order", async () => {
    const calls: any[][] = [];
    s()._clearDispatch(owner);
    s()._setDispatch(async (action: string, args: any[]) => {
      if (action === "applyLiveOps" || action === "liveSendOps") calls.push(args[2]);
      return { rev: calls.length, keys: [] };
    }, { owner });
    const ops = Array.from({ length: 1000 }, (_, i) => ({ k: `el_${i}`, put: { kind: "sticky", x: i } }));
    sendLiveOps(DOC, "main", ops);
    // The first batch is in the store and on the wire now; the rest wait their turn, one task each.
    expect(calls).toHaveLength(1);
    expect(s().liveElements[liveRowId(DOC, "main", "el_0")]).toBeDefined();
    expect(s().liveElements[liveRowId(DOC, "main", "el_999")]).toBeUndefined();
    await Bun.sleep(30);
    expect(calls.map((c) => c.length)).toEqual([400, 400, 200]);
    expect(calls[2][199].k).toBe("el_999");
    expect(s().liveElements[liveRowId(DOC, "main", "el_999")].x).toBe(999);
    // Only the first batch planted locks; the rest of the write rode the held rows, not 600 more locks.
    const locks = Object.keys(s().pending).filter((k) => k.startsWith(`liveElements:${DOC}|`));
    expect(locks.length).toBeLessThanOrEqual(400);
    expect(locks.some((k) => k.includes("|el_999"))).toBe(false);
    await whenLiveSent(DOC, 1000);
  });
});
