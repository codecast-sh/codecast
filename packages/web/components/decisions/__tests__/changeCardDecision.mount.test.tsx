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
  const { container, unmount } = await mount(<ChangeCardDecision card={card} live={57} impact="1 noticed by the contact" answer={<DecisionAnswerControls decision={decisionOf(card)} onAnswer={() => {}} describe />} />);
  expect(container.querySelector("[data-card-headline]")!.textContent).toBe(card.headline);
  expect(container.querySelector(".ccd-today")!.textContent).toContain(card.wrong);
  expect(container.querySelector(".ccd-after")!.textContent).toContain(card.change);
  const tiles = Array.from(container.querySelectorAll(".ccd-tile-label")).map((t) => t.textContent);
  expect(tiles).toEqual(["Conversations", "Proof", "Checks", "Risk"]);
  expect(container.querySelector("[data-card-tiles]")!.textContent).toContain("57");
  // Impact in the problem page's words, never the judge's floor score.
  expect(container.querySelector("[data-card-tiles]")!.textContent).toContain("1 noticed by the contact");
  expect(container.querySelector("[data-card-tiles]")!.textContent).not.toMatch(/\/10/);
  // The Checks tile is the one figure; its list opens from it, in place: every check in one row, red first, then not
  // run, then passed, never "passed" above a red list.
  expect(container.querySelector("[data-card-checks]")).toBeNull();
  await act(async () => { (container.querySelector("[data-card-tile=Checks]") as HTMLButtonElement).click(); });
  const checks = Array.from(container.querySelectorAll("[data-card-checks] [data-cc-check-state]")).map((c) => `${c.getAttribute("data-cc-check-state")}:${c.textContent}`);
  expect(checks).toEqual(["fail:Verifyhandoff blocked", "not-run:Evalopen", "pass:Reviewapproved"]);
  // A verdict against shipping reads as the checks that hold it back; an owed eval holds nothing back on its own.
  expect(Array.from(container.querySelectorAll(".cc-why-chip")).map((c) => c.textContent)).toEqual(["Verify: handoff blocked"]);
  // Each answer says what it does.
  expect(container.querySelectorAll(".cc-verdict-desc").length).toBeGreaterThanOrEqual(3);
  await unmount();
});

test("a card with no real case replayed has no cases section; the Proof tile says what it ran on (tc-16, tc-18)", async () => {
  const card: ChangeCard = { ...base, examples: [] };
  const { container, unmount } = await mount(<ChangeCardDecision card={card} answer={null} />);
  expect(container.querySelector("[data-card-examples]")).toBeNull();
  await unmount();
});

test("a Ship with an owed eval unscored reads Ship after evals", async () => {
  const card: ChangeCard = { ...base, checks: [{ name: "Eval", ok: true, detail: UNSCORED_DETAIL }], recommend: { verdict: "ship", why: "The fix works on the record." } };
  const { container, unmount } = await mount(<DecisionAnswerControls decision={decisionOf(card)} onAnswer={() => {}} describe />);
  expect(container.querySelector("[data-cc-recommended]")!.textContent).toStartWith("Ship after evals recommended");
  await unmount();
});

