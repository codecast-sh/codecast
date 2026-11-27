import { replaceGlobals } from "../../../test-helpers/globals";
import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";

// A priority card belongs to its person alone and is acted on only through the
// card (isPriorityCard): the "one at a time" stepper draws the card itself,
// never the session it sits in, and the inbox panel lists it by its short form,
// under no session's name.

import { JSDOM } from "jsdom";
import { closeDomWindow } from "../../../test-helpers/domGlobals";
import { priorityCardFixture as card } from "../__fixtures__/priorityCard.fixture";

const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "https://app.test/decisions", pretendToBeVisual: true });
const restoreGlobals = replaceGlobals({
  window: dom.window,
  document: dom.window.document,
  navigator: dom.window.navigator,
  location: dom.window.location,
  Element: dom.window.Element,
  HTMLElement: dom.window.HTMLElement,
  Node: dom.window.Node,
  KeyboardEvent: dom.window.KeyboardEvent,
  Event: dom.window.Event,
  getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
  requestAnimationFrame: (cb: FrameRequestCallback) => setTimeout(() => cb(0), 0) as unknown as number,
  cancelAnimationFrame: (id: number) => clearTimeout(id),
  IS_REACT_ACT_ENVIRONMENT: true,
});
afterAll(() => {
  closeDomWindow(dom);
  restoreGlobals();
});

const CONV_A = "convaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const CONV_B = "convbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const CARD_ID = "d-pcc-queue";

const item = (key: string, conversationId: string, sessionTitle: string, decisionId?: string) => ({
  key,
  source: "decide" as const,
  conversationId,
  sessionTitle,
  question: `question ${key}`,
  options: [{ label: "yes" }, { label: "no" }],
  blocking: true,
  createdAt: 1,
  decisionId,
});

// The card sits in Alpha's session; Beta asks a question of its own.
const queue = [item("card", CONV_A, "Alpha", CARD_ID), item("b1", CONV_B, "Beta")];

const realQueueModule = { ...(await import("../../../hooks/useDecisionQueue")) };
mock.module("../../../hooks/useDecisionQueue", () => ({ ...realQueueModule, useDecisionQueue: () => queue }));
mock.module("../../../app/inbox/QueuePageClient", () => ({
  InboxConversation: ({ sessionId }: { sessionId: string }) => <div data-conv={sessionId} />,
}));

const { useInboxStore } = await import("../../../store/inboxStore");
const { DecisionQueue } = await import("../../DecisionQueue");
const { InboxDecisionQueue } = await import("../InboxDecisionQueue");
const React = await import("react");
const { createRoot } = await import("react-dom/client");
const { MemoryRouter } = await import("react-router");
const act: <T>(cb: () => T | Promise<T>) => Promise<T> = (React as any).act;

useInboxStore.setState((s: any) => ({
  sessionDecisions: {
    ...s.sessionDecisions,
    [CARD_ID]: {
      _id: CARD_ID, conversation_id: CONV_A, session_id: "s-a", question: "Should your priorities follow what you worked on today?",
      options: card.changes.map((c) => ({ label: c.id })), kind: "multi", silent: true, blocking: true, status: "pending", created_at: 1, priority_card: card,
    },
  },
}));

describe("a priority card in the queue", () => {
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

  test("the inbox panel lists it by its short form, under no session", async () => {
    await act(async () => root.render(<MemoryRouter><InboxDecisionQueue collapsed={false} onToggle={() => {}} extraSessions={[]} onSelectSession={() => {}} /></MemoryRouter>));
    const row = container.querySelector<HTMLElement>("[data-decision-queue-priority-card] [data-decision-queue-row]")!;
    expect(row.textContent).toContain(`${card.changes.length} changes to your priorities`);
    expect(row.textContent).not.toContain("question card");
    expect(row.closest("[data-session-id]")).toBeNull();
    // The session it sits in is not named; the other session's ask still sits under its own.
    expect(container.textContent).not.toContain("Alpha");
    expect(container.textContent).toContain("Beta");
  }, 30_000);

  test("the stepper draws the card itself, not the session it sits in, and answering it steps on", async () => {
    await act(async () => root.render(<MemoryRouter><DecisionQueue initialKey="card" /></MemoryRouter>));
    expect(container.querySelector("[data-decision-queue-card]")).not.toBeNull();
    expect(container.querySelector("[data-priority-card]")).not.toBeNull();
    expect(container.querySelector(`[data-conv="${CONV_A}"]`)).toBeNull();
    expect(container.querySelector("[data-decision-queue-step]")!.getAttribute("data-decision-queue-step")).toBe("1/2");
    // Accept none: the card is answered through the store, and the stepper moves to the next decision.
    await act(async () => { container.querySelector<HTMLElement>('[data-option="1"]')!.click(); });
    expect(useInboxStore.getState().sessionDecisions[CARD_ID].status).toBe("dismissed");
    expect(container.querySelector(`[data-conv="${CONV_B}"]`)).not.toBeNull();
  });
});
