import { replaceGlobals } from "../../test-helpers/globals";
import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";

// The rail's QUESTIONS card stayed unlit while its question filled the stage.
// Off the inbox the rail highlights `sidePanelSessionId` (sessionFocusKind →
// "panel"), and nothing wrote it on /questions, so the card the user had just
// clicked read as unselected — and a stale pointer could even light a
// different card. The queue now publishes the conversation it is showing, so
// the highlight tracks the question on screen, entry item and every advance.

import { JSDOM } from "jsdom";

const dom = new JSDOM("<!doctype html><html><body></body></html>", {
  url: "https://app.test/questions",
  pretendToBeVisual: true,
});
const restoreGlobals = replaceGlobals({
  window: dom.window,
  document: dom.window.document,
  navigator: dom.window.navigator,
  location: dom.window.location,
  IS_REACT_ACT_ENVIRONMENT: true,
});
afterAll(() => {
  dom.window.close();
  restoreGlobals();
});



// posthog-js reads bare `location` at module load; the analytics import rides
// in with the store.



const CONV_A = "convaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const CONV_B = "convbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

const item = (key: string, conversationId: string) => ({
  key,
  source: "decide" as const,
  conversationId,
  question: `question ${key}`,
  options: [{ label: "yes" }, { label: "no" }],
  blocking: true,
  createdAt: 1,
});

let queue = [item("a", CONV_A), item("b", CONV_B)];

// Only the hook is answered differently; DecisionStepperContext and the rest
// of the module stay real, so anything importing it later is unaffected.
const realQueueModule = { ...(await import("../../hooks/useDecisionQueue")) };
mock.module("../../hooks/useDecisionQueue", () => ({
  ...realQueueModule,
  useDecisionQueue: () => queue,
}));

// The conversation pane is the whole inbox stage; the queue's job here is the
// pointer it publishes, not what the pane paints. Stubbed rather than spread:
// importing the real module to keep its other exports would drag the entire
// conversation tree (and its Convex hooks) into the process for nothing. No
// other test imports it — the one that names it reads it as source text.
mock.module("../../app/inbox/QueuePageClient", () => ({
  InboxConversation: ({ sessionId }: { sessionId: string }) => (
    <div data-conv={sessionId} />
  ),
}));

const { DecisionQueue } = await import("../DecisionQueue");
const { useInboxStore } = await import("../../store/inboxStore");
const React = await import("react");
const { createRoot } = await import("react-dom/client");

const act: <T>(cb: () => T | Promise<T>) => Promise<T> = (React as any).act;
const railFocus = () => useInboxStore.getState().sidePanelSessionId;

describe("the queue lights the rail card it is showing", () => {
  let container: HTMLElement;
  let root: ReturnType<typeof createRoot>;

  afterAll(async () => {
    await act(async () => root.unmount());
    container.remove();
  });

  beforeAll(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    useInboxStore.setState({ sidePanelSessionId: null } as any);
  });

  test("the entry question owns the highlight", async () => {
    await act(async () => root.render(<DecisionQueue initialConversationId={CONV_B} />));
    expect(railFocus()).toBe(CONV_B);
  });

  test("advancing past it moves the highlight to the next question", async () => {
    // The entry item is answered and leaves the queue.
    queue = [item("b", CONV_B), item("c", CONV_A)];
    await act(async () => root.render(<DecisionQueue />));
    expect(railFocus()).toBe(CONV_B);

    queue = [item("c", CONV_A)];
    await act(async () => root.render(<DecisionQueue />));
    expect(railFocus()).toBe(CONV_A);
  });

  test("an emptied queue leaves the last answered question lit, not a stale one", async () => {
    queue = [];
    await act(async () => root.render(<DecisionQueue />));
    expect(railFocus()).toBe(CONV_A);
  });
});
