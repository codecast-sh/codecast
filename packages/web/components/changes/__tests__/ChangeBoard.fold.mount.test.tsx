// The change grid's folded groups (Closed, Parked): folded until the viewer presses the head, which opens and folds them.
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

mock.module("next/link", () => ({
  default: ({ href, children, ...props }: any) => <a href={href} {...props}>{children}</a>,
}));

const { createRoot } = await import("react-dom/client");
const { ChangeBoard } = await import("../ChangeBoard");
const { changeExamples } = await import("../../../lib/changes/examples");
const { changeLifecycle } = await import("../../../lib/changes/lifecycle");

afterAll(() => {
  closeDomWindow(dom);
  restoreGlobals();
});

const NOW = 1_790_000_000_000;
const closed = changeExamples(NOW).find((e) => e.id === "closed")!;
const row = { key: "pr:42", lifecycle: changeLifecycle(closed.facts), updated_at: NOW - 60_000 };

function mount() {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  act(() => root.render(<ChangeBoard rows={[row]} at={NOW} />));
  const group = () => host.querySelector('[data-change-group="closed"]')!;
  return { host, group, unmount: () => act(() => root.unmount()) };
}

test("a folded group stays folded until pressed", () => {
  const { group, unmount } = mount();
  expect(group().hasAttribute("data-folded")).toBe(true);
  expect(group().querySelector("[data-change-row]")).toBeNull();
  unmount();
});

test("the viewer's press opens the group, and a second press folds it again", () => {
  const { group, unmount } = mount();
  act(() => (group().querySelector("[data-change-fold]") as HTMLButtonElement).click());
  expect(group().hasAttribute("data-folded")).toBe(false);
  expect(group().querySelector('[data-change-row="pr:42"]')).not.toBeNull();
  act(() => (group().querySelector("[data-change-fold]") as HTMLButtonElement).click());
  expect(group().hasAttribute("data-folded")).toBe(true);
  expect(group().querySelector("[data-change-row]")).toBeNull();
  unmount();
});
