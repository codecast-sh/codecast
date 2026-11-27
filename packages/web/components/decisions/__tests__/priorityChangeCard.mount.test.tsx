import { afterAll, expect, test } from "bun:test";
import { act, useState } from "react";
import { JSDOM } from "jsdom";
import { CHANGE_PREFIX } from "@codecast/shared/contracts/priorityCard";
import { replaceGlobals } from "../../../test-helpers/globals";
import { closeDomWindow } from "../../../test-helpers/domGlobals";
import { priorityCardFixture as card } from "../__fixtures__/priorityCard.fixture";

// The priority change card (pl-1131): every change a row with its icon, bold
// prefix and chips; a row is one click; the first answer counts the ticks;
// the Quotes switch and the words table's headers are the card's own state.
const dom = new JSDOM("<!doctype html><html><body></body></html>", { pretendToBeVisual: true, url: "https://codecast.sh/questions" });
const restoreGlobals = replaceGlobals({
  window: dom.window,
  document: dom.window.document,
  navigator: dom.window.navigator,
  HTMLElement: dom.window.HTMLElement,
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
const { PriorityChangeCard } = await import("../PriorityChangeCard");
const { toggleTicked } = await import("../../../lib/priorityCardTicks");
type Answer = Parameters<React.ComponentProps<typeof PriorityChangeCard>["onAnswer"]>[0];
afterAll(() => { closeDomWindow(dom); restoreGlobals(); });

type Answered = React.ComponentProps<typeof PriorityChangeCard>["answered"];
function Harness({ initial, answers, answered, now }: { initial: string[]; answers: Answer[]; answered?: Answered; now?: number }) {
  const [ticked, setTicked] = useState(initial);
  return <PriorityChangeCard card={card} ticked={ticked} onToggle={(next) => setTicked(next)} answered={answered} onAnswer={(a) => answers.push(a)} now={now} />;
}

async function mount(initial: string[] = card.suggested, answered?: Answered, now?: number) {
  const answers: Answer[] = [];
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(() => root.render(<Harness initial={initial} answers={answers} answered={answered} now={now} />));
  const row = (id: string) => container.querySelector(`[data-pcc-row="${id}"]`) as HTMLElement;
  const checked = () => Array.from(container.querySelectorAll("[data-pcc-row]")).filter((r) => r.getAttribute("aria-checked") === "true").map((r) => r.getAttribute("data-pcc-row"));
  const first = () => container.querySelector('[data-option="0"]') as HTMLButtonElement;
  return { container, answers, row, checked, first, unmount: () => act(() => root.unmount()) };
}

test("every change renders as a row under its priority: icon, bold prefix, then what changed", async () => {
  const { container, row, unmount } = await mount();
  expect(container.querySelectorAll("[data-pcc-row]").length).toBe(card.changes.length);
  expect(container.querySelectorAll("[data-pcc-group]").length).toBe(card.groups.length);
  for (const c of card.changes) {
    const r = row(c.id);
    expect(r.querySelector("[data-pcc-icon] svg")).not.toBeNull();
    const prefix = r.querySelector(".pcc-prefix");
    if (CHANGE_PREFIX[c.kind]) expect(prefix!.textContent).toBe(`${CHANGE_PREFIX[c.kind]}:`);
    else expect(prefix).toBeNull();
  }
  expect(row("c1").querySelector("[data-pcc-line]")!.textContent).toBe("Moved: to #3 from #9");
  expect(row("c12").querySelector("[data-pcc-line]")!.textContent).toBe("New priority at #12");
  // The icon's name is on hover, never written in the row.
  expect(row("c6").querySelector("[data-pcc-icon]")!.getAttribute("aria-label")).toBe("Rename");
  // A new priority's header says NEW; an inactive one a dash.
  expect(container.querySelector('[data-pcc-group="new-1"] .pcc-rank')!.textContent).toBe("NEW");
  expect(container.querySelector('[data-pcc-group="pri-3"] .pcc-rank')!.textContent).toBe("–");
  unmount();
}, 30_000); // the first mount pays for loading the store under a loaded machine

test("an existing milestone the row names is a chip with its state mark; a new one is plain text", async () => {
  const { row, unmount } = await mount();
  const chip = row("c2").querySelector("[data-pcc-chip]")!;
  expect(chip.textContent).toBe("Retries back off instead of hammering the gateway");
  expect(chip.querySelector("[data-milestone-mark]")!.getAttribute("data-milestone-mark")).toBe("open");
  expect(row("c7").querySelector("[data-milestone-mark]")!.getAttribute("data-milestone-mark")).toBe("done");
  // A rename names the milestone as it is now in a chip, then the new title in words.
  expect(row("c6").querySelector("[data-pcc-chip]")!.textContent).toBe("Email verification flow");
  expect(row("c6").querySelector("[data-pcc-line]")!.textContent).toContain("→ Verification waits until after the first order");
  expect(row("c13").querySelector("[data-pcc-chip]")).toBeNull();
  unmount();
});

test("a row is one click: it flips its tick and the first answer counts the ticks", async () => {
  const { row, checked, first, unmount } = await mount();
  const n = card.changes.length;
  expect(first().textContent).toContain(`Accept all ${n} changes`);
  expect(first().textContent).toContain("Suggested");
  await act(() => { row("c5").click(); });
  expect(checked()).not.toContain("c5");
  expect(row("c5").className).toContain("is-off");
  expect(first().textContent).toContain(`Accept ${n - 1} of ${n} changes`);
  await act(() => { row("c5").click(); });
  expect(checked()).toContain("c5");
  unmount();
});

test("unticking a new priority unticks its milestones; ticking one of them ticks the priority back", async () => {
  const { row, checked, first, unmount } = await mount();
  const n = card.changes.length;
  await act(() => { row("c12").click(); });
  expect(checked()).not.toContain("c12");
  expect(checked()).not.toContain("c13");
  expect(checked()).not.toContain("c14");
  expect(first().textContent).toContain(`Accept ${n - 3} of ${n} changes`);
  await act(() => { row("c14").click(); });
  expect(checked()).toContain("c12");
  expect(checked()).toContain("c14");
  expect(checked()).not.toContain("c13");
  // Pure helper, card order.
  expect(toggleTicked(card, ["c13", "c1"], "c12")).toEqual(["c1", "c12", "c13"]);
  unmount();
});

test("the answers say accept, none, or the person's words", async () => {
  const { container, row, first, answers, unmount } = await mount();
  await act(() => { row("c9").click(); });
  await act(() => { first().click(); });
  expect(answers[0]).toEqual({ kind: "accept", ids: card.changes.map((c) => c.id).filter((id) => id !== "c9") });
  await act(() => { (container.querySelector('[data-option="1"]') as HTMLElement).click(); });
  expect(answers[1]).toEqual({ kind: "none" });
  await act(() => { (container.querySelector('[data-option="2"]') as HTMLElement).click(); });
  const box = container.querySelector("[data-pcc-write] textarea") as HTMLTextAreaElement;
  box.value = "Keep checkout at #9 until the holiday freeze.";
  await act(() => { (container.querySelector("[data-pcc-send]") as HTMLElement).click(); });
  expect(answers[2]).toEqual({ kind: "text", text: "Keep checkout at #9 until the holiday freeze." });
  unmount();
});

test("nothing ticked holds the first answer", async () => {
  const { first, unmount } = await mount([]);
  expect(first().disabled).toBe(true);
  expect(first().textContent).toContain(`Accept 0 of ${card.changes.length} changes`);
  unmount();
});

test("the Quotes switch hides quotes and events alike", async () => {
  const { container, row, unmount } = await mount();
  expect(row("c1").querySelector('[data-pcc-evidence="quote"]')!.textContent).toContain("Checkout is the thing customers actually feel");
  expect(row("c1").querySelector('[data-pcc-evidence="quote"]')!.textContent).toContain("You · Retry storm on the payment step ·");
  expect(row("c2").querySelector('[data-pcc-evidence="event"]')!.textContent).toContain("acme/bakery#212");
  const before = container.querySelectorAll("[data-pcc-evidence]").length;
  expect(before).toBeGreaterThan(10);
  const toggle = container.querySelector("[data-pcc-quotes]") as HTMLElement;
  expect(toggle.getAttribute("aria-pressed")).toBe("true");
  await act(() => { toggle.click(); });
  expect(container.querySelectorAll("[data-pcc-evidence]").length).toBe(0);
  expect(toggle.getAttribute("aria-pressed")).toBe("false");
  await act(() => { toggle.click(); });
  expect(container.querySelectorAll("[data-pcc-evidence]").length).toBe(before);
  unmount();
});

test("the words table sorts by share, then by any header clicked", async () => {
  const { container, unmount } = await mount();
  const order = () => Array.from(container.querySelectorAll("[data-pcc-word]")).map((r) => r.getAttribute("data-pcc-word"));
  expect(order()).toEqual(["pri-14", "none", "pri-8", "pri-3", "pri-11", "pri-2", "pri-1"]);
  const sort = (k: string) => act(() => { (container.querySelector(`[data-pcc-sort="${k}"]`) as HTMLElement).click(); });
  await sort("rank");
  expect(order()).toEqual(["pri-1", "pri-2", "pri-8", "pri-11", "pri-14", "none", "pri-3"]);
  await sort("rank");
  expect(order().slice(0, 5)).toEqual(["pri-14", "pri-11", "pri-8", "pri-2", "pri-1"]);
  await sort("title");
  expect(order()[0]).toBe("pri-2"); // Bakery dashboard loads fast
  // A ranked priority nobody talked about reads in the caution ink.
  expect(container.querySelector('[data-pcc-word="pri-1"]')!.className).toContain("is-warn");
  expect(container.querySelector("[data-pcc-facts]")!.textContent).toContain("$0.38");
  unmount();
});

const HOUR = 3_600_000;
const answeredAt = card.run.at + HOUR; // 7:01 PM UTC, the run's day

test("answered: the headline counts, rows lose their boxes, declined rows are struck, the correction sits under its change", async () => {
  const ids = card.changes.map((c) => c.id).filter((id) => !["c9", "c12", "c13", "c14"].includes(id));
  const { container, row, unmount } = await mount(card.suggested, { kind: "accept", ids, text: "Text sign-in is how the kiosk works; keep it.", about: "c9", at: answeredAt }, answeredAt + HOUR);
  expect(container.querySelector("[data-card-headline]")!.textContent).toBe(`Accepted ${ids.length} of ${card.changes.length}`);
  // Answered today: the clock alone.
  expect(container.querySelector("[data-pcc-when]")!.textContent).toBe("· answered 7:01 PM");
  expect(container.querySelector("[data-pcc-box]")).toBeNull();
  expect(container.querySelector("[data-option]")).toBeNull();
  expect(container.querySelector("[data-pcc-words]")).toBeNull();
  expect(row("c9").getAttribute("role")).toBeNull();
  expect(row("c9").className).toContain("is-off");
  expect(row("c1").className).not.toContain("is-off");
  expect(row("c9").querySelector("[data-pcc-correction]")!.textContent).toContain("Text sign-in is how the kiosk works");
  expect(container.querySelectorAll("[data-pcc-correction]").length).toBe(1);
  expect(container.querySelector("[data-pcc-unapplied]")).toBeNull();
  unmount();
});

test("an answer from another day leads with its weekday, read against now and not the run", async () => {
  const { container, unmount } = await mount(card.suggested, { kind: "accept", ids: ["c1"], at: answeredAt }, answeredAt + 2 * 24 * HOUR);
  expect(container.querySelector("[data-pcc-when]")!.textContent).toBe("· answered Tue 7:01 PM");
  unmount();
});

test("words beside accepted changes about no one change read at the end", async () => {
  const { container, unmount } = await mount(card.suggested, { kind: "accept", ids: ["c1"], text: "The rest can wait a week." });
  expect(container.querySelector(".pcc-loose [data-pcc-correction]")!.textContent).toContain("The rest can wait a week.");
  unmount();
});

test("a correction instead of an answer: its words lead, the rows read not applied rather than declined", async () => {
  const { container, unmount } = await mount(card.suggested, { kind: "text", ids: [], text: "None of this, the week was a one-off.", at: answeredAt }, answeredAt);
  expect(container.querySelector("[data-card-headline]")!.textContent).toBe("You sent a correction");
  expect(container.querySelector("[data-card-headline] + [data-pcc-correction]")!.textContent).toBe("None of this, the week was a one-off.");
  expect(container.querySelector("[data-pcc-unapplied]")!.textContent).toBe("Not applied");
  expect(container.querySelectorAll("[data-pcc-row].is-off").length).toBe(0);
  expect(container.querySelector(".pcc-loose")).toBeNull();
  expect(container.querySelectorAll("[data-pcc-correction]").length).toBe(1);
  unmount();
});

test("Accept none reads accepted none, with every row declined", async () => {
  const { container, unmount } = await mount(card.suggested, { kind: "none", ids: [], at: answeredAt }, answeredAt);
  expect(container.querySelector("[data-card-headline]")!.textContent).toBe("Accepted none");
  expect(container.querySelector("[data-pcc-when]")!.textContent).toBe("· accepted none 7:01 PM");
  expect(container.querySelectorAll("[data-pcc-row]:not(.is-off)").length).toBe(0);
  unmount();
});

test("Serves names the goals by title in chips", async () => {
  const { row, unmount } = await mount();
  expect(Array.from(row("c4").querySelectorAll("[data-pcc-chip]")).map((c) => c.textContent)).toEqual(["The holiday rush without an outage", "Faster pages everywhere"]);
  unmount();
});
