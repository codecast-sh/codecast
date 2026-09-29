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
  // The trigger's pill names it and opens it.
  expect(host.querySelector("[data-pill='tr-1168']")).not.toBeNull();
});

test("a role's run is one line at rest and opens inline to its card, the waiting state and the prompt", async () => {
  const firedAt = Date.now();
  const content = formatScheduledTask({
    title: "A session under you needs input", task_id: "rx2", trigger: "tr-1168", event: "session_needs_input",
    role: { handle: "calling", name: "Calling lead", reports_to: "Cam", scope: ["Callers & Call Management"], charter: "Keeps the caller team effective.", goals: ["Cost per intro under $250"] },
    waiting: { short_id: "jx7781p", title: "Broker cleanup", why: "blocked", since: firedAt - 9 * 60_000, state: "Which tool cuts come next?" },
    // The writer appends a note for the agent alone when its session is out of the inbox.
    body: "A session that reports to you is waiting.\n\nThis session is STASHED: the user will not see this run or its output. End your turn with cast state --status done|dormant to stay quietly out of their inbox.",
  });
  const host = document.createElement("div");
  document.body.appendChild(host);
  await act(async () => createRoot(host).render(React.createElement(ScheduledTaskBlock, { content, timestamp: firedAt })));
  const block = host.querySelector("[data-role-wake=calling]") as HTMLElement;
  expect(block.textContent).toContain("is blocked for 9m");
  expect(host.querySelector("[data-role-wake-detail]")).toBeNull();
  await act(async () => (block.querySelector("[role=button]") as HTMLElement).click());
  const detail = host.querySelector("[data-role-wake-detail]") as HTMLElement;
  expect(detail.textContent).toContain("Which tool cuts come next?");
  expect(detail.textContent).toContain("Callers & Call Management");
  expect(detail.textContent).toContain("reports to Cam");
  expect(host.querySelector("[data-role-wake-prompt]")!.textContent).toBe("A session that reports to you is waiting.");
  expect(detail.textContent).not.toMatch(/STASHED|cast state/);
});
