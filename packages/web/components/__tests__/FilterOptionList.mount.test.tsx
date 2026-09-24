import { afterAll, expect, test } from "bun:test";
import { act } from "react";
import { JSDOM } from "jsdom";
import { replaceGlobals } from "../../test-helpers/globals";
import { closeDomWindow } from "../../test-helpers/domGlobals";
import { FilterOptionList } from "../FilterDropdown";

const dom = new JSDOM("<!doctype html><html><body></body></html>");
const restoreGlobals = replaceGlobals({
  window: dom.window,
  document: dom.window.document,
  navigator: dom.window.navigator,
  HTMLElement: dom.window.HTMLElement,
  IS_REACT_ACT_ENVIRONMENT: true,
});
const { createRoot } = await import("react-dom/client");

afterAll(() => {
  closeDomWindow(dom);
  restoreGlobals();
});

const options = [{ key: "", label: "Any" }, ...["alpha", "beta", "gamma", "delta"].map((l) => ({ key: l, label: l }))];
const rowLabels = (el: HTMLElement) => [...el.querySelectorAll("button")].map((b) => b.textContent);

test("picked values sit under Any, including ones the source does not list", async () => {
  const container = document.createElement("div");
  const root = createRoot(container);
  await act(async () => {
    root.render(<FilterOptionList options={options} value="gamma,gone" multi onChange={() => {}} />);
  });
  expect(rowLabels(container)).toEqual(["Any", "gamma", "gone", "alpha", "beta", "delta"]);
  root.unmount();
});

test("a pick made while the menu is open does not reorder the rows", async () => {
  const container = document.createElement("div");
  const root = createRoot(container);
  await act(async () => {
    root.render(<FilterOptionList options={options} value="" multi onChange={() => {}} />);
  });
  await act(async () => {
    root.render(<FilterOptionList options={options} value="delta" multi onChange={() => {}} />);
  });
  expect(rowLabels(container)).toEqual(["Any", "alpha", "beta", "gamma", "delta"]);
  root.unmount();
});
