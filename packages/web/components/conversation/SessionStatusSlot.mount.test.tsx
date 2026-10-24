// The header's status slot: the agent's status, or the verdict on a stop that
// went wrong with the one action that fixes it.
// Run: bun test components/conversation/SessionStatusSlot.mount.test.tsx
import { afterAll, expect, test } from "bun:test";
import { closeDomWindow } from "../../test-helpers/domGlobals";

const CONV = "c".repeat(32);
let dom: any;

async function mount() {
  const { JSDOM } = await import("jsdom");
  dom = new JSDOM("<!doctype html><html><body><div id='root'></div></body></html>", { url: "https://local.codecast.sh" });
  for (const key of ["window", "document", "navigator", "HTMLElement", "Element", "Node", "MutationObserver", "CustomEvent", "Event", "getComputedStyle"]) {
    Object.defineProperty(globalThis, key, { value: (dom.window as any)[key], configurable: true, writable: true });
  }
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  const React = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { useInboxStore } = await import("../../store/inboxStore");
  const { SessionStatusSlot } = await import("./SessionStatusSlot");
  const root = createRoot(document.getElementById("root")!);
  const restarts: number[] = [];
  const render = () => React.act(() => {
    root.render(React.createElement(SessionStatusSlot, { conversationId: CONV, agentStatus: "working", disconnected: false, live: false, onRestart: () => restarts.push(1) }));
  });
  const stop = (fields: Record<string, unknown>) => React.act(() => {
    useInboxStore.setState({ sessionCommands: { r1: { _id: "r1", kind: "interrupt", command: "escape", conversation_id: CONV, executed_at: null, result: null, error: null, ...fields } } } as any);
  });
  return { React, root, useInboxStore, render, stop, restarts, el: () => document.querySelector("[data-cc-conv-status]") as HTMLElement };
}

afterAll(() => closeDomWindow(dom));

test("the status shows until a stop goes wrong; then the verdict and its fix take the slot", async () => {
  const m = await mount();
  m.stop({ requested_at: Date.now() - 5_000 });
  m.render();
  expect(m.el().dataset.interruptVerdict).toBeUndefined();
  expect(m.el().textContent).toContain("Working");

  const escapes: string[] = [];
  m.useInboxStore.setState({ sendEscape: async (id: string) => { escapes.push(id); } } as any);
  m.stop({ requested_at: Date.now() - 40_000 });
  m.render();
  expect(m.el().dataset.interruptVerdict).toBe("undelivered");
  m.React.act(() => { m.el().querySelector("button")!.click(); });
  expect(escapes).toEqual([CONV]);

  m.stop({ requested_at: Date.now() - 2_000, executed_at: Date.now(), error: "No running process for session ab" });
  m.render();
  expect(m.el().dataset.interruptVerdict).toBe("failed");
  expect(m.el().querySelector("button")!.textContent).toBe("Restart");
  m.React.act(() => { m.el().querySelector("button")!.click(); });
  expect(m.restarts).toHaveLength(1);
  expect(m.useInboxStore.getState().sessionCommands.r1).toBeUndefined();
  expect(m.el().dataset.interruptVerdict).toBeUndefined();
  m.React.act(() => m.root.unmount());
});
