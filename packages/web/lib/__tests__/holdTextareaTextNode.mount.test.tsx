import { afterAll, expect, test } from "bun:test";
import { act, useState } from "react";
import { JSDOM } from "jsdom";
import { replaceGlobals } from "../../test-helpers/globals";
import { closeDomWindow } from "../../test-helpers/domGlobals";

// Every controlled textarea, once holdTextareaTextNodes is installed (at boot,
// src/main.tsx): a change of value reaches
// the box without touching the DOM tree, and every value React sets, typed or
// from props, is still what the box shows.
const dom = new JSDOM("<!doctype html><html><body></body></html>");
const restoreGlobals = replaceGlobals({
  window: dom.window,
  document: dom.window.document,
  navigator: dom.window.navigator,
  HTMLElement: dom.window.HTMLElement,
  IS_REACT_ACT_ENVIRONMENT: true,
});
const { createRoot } = await import("react-dom/client");
const { holdTextareaTextNodes } = await import("../holdTextareaTextNode");
holdTextareaTextNodes(dom.window as any);

afterAll(() => {
  closeDomWindow(dom);
  restoreGlobals();
});

test("a controlled textarea shows every value without changing the DOM tree", async () => {
  let setText: (t: string) => void = () => {};
  function Box() {
    const [text, set] = useState("restored draft");
    setText = set;
    return <textarea value={text} onChange={(e) => set(e.target.value)} />;
  }
  const container = dom.window.document.createElement("div");
  dom.window.document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => root.render(<Box />));
  const ta = container.querySelector("textarea")!;
  expect(ta.value).toBe("restored draft");

  const records: string[] = [];
  const mo = new dom.window.MutationObserver((rs) => { for (const r of rs) records.push(r.type); });
  mo.observe(container, { subtree: true, childList: true, characterData: true, attributes: true });
  const setValue = Object.getOwnPropertyDescriptor(dom.window.HTMLTextAreaElement.prototype, "value")!.set!;
  for (const next of ["restored draft!", "restored draft!!"]) {
    setValue.call(ta, next);
    await act(async () => { ta.dispatchEvent(new dom.window.Event("input", { bubbles: true })); });
    expect(ta.value).toBe(next);
  }
  await act(async () => setText(""));
  expect(ta.value).toBe("");
  await act(async () => setText("populated from a prop"));
  expect(ta.value).toBe("populated from a prop");
  records.push(...mo.takeRecords().map((r) => r.type));
  mo.disconnect();
  expect(records).toEqual([]);
  await act(async () => root.unmount());
});

test("the app entry installs the hold before anything mounts", async () => {
  const src = await Bun.file(new URL("../../src/main.tsx", import.meta.url)).text();
  expect(src.indexOf("holdTextareaTextNodes();")).toBeGreaterThan(-1);
  expect(src.indexOf("holdTextareaTextNodes();")).toBeLessThan(src.indexOf("bootAfterHandoffGate("));
});

test("an uncontrolled box still takes a new default", async () => {
  const ta = dom.window.document.createElement("textarea");
  ta.defaultValue = "first";
  expect(ta.value).toBe("first");
  ta.defaultValue = "second";
  expect(ta.value).toBe("second");
  expect(ta.textContent).toBe("second");
});
