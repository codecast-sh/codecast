// The global header chip must not speak for a remote box (grok-bot-vm,
// AWS ip-*), even when that box never set is_remote. The session that runs
// there may warn, including a stale daemon.
// Run: bun test components/__tests__/daemonStatusChip.mount.test.tsx
import { replaceGlobals } from "../../test-helpers/globals";
import { afterAll, expect, mock, test } from "bun:test";
import { JSDOM } from "jsdom";

const dom = new JSDOM("<!doctype html><html><body><div id='root'></div></body></html>", {
  url: "https://local.codecast.sh",
  pretendToBeVisual: true,
});
const restoreGlobals = replaceGlobals({
  window: dom.window,
  document: dom.window.document,
  navigator: dom.window.navigator,
  HTMLElement: dom.window.HTMLElement,
  Element: dom.window.Element,
  Node: dom.window.Node,
  MutationObserver: dom.window.MutationObserver,
  CustomEvent: dom.window.CustomEvent,
  Event: dom.window.Event,
  getComputedStyle: dom.window.getComputedStyle,
  IS_REACT_ACT_ENVIRONMENT: true,
});
afterAll(() => {
  Date.now = realNow;
  dom.window.close();
  restoreGlobals();
});

const convexReact = await import("convex/react");
mock.module("convex/react", () => ({
  ...convexReact,
  useQuery: () => undefined,
  useQueries: () => ({}),
  useMutation: () => async () => undefined,
  useConvex: () => ({
    query: async () => null,
    mutation: async () => null,
    connectionState: () => ({ isWebSocketConnected: true }),
    subscribeToConnectionState: () => () => {},
  }),
}));

const React = await import("react");
const { createRoot } = await import("react-dom/client");
const act: <T>(cb: () => T | Promise<T>) => Promise<T> = (React as any).act;
const { DaemonStatusChip, SessionDaemonChip } = await import("../DaemonStatusChip");
const { useInboxStore } = await import("../../store/inboxStore");

const realNow = Date.now;

test("global header ignores an unflagged grok-bot-vm; the session header names it", async () => {
  const now = realNow();
  const laptop = {
    device_id: "laptop",
    label: "MacBook",
    platform: "darwin",
    is_remote: false,
    online: true,
    last_seen: now - 1000,
  };
  const grokVm = {
    device_id: "grok-vm",
    label: "Linux - grok-bot-vm-2307902",
    platform: "linux",
    is_remote: false,
    online: false,
    last_seen: now - 51 * 60 * 1000,
  };
  const convId = "conv-remote";
  useInboxStore.getState().setMachineRoster([laptop, grokVm] as any);
  useInboxStore.setState({
    sessions: { [convId]: { owner_device_id: "grok-vm" } as any },
    liveLoading: {},
    syncLogLag: {},
  });
  const root = createRoot(document.getElementById("root")!);
  await act(async () => {
    root.render(
      <div>
        <div data-fleet>
          <DaemonStatusChip />
        </div>
        <div data-session>
          <SessionDaemonChip conversationId={convId} />
        </div>
      </div>,
    );
  });

  // Past the post-wake grace so a stale last_seen is attributed to the daemon.
  await act(async () => {
    Date.now = () => now + 61_000;
    document.dispatchEvent(new Event("visibilitychange"));
  });

  const fleet = document.querySelector("[data-fleet]")?.textContent ?? "";
  const session = document.querySelector("[data-session]")?.textContent ?? "";
  expect(fleet).not.toContain("daemon stale");
  expect(fleet).not.toContain("grok-bot-vm");
  expect(session).toContain("Cloud Linux: daemon stale");
  expect(session).toMatch(/\d+ min/);

  await act(async () => root.unmount());
});
