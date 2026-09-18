import { replaceGlobals } from "../test-helpers/globals";
import { afterAll, test, expect, mock } from "bun:test";
import { JSDOM } from "jsdom";
import React, { act } from "react";
import { createRoot } from "react-dom/client";

// Regression: MermaidDiagram fills its own <div> imperatively with
// `ref.current.innerHTML = svg`, so the rendered diagram is invisible to
// React. Its error branch used to return a bare <div> in the same position as
// the diagram branch, so React REUSED the very DOM node holding that diagram:
// the error text was appended *below a stale diagram* instead of replacing it.
// Distinct keys force a real unmount/mount, which also keeps React's own
// children and the imperative innerHTML out of the same node.

const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "https://app.test/" });
const restoreGlobals = replaceGlobals({
  window: dom.window,
  document: dom.window.document,
  navigator: dom.window.navigator,
  IS_REACT_ACT_ENVIRONMENT: true,
});
afterAll(() => {
  dom.window.close();
  restoreGlobals();
});

mock.module("mermaid", () => ({
  default: {
    initialize: () => {},
    render: async (_id: string, code: string) => {
      if (code.includes("BAD")) throw new Error("bad syntax");
      return { svg: "<svg data-diagram=\"1\"></svg>" };
    },
  },
}));

const { MermaidDiagram } = await import("./MermaidDiagram");

const flush = async () => { await act(async () => { await Promise.resolve(); await Promise.resolve(); }); };

test("switching to the error branch does not leave the rendered diagram behind", async () => {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);

  await act(async () => { root.render(<MermaidDiagram code="graph TD; A-->B" />); });
  await flush();
  expect(host.querySelector("[data-diagram]")).not.toBeNull();

  // A re-render whose code fails to parse must replace the diagram, not stack
  // the error message underneath it.
  await act(async () => { root.render(<MermaidDiagram code="BAD" />); });
  await flush();

  expect(host.textContent).toContain("Diagram error: bad syntax");
  expect(host.querySelector("[data-diagram]")).toBeNull();

  await act(async () => { root.unmount(); });
  host.remove();
});
