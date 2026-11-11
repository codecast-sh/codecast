import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { useInboxStore } from "../inboxStore";
import { liveRowId } from "../liveArtifactsSlice";
import { applyElementsPayload, sendLiveOps, settleAfter } from "../../components/live/useLiveArtifact";

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
    applyElementsPayload({ ...payload([row({ x: 0 }, 1), B], 2), total: 2 });
    expect(s().liveHeads[DOC].complete).toBe(2);
    // A tail that says the doc holds a row this cache never saw: not whole.
    applyElementsPayload({ ...payload([row({ x: 3 }, 4)], 4), total: 3 });
    expect(s().liveHeads[DOC].complete).toBeNull();
    // A row this tab made that the server has not stamped never counts toward the proof.
    s().applyLiveOps(DOC, "main", [{ k: "el_new", put: { kind: "sticky", x: 9 } }]);
    applyElementsPayload({ ...payload([row({ x: 3 }, 5)], 5), total: 3 });
    expect(s().liveHeads[DOC].complete).toBeNull();
    // An unknown total proves nothing.
    applyElementsPayload({ ...payload([row({ x: 4 }, 6)], 6), total: null });
    expect(s().liveHeads[DOC].complete).toBeNull();
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
});
