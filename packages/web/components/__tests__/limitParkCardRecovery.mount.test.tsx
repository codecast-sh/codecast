import { afterAll, expect, mock, test } from "bun:test";
import { act } from "react";
import { JSDOM } from "jsdom";
import { ConvexProvider, type ConvexReactClient } from "convex/react";
import { getFunctionName } from "convex/server";
import { MemoryRouter } from "react-router";
import { replaceGlobals } from "../../test-helpers/globals";
import { closeDomWindow } from "../../test-helpers/domGlobals";

// A session parked on a limit while the person's recovery mode is off: the
// card says so and lets them turn recovery on right there, as the person's
// choice (no machine named in the write).

const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost", pretendToBeVisual: true });
const restore = replaceGlobals({ window: dom.window, document: dom.window.document, navigator: dom.window.navigator, HTMLElement: dom.window.HTMLElement, HTMLInputElement: dom.window.HTMLInputElement, Element: dom.window.Element, MutationObserver: dom.window.MutationObserver, Node: dom.window.Node, NodeFilter: dom.window.NodeFilter, CustomEvent: dom.window.CustomEvent, getComputedStyle: dom.window.getComputedStyle.bind(dom.window), localStorage: dom.window.localStorage, sessionStorage: dom.window.sessionStorage, IS_REACT_ACT_ENVIRONMENT: true });

const now = Date.now();
const device = { device_id: "mac", label: "Mac", is_remote: false, online: true, auto_switch: false, auto_continue: false, ask_first: false, profiles: [] };
const realRecovery = { ...(await import("../../hooks/useLimitRecovery")) };
mock.module("../../hooks/useLimitRecovery", () => ({
  ...realRecovery,
  useLimitRecovery: () => ({ now, device, phase: { phase: "parked" } }),
}));

const { createRoot } = await import("react-dom/client");
const { LimitParkCard } = await import("../LimitParkCard");

const mutations: Array<{ name: string; args: any }> = [];
const client = {
  url: "https://park-card-fixture.invalid",
  connectionState: () => ({ isWebSocketConnected: true }),
  subscribeToConnectionState: () => () => {},
  mutation: async (ref: any, args: any) => { mutations.push({ name: getFunctionName(ref), args }); return {}; },
  watchQuery: () => ({ onUpdate: () => () => {}, localQueryResult: () => undefined, journal: () => undefined }),
} as unknown as ConvexReactClient;

afterAll(() => { closeDomWindow(dom); restore(); });

test("a parked card with recovery off offers the mode picker and writes the person's mode", async () => {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(() => root.render(
    <ConvexProvider client={client}><MemoryRouter>
      <LimitParkCard message="You've hit your weekly limit · resets 7am (UTC)" timestamp={now - 60_000} conversationId="c1" live />
    </MemoryRouter></ConvexProvider>,
  ));
  expect(host.textContent).toContain("Parked until you continue it.");
  expect(host.textContent).not.toContain("on this machine");

  const picker = [...host.querySelectorAll("button")].find((b) => b.textContent?.includes("Auto-resume off"));
  expect(picker).toBeDefined();
  await act(async () => {
    picker!.dispatchEvent(new dom.window.PointerEvent("pointerdown", { bubbles: true, button: 0 }));
    picker!.click();
  });
  const option = [...document.querySelectorAll<HTMLButtonElement>("[role=radio]")].find((b) => b.textContent?.includes("Continue on this account"));
  expect(option).toBeDefined();
  await act(async () => { option!.click(); });
  expect(mutations.at(-1)).toEqual({ name: "accountSwitch:setRecoveryMode", args: { mode: "resume" } });
  await act(() => root.unmount());
});
