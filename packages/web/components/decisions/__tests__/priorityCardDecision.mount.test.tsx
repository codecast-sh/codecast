import { afterAll, afterEach, expect, test } from "bun:test";
import { act } from "react";
import { JSDOM } from "jsdom";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { changeLine } from "@codecast/shared/contracts/priorityCard";
import { replaceGlobals } from "../../../test-helpers/globals";
import { closeDomWindow } from "../../../test-helpers/domGlobals";
import { priorityCardFixture as card } from "../__fixtures__/priorityCard.fixture";

// A decision row carrying a priority change card (pl-1131) is drawn as the
// card, not as its option list; its ticks live in the decision's draft; its
// three answers ride the store's answerDecision (Accept: the ticked changes'
// option indexes; Accept none: a dismissal; Something else: a text answer);
// and settled, the card reads its record off the row at once.
const dom = new JSDOM("<!doctype html><html><body></body></html>", { pretendToBeVisual: true, url: "https://codecast.sh/decisions" });
const restoreGlobals = replaceGlobals({
  window: dom.window,
  document: dom.window.document,
  navigator: dom.window.navigator,
  HTMLElement: dom.window.HTMLElement,
  HTMLTextAreaElement: dom.window.HTMLTextAreaElement,
  Element: dom.window.Element,
  Node: dom.window.Node,
  KeyboardEvent: dom.window.KeyboardEvent,
  Event: dom.window.Event,
  localStorage: dom.window.localStorage,
  getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
  requestAnimationFrame: (cb: FrameRequestCallback) => setTimeout(() => cb(0), 0) as unknown as number,
  cancelAnimationFrame: (id: number) => clearTimeout(id),
  IS_REACT_ACT_ENVIRONMENT: true,
});
const { createRoot } = await import("react-dom/client");
const { useInboxStore } = await import("../../../store/inboxStore");
const { PriorityCardDecision } = await import("../PriorityCardDecision");
afterAll(() => { closeDomWindow(dom); restoreGlobals(); });

const titleOf = (p: string) => card.groups.find((g) => g.priority === p)?.title ?? p;
let n = 0;

/** A fresh row in the store, shaped as the server posts it: a silent, blocking multi whose option i is change i (it waits on the person; nothing goes ahead without them). */
function seed(extra: Record<string, unknown> = {}) {
  const id = `d-pcc-${++n}`;
  const row: any = {
    _id: id, conversation_id: "c-pcc", session_id: "s-pcc", question: "Should your priorities follow what you worked on today?",
    context_md: "A third of what you typed went to checkout.\n\nMore below.", options: card.changes.map((c) => ({ label: changeLine(c, titleOf) })),
    kind: "multi", silent: true, blocking: true, status: "pending", created_at: 1, priority_card: card, ...extra,
  };
  useInboxStore.setState((s: any) => ({ sessionDecisions: { ...s.sessionDecisions, [id]: row } }));
  return id;
}

const mounted: Array<() => void> = [];
afterEach(() => { while (mounted.length) mounted.pop()!(); });

async function mount(id: string) {
  const answers: any[] = [];
  // The page's own answer path: adopt, then the store action.
  const onAnswer = (a: any) => { answers.push(a); useInboxStore.getState().adoptDecision(id); useInboxStore.getState().answerDecision(id, a); };
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const Live = () => {
    const decision = useInboxStore((s) => s.sessionDecisions[id]);
    return <PriorityCardDecision decision={decision} card={decision.priority_card!} onAnswer={onAnswer} />;
  };
  await act(() => root.render(<Live />));
  mounted.push(() => act(() => root.unmount()));
  const q = (sel: string) => container.querySelector(sel) as HTMLElement;
  return { container, answers, q, row: () => useInboxStore.getState().sessionDecisions[id] };
}

test("a decision with a priority card draws the card, its question and the context's first line", async () => {
  const { container, q } = await mount(seed());
  expect(q("[data-priority-card]")).not.toBeNull();
  expect(container.querySelectorAll("[data-pcc-row]").length).toBe(card.changes.length);
  expect(q("[data-card-headline]").textContent).toBe("Should your priorities follow what you worked on today?");
  expect(q(".pcc-case").textContent).toBe("A third of what you typed went to checkout.");
  // The three answers are the card's own; no option per change is listed.
  expect(container.querySelectorAll("[data-option]").length).toBe(3);
}, 30_000);

