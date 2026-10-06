// The empty inbox's first-run card, by machine: a browser tab hands out the
// install command; the desktop app sets the machine up behind one click and
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
mock.module("convex/react", () => ({ ...convex, useMutation: () => async () => ({ token: "setup_tok_123456", expiresAt: Date.now() + 3_600_000 }) }));
const analytics = await import("../../lib/analytics");
const tracked: Array<[string, any]> = [];
mock.module("../../lib/analytics", () => ({ ...analytics, track: (e: string, p: any) => { tracked.push([e, p]); } }));

const { EmptyState } = await import("../EmptyState");
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
});
afterEach(async () => { await act(async () => root.unmount()); });

test("a browser tab gets the install command", async () => {
  await render();
  expect(text()).toContain("Start syncing your sessions");
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
  expect(tracked.map(([e]) => e)).toEqual(["desktop_setup_started", "desktop_setup_finished"]);
  expect(tracked[1][1]).toEqual({ ok: true });
});

test("a failed run falls back to the command to paste", async () => {
  desktop();
  setupResult = { ok: false, error: "installer_failed" };
  await render();
  await act(async () => { button("Set up this machine")!.dispatchEvent(new window.MouseEvent("click", { bubbles: true })); });
  await flush();
  expect(text()).toContain("Setup did not finish from here");
  expect(button("Generate install command")).toBeTruthy();
  expect(tracked[1][1]).toEqual({ ok: false, error: "installer_failed" });
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
