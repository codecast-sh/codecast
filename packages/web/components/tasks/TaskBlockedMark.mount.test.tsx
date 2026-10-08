import { afterAll, expect, test } from "bun:test";
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
const { createRoot } = await import("react-dom/client");
const { useInboxStore } = await import("../../store/inboxStore");
const { TaskBlockedMark } = await import("./TaskBlockedMark");

const before = useInboxStore.getState().tasks;
afterAll(() => {
  useInboxStore.setState({ tasks: before } as any);
  closeDomWindow(dom);
  restoreGlobals();
});

const blocker = (status: string) => ({ _id: "b1", short_id: "ct-7", title: "Blocker", status });
const task = {
  status: "open",
  blocked_by: ["ct-7"],
  waits: [{ id: "w1", kind: "pr_merged", repository: "o/r", pr_number: 42, state: "waiting", created_at: 0 }],
} as any;

test("names what holds the row, and clears when the blocker closes", async () => {
  useInboxStore.setState({ tasks: { b1: blocker("in_progress") } } as any);
  const container = document.createElement("div");
  const root = createRoot(container);
  await act(async () => { root.render(<TaskBlockedMark task={task} />); });

  const mark = container.querySelector("[role=img]")!;
  expect(mark.getAttribute("title")).toBe("Blocked by ct-7, PR #42 merges");
  expect(mark.textContent).toBe("2");
  expect(mark.className).toContain("text-sol-orange");

  // The blocker closing elsewhere repaints the row: only the wait is left.
  await act(async () => { useInboxStore.setState({ tasks: { b1: blocker("done") } } as any); });
  expect(container.querySelector("[role=img]")!.getAttribute("title")).toBe("Blocked by PR #42 merges");
  expect(container.querySelector("[role=img]")!.textContent).toBe("");

  root.unmount();
});

test("a failed wait draws red; nothing holding the task draws nothing", async () => {
  useInboxStore.setState({ tasks: {} } as any);
  const container = document.createElement("div");
  const root = createRoot(container);
  const failed = { ...task, blocked_by: [], waits: [{ ...task.waits[0], state: "failed", note: "closed without merging" }] };
  await act(async () => { root.render(<TaskBlockedMark task={failed} />); });
  expect(container.querySelector("[role=img]")!.className).toContain("text-sol-red");

  await act(async () => { root.render(<TaskBlockedMark task={{ status: "open", blocked_by: ["ct-7"] }} />); });
  expect(container.innerHTML).toBe("");
  root.unmount();
});
