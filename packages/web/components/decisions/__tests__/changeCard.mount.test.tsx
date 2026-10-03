import { afterAll, expect, mock, test } from "bun:test";
import { act } from "react";
import { JSDOM } from "jsdom";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { replaceGlobals } from "../../../test-helpers/globals";
import { closeDomWindow } from "../../../test-helpers/domGlobals";
import { CARD_DECISION_OPTIONS, suiteGateCheck, SUITE_GATE_CHECK, type ChangeCard } from "@codecast/shared/contracts/changeCard";

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
const { ChangeCardView, exampleInputAdds, cardOutcome } = await import("../ChangeCardView");
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
  // The cause's facts read "14 signals · first seen …": each carries its
  // separator inside a clipped row, so the one opening a line never shows.
  const metas = container.querySelectorAll(".cc-cause-facts .cc-cause-meta");
  expect(Array.from(metas).every((m) => m.firstElementChild?.classList.contains("cc-sep"))).toBe(true);
  // Two rows: the cause, then signals with their sources, age and goal on one line.
  expect(container.querySelectorAll(".cc-cause > .cc-cause-row, .cc-cause-facts > .cc-cause-row")).toHaveLength(2);
  expect(metas[0].textContent).toContain(`${card.cause.signals} signals from ${card.cause.sources[0]}`);
  // The box opens on the proposal and its recommendation, said once.
  expect(container.querySelector("[data-cc-head]")!.textContent).toBe("Change readyRecommends Ship");
  expect(container.querySelector(".cc-recommend")!.textContent).toContain("Why Ship");
  expect(text).toContain(card.goal.name);
  expect(text).toContain(card.wrong);
  expect(text).toContain(card.change);
  expect(text).toContain("4 proven misses, all fixed");
  expect(container.querySelectorAll(".cc-proof-row.is-fixed")).toHaveLength(4);
  // Two pairs by default (CSS hides the second on a phone); the rest are a click away.
  expect(container.querySelectorAll(".cc-example")).toHaveLength(2);
  expect(container.querySelectorAll(".cc-example-extra")).toHaveLength(1);
  const more = container.querySelector("[data-cc-more]") as HTMLButtonElement;
  expect(more.querySelector(".cc-more-wide")!.textContent).toBe("and 1 more");
  expect(more.querySelector(".cc-more-narrow")!.textContent).toBe("and 2 more");
  await act(() => { more.click(); });
  expect(container.querySelectorAll(".cc-example")).toHaveLength(3);
  expect(container.querySelector("[data-cc-more]")).toBeNull();
  // The shared before and after read once as a caption, with no column labels;
  // only the row that differs keeps its detail.
  expect(container.querySelector(".cc-track-labels")).toBeNull();
  expect(container.querySelector(".cc-proof-caption")!.textContent).toContain("fails on origin/main");
  expect(Array.from(container.querySelectorAll(".cc-proof-detail")).filter((d) => d.textContent).length).toBe(1);
  // The goal is one muted line in the cause header; every section and fact is named one way.
  expect(container.querySelector(".cc-goal")!.textContent).toContain(`serves ${card.goal.name}`);
  expect(Array.from(container.querySelectorAll(".cc-label")).map((k) => k.textContent)).toEqual(["Proof", "Examples", "Checks", "Diff", "Risk", "Cost"]);
  // Passing checks fold into a count in the facts and open on a click.
  expect(container.querySelector("[data-cc-checks]")!.textContent).toContain("all 3 pass");
  // Diff counts are neutral ink, never the proof's red and green.
  expect(container.querySelector(".cc-diff")!.closest(".cc-text-green, .cc-text-red")).toBeNull();
  expect(container.querySelector(".cc-diff .cc-text-green, .cc-diff .cc-text-red")).toBeNull();
  expect(container.querySelector(".cc-checks")).toBeNull();
  await act(() => { (container.querySelector("[data-cc-checks]") as HTMLButtonElement).click(); });
  expect(container.querySelectorAll(".cc-check")).toHaveLength(3);
  expect(text).toContain("PR #912");
  expect(text).toContain("Low risk");
  expect(text).toContain("$1.96");
  await unmount();
}, 30_000); // the first mount pays for loading the store under a loaded machine

test("a failed suite gate shows unfolded in the checks, naming its scenarios", async () => {
  const gated: ChangeCard = { ...card, checks: [...card.checks, suiteGateCheck(["handoff-keeps-owner", "dup-merge-keeps-newest"])], recommend: { verdict: "revise", why: "Two suite scenarios fail." } };
  const { container, unmount } = await mount(<ChangeCardView card={gated} />);
  expect(container.querySelector("[data-cc-checks]")!.textContent).toContain("1 of 4 fail");
  const row = Array.from(container.querySelectorAll(".cc-check")).find((r) => r.textContent!.includes(SUITE_GATE_CHECK))!;
  expect(row.querySelector(".cc-tone-red")).toBeTruthy();
  expect(row.textContent).toContain("handoff-keeps-owner, dup-merge-keeps-newest");
  await unmount();
});