test("each conversation shows the contact's situation above the words sent, what they leave out under them, and a finding without a quote reads as the finding (tc-18, tc-6)", async () => {
  const seen = [
    { key: "a", title: "t", quote: "Piedmont is an M&A advisory firm, so this is an advisory route.", asked: "Fortune 1000 corp dev only", missing: "the member's corp-dev-only limit", at: 0 },
    { key: "b", title: "t", quote: "Union pitched a supplier when a client was asked for.", asked: "Clients, not suppliers", at: 0, finding: true },
  ];
  const { container, unmount } = await mount(<ChangeCardDecision card={{ ...base, examples: [] }} seen={seen} answer={null} />);
  expect(Array.from(container.querySelectorAll("[data-seen-asked]")).map((a) => a.textContent)).toEqual(["SituationFortune 1000 corp dev only", "SituationClients, not suppliers"]);
  expect(Array.from(container.querySelectorAll("[data-seen-missing]")).map((a) => a.textContent)).toEqual(["Missingthe member's corp-dev-only limit"]);
  expect(container.textContent).not.toContain("Asked");
  expect(container.querySelectorAll("[data-seen-finding]").length).toBe(1);
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

test("a replay proof with no real case shown says what ran on the Proof tile; Today and After stay the author's words (tc-3)", async () => {
  const card: ChangeCard = {
    ...base,
    examples: [],
    proof: {
      before: [{ name: "replay: cd backend && bun scripts/repro/ct-1-replay.ts", ok: false, detail: "draw 1: fail\nRED: 2 of 2 draws paid the due promise with a still-waiting note." }],
      after: [{ name: "replay: cd backend && bun scripts/repro/ct-1-replay.ts", ok: true, detail: "ct-1 replay · prompt texts changed in this checkout: promiseFollowThrough, dailyReview\nGREEN: 2 of 2 draws sent no unresolved-wait note." }],
    },
  };
  const { container, unmount } = await mount(<ChangeCardDecision card={card} answer={null} />);
  // A synthetic replay passes; only a real case replayed earns "Fixed".
  expect(container.querySelector("[data-card-tiles]")!.textContent).toContain("Passes ×2");
  expect(container.querySelector("[data-card-tiles]")!.textContent).not.toContain("Fixed");
  expect(container.querySelector("[data-card-tiles]")!.textContent).toContain("0 real cases");
  expect(container.querySelector(".ccd-today")!.textContent).toContain(card.wrong);
  expect(container.querySelector(".ccd-after")!.textContent).toContain(card.change);
  expect(container.textContent).not.toContain("draws");
  expect(container.textContent).not.toContain("promiseFollowThrough");
  await unmount();
});

const example = { input: "Ryan accepted the 1:45pm slot Union offered", before: "I can't arrange a Zoom invitation for 1:45pm today.", after: "The 1:45pm meeting he was offered is booked.", note: "" };
const proofOf = (name: string) => ({ before: [{ name, ok: false, detail: "RED: fails" }], after: [{ name, ok: true, detail: "GREEN: passes" }] });

test("a code test passing reads Test passes in a neutral tone, and its cases read as what should happen, never as observed (tc-16)", async () => {
  const card: ChangeCard = { ...base, examples: [example], proof: proofOf("repro: cd backend && bun test scripts/repro/ct-59227.test.ts") };
  const { container, unmount } = await mount(<ChangeCardDecision card={card} answer={null} />);
  const tiles = container.querySelector("[data-card-tiles]")!.textContent!;
  expect(tiles).toContain("Test passes");
  expect(tiles).toContain("code test only");
  expect(tiles).not.toContain("Fixed");
  expect(container.querySelector("[data-card-examples]")!.hasAttribute("data-card-examples-real")).toBe(false);
  expect(container.querySelector("[data-card-examples] .cc-label")!.textContent).not.toContain("before and after");
  expect(Array.from(container.querySelectorAll("[data-card-examples] .cc-side-label")).map((l) => l.textContent)).toEqual(["Before", "Expected"]);
  await unmount();
});

test("a real case replayed before and after reads Fixed, and its cases read as observed (tc-14)", async () => {
  const card: ChangeCard = { ...base, examples: [example], proof: proofOf("replay: cd backend && bun scripts/repro/ct-59462-replay.ts") };
  const { container, unmount } = await mount(<ChangeCardDecision card={card} answer={null} />);
  expect(container.querySelector("[data-card-tiles]")!.textContent).toContain("Fixed");
  expect(container.querySelector("[data-card-tiles]")!.textContent).toContain("on a replayed real case");
  expect(container.querySelector("[data-card-examples]")!.hasAttribute("data-card-examples-real")).toBe(true);
  expect(Array.from(container.querySelectorAll("[data-card-examples] .cc-side-label")).map((l) => l.textContent)).toEqual(["Before", "After"]);
  await unmount();
});

test("a problem left with no findings reads No current evidence in red and says where it went, never the card's frozen count (tc-18)", async () => {
  const card: ChangeCard = { ...base, cause: { ...base.cause, signals: 2 } };
  const { container, unmount } = await mount(<ChangeCardDecision card={card} live={0} gone="moved to ct-59425" answer={null} />);
  const tile = container.querySelector(".ccd-tile")!;
  expect(tile.textContent).toBe("Conversations0No current evidencemoved to ct-59425");
  expect(container.querySelector("[data-card-stale]")).not.toBeNull();
  expect(container.textContent).not.toContain("Reports");
  await unmount();
});

test("the Conversations tile leads with what the change covers of the problem now, and a change that sends less shows what it stops, over what it was counted, and what the contact hears next (tc-3, tc-6, tc-14)", async () => {
  const card: ChangeCard = { ...base, reach: { conversations: 6, of: 17 }, stops: { per_week: 4, what: "emails", next: "Steve hears from his caller on the next call, within 2 days", basis: "14 days, all contacts" } };
  const { container, unmount } = await mount(<ChangeCardDecision card={card} live={17} answer={null} />);
  expect(container.querySelector("[data-card-reach]")!.textContent).toBe("6 of 17");
  expect(container.querySelector("[data-card-stops]")!.textContent).toBe("~4 emails/wk");
  expect(container.querySelector("[data-card-stops-basis]")!.textContent).toBe("14 days, all contacts");
  const labels = Array.from(container.querySelectorAll(".ccd-tile-label")).map((t) => t.textContent);
  expect(labels).toEqual(["Conversations", "Proof", "Stops", "Checks", "Risk"]);
  expect(container.querySelector("[data-card-tiles]")!.textContent).toContain("within 2 days");
  await unmount();
});

test("a change none of whose conversations is still a finding reads 0 of N in red (tc-32)", async () => {
  const card: ChangeCard = { ...base, reach: { conversations: 2, of: 10, covers: ["sg-2666", "sg-2485"] } };
  const { container, unmount } = await mount(<ChangeCardDecision card={card} live={9} coverage={{ covered: 0, other: 7, fresh: 2, gone: 3 }} answer={null} />);
  expect(container.querySelector("[data-card-reach]")!.textContent).toBe("0 of 9");
  expect(container.querySelector("[data-card-reach-none]")).not.toBeNull();
  await unmount();
});

test("a card built before the verify step counted its own checks reads the run's Verify, one figure on both", async () => {
  const { useInboxStore } = await import("../../../store/inboxStore");
  const card: ChangeCard = { ...base, checks: [{ name: "Verify", ok: true, detail: "The builder handed it over as done" }, { name: "Review", ok: true, detail: "An independent reviewer approved it" }] };
  const steps = JSON.stringify({ ok: true, steps: [{ name: "typecheck", ok: true }, { name: "unit", ok: true }, { name: "lint", ok: true }, { name: "e2e", ok: true }] });
  const prev = useInboxStore.getState().workflowRuns;
  useInboxStore.setState({ workflowRuns: { r5: { _id: "r5", node_statuses: [{ node_id: "verify", status: "completed", outcome: "success", result_preview: steps }] } } } as never);
  const { container, unmount } = await mount(<ChangeCardDecision card={card} answer={null} runId="r5" />);
  await act(async () => { (container.querySelector("[data-card-tile=Checks]") as HTMLButtonElement).click(); });
  const verify = Array.from(container.querySelectorAll("[data-card-checks] [data-cc-check-state]")).map((c) => c.textContent).find((t) => t?.startsWith("Verify"));
  expect(verify).not.toContain("handed it over");
  expect(verify).toContain("4");
  useInboxStore.setState({ workflowRuns: prev } as never);
  await unmount();
});
