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
const litRow = (c: HTMLElement) => rows(c).find((r) => r.querySelector(".text-sol-yellow"));

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

    await act(async () => root.render(<MemoryRouter>{panel}<DecisionQueue key="a2" initialKey="a2" /></MemoryRouter>));
    expect(litRow(container)?.getAttribute("data-decision-queue-row")).toBe("3");
  });

  test("leaving the stepper clears the lit row", async () => {
    await act(async () => root.render(<MemoryRouter>{panel}</MemoryRouter>));
    expect(litRow(container)).toBeUndefined();
  });
});

// The advisory row said "Going ahead on a default 13" and opened every
// decision. It opens the list filtered to the advisory asks, and its count is
// what that list shows.
describe("the advisory row opens the list it counts", () => {
  test("its count is the Mine tab under the advisory filter, and it links there", async () => {
    const { useInboxStore } = await import("../../../store/inboxStore");
    const { decisionView, filterCounts, inTab, passesFilters } = await import("../../../lib/decisions/decisionRows");
    const dec = (id: string, extra: Record<string, unknown>) => ({ _id: id, status: "pending", question: id, options: [], created_at: 1, asked_user_ids: ["me"], ...extra });
    const decisions = {
      adv: dec("adv", { blocking: false }),
      advStacked: dec("advStacked", { blocking: false, stack_id: "st1" }),
      advOther: dec("advOther", { blocking: false, asked_user_ids: ["someone"] }),
      advTrial: dec("advTrial", { blocking: false, trial: true }),
      blocked: dec("blocked", { blocking: true }),
      answered: dec("answered", { blocking: false, status: "answered" }),
    };
    useInboxStore.setState({ sessionDecisions: decisions, currentUser: { _id: "me" } } as any);

    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => root.render(<MemoryRouter><InboxDecisionQueue collapsed={false} onToggle={() => {}} extraSessions={[]} onSelectSession={() => {}} /></MemoryRouter>));
    const link = container.querySelector<HTMLAnchorElement>("[data-decision-advisory]")!;
    expect(link.textContent).toContain("Not blocking");
    expect(link.getAttribute("href")).toBe("/decisions?blocking=advisory");

    const listed = Object.values(decisions).filter((d: any) => !d.trial);
    const view = decisionView({ blocking: "advisory" });
    const shown = listed.filter((d: any) => inTab(d, "mine", "me") && passesFilters(d, view, 0)).length;
    expect(shown).toBe(2);
    expect(filterCounts(listed as any, view, "me", 0, "blocking").get("advisory")).toBe(shown);
    expect(link.getAttribute("data-decision-advisory")).toBe(String(shown));

    await act(async () => root.unmount());
    container.remove();
  });
});