test("unticking two changes and Accept sends the ticked changes' option indexes", async () => {
  const id = seed();
  const { container, answers, q, row } = await mount(id);
  const off = [card.changes[1].id, card.changes[3].id];
  for (const c of off) await act(() => { q(`[data-pcc-row="${c}"]`).click(); });
  // The ticks are the decision's draft, so they outlive this mount.
  expect(useInboxStore.getState().drafts[`decision:${id}`]?.ticked).not.toContain(off[0]);
  await act(() => { (container.querySelector('[data-option="0"]') as HTMLElement).click(); });
  const want = card.changes.flatMap((c, i) => (card.suggested.includes(c.id) && !off.includes(c.id) ? [i] : []));
  expect(answers).toEqual([{ json: want }]);
  expect(row().status).toBe("answered");
  expect(row().answer_json).toEqual(want);
  // Answered at once from the store: the card reads its record, the answers are gone.
  expect(q("[data-priority-card]").hasAttribute("data-answered")).toBe(true);
  expect(q("[data-card-headline]").textContent).toBe(`Accepted ${want.length} of ${card.changes.length}`);
  expect(container.querySelector("[data-pcc-answers]")).toBeNull();
  expect(useInboxStore.getState().drafts[`decision:${id}`]).toBeUndefined();
});

test("Accept none dismisses the row, and the card records none accepted", async () => {
  const { container, answers, q, row } = await mount(seed());
  await act(() => { (container.querySelector('[data-option="1"]') as HTMLElement).click(); });
  expect(answers).toEqual([{ dismiss: true }]);
  expect(row().status).toBe("dismissed");
  expect(q("[data-card-headline]").textContent).toBe("Accepted none");
  expect(q("[data-pcc-when]").textContent).toContain("accepted none");
  expect(q("[data-pcc-when]").textContent).not.toContain("answered");
  // Every row reads declined.
  expect(container.querySelectorAll("[data-pcc-row]:not(.is-off)").length).toBe(0);
});

test("Something else sends the person's words as a text answer", async () => {
  const { container, answers, q, row } = await mount(seed());
  await act(() => { (container.querySelector('[data-option="2"]') as HTMLElement).click(); });
  const box = q("[data-pcc-write] textarea") as HTMLTextAreaElement;
  box.value = "Keep checkout where it is.";
  await act(() => { q("[data-pcc-send]").click(); });
  expect(answers).toEqual([{ text: "Keep checkout where it is." }]);
  expect(row().status).toBe("answered");
  expect(row().answer_text).toBe("Keep checkout where it is.");
  // The correction leads the card in place of a count; the rows were not applied, not declined.
  expect(q("[data-card-headline]").textContent).toBe("You sent a correction");
  expect(q("[data-card-headline] + [data-pcc-correction]").textContent).toBe("Keep checkout where it is.");
  expect(q("[data-pcc-unapplied]").textContent).toBe("Not applied");
  expect(container.querySelectorAll("[data-pcc-row].is-off").length).toBe(0);
});

test("a settled row renders its record: the server's outcome wins over the picked indexes", async () => {
  const accepted = [card.changes[0].id, card.changes[2].id];
  const { container, q } = await mount(seed({
    status: "answered", answer_json: [0, 1, 2], resolved_at: card.run.at + 60_000,
    priority_card: { ...card, outcome: { accepted, skipped: card.changes.map((c) => c.id).filter((c) => !accepted.includes(c)), at: card.run.at + 90_000 } },
  }));
  expect(q("[data-card-headline]").textContent).toBe(`Accepted 2 of ${card.changes.length}`);
  const on = Array.from(container.querySelectorAll("[data-pcc-row]")).filter((r) => !r.classList.contains("is-off")).map((r) => r.getAttribute("data-pcc-row"));
  expect(on).toEqual(accepted);
  expect(container.querySelector("[data-pcc-answers]")).toBeNull();
});

test("the decision page draws the card in place of its question, options and answer footer", () => {
  const doc = readFileSync(join(import.meta.dir, "..", "DecisionDocument.tsx"), "utf8");
  expect(doc).toContain("<PriorityCardDecision decision={decision} card={priorityCard} onAnswer={onAnswer} />");
  expect(doc).toContain("!verdictBar && !outcome && !priorityCard && <section");
  expect(doc).toContain("a.answerSection && !priorityCard && <section");
});

test("a compact row asks how many changes the card proposes, and a settled one says how many were taken", async () => {
  const { priorityCardAsk, priorityCardAnswerWord } = await import("../../../lib/priorityCardDecision");
  expect(priorityCardAsk(card)).toBe(`${card.changes.length} changes to your priorities`);
  expect(priorityCardAnswerWord({ status: "pending", priority_card: card })).toBeNull();
  expect(priorityCardAnswerWord({ status: "answered", answer_json: [0, 3], priority_card: card })).toBe(`Accepted 2 of ${card.changes.length}`);
  expect(priorityCardAnswerWord({ status: "dismissed", priority_card: card })).toBe("Accepted none");
  expect(priorityCardAnswerWord({ status: "answered", answer_text: "Not checkout.", priority_card: card })).toBe("Not checkout.");
});
