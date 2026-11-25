import { replaceGlobals } from "../../test-helpers/globals";
import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";

// Answering a decision in the stepper froze the page for 0.5–2 s (ct-101302):
// the answer's own click handler called the stepper's onDone, which re-anchored
// the queue, and the queue keys InboxConversation by conversation id, so the
// whole conversation pane of the old session unmounted and the next session's
// pane mounted inside the click's own synchronous commit. The press must not
// pay for that rebuild: when the click handler returns, no pane has been torn
// down or built yet, and the next decision still shows once React gets to it.

import { JSDOM } from "jsdom";
import { closeDomWindow } from "../../test-helpers/domGlobals";

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

const item = (key: string, conversationId: string) => ({
  key,
  source: "decide" as const,
  conversationId,
  question: `question ${key}`,
  options: [{ label: "yes" }, { label: "no" }],
  blocking: true,
  createdAt: 1,
});

const queue = [item("decide:a", CONV_A), item("decide:b", CONV_B)];

const realQueueModule = { ...(await import("../../hooks/useDecisionQueue")) };
mock.module("../../hooks/useDecisionQueue", () => ({ ...realQueueModule, useDecisionQueue: () => queue }));

// Every pane mount and unmount is logged. The stub's answer button does what
// SessionDecisionCard's answer() does with a plain (ungated) option: call the
// stepper's onDone inside the click.
const paneLog: string[] = [];
mock.module("../../app/inbox/QueuePageClient", () => ({
  InboxConversation: ({ sessionId }: { sessionId: string }) => {
    const stepper = React.useContext(realQueueModule.DecisionStepperContext);
    React.useLayoutEffect(() => {
      paneLog.push(`mount ${sessionId}`);
      return () => { paneLog.push(`unmount ${sessionId}`); };
    }, []);
    return (
      <div data-conv={sessionId} data-stepper-item={stepper?.item?.key}>
        <button data-answer onClick={() => stepper?.onDone()}>yes</button>
      </div>
    );
  },
}));

const React = await import("react");
const { DecisionQueue } = await import("../DecisionQueue");
const { createRoot } = await import("react-dom/client");
const act: <T>(cb: () => T | Promise<T>) => Promise<T> = (React as any).act;

describe("answering in the stepper does not rebuild the conversation pane inside the click", () => {
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

  test("the click returns before any pane unmounts or mounts, and the next decision follows", async () => {
    await act(async () => root.render(<DecisionQueue initialKey="decide:a" />));
    expect(container.querySelector("[data-conv]")?.getAttribute("data-conv")).toBe(CONV_A);
    paneLog.length = 0;

    // A real press: a native click dispatched outside act, so React handles it
    // as a discrete event exactly as the browser would.
    const button = container.querySelector<HTMLButtonElement>("[data-answer]")!;
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = false;
    button.dispatchEvent(new window.MouseEvent("click", { bubbles: true, cancelable: true }));
    // React flushes a discrete event's sync-lane work in a microtask, still in
    // the click's task and before the browser can paint. Drain the microtask
    // queue (no new task) and read what the press itself cost.
    for (let i = 0; i < 20; i++) await Promise.resolve();
    const duringClick = [...paneLog];
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

    // The press's own task: no pane torn down or built.
    expect(duringClick).toEqual([]);

    // Afterwards the stepper has moved on to the next session's decision.
    await act(async () => { await new Promise((r) => setTimeout(r, 50)); });
    expect(container.querySelector("[data-conv]")?.getAttribute("data-stepper-item")).toBe("decide:b");
    expect(container.querySelector("[data-conv]")?.getAttribute("data-conv")).toBe(CONV_B);
  });
});
