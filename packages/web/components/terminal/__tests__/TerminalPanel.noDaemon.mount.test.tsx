// ct-101444: a terminal dock left open on an earlier visit reopens (its open
// state is device-local and persisted) on a machine where no local daemon can
// be reached. The panel then holds its full height (280 px by default) above
// the conversation with only the "No local daemon reachable" note in it, until
// the person closes it by hand.
//
// What this checks: once discovery has found no daemon, a dock that was
// restored open (nobody opened it this visit) no longer takes that space: it is
// hidden, or folded below the panel's own minimum height.
// Run: bun test components/terminal/__tests__/TerminalPanel.noDaemon.mount.test.tsx
import { afterAll, expect, mock, test } from "bun:test";
import { closeDomWindow } from "../../../test-helpers/domGlobals";

const { JSDOM } = await import("jsdom");
const dom = new JSDOM("<!doctype html><html><body><div id='root'></div></body></html>", { url: "https://codecast.sh" });
for (const key of ["window", "document", "navigator", "HTMLElement", "Element", "Node", "MutationObserver", "CustomEvent", "Event", "getComputedStyle", "localStorage"]) {
  Object.defineProperty(globalThis, key, { value: (dom.window as any)[key], configurable: true, writable: true });
}
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

// No daemon on this machine: discovery answers null, the way the relay does
// when it finds no live device.
const endpointCalls: unknown[] = [];
const realEndpoint = { ...(await import("../../../lib/terminal/endpoint")) };
afterAll(() => mock.module("../../../lib/terminal/endpoint", () => realEndpoint));
mock.module("../../../lib/terminal/endpoint", () => ({
  ...realEndpoint,
  getTerminalEndpoint: async (...args: unknown[]) => {
    endpointCalls.push(args);
    return null;
  },
  lastDiscoveryFailure: () => "no-devices",
  probeEndpoint: async () => null,
}));

const React = await import("react");
const { act } = React;
const { createRoot } = await import("react-dom/client");
const { ConvexProvider } = await import("convex/react");
const { useInboxStore } = await import("../../../store/inboxStore");
const { TerminalPanel } = await import("../TerminalPanel");

const MIN_HEIGHT = 110;

afterAll(() => closeDomWindow(dom));

test("a dock restored open on a machine with no reachable daemon stops taking space above the conversation", async () => {
  // The persisted arrangement from an earlier visit: dock open.
  useInboxStore.getState().setDockOpen(true);
  expect(useInboxStore.getState().workspace.dock.pane).not.toBeNull();

  const client = { connectionState: () => ({ isWebSocketConnected: true }), subscribeToConnectionState: () => () => {} };
  const root = createRoot(document.getElementById("root")!);
  await act(async () => {
    root.render(React.createElement(ConvexProvider, { client: client as any }, React.createElement(TerminalPanel)));
  });
  // Let discovery settle.
  for (let i = 0; i < 5; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); });

  expect(endpointCalls.length).toBeGreaterThan(0);
  const panel = document.querySelector("[data-terminal-panel]") as HTMLElement | null;
  expect(panel).not.toBeNull();
  // Sanity: the miss is the no-daemon state, not a panel stuck connecting.
  expect(panel!.textContent ?? "").not.toContain("Connecting to local daemon");

  const hidden = panel!.classList.contains("hidden");
  const height = Number.parseFloat(panel!.style.height || "0");
  const occupied = hidden ? 0 : height;
  expect(occupied).toBeLessThan(MIN_HEIGHT);

  // The saved choice survives for a later visit with a reachable daemon.
  expect(useInboxStore.getState().workspace.dock.pane).not.toBeNull();
  // One press of the toggle shows the folded dock again, reason and Retry in view.
  const { selectDockShown } = await import("../../../store/inboxStore");
  await act(async () => { const st = useInboxStore.getState(); st.setDockOpen(!selectDockShown(st)); });
  for (let i = 0; i < 5; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
  expect(panel!.classList.contains("hidden")).toBe(false);
  expect(panel!.textContent ?? "").toContain("Retry");

  await act(async () => root.unmount());
});
