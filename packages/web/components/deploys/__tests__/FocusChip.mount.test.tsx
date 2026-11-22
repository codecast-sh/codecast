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
const { FocusChip } = await import("../DeploysPage");

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
