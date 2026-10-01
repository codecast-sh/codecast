import { afterAll, expect, mock, test } from "bun:test";
import { act } from "react";
import { JSDOM } from "jsdom";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { replaceGlobals } from "../../../test-helpers/globals";
import { closeDomWindow } from "../../../test-helpers/domGlobals";
import { CARD_DECISION_OPTIONS, type ChangeCard } from "@codecast/shared/contracts/changeCard";

// A decision about a change card (LE11) draws the card natively and answers
// Ship, Revise or Drop with the keys; Revise carries a note.
mock.module("../../tools/MarkdownRenderer", () => ({ MarkdownRenderer: ({ content }: { content: string }) => <div>{content}</div> }));

const dom = new JSDOM("<!doctype html><html><body></body></html>", { pretendToBeVisual: true, url: "https://codecast.sh/questions" });
const restoreGlobals = replaceGlobals({
  window: dom.window,
  document: dom.window.document,
  navigator: dom.window.navigator,
  HTMLElement: dom.window.HTMLElement,
  KeyboardEvent: dom.window.KeyboardEvent,
  localStorage: dom.window.localStorage,
  getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
  requestAnimationFrame: (cb: FrameRequestCallback) => setTimeout(() => cb(0), 0) as unknown as number,
  cancelAnimationFrame: (id: number) => clearTimeout(id),
  IS_REACT_ACT_ENVIRONMENT: true,
});
const { createRoot } = await import("react-dom/client");
const { MemoryRouter } = await import("react-router");
const { ChangeCardView } = await import("../ChangeCardView");
const { DecisionAnswerControls } = await import("../DecisionAnswerControls");
afterAll(() => { closeDomWindow(dom); restoreGlobals(); });

const card: ChangeCard = JSON.parse(readFileSync(join(import.meta.dir, "../../../../shared/contracts/__fixtures__/changeCard/card.json"), "utf-8"));
const decision: any = { _id: "d1", conversation_id: "c1", session_id: "s1", question: card.cause.title, options: CARD_DECISION_OPTIONS.map((o) => ({ ...o })), blocking: true, status: "pending", created_at: 0, card };

async function mount(ui: React.ReactNode) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(() => root.render(<MemoryRouter>{ui}</MemoryRouter>));
  return { container, unmount: () => act(() => root.unmount()) };
}
const press = (key: string, target: EventTarget = window) =>
  act(() => { target.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key, bubbles: true })); });

test("the full card draws every section from the contract", async () => {
  const { container, unmount } = await mount(<ChangeCardView card={card} />);
  const text = container.textContent!;
  expect(text).toContain("ct-56301");
  expect(text).toContain(card.goal.name);
  expect(text).toContain(card.wrong);
  expect(text).toContain(card.change);
  expect(text).toContain("4 of 4 checks went red to green");
  expect(container.querySelectorAll(".cc-proof-row.is-fixed")).toHaveLength(4);
  expect(container.querySelectorAll(".cc-example")).toHaveLength(3);
  expect(text).toContain("PR #912");
  expect(text).toContain("Low risk");
  expect(text).toContain("$1.96");
  expect(text).toContain("Recommends Ship");
  await unmount();
});

test("the line is one dense proof summary", async () => {
  const { container, unmount } = await mount(<ChangeCardView card={card} density="line" />);
  expect(container.querySelectorAll(".cc-pip-fixed")).toHaveLength(4);
  expect(container.textContent).toContain("3/3 checks");
  expect(container.textContent).toContain("recommends Ship");
  await unmount();
});

test("1 ships, 3 drops, 2 opens a note that return sends as Revise", async () => {
  const answers: any[] = [];
  const { container, unmount } = await mount(<DecisionAnswerControls decision={decision} onAnswer={(a) => answers.push(a)} keys />);
  expect(Array.from(container.querySelectorAll("[data-verdict]")).map((b) => b.getAttribute("data-verdict"))).toEqual(["ship", "revise", "drop"]);
  await press("1");
  await press("3");
  expect(answers).toEqual([{ index: 0 }, { index: 2 }]);
  await press("2");
  const note = container.querySelector("textarea")!;
  expect(note).toBeTruthy();
  await press("Enter", note);
  expect(answers).toHaveLength(2); // an empty note is not a Revise
  await act(() => {
    const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLTextAreaElement.prototype, "value")!.set!;
    setter.call(note, "keep the greeting rule, drop the length cap");
    note.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
  });
  await press("Enter", note);
  expect(answers[2]).toEqual({ index: 1, text: "Revise: keep the greeting rule, drop the length cap" });
  await unmount();
});
