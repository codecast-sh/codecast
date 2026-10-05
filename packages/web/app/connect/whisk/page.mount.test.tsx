// /connect/whisk: Whisk's return is read once, never left in the address
// bar, and survives a sign-in (the desktop app opens the connect in a system
// browser that may not be signed in), then finishes exactly once.
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { JSDOM } from "jsdom";
import * as React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { BrowserRouter, Route, Routes, useLocation } from "react-router";

const dom = new JSDOM("<!doctype html><html><body><div id='root'></div></body></html>", { url: "https://codecast.test", pretendToBeVisual: true });
for (const key of ["window", "document", "navigator", "HTMLElement", "Element", "Node", "MutationObserver", "Event", "sessionStorage", "localStorage"]) {
  Object.defineProperty(globalThis, key, { value: (dom.window as any)[key], configurable: true, writable: true });
}
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let auth = { isAuthenticated: false, isLoading: false };
let calls: unknown[] = [];
const finish = async (args: unknown) => {
  calls.push(args);
  return { ok: true, return_to: "/simple/connections" };
};
const convex = await import("convex/react");
mock.module("convex/react", () => ({ ...convex, useConvexAuth: () => auth, useAction: () => finish }));
const { default: WhiskReturn, WHISK_SIGN_IN_URL } = await import("./page");

let root: Root;
const flush = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });
function Where() {
  const loc = useLocation();
  return <p data-where>{loc.pathname + loc.search}</p>;
}
const render = () => act(async () => root.render(<React.StrictMode><BrowserRouter><Routes>
  <Route path="/connect/whisk" element={<WhiskReturn />} />
  <Route path="*" element={<Where />} />
</Routes></BrowserRouter></React.StrictMode>));
const here = () => window.location.pathname + window.location.search;

beforeEach(() => {
  document.body.innerHTML = "<div id='root'></div>";
  root = createRoot(document.getElementById("root")!);
  auth = { isAuthenticated: false, isLoading: false };
  calls = [];
});
afterEach(async () => {
  await act(async () => root.unmount());
  sessionStorage.clear();
});

describe("/connect/whisk", () => {
  test("a signed-in return finishes once under StrictMode and lands on the lane page", async () => {
    auth = { isAuthenticated: true, isLoading: false };
    window.history.replaceState(null, "", "/connect/whisk?whisk_code=one-time&state=signed");
    await render();
    await flush();
    expect(calls).toEqual([{ code: "one-time", state: "signed", error: undefined }]);
    expect(here()).toBe("/simple/connections?whisk=connected");
    expect(sessionStorage.length).toBe(0);
  });

  test("a signed-out return is held, sends the person to sign in, and finishes when sign-in comes back", async () => {
    window.history.replaceState(null, "", "/connect/whisk?whisk_code=one-time&state=signed");
    await render();
    await flush();
    expect(calls).toEqual([]);
    expect(here()).toBe(WHISK_SIGN_IN_URL);
    // The code never stays in an address bar.
    expect(window.location.href).not.toContain("one-time");

    // Sign-in returns here with none of Whisk's keys.
    await act(async () => root.unmount());
    root = createRoot(document.getElementById("root")!);
    auth = { isAuthenticated: true, isLoading: false };
    window.history.replaceState(null, "", "/connect/whisk");
    await render();
    await flush();
    expect(calls).toEqual([{ code: "one-time", state: "signed", error: undefined }]);
    expect(here()).toBe("/simple/connections?whisk=connected");
    expect(sessionStorage.length).toBe(0);
  });

  test("a visit with nothing to finish says so on Connections and calls nothing", async () => {
    auth = { isAuthenticated: true, isLoading: false };
    window.history.replaceState(null, "", "/connect/whisk");
    await render();
    await flush();
    expect(calls).toEqual([]);
    expect(here()).toBe("/simple/connections?whisk=error&reason=bad_state");
  });
});
