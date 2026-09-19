import { afterAll, expect, test } from "bun:test";
import { JSDOM } from "jsdom";
import { replaceGlobals } from "../../test-helpers/globals";

import { closeDomWindow } from "../../test-helpers/domGlobals";
const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "https://app.test/", pretendToBeVisual: true });
const restoreGlobals = replaceGlobals({
  window: dom.window,
  document: dom.window.document,
  navigator: dom.window.navigator,
  HTMLElement: dom.window.HTMLElement,
  Element: dom.window.Element,
  Node: dom.window.Node,
  IS_REACT_ACT_ENVIRONMENT: true,
});
afterAll(() => { closeDomWindow(dom); restoreGlobals(); });

const React = await import("react");
const { act } = React;
const { createRoot } = await import("react-dom/client");
const { MemoryRouter } = await import("react-router");
const { ConvexProvider } = await import("convex/react");
const { TabParamsCtx } = await import("../../lib/tabParams");
const { TooltipProvider } = await import("../ui/tooltip");
const { MonitorBars } = await import("../GlobalSessionPanel");
const { useInboxStore } = await import("../../store/inboxStore");
const { declareViewNav } = await import("../../store/viewNav");

const sessionId = "a".repeat(32);
const messageId = "b".repeat(32);
const startedAt = Date.now() - 20 * 3600_000;
const session = {
  _id: sessionId,
  agent_status: "waiting",
  open_tasks_at: Date.now(),
  open_tasks: [{ id: "task-watch", kind: "background", started_at: startedAt, tool_use_id: "tool-watch", description: "Prove the orphan sweep", command: "sleep 60" }],
};
const messages = [{ _id: messageId, role: "assistant", timestamp: startedAt - 1, tool_calls: [{ id: "tool-watch", name: "Bash", input: "{}" }] }];

for (const pathname of ["/inbox", "/conversation/current", "/tasks"]) {
  test(`a daemon-only background bar jumps to its message from ${pathname}`, async () => {
    const requests: unknown[] = [];
    const routes: string[] = [];
    const client = { query: async (_query: unknown, args: unknown) => { requests.push(args); return { messages }; } };
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    const previous = useInboxStore.getState();
    const owner = {};
    previous._setDispatch(async () => {}, { owner });
    useInboxStore.setState({ pendingScrollToMessageId: null, pendingScrollToMessageTimestamp: null });
    try {
      await act(async () => root.render(
        <MemoryRouter>
          <TabParamsCtx.Provider value={{ tabId: "watch-test", pathname, params: {}, searchParams: new URLSearchParams(), isActive: true, navigate: (path) => routes.push(path) }}>
            <ConvexProvider client={client as any}>
              <TooltipProvider><MonitorBars session={session as any} isActive={false} /></TooltipProvider>
            </ConvexProvider>
          </TabParamsCtx.Provider>
        </MemoryRouter>,
      ));
      expect(useInboxStore.getState().messages[sessionId]).toBeUndefined();
      const button = host.querySelector<HTMLButtonElement>("button")!;
      expect(button.textContent).toContain("Prove the orphan sweep");
      await act(async () => button.click());
      expect(requests).toEqual([{ conversation_id: sessionId, center_timestamp: startedAt, limit_before: 50, limit_after: 50 }]);
      if (pathname === "/tasks") {
        expect(routes).toEqual([`/conversation/${sessionId}#msg-${messageId}`]);
        expect(useInboxStore.getState().pendingScrollToMessageId).toBeNull();
      } else {
        expect(routes).toEqual([]);
        expect(useInboxStore.getState().pendingNavigateId).toBe(sessionId);
        expect(useInboxStore.getState().pendingScrollToMessageId).toBe(messageId);
        expect(useInboxStore.getState().pendingScrollToMessageTimestamp).toBe(startedAt - 1);
      }
      expect(button.disabled).toBe(false);
      expect(button.getAttribute("aria-busy")).toBe("false");
    } finally {
      await act(async () => root.unmount());
      host.remove();
      useInboxStore.getState()._clearDispatch(owner);
      declareViewNav("gesture");
      useInboxStore.setState({ pendingNavigateId: previous.pendingNavigateId, pendingScrollToMessageId: previous.pendingScrollToMessageId, pendingScrollToMessageTimestamp: previous.pendingScrollToMessageTimestamp });
    }
  }, 30_000);
}
