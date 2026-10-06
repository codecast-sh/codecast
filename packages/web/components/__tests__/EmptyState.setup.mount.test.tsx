// The empty inbox's first-run card: a person with no machine is offered two
// starts, the hosted assistant here or their own coding tools, and in hosted mode
// only the assistant. By machine: a browser tab hands out the install command; the desktop app sets the machine up behind one click and
// then waits for the first session; a failed run falls back to the command;
// and a terminal that just connected is never asked to install again.
import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { JSDOM } from "jsdom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

const dom = new JSDOM("<!doctype html><html><body><div id='root'></div></body></html>", { url: "https://codecast.test/inbox", pretendToBeVisual: true });
for (const key of ["window", "document", "navigator", "HTMLElement", "Element", "Node", "MutationObserver", "Event", "sessionStorage", "localStorage"]) {
  Object.defineProperty(globalThis, key, { value: (dom.window as any)[key], configurable: true, writable: true });
}
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let setupResult: { ok: boolean; error?: string } = { ok: true };
let setupTokens: string[] = [];
const convex = await import("convex/react");
// Every query answers true (whisk.connectAvailable: mail can be connected).
mock.module("convex/react", () => ({
  ...convex,
  useMutation: () => async () => ({ token: "setup_tok_123456", expiresAt: Date.now() + 3_600_000 }),
  useAction: () => async () => null,
  useQueries: (queries: Record<string, unknown>) => Object.fromEntries(Object.keys(queries).map((k) => [k, true])),
}));
const analytics = await import("../../lib/analytics");
const tracked: Array<[string, any]> = [];
mock.module("../../lib/analytics", () => ({ ...analytics, track: (e: string, p: any) => { tracked.push([e, p]); } }));

const { EmptyState } = await import("../EmptyState");
const { useInboxStore } = await import("../../store/inboxStore");
const { HOSTED_AGENT_TYPE } = await import("@codecast/shared/contracts/assistant");
// The store is shared with every test file in the run, so the mode is set
// here rather than read from whatever an earlier file left.
const withLane = (lane?: string) => {
  const cs = useInboxStore.getState().clientState as any;
  useInboxStore.setState({ clientState: { ...cs, ui: { ...cs.ui, lane } } });
};
const { CLI_CONNECTED_KEY, cliJustConnected } = await import("../../lib/cliConnected");

let root: Root;
const flush = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });
const render = async () => {
  await act(async () => root.render(<EmptyState variant="onboarding" title="" description="" />));
  await flush();
};
const text = () => document.body.textContent ?? "";
const button = (label: string) => [...document.querySelectorAll("button")].find((b) => b.textContent?.includes(label));
const desktop = (machine = { supported: true, installed: false, linked: false, running: false }) => {
  (window as any).__CODECAST_ELECTRON__ = {
    getDaemonSetup: async () => machine,
    runDaemonSetup: async (token: string) => { setupTokens.push(token); return setupResult; },
  };
};

beforeEach(() => {
  document.body.innerHTML = "<div id='root'></div>";
  root = createRoot(document.getElementById("root")!);
  sessionStorage.removeItem(CLI_CONNECTED_KEY);
  delete (window as any).__CODECAST_ELECTRON__;
  setupResult = { ok: true };
  setupTokens = [];
  tracked.length = 0;
  useInboxStore.setState({ composes: [] });
  withLane(undefined);
});
afterEach(async () => { await act(async () => root.unmount()); });
const click = (label: string) => act(async () => { button(label)!.dispatchEvent(new window.MouseEvent("click", { bubbles: true })); });

test("a person with no machine is offered the assistant here or their own coding tools", async () => {
  await render();
  expect(text()).toContain("How would you like to start?");
  expect(text()).toContain("Ask the Codecast assistant");
  expect(text()).toContain("your mail and calendar through Whisk");
  expect(text()).toContain("Ask the assistant right here, or connect the coding tools on your computer.");
  expect(text()).toContain("Connect your coding tools");
  expect(text()).toContain("For developers:");
  expect(button("Start a conversation")).toBeTruthy();
  expect(button("Generate install command")).toBeTruthy();
});

test("the assistant start opens a composer on the hosted assistant", async () => {
  await render();
  await click("Start a conversation");
  const composes = useInboxStore.getState().composes;
  expect(composes).toHaveLength(1);
  expect(composes[0].context?.agentType).toBe(HOSTED_AGENT_TYPE);
  expect(tracked).toEqual([["first_run_start_chosen", { start: "assistant" }]]);
});

test("asking for the install command counts as choosing the machine", async () => {
  await render();
  await click("Generate install command");
  await flush();
  expect(tracked[0]).toEqual(["first_run_start_chosen", { start: "machine" }]);
});

test("hosted mode offers only the assistant", async () => {
  withLane("simple");
  await render();
  expect(text()).toContain("Ask the Codecast assistant");
  expect(text()).not.toContain("Connect your coding tools");
  expect(button("Generate install command")).toBeUndefined();
});

test("a browser tab gets the install command", async () => {
  await render();
  expect(button("Generate install command")).toBeTruthy();
  expect(button("Set up this machine")).toBeUndefined();
});

test("the desktop app sets the machine up in one click, then waits for sessions", async () => {
  desktop();
  await render();
  expect(button("Generate install command")).toBeUndefined();
  await act(async () => { button("Set up this machine")!.dispatchEvent(new window.MouseEvent("click", { bubbles: true })); });
  await flush();
  expect(setupTokens).toEqual(["setup_tok_123456"]);
  expect(text()).toContain("This machine is connected");
  expect(cliJustConnected()).toBe(true);
  expect(tracked.map(([e]) => e)).toEqual(["first_run_start_chosen", "desktop_setup_started", "desktop_setup_finished"]);
  expect(tracked[2][1]).toEqual({ ok: true });
});

test("a failed run falls back to the command to paste", async () => {
  desktop();
  setupResult = { ok: false, error: "installer_failed" };
  await render();
  await act(async () => { button("Set up this machine")!.dispatchEvent(new window.MouseEvent("click", { bubbles: true })); });
  await flush();
  expect(text()).toContain("Setup did not finish from here");
  expect(button("Generate install command")).toBeTruthy();
  expect(tracked[2][1]).toEqual({ ok: false, error: "installer_failed" });
});

test("a desktop build without the bridge, or on an unsupported OS, gets the command", async () => {
  desktop({ supported: false, installed: false, linked: false, running: false });
  await render();
  expect(button("Set up this machine")).toBeUndefined();
  expect(button("Generate install command")).toBeTruthy();
});

test("a terminal that just connected is told to wait, not to install", async () => {
  sessionStorage.setItem(CLI_CONNECTED_KEY, String(Date.now()));
  await render();
  expect(text()).toContain("This machine is connected");
  expect(button("Generate install command")).toBeUndefined();
});
