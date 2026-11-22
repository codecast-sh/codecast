// A feeder's error while the server identity is lost is not reported.
//
// eg-1527 (agentDefinitions:list, requireCaller): the boot gate latches once
// the server confirms the caller. When a token refresh later fails, Convex
// clears the socket's identity while the local token keeps the tree mounted,
// so every live feeder re-runs as an anonymous caller and a handler that
// requires a caller throws. useConvexSync already holds the data in that
// window; the error report must be held the same way, or every lost identity
// files a production error for a state the app already handles.

import type { Root } from "react-dom/client";
import { afterAll, describe, expect, mock, test } from "bun:test";
import { act } from "react";
import { JSDOM } from "jsdom";
import { replaceGlobals } from "../../test-helpers/globals";
import { closeDomWindow } from "../../test-helpers/domGlobals";

mock.restore();

let authenticated = true;
let answer: unknown = [];
const captured: Array<{ message: string; context: unknown }> = [];

const convexReact = await import("convex/react");
mock.module("convex/react", () => ({
  ...convexReact,
  useConvexAuth: () => ({ isAuthenticated: authenticated, isLoading: false }),
  useQueries: (queries: Record<string, unknown>) => Object.fromEntries(Object.keys(queries).map((k) => [k, answer])),
}));
const realAnalytics = { ...(await import("../../lib/analytics")) };
mock.module("../../lib/analytics", () => ({
  ...realAnalytics,
  captureError: (error: Error, context?: unknown) => { captured.push({ message: error.message, context }); },
}));

const dom = new JSDOM("<!doctype html><html><body></body></html>", { pretendToBeVisual: true, url: "http://localhost/" });
const restoreGlobals = replaceGlobals({ window: dom.window, document: dom.window.document, navigator: dom.window.navigator, localStorage: dom.window.localStorage });
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const { createRoot } = await import("react-dom/client");
const { makeFunctionReference } = await import("convex/server");
const { useSyncCollection } = await import(`${import.meta.dir}/../useSyncCollection.ts?fresh-lost-error`);
const AGENT_DEFINITIONS = makeFunctionReference<"query">("agentDefinitions:list");

afterAll(() => {
  mock.module("convex/react", () => convexReact);
  mock.module("../../lib/analytics", () => realAnalytics);
  closeDomWindow(dom);
  restoreGlobals();
});

describe("useSyncCollection while the server identity is lost", () => {
  test("does not report the anonymous caller's requireCaller error", async () => {
    const root: Root = createRoot(dom.window.document.body.appendChild(dom.window.document.createElement("div")));
    const realWarn = console.warn;
    console.warn = () => {};
    function Probe() {
      useSyncCollection("agentDefinitions", AGENT_DEFINITIONS, {});
      return null;
    }
    try {
      authenticated = true;
      answer = [];
      await act(async () => root.render(<Probe />));

      authenticated = false;
      answer = new Error("[CONVEX Q(agentDefinitions:list)] [Request ID: 5e6abd9024c0a2ef] Server Error\nUncaught Error: Not authenticated\n    at requireCaller (../../convex/agentDefinitions.ts)");
      await act(async () => root.render(<Probe />));

      expect(captured).toEqual([]);
    } finally {
      console.warn = realWarn;
      await act(async () => root.unmount());
    }
  });

  test("still reports a confirmed caller's error", async () => {
    captured.length = 0;
    const root: Root = createRoot(dom.window.document.body.appendChild(dom.window.document.createElement("div")));
    const realWarn = console.warn;
    console.warn = () => {};
    function Probe() {
      useSyncCollection("agentDefinitions", AGENT_DEFINITIONS, {});
      return null;
    }
    try {
      authenticated = true;
      answer = new Error("[CONVEX Q(agentDefinitions:list)] Server Error");
      await act(async () => root.render(<Probe />));
      expect(captured.map((c) => c.message)).toEqual(["[CONVEX Q(agentDefinitions:list)] Server Error"]);
    } finally {
      console.warn = realWarn;
      await act(async () => root.unmount());
    }
  });
});
