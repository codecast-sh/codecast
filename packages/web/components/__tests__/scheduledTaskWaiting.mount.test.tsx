// A role's needs-input trigger run (org-staffing.md S28) renders as a trigger
// block that names the waiting session, not as a message from a person.
import { afterAll, expect, mock, test } from "bun:test";
import { act } from "react";
import { JSDOM } from "jsdom";
import { replaceGlobals } from "../../test-helpers/globals";
import { closeDomWindow } from "../../test-helpers/domGlobals";
import { formatScheduledTask } from "@codecast/shared/contracts";

const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "https://local.codecast.sh", pretendToBeVisual: true });
const restoreGlobals = replaceGlobals({
  window: dom.window,
  document: dom.window.document,
  navigator: dom.window.navigator,
  HTMLElement: dom.window.HTMLElement,
  Element: dom.window.Element,
  Node: dom.window.Node,
  NodeFilter: dom.window.NodeFilter,
  MutationObserver: dom.window.MutationObserver,
  CustomEvent: dom.window.CustomEvent,
  Event: dom.window.Event,
  getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
  requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window),
  cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window),
  IS_REACT_ACT_ENVIRONMENT: true,
});
const { createRoot } = await import("react-dom/client");
const React = await import("react");
// The pills resolve through Convex; here they stand as their ids.
const pills = await import("../EntityIdPill");
mock.module("../EntityIdPill", () => ({
  ...pills,
  EntityIdPill: ({ shortId }: { shortId: string }) => React.createElement("span", { "data-pill": shortId }, shortId),
}));
const { ScheduledTaskBlock } = await import("../conversation/blocks/systemBlocks");
afterAll(() => { closeDomWindow(dom); restoreGlobals(); });

test("a needs-input run names the session, why it waits, for how long, its state line and the trigger", async () => {
  const firedAt = Date.now();
  const content = formatScheduledTask({
    title: "A session under you needs input", task_id: "rx1", trigger: "tr-1168", event: "session_needs_input",
    waiting: { short_id: "jx7781p", title: "Broker agent scheduling cleanup", why: "blocked", since: firedAt - 12 * 60_000, state: "Broker cleanup: 8 self-wake paths collapsed to 2" },
    body: "A session that reports to you is waiting.",
  });
  const host = document.createElement("div");
  document.body.appendChild(host);
  await act(async () => createRoot(host).render(React.createElement(ScheduledTaskBlock, { content, timestamp: firedAt })));
  const line = host.querySelector("[data-waiting-session]") as HTMLElement;
  expect(line.getAttribute("data-waiting-session")).toBe("jx7781p");
  expect(line.textContent).toContain("is blocked");
  expect(line.textContent).toContain("for 12m");
  expect(line.textContent).toContain("8 self-wake paths collapsed to 2");
  // The raw frame never leaks into the prompt text.
  expect(host.textContent).not.toContain("waiting-session");
  expect(host.textContent).toContain("A session under you needs input");
});
