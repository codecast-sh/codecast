import { afterAll, expect, mock, test } from "bun:test";
import { act } from "react";
import { JSDOM } from "jsdom";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { replaceGlobals } from "../../../test-helpers/globals";
import { closeDomWindow } from "../../../test-helpers/domGlobals";
import { CARD_DECISION_OPTIONS, type ChangeCard } from "@codecast/shared/contracts/changeCard";

// ct-97331: Ship on a real line-run card never ships on one press, but the
// first press must not be lost in silence when the person moves on to another
// decision. Pressing Ship once and then opening the next card has to leave
// one of: the ship started, the confirm still open for that card, or a notice
// saying it did not ship.

// Records every toast while still showing the real one (bun shares module mocks across files).
const toasts: string[] = [];
// The namespace binds live to the mock once it is installed, so the real
// toast is held here first; calling through realSonner.toast would call the spy.
const realSonner = { ...(await import("sonner")) };
const realToast = realSonner.toast;
const { success, error, warning, info } = realToast;
const spy = Object.assign((msg: unknown, ...rest: unknown[]) => { toasts.push(String(msg)); return (realToast as any)(msg, ...rest); }, realToast, {
  success: (msg: unknown, ...rest: unknown[]) => { toasts.push(String(msg)); return success(msg as any, ...(rest as [])); },
  error: (msg: unknown, ...rest: unknown[]) => { toasts.push(String(msg)); return error(msg as any, ...(rest as [])); },
  warning: (msg: unknown, ...rest: unknown[]) => { toasts.push(String(msg)); return warning(msg as any, ...(rest as [])); },
  info: (msg: unknown, ...rest: unknown[]) => { toasts.push(String(msg)); return info(msg as any, ...(rest as [])); },
});
mock.module("sonner", () => ({ ...realSonner, toast: spy }));

const dom = new JSDOM("<!doctype html><html><body></body></html>", { pretendToBeVisual: true, url: "https://codecast.sh/questions" });
const restoreGlobals = replaceGlobals({
  window: dom.window,
  document: dom.window.document,
  navigator: dom.window.navigator,
  HTMLElement: dom.window.HTMLElement,
  Element: dom.window.Element,
  Node: dom.window.Node,
  KeyboardEvent: dom.window.KeyboardEvent,
  localStorage: dom.window.localStorage,
  getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
  requestAnimationFrame: (cb: FrameRequestCallback) => setTimeout(() => cb(0), 0) as unknown as number,
  cancelAnimationFrame: (id: number) => clearTimeout(id),
  IS_REACT_ACT_ENVIRONMENT: true,
});
const { createRoot } = await import("react-dom/client");
const { MemoryRouter } = await import("react-router");
const { DecisionAnswerControls } = await import("../DecisionAnswerControls");
const { useInboxStore } = await import("../../../store/inboxStore");
afterAll(() => { closeDomWindow(dom); restoreGlobals(); });

const card: ChangeCard = JSON.parse(readFileSync(join(import.meta.dir, "../../../../shared/contracts/__fixtures__/changeCard/card.json"), "utf-8"));
const realCard = (id: string): any => ({ _id: id, conversation_id: "c1", session_id: "s1", question: card.cause.title, options: CARD_DECISION_OPTIONS.map((o) => ({ ...o })), blocking: true, status: "pending", created_at: 0, card, task_id: `t-${id}`, workflow_run_id: `r-${id}` });

test("one Ship press on a real flow card, then moving to the next decision, is never silently dropped", async () => {
  const started: unknown[][] = [];
  const realStart = useInboxStore.getState().startShip;
  useInboxStore.setState({ startShip: ((...args: unknown[]) => { started.push(args); }) as never });

  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(() => root.render(
    <MemoryRouter>
      <section data-card="d1"><DecisionAnswerControls decision={realCard("d1")} onAnswer={() => {}} /></section>
      <section data-card="d2"><DecisionAnswerControls decision={realCard("d2")} onAnswer={() => {}} /></section>
    </MemoryRouter>,
  ));
  const shipOf = (id: string) => container.querySelector(`[data-card=${id}] [data-verdict=ship]`) as HTMLButtonElement;

  // The person presses Ship once on the first decision...
  await act(() => { shipOf("d1").focus(); shipOf("d1").click(); });
  expect(started).toHaveLength(0);
  toasts.length = 0;

  // ...then moves to the next decision without pressing again.
  await act(() => { shipOf("d2").focus(); });
  await act(() => new Promise((r) => setTimeout(r, 20)));

  const shipStarted = started.some((a) => (a as any[])[2] === "d1");
  const confirmStillOpen =
    shipOf("d1").getAttribute("aria-pressed") === "true" ||
    !!document.querySelector("[role=dialog], [role=alertdialog]");
  const noticeShown = toasts.some((t) => !/sent/i.test(t));
  expect({ shipStarted, confirmStillOpen, noticeShown }).not.toEqual({ shipStarted: false, confirmStillOpen: false, noticeShown: false });

  useInboxStore.setState({ startShip: realStart });
  await act(() => root.unmount());
});
