// The Deploys page's focus chip: a link that names a session by its 32-character conversation id reads as the
// session's short id inside a session pill, never the whole id, and its × still clears the highlight. The pill runs
// for real; only the Convex transport is faked.
import { afterAll, expect, mock, test } from "bun:test";
import { act } from "react";
import { JSDOM } from "jsdom";
import { replaceGlobals } from "../../../test-helpers/globals";
import { closeDomWindow } from "../../../test-helpers/domGlobals";

const dom = new JSDOM("<!doctype html><html><body></body></html>");
const restoreGlobals = replaceGlobals({
  window: dom.window,
  document: dom.window.document,
  navigator: dom.window.navigator,
  HTMLElement: dom.window.HTMLElement,
  Element: dom.window.Element,
  Node: dom.window.Node,
  IS_REACT_ACT_ENVIRONMENT: true,
});

const convexReact = await import("convex/react");
mock.module("convex/react", () => ({
  ...convexReact,
  useQuery: () => undefined,
  useQueries: () => ({}),
  useMutation: () => async () => undefined,
}));
const noThrow = await import("../../../hooks/useQueryNoThrow");
mock.module("../../../hooks/useQueryNoThrow", () => ({ ...noThrow, useQueryNoThrow: () => ({ data: undefined }) }));
mock.module("next/link", () => ({
  default: ({ href, children, ...props }: any) => <a href={href} {...props}>{children}</a>,
}));

const { createRoot } = await import("react-dom/client");
const { MemoryRouter } = await import("react-router");
const { FocusChip, Paused } = await import("../DeploysPage");

afterAll(() => {
  closeDomWindow(dom);
  restoreGlobals();
});

const CONVERSATION_ID = "jx7b0m0k4q2v9d8h3s6n1p5r7t2w8y4z";

function mount(focus: any, onClear = () => {}) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  act(() => root.render(<MemoryRouter><FocusChip focus={focus} waiting deploys={[]} live={null} onClear={onClear} /></MemoryRouter>));
  return { host, unmount: () => act(() => root.unmount()) };
}

test("a session named by its conversation id reads as its short id, in a session pill", () => {
  let cleared = 0;
  const { host, unmount } = mount({ kind: "session", id: CONVERSATION_ID }, () => cleared++);
  const chip = host.querySelector(".dpp-focus")!;
  expect(chip.textContent).toContain("jx7b0m0");
  expect(chip.textContent).not.toContain(CONVERSATION_ID);
  expect(chip.querySelector(`a[href*="${CONVERSATION_ID}"]`)).not.toBeNull();
  act(() => (chip.querySelector("[data-deploy-focus-clear]") as HTMLButtonElement).click());
  expect(cleared).toBe(1);
  unmount();
});

test("a session already named by its short id reads the same", () => {
  const { host, unmount } = mount({ kind: "session", id: "jx7b0m0" });
  expect(host.querySelector(".dpp-focus")!.textContent).toContain("jx7b0m0");
  unmount();
});

test("a task keeps its plain word", () => {
  const { host, unmount } = mount({ kind: "task", id: "ct-98653" });
  expect(host.querySelector(".dpp-focus b")!.textContent).toBe("ct-98653");
  unmount();
});

// The repository's production pause (DP17): who, why, the rollback and the task that lift it, the migrations that rule
// a revert out, and Lift only for whoever may lift it.
function mountPaused(p: any, canLift: boolean, onLift = () => {}) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  act(() => root.render(<MemoryRouter><Paused p={p} canLift={canLift} now={p.at + 3 * 60_000} onLift={onLift} /></MemoryRouter>));
  return { host, unmount: () => act(() => root.unmount()) };
}

test("a pause by hand says who and why, lifts by them or the Release Captain, and Lift is one press for its holder", () => {
  let lifted = 0;
  const p = { repository: "acme/app", by: "Ana", reason: "errors spiking", at: 1_000_000, lifts: "", rollback: null, until: null };
  const { host, unmount } = mountPaused(p, true, () => lifted++);
  const box = host.querySelector("[data-deploy-paused]")!;
  expect(box.textContent).toContain("Paused");
  expect(box.textContent).toContain("Ana");
  expect(box.textContent).toContain("3m");
  expect(box.querySelector("[data-deploy-pause-reason]")!.textContent).toBe("errors spiking");
  expect(box.querySelector("[data-deploy-pause-lifts]")!.textContent).toBe("Ana or the Release Captain");
  expect(box.querySelector("[data-deploy-pause-migrations]")).toBeNull();
  act(() => (box.querySelector("[data-deploy-lift]") as HTMLButtonElement).click());
  expect(lifted).toBe(1);
  unmount();
  const other = mountPaused(p, false);
  expect(other.host.querySelector("[data-deploy-lift]")).toBeNull();
  other.unmount();
});

test("a rollback's pause names its deploy and task, and a fix forward shows the migrations that rule a revert out", () => {
  const p = { repository: "acme/app", by: "Ana", reason: "Rollback dp-10: checkout broken", at: 1_000_000, lifts: "", rollback: "dp-10", until: { task: "ct-5", kind: "fix_forward", migrations: ["drizzle/0007_x.sql"], commits: 2 } };
  const { host, unmount } = mountPaused(p, false);
  const box = host.querySelector("[data-deploy-paused]")!;
  expect(box.textContent).toContain("dp-10");
  expect(box.querySelector("[data-deploy-pause-lifts]")!.textContent).toContain("ct-5");
  expect(box.querySelector("[data-deploy-pause-lifts]")!.textContent).toContain("fix forward green on main");
  const warn = box.querySelector("[data-deploy-pause-migrations]")!;
  expect(warn.getAttribute("role")).toBe("alert");
  expect(warn.textContent).toContain("No revert: fix forward");
  expect(warn.textContent).toContain("drizzle/0007_x.sql");
  unmount();
});