test("an answerable surface says the recommendation once, on the control", async () => {
  const { container, unmount } = await mount(<><ChangeCardView card={card} recommend={false} /><DecisionAnswerControls decision={decision} onAnswer={() => {}} /></>);
  expect(container.querySelector(".cc-recommend")).toBeNull();
  expect(container.querySelector("[data-cc-head]")!.textContent).toBe("Change ready");
  expect(container.querySelector("[data-verdict=ship]")!.textContent).toContain("recommended");
  expect(container.querySelector(".cc-why")!.textContent).toContain(card.recommend.why);
  await unmount();
});

test("an example input shows only when its Before does not already quote it", () => {
  // A Before that is a run of the input only repeats it, so the input is dropped.
  expect(exampleInputAdds(card.examples[0].input, card.examples[0].before)).toBe(false);
  expect(exampleInputAdds("fix the bug", "Fix the bug.")).toBe(false);
  expect(exampleInputAdds("the deploy fails after the bun upgrade", "Railway deploy is broken")).toBe(true);
});

test("a settled card says what happened in place of the recommendation", async () => {
  const answered = { ...decision, status: "answered", answer_index: 0, resolved_at: Date.now() - 47 * 60_000 };
  const outcome = cardOutcome(answered, "Ashot", Date.now())!;
  expect(outcome.pill).toBe("Shipped by Ashot · 47m ago");
  expect(outcome.verdict).toBe("Shipped");
  expect(outcome.tone).toBe("green");
  const { container, unmount } = await mount(<ChangeCardView card={card} outcome={outcome.line} />);
  expect(container.querySelector(".cc-recommend")).toBeNull();
  expect(container.querySelector("[data-cc-outcome]")!.textContent).toContain("Shipped");
  expect(container.querySelector("[data-cc-head]")!.textContent).toBe("Change proposed");
  await unmount();
  const revised = cardOutcome({ ...answered, answer_index: 1, answer_text: "Revise: keep the greeting" }, "Ashot", Date.now())!;
  expect(revised.pill.startsWith("Sent back to revise by Ashot")).toBe(true);
  expect(cardOutcome({ ...decision }, "Ashot", Date.now())).toBeNull();
});

test("a withdrawn or dismissed card ends on that, muted, not on the recommendation", async () => {
  const withdrawn = cardOutcome({ ...decision, status: "withdrawn", resolved_at: Date.now() - 9 * 60_000 }, "Ashot", Date.now())!;
  expect(withdrawn.pill).toBe("Withdrawn by the agent · 9m ago");
  expect(withdrawn.tone).toBe("dim");
  const { container, unmount } = await mount(<ChangeCardView card={card} outcome={withdrawn.line} />);
  expect(container.querySelector(".cc-recommend")).toBeNull();
  expect(container.querySelector("[data-cc-outcome]")!.textContent).toContain("Withdrawn");
  await unmount();
  const dismissed = cardOutcome({ ...decision, status: "dismissed", resolved_at: Date.now() - 5 * 60_000, answered_by: { kind: "user", id: "u1" } }, "Ashot", Date.now())!;
  expect(dismissed.pill).toBe("Dismissed by Ashot · 5m ago");
});

test("the verdict bar leads with the answer on record", async () => {
  const answered = { ...decision, blocking: false, status: "answered", answer_index: 2, resolved_at: Date.now() - 5 * 3600_000 };
  const outcome = cardOutcome(answered, "Ashot", Date.now())!;
  const { container, unmount } = await mount(<DecisionAnswerControls decision={answered} onAnswer={() => {}} record={outcome.pill} />);
  expect(container.querySelector("[data-cc-course]")!.textContent).toBe("Dropped by Ashot · 5h ago. Pick another to change course.");
  await unmount();
});

test("a page that leads with the change draws the card without its head", async () => {
  const { container, unmount } = await mount(<ChangeCardView card={card} change={false} />);
  expect(container.querySelector(".cc-change")).toBeNull();
  expect(container.querySelector(".cc-cause")).toBeNull();
  expect(container.textContent).toContain(card.wrong);
  await unmount();
});

test("the line is one dense proof summary", async () => {
  const { container, unmount } = await mount(<ChangeCardView card={card} density="line" />);
  // Past three misses one pip stands for them all; the count reads beside it.
  expect(container.querySelectorAll(".cc-pip")).toHaveLength(1);
  expect(container.querySelectorAll(".cc-pip-fixed")).toHaveLength(1);
  // The line is proof, checks and risk; the diff lives on the full card.
  expect(container.textContent).not.toContain(`${card.diff.added}`);
  // Proof and the card's own checks are named apart.
  expect(container.textContent).toContain("4/4 misses fixed");
  expect(container.textContent).toContain("checks 3/3");
  expect(container.textContent).toContain("recommends Ship");
  expect(container.textContent).not.toContain("$1.96");
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
