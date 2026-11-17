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
  Element: dom.window.Element,
  Node: dom.window.Node,
  IS_REACT_ACT_ENVIRONMENT: true,
});

// The ghost's one control: a Tab cap that puts the reply in the box.
const real = await import("../../hooks/useComposerSuggestion");
mock.module("../../hooks/useComposerSuggestion", () => ({
  ...real,
  useComposerSuggestion: () => ({
    text: "add the regression test first",
    accept: () => "add the regression test first",
    settleSend: () => {},
  }),
}));
const { createRoot } = await import("react-dom/client");
const { ComposerSuggestion } = await import("../ComposerSuggestion");

afterAll(() => {
  closeDomWindow(dom);
  restoreGlobals();
});

test("the ghost shows its one reply and only the Tab cap", async () => {
  const taken: string[] = [];
  const container = document.createElement("div");
  const root = createRoot(container);
  await act(async () => {
    root.render(<ComposerSuggestion conversationId="c1" idle hidden={false} onAccept={(t) => taken.push(t)} />);
  });
  expect(container.querySelector("[data-composer-ghost]")!.textContent).toContain("add the regression test first");
  const buttons = container.querySelectorAll("button");
  expect(buttons.length).toBe(1);
  expect(buttons[0]!.textContent).toBe("Tab");
  await act(async () => { (buttons[0] as HTMLButtonElement).click(); });
  expect(taken).toEqual(["add the regression test first"]);
  await act(async () => root.unmount());
});
