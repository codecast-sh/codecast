import { replaceGlobals } from "../../../test-helpers/globals";
import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";

// The sidebar said 47, the stepper "2 of 32" and the inbox panel "Decisions 2":
// three counts over three different sets. The panel's Decisions section is now
// the queue itself, so its count is the stepper's total, its rows are numbered
// in the stepper's order, and the row the stepper is on is the lit one.

import { JSDOM } from "jsdom";
import { closeDomWindow } from "../../../test-helpers/domGlobals";

const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "https://app.test/decisions", pretendToBeVisual: true });
const restoreGlobals = replaceGlobals({
  window: dom.window,
  document: dom.window.document,
  navigator: dom.window.navigator,
  location: dom.window.location,
  // Prism (reached through the markdown renderer) polyfills Element.prototype at import.
  Element: dom.window.Element,
  HTMLElement: dom.window.HTMLElement,
  IS_REACT_ACT_ENVIRONMENT: true,
});
afterAll(() => {
  closeDomWindow(dom);
  restoreGlobals();
});

const CONV_A = "convaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const CONV_B = "convbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

const item = (key: string, conversationId: string, sessionTitle: string) => ({
  key,
  source: "decide" as const,
  conversationId,
  sessionTitle,
  question: `question ${key}`,
  options: [{ label: "yes" }, { label: "no" }],
  blocking: true,
  createdAt: 1,
});

// Queue order interleaves the two sessions: A, B, A.
const queue = [item("a1", CONV_A, "Alpha"), item("b1", CONV_B, "Beta"), item("a2", CONV_A, "Alpha")];

const realQueueModule = { ...(await import("../../../hooks/useDecisionQueue")) };
mock.module("../../../hooks/useDecisionQueue", () => ({ ...realQueueModule, useDecisionQueue: () => queue }));
mock.module("../../../app/inbox/QueuePageClient", () => ({
  InboxConversation: ({ sessionId }: { sessionId: string }) => <div data-conv={sessionId} />,
}));

const { DecisionQueue } = await import("../../DecisionQueue");
const { InboxDecisionQueue } = await import("../InboxDecisionQueue");
const React = await import("react");
const { createRoot } = await import("react-dom/client");
const { MemoryRouter } = await import("react-router");
const act: <T>(cb: () => T | Promise<T>) => Promise<T> = (React as any).act;

const rows = (c: HTMLElement) => [...c.querySelectorAll<HTMLElement>("[data-decision-queue-row]")];
const litRow = (c: HTMLElement) => rows(c).find((r) => r.getAttribute("data-here") === "true");

describe("the inbox panel's Decisions section is the stepper's queue", () => {
  let container: HTMLElement;
  let root: ReturnType<typeof createRoot>;

  beforeAll(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });
  afterAll(async () => {
    await act(async () => root.unmount());
    container.remove();
  });

  const panel = <InboxDecisionQueue collapsed={false} onToggle={() => {}} extraSessions={[]} onSelectSession={() => {}} />;

  test("the header counts the queue and rows carry queue positions under their session", async () => {
    await act(async () => root.render(<MemoryRouter>{panel}</MemoryRouter>));
    expect(container.querySelector("[data-inbox-section=questions]")?.getAttribute("data-inbox-section-count")).toBe("3");
    expect(rows(container).map((r) => r.getAttribute("data-decision-queue-row"))).toEqual(["1", "3", "2"]);
    expect(container.textContent).toContain("Alpha");
    expect(container.textContent).toContain("Beta");
  });

  test("the row the stepper is on is lit, and it follows a jump to another item", async () => {
    await act(async () => root.render(<MemoryRouter>{panel}<DecisionQueue key="b1" initialKey="b1" /></MemoryRouter>));
    expect(litRow(container)?.getAttribute("data-decision-queue-row")).toBe("2");
    expect(litRow(container)?.closest("[data-session-id]")?.getAttribute("data-active")).toBe("true");

    await act(async () => root.render(<MemoryRouter>{panel}<DecisionQueue key="a2" initialKey="a2" /></MemoryRouter>));
    expect(litRow(container)?.getAttribute("data-decision-queue-row")).toBe("3");
  });

  test("leaving the stepper clears the lit row", async () => {
    await act(async () => root.render(<MemoryRouter>{panel}</MemoryRouter>));
    expect(litRow(container)).toBeUndefined();
  });
});
