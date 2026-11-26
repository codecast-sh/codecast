// ct-102136: returning focus to the window froze the page for 1.6s inside
// the window `focus` listener. useSyncCore is mounted by DashboardLayout
// itself, and its web wake source calls emitSyncWake() synchronously from
// `visibilitychange` and `focus`. Every wake consumer then runs inside the
// event: the stub sweep's setState re-renders the dashboard host, and the
// change feed, which also listens for both events on its own, starts a
// catch-up for each of them.
//
// A return to the window is one `visibilitychange` (visible) and one `focus`.
// It must cost the host no React commit before the event's task ends, and
// it must replay the sync log exactly once.
import { afterAll, expect, mock, test } from "bun:test";
import { JSDOM } from "jsdom";
import { closeDomWindow } from "../test-helpers/domGlobals";

const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost/inbox", pretendToBeVisual: true });
for (const key of ["window", "document", "navigator", "HTMLElement", "Element", "Node", "MutationObserver", "Event", "localStorage"]) {
  Object.defineProperty(globalThis, key, { value: (dom.window as any)[key], configurable: true, writable: true });
}
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

// The server: a client whose every ask answers "nothing new", counted by name.
const asked: string[] = [];
const fnName = (ref: any): string => {
  try {
    const { getFunctionName } = require("convex/server");
    return getFunctionName(ref);
  } catch {
    return String(ref);
  }
};
const fakeConvex: any = {
  query: async (ref: any) => {
    asked.push(fnName(ref));
    return { heads: [] };
  },
  mutation: async () => null,
  action: async () => null,
  watchQuery: () => ({ onUpdate: () => () => {}, localQueryResult: () => undefined, journal: () => undefined }),
  connectionState: () => ({ isWebSocketConnected: true }),
  subscribeToConnectionState: () => () => {},
};
const realConvexReact = { ...(await import("convex/react")) };
mock.module("convex/react", () => ({
  ...realConvexReact,
  useConvex: () => fakeConvex,
  useQuery: () => undefined,
  useQueries: () => ({}),
  useMutation: () => Object.assign(async () => null, { withOptimisticUpdate: () => async () => null }),
  useAction: () => async () => null,
  useConvexAuth: () => ({ isLoading: false, isAuthenticated: true }),
}));

const React = await import("react");
const { act } = React;
const { createRoot } = await import("react-dom/client");
const { useInboxStore } = await import("../store/inboxStore");
const { useSyncCore } = await import("./useSyncCore");

afterAll(() => closeDomWindow(dom));

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

test("returning to the window commits nothing in the event and replays the sync log once", async () => {
  useInboxStore.setState({ clientStateInitialized: true } as any);
  let hostRenders = 0;
  function DashboardHost() {
    hostRenders++;
    useSyncCore("web");
    return null;
  }
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(<DashboardHost />);
  });
  // Let mount-time catch-ups, floors and timers settle.
  for (let i = 0; i < 20; i++) await act(async () => { await tick(); });

  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = false;
  const rendersBefore = hostRenders;
  const headsBefore = asked.filter((n) => n.endsWith("getHeads")).length;

  // The person comes back: the tab turns visible, then the window takes focus.
  document.dispatchEvent(new window.Event("visibilitychange"));
  window.dispatchEvent(new window.Event("focus"));
  // React flushes a discrete event's sync update in a microtask: still
  // inside this task, so still blocking the person's next input.
  await Promise.resolve();
  await Promise.resolve();
  const rendersInEvent = hostRenders - rendersBefore;

  // Now let the catch-up finish (and any queued rerun with it).
  for (let i = 0; i < 20; i++) await tick();
  const headsAfter = asked.filter((n) => n.endsWith("getHeads")).length;
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  await act(async () => root.unmount());

  expect({ hostCommitsInFocusTask: rendersInEvent, catchUpRunsPerReturn: headsAfter - headsBefore }).toEqual({
    hostCommitsInFocusTask: 0,
    catchUpRunsPerReturn: 1,
  });
});
