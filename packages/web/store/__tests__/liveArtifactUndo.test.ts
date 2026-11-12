import { afterAll, expect, mock, test } from "bun:test";
import { JSDOM } from "jsdom";
import { IDBFactory, IDBKeyRange } from "fake-indexeddb";
import { replaceGlobals } from "../../test-helpers/globals";
import { closeDomWindow } from "../../test-helpers/domGlobals";

const dom = new JSDOM("<html><body></body></html>", { url: "https://app.test", pretendToBeVisual: true });
const restore = replaceGlobals({ window: dom.window, document: dom.window.document, navigator: dom.window.navigator, HTMLElement: dom.window.HTMLElement, localStorage: dom.window.localStorage, sessionStorage: dom.window.sessionStorage, indexedDB: new IDBFactory(), IDBKeyRange, IS_REACT_ACT_ENVIRONMENT: true });
afterAll(() => { closeDomWindow(dom); restore(); });
const convex = { ...(await import("convex/react")) };
const noop = async () => null;
mock.module("convex/react", () => ({ ...convex, useMutation: () => noop, useAction: () => noop }));
const feed = { ...(await import("../../hooks/useSyncLiveArtifact")) };
mock.module("../../hooks/useSyncLiveArtifact", () => ({ ...feed, useSyncLiveArtifact: () => ({ ready: true }) }));
const { createElement, act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { useInboxStore } = await import("../inboxStore");
const { useLiveArtifact, useLiveUnsettled } = await import("../../components/live/useLiveArtifact");


for (const close of ["save", "discard", "remote"] as const) {
  test(`closing a draft with ${close} clears redo without reopening it`, async () => {
    const DOC = `undo-regression-${close}`;
    useInboxStore.setState({ liveElements: {}, liveHeads: {}, pending: {} } as any);
    const owner = {};
    const calls: string[] = [];
    const store = () => useInboxStore.getState() as any;
    store()._setDispatch(async (name: string) => { calls.push(name); return { rev: 3, keys: ["a"] }; }, { owner });
    feed.applyElementsPayload({ doc_id: DOC, head: 1, next: 1, more: false, draft: { by: "u:me", by_name: "Me", at: 1 }, rows: [{ doc_id: DOC, layer: "main", key: "a", kind: "sticky", fields: { x: 0 }, rev: 1 }] });
    let handle!: ReturnType<typeof useLiveArtifact>;
    let unsettled = 0;
    function Harness() { handle = useLiveArtifact(DOC); unsettled = useLiveUnsettled(DOC); return null; }
    async function landed() {
      const deadline = Date.now() + 3000;
      do {
        await act(async () => { await new Promise<void>((resolve) => setImmediate(resolve)); });
        if (Date.now() > deadline) throw new Error("Artifact writes did not settle");
      } while (unsettled);
    }
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    try {
      await act(async () => { root.render(createElement(Harness)); });
      await act(async () => { handle.apply([{ k: "a", set: { x: 1 } }]); });
      await act(async () => { handle.undo(); });
      await landed();
      expect(handle.canRedo).toBe(true);
      await act(async () => {
        if (close === "remote") feed.applyElementsPayload({ doc_id: DOC, head: 3, next: 3, more: false, draft: null, rows: [] });
        else handle.draft[close]();
      });
      expect(handle.canRedo).toBe(false);
      const writes = calls.filter((name) => name === "applyLiveOps").length;
      await act(async () => { handle.redo(); });
      expect(calls.filter((name) => name === "applyLiveOps")).toHaveLength(writes);
      expect(handle.draft.active).toBe(false);
    } finally {
      await act(async () => { root.unmount(); });
      container.remove();
      store()._clearDispatch(owner);
    }
  });
}
