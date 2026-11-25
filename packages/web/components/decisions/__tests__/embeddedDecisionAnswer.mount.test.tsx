import { afterAll, expect, mock, test } from "bun:test";
import { act } from "react";
import { JSDOM } from "jsdom";
import { replaceGlobals } from "../../../test-helpers/globals";
import { closeDomWindow } from "../../../test-helpers/domGlobals";

// ct-101298. A decision referenced in a chat message (`sd-3164` alone on its
// line) renders as the compact card with its options right there. Clicking an
// option writes the answer to the store at once (answerDecision's draft flips
// the row to "answered"), but the embed draws the decision from the
// sessionDecisions.get query's snapshot, so until the server echoes the card
// keeps showing the same live options and the person clicks again (replay
// rp-24745: the same option clicked twice, 2.5s apart). Here the server never
// echoes: the click must still show at once that the answer registered.

const DECISION_ID = "jd7decision0000000000000000000001";
const pendingDecision = {
  _id: DECISION_ID,
  short_id: "sd-3164",
  conversation_id: "jx7conversation00000000000000001",
  question: "Keep the reply cap, or follow the template rule?",
  status: "pending",
  kind: "single",
  options: [
    { label: "Follow the template", description: "one original, no replies" },
    { label: "Keep it as is", description: "your sd-3164 approval stands over the template rule" },
  ],
  created_at: Date.now() - 60_000,
};

mock.module("next/link", () => ({ default: ({ children, href, ...rest }: any) => <a href={typeof href === "string" ? href : "#"} {...rest}>{children}</a> }));
mock.module("../../../lib/convexUrl", () => ({ CONVEX_URL: "https://convex.test", getConvexUrl: () => "https://convex.test" }));
// The server's answer to every reference query: the decision as it was before
// the click, and it never updates (the round trip has not come back).
mock.module("../../../hooks/useQueryNoThrow", () => ({
  useQueryNoThrow: (_fn: unknown, args: any) => ({ data: args && args !== "skip" && args.decision_id ? pendingDecision : undefined, error: null }),
}));
mock.module("../../../hooks/useOpenLinkedSession", () => ({ useOpenLinkedSession: () => () => {} }));
mock.module("../../../hooks/useJumpToDecisionAsk", () => ({ useJumpToDecisionAsk: () => async () => true, locateDecisionAsk: async () => null }));
const realEmbed = { ...(await import("../../PublishedPageEmbed")) };
mock.module("../../PublishedPageEmbed", () => ({ ...realEmbed, PublishedPageEmbed: () => null }));

const dom = new JSDOM("<!doctype html><html><body></body></html>", { pretendToBeVisual: true, url: "https://codecast.sh/chat/hx7chat" });
const restoreGlobals = replaceGlobals({
  window: dom.window,
  document: dom.window.document,
  navigator: dom.window.navigator,
  HTMLElement: dom.window.HTMLElement,
  Element: dom.window.Element,
  Node: dom.window.Node,
  HTMLButtonElement: dom.window.HTMLButtonElement,
  HTMLAnchorElement: dom.window.HTMLAnchorElement,
  Event: dom.window.Event,
  MouseEvent: dom.window.MouseEvent,
  KeyboardEvent: dom.window.KeyboardEvent,
  localStorage: dom.window.localStorage,
  getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
  requestAnimationFrame: (cb: FrameRequestCallback) => setTimeout(() => cb(0), 0) as unknown as number,
  cancelAnimationFrame: (id: number) => clearTimeout(id),
  ResizeObserver: class { observe() {} disconnect() {} unobserve() {} },
  IS_REACT_ACT_ENVIRONMENT: true,
});
const { createRoot } = await import("react-dom/client");
const { MemoryRouter } = await import("react-router");
const { useInboxStore } = await import("../../../store/inboxStore");
const { EntityObjectCard } = await import("../../EntityObjectCard");

afterAll(() => { closeDomWindow(dom); restoreGlobals(); });

test("clicking an option on a decision embedded in chat shows the answer registered at once, with the server echo still out", async () => {
  // The viewer holds the decision in their queue, as the person it was asked of does.
  useInboxStore.setState((s: any) => ({ sessionDecisions: { ...s.sessionDecisions, [DECISION_ID]: { ...pendingDecision } } }));

  const pane = document.createElement("div");
  document.body.appendChild(pane);
  const root = createRoot(pane);
  await act(() => root.render(<MemoryRouter><EntityObjectCard refId="sd-3164" count={1} /></MemoryRouter>));

  const card = pane.querySelector("[data-decision-card]");
  expect(card).not.toBeNull();
  const option = Array.from(card!.querySelectorAll("button")).find((b) => b.textContent?.includes("Keep it as is"));
  expect(option).toBeDefined();

  await act(async () => { option!.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true })); });

  // The store took the answer (so a failure below is the card not reading it).
  expect((useInboxStore.getState() as any).sessionDecisions[DECISION_ID]?.status).toBe("answered");

  // The card says so: it no longer offers the option as a live answer to click again.
  const after = pane.querySelector("[data-decision-card]");
  const stillLive = after ? Array.from(after.querySelectorAll("button:not([disabled])")).filter((b) => b.textContent?.includes("Keep it as is")) : [];
  expect(stillLive.length).toBe(0);

  await act(() => root.unmount());
  pane.remove();
});
