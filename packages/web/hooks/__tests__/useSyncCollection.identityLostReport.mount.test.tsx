// A feeder does not report UNAUTHENTICATED as a production error while the
// server has lost an identity it had confirmed (ct-74852).
//
// externalEvents:listForTeam threw ConvexError UNAUTHENTICATED from
// requireUser in production (eg-1526, eg-2755) after the auth gate had
// opened. The gate latches, so when a token refresh fails mid-session the
// subscription stays live and re-runs as an anonymous caller. useConvexSync
// already discards what arrives in that window; useFeederError still sent the
// throw to Sentry. Real failures stay reported exactly once.

import type { Root } from "react-dom/client";
import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { act } from "react";
import { JSDOM } from "jsdom";
import { ConvexError } from "convex/values";
import { replaceGlobals } from "../../test-helpers/globals";
import { closeDomWindow } from "../../test-helpers/domGlobals";

mock.restore();

let authenticated = true;
let answer: unknown;
const reported: Array<{ error: Error; context?: Record<string, unknown> }> = [];

const convexReact = await import("convex/react");
mock.module("convex/react", () => ({
  ...convexReact,
  useConvexAuth: () => ({ isAuthenticated: authenticated, isLoading: false }),
  useQueries: (queries: Record<string, unknown>) => Object.fromEntries(Object.keys(queries).map((k) => [k, answer])),
}));
const realAnalytics = await import("../../lib/analytics");
mock.module("../../lib/analytics", () => ({
  ...realAnalytics,
  captureError: (error: Error, context?: Record<string, unknown>) => { reported.push({ error, context }); },
}));

const dom = new JSDOM("<!doctype html><html><body></body></html>", { pretendToBeVisual: true, url: "http://localhost/" });
const restoreGlobals = replaceGlobals({ window: dom.window, document: dom.window.document, navigator: dom.window.navigator, localStorage: dom.window.localStorage });
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const { createRoot } = await import("react-dom/client");
const { makeFunctionReference } = await import("convex/server");
const { useSyncCollection } = await import(`${import.meta.dir}/../useSyncCollection.ts?fresh-lost-report`);
const { useInboxStore } = await import("../../store/inboxStore");
const TEAM_EVENTS = makeFunctionReference<"query">("externalEvents:listForTeam");

afterAll(() => {
  mock.module("convex/react", () => convexReact);
  mock.module("../../lib/analytics", () => realAnalytics);
  closeDomWindow(dom);
  restoreGlobals();
});

const ROW = { _id: "k97cc9y1a48swe3kfnwcs44a857wmxj2", team_id: "t1", source: "github", title: "push" };
const unauthenticated = () => new ConvexError({ code: "UNAUTHENTICATED", message: "Unauthorized" });

let root: Root;
beforeEach(() => {
  reported.length = 0;
  useInboxStore.getState().syncTable("externalEvents", []);
  root = createRoot(dom.window.document.body.appendChild(dom.window.document.createElement("div")));
});

function Probe() {
  useSyncCollection("externalEvents", TEAM_EVENTS, { limit: 200 });
  return null;
}
async function step(auth: boolean, next: unknown) {
  authenticated = auth;
  answer = next;
  await act(async () => root.render(<Probe />));
}

describe("useSyncCollection — error reports while the server identity is lost", () => {
  test("UNAUTHENTICATED after a confirmed identity is lost is not reported, and the cached rows stay", async () => {
    await step(true, [ROW]);
    expect(Object.keys((useInboxStore.getState() as any).externalEvents)).toEqual([ROW._id]);
    await step(false, unauthenticated());
    expect(reported.map((r) => r.error.message)).toEqual([]);
    expect(Object.keys((useInboxStore.getState() as any).externalEvents)).toEqual([ROW._id]);
    await act(async () => root.unmount());
  });

  test("UNAUTHENTICATED while the socket says it is signed in is still reported once", async () => {
    await step(true, unauthenticated());
    await step(true, unauthenticated());
    expect(reported.length).toBe(1);
    await act(async () => root.unmount());
  });

  test("FORBIDDEN is still reported once, even while the identity is lost", async () => {
    await step(true, [ROW]);
    await step(false, new ConvexError({ code: "FORBIDDEN", message: "Not a member of this team" }));
    await step(false, new ConvexError({ code: "FORBIDDEN", message: "Not a member of this team" }));
    expect(reported.length).toBe(1);
    await act(async () => root.unmount());
  });

  test("a plain server error is still reported once", async () => {
    await step(true, new Error("[CONVEX Q(externalEvents:listForTeam)] Server Error"));
    expect(reported.length).toBe(1);
    expect(reported[0].context).toEqual({ feeder: "externalEvents:listForTeam" });
    await act(async () => root.unmount());
  });
});
