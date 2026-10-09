import { afterAll, expect, mock, test } from "bun:test";
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
// The mark's clock, driven by the test: the only words on it that move with
// time are a time wait's moment and the suffix that marks it overdue, and the
// component has to read them off the shared coarse clock rather than off the
// wall, or a board left open freezes at the moment it painted.
let now = Date.UTC(2026, 0, 5, 12, 0);
const realClock = { ...(await import("../../hooks/useCoarseNow")) };
mock.module("../../hooks/useCoarseNow", () => ({ ...realClock, useCoarseNow: () => now }));

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
  expect(mark.getAttribute("title")).toBe("Waiting on ct-7 Blocker · Waiting on PR #42");
  expect(mark.textContent).toBe("2");
  expect(mark.className).toContain("text-sol-orange");

  // The blocker closing elsewhere repaints the row: only the wait is left.
  await act(async () => { useInboxStore.setState({ tasks: { b1: blocker("done") } } as any); });
  expect(container.querySelector("[role=img]")!.getAttribute("title")).toBe("Waiting on PR #42");
  expect(container.querySelector("[role=img]")!.textContent).toBe("");

  root.unmount();
});

test("a failed wait draws a red no-entry sign, not urgent priority's triangle; nothing holding the task, or a closed task, draws nothing", async () => {
  useInboxStore.setState({ tasks: {} } as any);
  const container = document.createElement("div");
  const root = createRoot(container);
  const failed = { ...task, blocked_by: [], waits: [{ ...task.waits[0], state: "failed", note: "closed without merging" }] };
  await act(async () => { root.render(<TaskBlockedMark task={failed} />); });
  const warn = container.querySelector("[role=img]")!;
  expect(warn.className).toContain("text-sol-red");
  expect(warn.querySelector("svg")!.getAttribute("class")).toContain("lucide-ban");
  expect(warn.querySelector("svg")!.getAttribute("class")).not.toContain("triangle");

  // The store lacks ct-7, but the row's snapshot saw it finished.
  await act(async () => { root.render(<TaskBlockedMark task={{ status: "open", blocked_by: ["ct-7"], graph_status: [{ ref: "ct-7", short_id: "ct-7", status: "done" }] }} />); });
  expect(container.innerHTML).toBe("");

  // Nothing answers for ct-7: it holds the row as unknown.
  await act(async () => { root.render(<TaskBlockedMark task={{ status: "open", blocked_by: ["ct-7"] }} />); });
  expect(container.querySelector("[role=img]")!.getAttribute("title")).toBe("Waiting on ct-7 (status unknown)");

  // A done task that still lists an open wait is held by nothing.
  await act(async () => { root.render(<TaskBlockedMark task={{ ...task, status: "done" }} />); });
  expect(container.innerHTML).toBe("");
  root.unmount();
});

test("a time wait whose moment goes by while the board is open marks itself overdue", async () => {
  useInboxStore.setState({ tasks: {} } as any);
  const DAY = 24 * 3_600_000;
  // Three days past the mark's clock: the whole tooltip is the mark's title
  // and accessible name and carries no state glyph, so the phrase itself has
  // to say the settle never came (`blockerWaitingLabel`).
  const late = { status: "open", waits: [{ id: "w9", kind: "time", at: now - 3 * DAY, state: "waiting", created_at: 0 }] } as any;
  const container = document.createElement("div");
  const root = createRoot(container);
  await act(async () => { root.render(<TaskBlockedMark task={late} />); });
  const tip = () => container.querySelector("[role=img]")!.getAttribute("title")!;
  expect(tip()).toStartWith("Waiting until ");
  expect(tip()).toEndWith(" (overdue by 3d)");

  // Two days on, the same row and the same store: nothing in the mark's wake
  // signature moved (it carries ids, states and titles only), so the clock is
  // the one thing that can keep this phrase true.
  now += 2 * DAY;
  await act(async () => { root.render(<TaskBlockedMark task={late} />); });
  expect(tip()).toEndWith(" (overdue by 5d)");
  root.unmount();
});
