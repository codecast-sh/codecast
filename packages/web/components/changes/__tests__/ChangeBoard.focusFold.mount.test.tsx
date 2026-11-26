// The change grid's folded groups (Closed, Parked): one holding the row a link points at opens on its own, the same
// group with nothing focused stays folded, and the viewer's press on its head still folds it while it holds the focus.
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
const row = { key: "pr:42", lifecycle: changeLifecycle(closed.facts), updated_at: NOW - 60_000, refs: { branch: null, pr: 42, shas: [] } };

function mount(focused?: (r: any) => boolean) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  act(() => root.render(<ChangeBoard rows={[row]} at={NOW} focused={focused} />));
  const group = () => host.querySelector('[data-change-group="closed"]')!;
  return { host, group, unmount: () => act(() => root.unmount()) };
}

test("a folded group stays folded with nothing focused", () => {
  const { group, unmount } = mount();
  expect(group().hasAttribute("data-folded")).toBe(true);
  expect(group().querySelector("[data-change-row]")).toBeNull();
  unmount();
});

test("a folded group that holds the focused row opens on its own, the row highlighted", () => {
  const { group, unmount } = mount((r) => r.key === "pr:42");
  expect(group().hasAttribute("data-folded")).toBe(false);
  expect(group().querySelector('[data-change-row="pr:42"]')!.hasAttribute("data-focus")).toBe(true);
  expect(group().querySelector("[data-change-fold]")!.getAttribute("aria-expanded")).toBe("true");
  unmount();
});

test("a focused row that is elsewhere leaves the group folded", () => {
  const { group, unmount } = mount((r) => r.key === "pr:7");
  expect(group().hasAttribute("data-folded")).toBe(true);
  unmount();
});

test("the viewer's press folds the group while it holds the focus, and a second press opens it again", () => {
  const { group, unmount } = mount((r) => r.key === "pr:42");
  act(() => (group().querySelector("[data-change-fold]") as HTMLButtonElement).click());
  expect(group().hasAttribute("data-folded")).toBe(true);
  expect(group().querySelector("[data-change-row]")).toBeNull();
  act(() => (group().querySelector("[data-change-fold]") as HTMLButtonElement).click());
  expect(group().hasAttribute("data-folded")).toBe(false);
  expect(group().querySelector('[data-change-row="pr:42"]')).not.toBeNull();
  unmount();
});
