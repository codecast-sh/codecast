import { replaceGlobals } from "../../test-helpers/globals";
import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";

// The rail's QUESTIONS card stayed unlit while its question filled the stage.
// Off the inbox the rail highlights `sidePanelSessionId` (sessionFocusKind →
// "panel"), and nothing wrote it on /questions, so the card the user had just
// clicked read as unselected — and a stale pointer could even light a
// different card. The queue now publishes the conversation it is showing, so
// the highlight tracks the question on screen, entry item and every advance.

import { JSDOM } from "jsdom";

import { closeDomWindow } from "../../test-helpers/domGlobals";
const dom = new JSDOM("<!doctype html><html><body></body></html>", {
  url: "https://app.test/questions",
  pretendToBeVisual: true,
});
const restoreGlobals = replaceGlobals({
  window: dom.window,
  document: dom.window.document,
  navigator: dom.window.navigator,
  location: dom.window.location,
  // Prism (reached through the priority card's option rows and their markdown) polyfills Element.prototype at import.
  Element: dom.window.Element,
  HTMLElement: dom.window.HTMLElement,
  IS_REACT_ACT_ENVIRONMENT: true,
});
afterAll(() => {
  closeDomWindow(dom);
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

let queue: Array<ReturnType<typeof item> & { decisionId?: string; shortId?: string }> = [item("a", CONV_A), item("b", CONV_B)];
let lastStepper: any = null;

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
// It reports the item the stepper hands it, the one the thread's card shows.
// The answered-decision view is a whole document page (markdown, prism); this test never opens it.
mock.module("../decisions/DecisionDocument", () => ({
  DecisionDocument: ({ id, nav }: { id: string; nav?: any }) => <div data-decision-doc={id}>{nav}</div>,
}));
mock.module("../../app/inbox/QueuePageClient", () => ({
  InboxConversation: ({ sessionId }: { sessionId: string }) => {
    const stepper = React.useContext(realQueueModule.DecisionStepperContext);
    lastStepper = stepper;
    return <div data-conv={sessionId} data-stepper-item={stepper?.item?.key} />;
  },
}));

const React = await import("react");
const { DecisionQueue } = await import("../DecisionQueue");
const { useInboxStore } = await import("../../store/inboxStore");
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

// A rail row under a session's group links to /decisions?s=<conv>&d=<key>.
// The thread's card shows the stepper's item when it is one of the thread's
// asks, so the stepper must hand it the `cast decide` ask the row named, not
// only a poll or permission item; otherwise every row of one session showed
// that session's first ask.
describe("a rail row picks the ask the thread's card shows", () => {
  test("entering on the third ask of a session hands that ask to the card", async () => {
    queue = [item("decide:1", CONV_A), item("decide:5", CONV_A), item("decide:19", CONV_A)];
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    const shown = () => container.querySelector("[data-conv]")?.getAttribute("data-stepper-item");
    await act(async () => root.render(<DecisionQueue key="19" initialConversationId={CONV_A} initialKey="decide:19" />));
    expect(shown()).toBe("decide:19");
    await act(async () => root.render(<DecisionQueue key="5" initialConversationId={CONV_A} initialKey="decide:5" />));
    expect(shown()).toBe("decide:5");
    await act(async () => root.unmount());
    container.remove();
  });
});

// Back from the stepper reaches the decisions answered in this visit: each
// opens whole on its own page, where its answer can be changed, and forward
// past the newest returns to the open queue.
describe("Back reaches what was answered in this visit", () => {
  test("answer one, go back to it, come forward to the queue", async () => {
    const one = { ...item("decide:1", CONV_A), decisionId: "d1", shortId: "sd-1" };
    const two = { ...item("decide:2", CONV_B), decisionId: "d2", shortId: "sd-2" };
    queue = [one, two];
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    const doc = () => container.querySelector("[data-decision-doc]")?.getAttribute("data-decision-doc");
    const conv = () => container.querySelector("[data-conv]")?.getAttribute("data-conv");
    await act(async () => root.render(<DecisionQueue />));
    expect(conv()).toBe(CONV_A);

    // Answered: it leaves the queue, and the stepper moves on to the next.
    await act(async () => lastStepper.onDone());
    queue = [two];
    await act(async () => root.render(<DecisionQueue />));
    expect(conv()).toBe(CONV_B);
    expect(lastStepper.onPrev).toBeDefined();

    await act(async () => lastStepper.onPrev());
    expect(doc()).toBe("sd-1");
    expect(container.querySelector("[data-decision-queue-back]")?.getAttribute("data-decision-queue-back")).toBe("1/1");

    await act(async () => { window.dispatchEvent(new window.KeyboardEvent("keydown", { key: "ArrowRight" })); });
    expect(doc()).toBeUndefined();
    expect(conv()).toBe(CONV_B);

    // The queue emptied: the answered ones are still one key away.
    await act(async () => lastStepper.onDone());
    queue = [];
    await act(async () => root.render(<DecisionQueue />));
    expect(container.querySelector("[data-decision-queue-review]")).not.toBeNull();
    await act(async () => { window.dispatchEvent(new window.KeyboardEvent("keydown", { key: "ArrowLeft" })); });
    expect(doc()).toBe("sd-2");

    await act(async () => root.unmount());
    container.remove();
  });
});
