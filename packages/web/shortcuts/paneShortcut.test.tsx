import { afterAll, expect, test } from "bun:test";
import { JSDOM } from "jsdom";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { TabParamsCtx } from "../lib/tabParams";
import { ShortcutProvider, useShortcuts, usePaneShortcutAction } from "./ShortcutProvider";

import { closeDomWindow } from "../test-helpers/domGlobals";
const dom = new JSDOM("<!doctype html><div id='root'></div>");
const globals = Object.fromEntries(["window", "document", "IS_REACT_ACT_ENVIRONMENT"].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
Object.assign(globalThis, { window: dom.window, document: dom.window.document, IS_REACT_ACT_ENVIRONMENT: true });

afterAll(() => {
  closeDomWindow(dom);
  for (const [key, descriptor] of Object.entries(globals)) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
});

function scope(tabId: string, isActive: boolean) {
  return { tabId, pathname: `/conversation/${tabId}`, searchParams: new URLSearchParams(), params: {}, isActive };
}

// A visited tab stays mounted hidden, so its conversation registers the same
// shortcut as the one on screen. Cmd+Shift+L toasted once per mounted copy.
test("a pane shortcut answers only in the active pane", async () => {
  const calls: string[] = [];
  let dispatch!: ReturnType<typeof useShortcuts>["dispatchAction"];
  function Conversation({ id }: { id: string }) {
    usePaneShortcutAction("conv.copyLink", () => { calls.push(id); });
    return null;
  }
  function Probe() {
    dispatch = useShortcuts().dispatchAction;
    return null;
  }
  const root = createRoot(document.getElementById("root")!);
  const render = (active: "a" | "b") => root.render(
    <ShortcutProvider>
      <Probe />
      <TabParamsCtx.Provider value={scope("a", active === "a")}><Conversation id="a" /></TabParamsCtx.Provider>
      <TabParamsCtx.Provider value={scope("b", active === "b")}><Conversation id="b" /></TabParamsCtx.Provider>
    </ShortcutProvider>,
  );

  await act(async () => { render("b"); });
  expect(dispatch("conv.copyLink")).toBe(true);
  expect(calls).toEqual(["b"]);

  await act(async () => { render("a"); });
  expect(dispatch("conv.copyLink")).toBe(true);
  expect(calls).toEqual(["b", "a"]);

  await act(async () => { root.unmount(); });
});
