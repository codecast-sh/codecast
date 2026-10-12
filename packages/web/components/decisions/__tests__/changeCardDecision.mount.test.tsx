import { afterAll, expect, test } from "bun:test";
import { act } from "react";
import { JSDOM } from "jsdom";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { replaceGlobals } from "../../../test-helpers/globals";
import { closeDomWindow } from "../../../test-helpers/domGlobals";
import { CARD_DECISION_OPTIONS, UNSCORED_DETAIL, type ChangeCard } from "@codecast/shared/contracts/changeCard";

// The card laid out for deciding (ChangeCardDecision): the change and what it
// fixes, four tiles, answers that say what they do, real cases, and only the
// checks that are not green. A Revise starts from the card's suggested note.

const dom = new JSDOM("<!doctype html><html><body></body></html>", { pretendToBeVisual: true, url: "https://codecast.sh/trial" });
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
const { ChangeCardDecision } = await import("../ChangeCardDecision");
const { DecisionAnswerControls } = await import("../DecisionAnswerControls");
afterAll(() => { closeDomWindow(dom); restoreGlobals(); });

const base: ChangeCard = JSON.parse(readFileSync(join(import.meta.dir, "../../../../shared/contracts/__fixtures__/changeCard/card.json"), "utf-8"));

async function mount(ui: React.ReactNode) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(() => root.render(<MemoryRouter>{ui}</MemoryRouter>));
  return { container, unmount: () => act(() => root.unmount()) };
}

const decisionOf = (card: ChangeCard): any => ({ _id: `d-${card.cause.task}`, conversation_id: "c", session_id: "s", question: "Ship this change?", options: CARD_DECISION_OPTIONS.map((o) => ({ ...o })), blocking: true, status: "pending", created_at: 0, card });

test("leads with the change, today against after, and four tiles; shows only checks that are not green", async () => {
  const card: ChangeCard = {
    ...base,
    headline: "Stop telling contacts a third party still hasn't answered",
    checks: [{ name: "Verify", ok: false, detail: "handoff status blocked" }, { name: "Eval", ok: true, detail: UNSCORED_DETAIL }, { name: "Review", ok: true, detail: "An independent reviewer approved it" }],
    recommend: { verdict: "revise", why: "The fix works; one stale check is red." },
  };
  const { container, unmount } = await mount(<ChangeCardDecision card={card} live={57} worst={5} answer={<DecisionAnswerControls decision={decisionOf(card)} onAnswer={() => {}} describe />} />);
  expect(container.querySelector("[data-card-headline]")!.textContent).toBe(card.headline);
  expect(container.querySelector(".ccd-today")!.textContent).toContain(card.wrong);
  expect(container.querySelector(".ccd-after")!.textContent).toContain(card.change);
  const tiles = Array.from(container.querySelectorAll(".ccd-tile-label")).map((t) => t.textContent);
  expect(tiles).toEqual(["Conversations", "Proof", "Checks", "Risk"]);
  expect(container.querySelector("[data-card-tiles]")!.textContent).toContain("57");
  // The open checks list the red one and the one never run, in plain words; the passing review is named once beside them.
  const checks = container.querySelector("[data-card-checks]")!.textContent!;
  expect(checks).toContain("the builder marked its handoff blocked");
  expect(checks).toContain("not run in the trial");
  expect(checks).toContain("Review passed");
  // Each answer says what it does.
  expect(container.querySelectorAll(".cc-verdict-desc").length).toBeGreaterThanOrEqual(3);
  await unmount();
});

test("a card with no real case replayed says so instead of showing nothing", async () => {
  const card: ChangeCard = { ...base, examples: [] };
  const { container, unmount } = await mount(<ChangeCardDecision card={card} answer={null} />);
  expect(container.querySelector("[data-card-no-examples]")).not.toBeNull();
  await unmount();
});

test("Revise starts from the card's suggested note", async () => {
  const card: ChangeCard = { ...base, recommend: { verdict: "revise", why: "Stale check." }, ask: "Clear the leftover blocked mark and send it back." };
  const { container, unmount } = await mount(<DecisionAnswerControls decision={decisionOf(card)} onAnswer={() => {}} describe />);
  expect(container.querySelector("[data-cc-ask]")!.textContent).toBe(card.ask);
  await act(() => { (container.querySelector('[data-verdict="revise"]') as HTMLButtonElement).click(); });
  expect((container.querySelector("textarea") as HTMLTextAreaElement).value).toBe(card.ask);
  await unmount();
});
