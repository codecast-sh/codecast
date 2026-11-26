import { afterAll, beforeEach, expect, jest, mock, test } from "bun:test";
import { JSDOM } from "jsdom";
import { replaceGlobals } from "../../test-helpers/globals";
import { closeDomWindow } from "../../test-helpers/domGlobals";

// ct-101648: on a brand-new account the header sync light reads "Syncing",
// turns to "Sync is slow" and never settles, and the slow state offers the
// person nothing to do.
//
// What this pins, against the real feeder and the real light:
//   1. The inbox feeder publishes `liveLoading.sessions = true` while its first
//      answer is owed. When the window stops feeding (the host feeders unmount:
//      the window is demoted to a follower, or the shell remounts) that flag is
//      never cleared, and on an account with no sessions the collection is
//      always "cold", so the light keeps reading Syncing, then Sync is slow,
//      for the life of the page. A warm account hides it (the cached rows make
//      the scope warm), which is why only new accounts see it.
//   2. Once the light reads Sync is slow, its panel must give the person one
//      control that acts on it.

const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost/", pretendToBeVisual: true });
const restoreGlobals = replaceGlobals({
  window: dom.window,
  document: dom.window.document,
  navigator: dom.window.navigator,
  HTMLElement: dom.window.HTMLElement,
  Element: dom.window.Element,
  Node: dom.window.Node,
  Event: dom.window.Event,
  CustomEvent: dom.window.CustomEvent,
  FocusEvent: dom.window.FocusEvent,
  MouseEvent: dom.window.MouseEvent,
  KeyboardEvent: dom.window.KeyboardEvent,
  getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
  ResizeObserver: class { observe() {} unobserve() {} disconnect() {} },
  IS_REACT_ACT_ENVIRONMENT: true,
});

// Every subscription is still owed its first answer.
const realQuery = { ...(await import("../../hooks/useQueryNoThrow")) };
mock.module("../../hooks/useQueryNoThrow", () => ({
  ...realQuery,
  useQueryNoThrow: () => ({ data: undefined, error: undefined, retry: () => {} }),
}));
const realAuth = { ...(await import("../../hooks/useServerAuthSettled")) };
mock.module("../../hooks/useServerAuthSettled", () => ({
  ...realAuth,
  useServerAuthSettled: () => true,
  useServerAuthenticated: () => true,
  useServerIdentityLost: () => false,
}));
const fakeConvex = {
  query: () => new Promise(() => {}),
  watchQuery: () => ({ onUpdate: () => () => {}, localQueryResult: () => undefined }),
  connectionState: () => ({ isWebSocketConnected: true }),
  subscribeToConnectionState: () => () => {},
};
const realConvexReact = { ...(await import("convex/react")) };
mock.module("convex/react", () => ({
  ...realConvexReact,
  useConvex: () => fakeConvex,
  useMutation: () => {
    const fn: any = async () => null;
    fn.withOptimisticUpdate = () => fn;
    return fn;
  },
  useAction: () => async () => null,
}));

const realDaemon = { ...(await import("../../hooks/useLocalDaemonHealth")) };
mock.module("../../hooks/useLocalDaemonHealth", () => ({ ...realDaemon, useLocalDaemonHealth: () => ({ kind: "ok" }) }));
const realOffline = { ...(await import("../../hooks/useAppOffline")) };
mock.module("../../hooks/useAppOffline", () => ({ ...realOffline, useAppOffline: () => ({ offline: false, online: true }) }));

const React = await import("react");
const { act } = React;
const { createRoot } = await import("react-dom/client");
const { useInboxStore } = await import("../../store/inboxStore");
const { useSyncInboxSessions } = await import("../../hooks/useSyncInboxSessions");
const { selectSyncing, selectSyncFlags, SyncStatusChip } = await import("../SyncStatusChip");

afterAll(() => {
  closeDomWindow(dom);
  restoreGlobals();
});

beforeEach(() => {
  // A brand-new account: nothing cached in any collection.
  useInboxStore.setState({
    liveLoading: {},
    syncLogLag: {},
    livenessHeldAt: null,
    sessions: {},
    tasks: {},
    docs: {},
    projects: {},
    plans: {},
    syncRole: "host",
  } as any);
});

function InboxFeeder() {
  useSyncInboxSessions();
  return null;
}

test("a new account's sync light settles once the window stops feeding the inbox", async () => {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => root.render(<InboxFeeder />));
  // While the feeder waits on its first answer, the light honestly syncs.
  expect(useInboxStore.getState().liveLoading.sessions).toBe(true);
  expect(selectSyncing(useInboxStore.getState())).toBe(true);

  // The window stops feeding (demoted to follower / host feeders unmount).
  await act(async () => root.unmount());
  host.remove();

  // Nothing is loading any more, so nothing may hold the light on.
  const s = useInboxStore.getState();
  expect({ syncing: selectSyncing(s), flags: selectSyncFlags(s), liveLoading: s.liveLoading }).toEqual({
    syncing: false,
    flags: 0,
    liveLoading: expect.not.objectContaining({ sessions: true }),
  });
});

test("once the light reads Sync is slow, its panel offers the person a control that acts on it", async () => {
  jest.useFakeTimers();
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  try {
    // A first load that never lands: the light goes Syncing, then Sync is slow.
    useInboxStore.getState().setLiveLoading("sessions", true);
    await act(async () => root.render(<SyncStatusChip />));
    await act(async () => { jest.advanceTimersByTime(25_000); });
    const button = document.querySelector('button[aria-label^="Sync status"]') as HTMLElement | null;
    expect(button?.getAttribute("aria-label")).toBe("Sync status: Sync is slow");

    // Open the hover panel (keyboard focus opens it, as hover does).
    await act(async () => {
      button!.focus();
    });
    await act(async () => { jest.advanceTimersByTime(1_000); });
    expect(document.body.textContent).toContain("Still waiting on the server");
    // The stalled panel must hold a control (beyond the trigger) the person can press.
    const controls = [...document.querySelectorAll("button, a[href]")].filter((el) => el !== button);
    expect(controls.map((el) => el.textContent?.trim())).not.toEqual([]);
  } finally {
    await act(async () => root.unmount());
    host.remove();
    jest.useRealTimers();
  }
});
