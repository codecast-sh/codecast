import { afterAll, beforeEach, expect, mock, test } from "bun:test";
import { act } from "react";
import { JSDOM } from "jsdom";
import { replaceGlobals } from "../../test-helpers/globals";
import { closeDomWindow } from "../../test-helpers/domGlobals";

const dom = new JSDOM("<!doctype html><html><body></body></html>");
const restoreGlobals = replaceGlobals({
  window: dom.window,
  document: dom.window.document,
  navigator: dom.window.navigator,
  HTMLElement: dom.window.HTMLElement,
  IS_REACT_ACT_ENVIRONMENT: true,
});

// The launcher is the seam: the strip decides when to offer the agent and
// what a click records; starting a session is sharingAgent.ts's job.
const launched: number[] = [];
mock.module("../settings/SharingAgentCard", () => ({ launchSharingAgent: () => { launched.push(Date.now()); } }));
mock.module("next/link", () => ({ default: ({ href, onClick, children, ...rest }: any) => <a href={href} onClick={(e) => { e.preventDefault(); onClick?.(e); }} {...rest}>{children}</a> }));

const { createRoot } = await import("react-dom/client");
const { useInboxStore } = await import("../../store/inboxStore");
const { SharingSetupBanner } = await import("../SharingSetupBanner");

afterAll(() => {
  closeDomWindow(dom);
  restoreGlobals();
});

const DAY = 24 * 60 * 60 * 1000;
let stamps: Record<string, number> = {};

function seedNow(over: { user?: Record<string, unknown> | null; sessions?: number; taken?: number } = {}) {
  const sessions: Record<string, unknown> = {};
  for (let i = 0; i < (over.sessions ?? 1); i++) sessions[`s${i}`] = { _id: `s${i}` };
  useInboxStore.setState({
    currentUser: over.user === null ? null : { _id: "u1", _creationTime: Date.now() - 2 * DAY, cli_version: "1.0.0", ...over.user },
    sessions: sessions as any,
    clientState: { ...useInboxStore.getState().clientState, dismissed: over.taken ? { sharing_setup: over.taken } : {} },
    updateClientDismissed: ((key: string, value: number) => {
      stamps[key] = value;
      useInboxStore.setState((s) => ({ clientState: { ...s.clientState, dismissed: { ...s.clientState.dismissed, [key]: value } } }));
    }) as any,
  });
}

async function seed(over: Parameters<typeof seedNow>[0] = {}) {
  await act(async () => { seedNow(over); });
}

async function render() {
  const container = document.createElement("div");
  const root = createRoot(container);
  await act(async () => { root.render(<SharingSetupBanner />); });
  return { container, root };
}

beforeEach(() => {
  launched.length = 0;
  stamps = {};
});

test("after the first sync, a new account is offered the agent", async () => {
  await seed();
  const { container, root } = await render();
  expect(container.textContent).toContain("Your sessions are syncing.");
  expect(container.textContent).toContain("Set up with an agent");
  root.unmount();
});

test("the strip waits for a connected CLI, a synced session and a recent sign up, and goes once taken", async () => {
  for (const state of [
    { user: { cli_version: undefined } },
    { sessions: 0 },
    { user: { _creationTime: Date.now() - 30 * DAY } },
    { taken: Date.now() - 1000 },
    { user: null },
  ]) {
    await seed(state);
    const { container, root } = await render();
    expect(container.textContent).toBe("");
    root.unmount();
  }
});

test("taking the agent starts it and retires the strip", async () => {
  await seed();
  const { container, root } = await render();
  const button = [...container.querySelectorAll("button")].find((b) => b.textContent === "Set up with an agent")!;
  await act(async () => { button.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true })); });
  expect(launched.length).toBe(1);
  expect(stamps.sharing_setup).toBeGreaterThan(0);
  expect(container.textContent).toBe("");
  root.unmount();
});

test("doing it by hand links to the settings page and also retires the strip", async () => {
  await seed();
  const { container, root } = await render();
  const link = container.querySelector('a[href="/settings/sync"]')!;
  await act(async () => { link.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true })); });
  expect(launched.length).toBe(0);
  expect(stamps.sharing_setup).toBeGreaterThan(0);
  root.unmount();
});
